#!/usr/bin/env node
// Investigation: "custom-model avatar breaks specifically on page RELOAD" —
// the project owner's much more precise repro than the earlier teleport/
// mis-scale investigation (verify-posed-rendering.mjs's own commit) tested:
// "with the model bug, it only happens with custom models after a reload of
// the page, at first the model will blink back to the default player model,
// then upon reload my [custom] model is huge and in the center."
//
// The earlier investigation's 150+ join/reload cycles never specifically
// isolated: (a) a CUSTOM (not preset) avatar, (b) confirmed correct in a
// LIVE, already-connected session first, (c) then a REAL page.reload() (not
// a fresh join) of that exact same client, watching the transition moment
// through SeatAvatar's own Suspense fallback (the "default"/ghost
// placeholder) into the resolved custom model.
//
// This script does exactly that: uploads RiggedFigure.glb (this repo's own
// committed rigged test fixture — public/test-fixtures/README.md) as a
// PLAYER's custom avatar (not the DM — the report says "my character
// model"), joins the real Game Room, confirms it renders correctly (scale
// ~1, genuinely posed, seat position away from world origin), then performs
// several REAL page.reload() cycles — each one polling GameRoom's own
// avatar-measure-state/model-pose-state/seat-layout-state hidden mirrors
// (WebGL has no DOM of its own to inspect directly, same reasoning as every
// other verify-*.mjs script here) plus real screenshots through the
// transition, to catch (or rule out) the reported blink-then-mis-scale
// sequence.
//
// Needs the shared Supabase stack configured in .env (this repo doesn't run
// a per-worktree local stack — .env's NEXT_PUBLIC_SUPABASE_URL points at the
// real shared instance). Starts `yarn dev` itself (and polls /api/health) if
// the target port isn't already serving.
// Usage: node scripts/db/verify-avatar-reload.mjs
//        APP_URL=http://localhost:3100 node scripts/db/verify-avatar-reload.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3100";
const SCREENSHOT_DIR = join(rootDir, "scripts", "db", "screenshots", "avatar-reload");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

function loadEnv(path) {
  const env = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = { ...loadEnv(join(rootDir, ".env")), ...loadEnv(join(rootDir, "supabase", ".env")), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY."
  );
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}
function note(label, detail) {
  console.log(`NOTE  ${label}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  const port = new URL(APP_URL).port || "3000";
  console.log(`dev server not running at ${APP_URL} — starting yarn dev on port ${port}…`);
  devServer = spawn("yarn", ["dev"], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PORT: port },
  });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error("dev server did not become healthy within 120s");
}

// The @supabase/ssr cookie format — see verify-day-night-mode.mjs's
// identical helper for the full reasoning.
const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;

function sessionCookies(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value, url: APP_URL }];
  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `avatar-reload-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `AvatarReload ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// Reads GameRoom's hidden avatar-measure-state mirror (added by the prior
// teleport/mis-scale investigation — SeatAvatar.tsx's onMeasureDebug). Keyed
// by user_id; a key absent entirely means that member's avatar hasn't
// finished loading (i.e. is still showing SeatAvatar's Suspense-fallback
// placeholder) yet.
async function measureState(page) {
  const el = await page.$('[data-testid="avatar-measure-state"]');
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}

async function poseState(page) {
  const el = await page.$('[data-testid="model-pose-state"]');
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}

async function seatLayoutState(page) {
  const el = await page.$('[data-testid="seat-layout-state"]');
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}

/**
 * Polls both debug mirrors from the instant they're attached (right after a
 * reload starts) up to `timeoutMs`, logging every DISTINCT observed state
 * for `userId` — the transition record this whole investigation needs.
 * Screenshots at: the first poll (whatever's showing right after reload —
 * the reported "blink to default" moment, if the placeholder is still up),
 * the instant the avatar first resolves, and settle (+1s after resolving,
 * to catch a possible second, LATER wrong transition).
 */
async function watchReloadTransition(page, userId, screenshotPrefix, timeoutMs = 15000) {
  const transitions = [];
  const deadline = Date.now() + timeoutMs;
  let lastSignature = null;
  let resolvedAt = null;
  let shotIndex = 0;

  async function shot(label) {
    shotIndex++;
    const path = join(SCREENSHOT_DIR, `${screenshotPrefix}-${String(shotIndex).padStart(2, "0")}-${label}.png`);
    await page.screenshot({ path }).catch(() => undefined);
    return path;
  }

  await shot("immediately-after-reload-trigger");

  while (Date.now() < deadline) {
    const measure = await measureState(page).catch(() => null);
    const pose = await poseState(page).catch(() => null);
    const hasMeasure = measure && Object.prototype.hasOwnProperty.call(measure, userId);
    const hasPose = pose && Object.prototype.hasOwnProperty.call(pose.avatars ?? {}, userId);
    const signature = JSON.stringify({ hasMeasure, measure: measure?.[userId] ?? null, hasPose, pose: pose?.avatars?.[userId] ?? null });
    if (signature !== lastSignature) {
      lastSignature = signature;
      const record = {
        tMs: timeoutMs - (deadline - Date.now()),
        hasMeasure,
        measurement: measure?.[userId] ?? null,
        hasPose,
        posed: pose?.avatars?.[userId] ?? null,
      };
      transitions.push(record);
      if (hasMeasure && resolvedAt === null) {
        resolvedAt = Date.now();
        await shot("first-resolved");
      } else if (!hasMeasure) {
        await shot("placeholder-or-unattached");
      } else {
        await shot("changed-after-resolve");
      }
    }
    if (hasMeasure && resolvedAt !== null && Date.now() - resolvedAt > 1200) break;
    await sleep(60);
  }
  await shot("settled");
  return transitions;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

// RiggedFigure.glb: a real, conforming-skeleton rigged model (this repo's
// own committed test fixture) — the report specifically says "custom
// models" (not an unrigged preset), and this is the exact fixture the prior
// posed-rendering investigation already validated renders genuinely posed.
// RiggedSimple.glb: a real skin, but a non-conforming 2-bone rig — exercises
// AvatarModel's OTHER groundY code path (box.min.y, same as any ordinary
// unrigged custom upload) instead of resolvedPose.hipsRestWorldY. Selected
// via FIXTURE=simple so both branches get run through this exact
// live-then-reload sequence without two near-duplicate scripts.
const useSimple = process.env.FIXTURE === "simple";
const riggedGlb = join(rootDir, "public", "test-fixtures", useSimple ? "RiggedSimple.glb" : "RiggedFigure.glb");
const expectPosed = !useSimple;

const campaignId = crypto.randomUUID();

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Avatar reload test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  const playerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await playerContext.addCookies(sessionCookies(player.session));
  const playerPage = await playerContext.newPage();
  // Timestamped + phase-labeled so a stale error from an EARLIER phase
  // (e.g. the /account upload step, long before any reload) can't be
  // mistaken for a freshly-recurring per-reload error — a flat
  // never-cleared array would double-count the exact same one-time error
  // against every subsequent reload cycle's own "no errors" check.
  const pageErrors = [];
  let currentPhase = "startup";
  playerPage.on("pageerror", (err) => pageErrors.push({ phase: currentPhase, t: Date.now(), err: String(err) }));

  // -- 1. Upload the rigged model as the PLAYER's own custom avatar via the
  //    real account UI, WITH a nonzero forward-offset (Confirm, not Skip) —
  //    covers model_orientation's own data-access path too, not just the
  //    default 0° case. --
  currentPhase = "account-upload";
  await playerPage.goto(`${APP_URL}/account`);
  await playerPage.getByLabel("Upload a custom avatar model").setInputFiles(riggedGlb);
  await playerPage.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  await playerPage.click('[data-testid="orientation-rotate-plus-45"]');
  await playerPage.click('[data-testid="orientation-confirm"]');
  await playerPage.getByText("Avatar saved.").waitFor({ timeout: 15000 });

  const { data: profileRow } = await admin
    .from("profiles")
    .select("avatar_source, avatar_ref")
    .eq("id", player.id)
    .maybeSingle();
  check(
    "the player's profile now points at a custom avatar",
    profileRow?.avatar_source === "custom" && !!profileRow?.avatar_ref,
    JSON.stringify(profileRow)
  );

  // -- 2. Join the real Game Room LIVE and confirm it renders correctly
  //    BEFORE any reload — the already-confirmed-working baseline this
  //    investigation must not regress. --
  currentPhase = "initial-room-load";
  await playerPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await playerPage.waitForSelector('[data-testid="avatar-measure-state"]', { state: "attached", timeout: 30000 });

  const deadlineInitial = Date.now() + 20000;
  let initialMeasure = null;
  let initialPose = null;
  while (Date.now() < deadlineInitial) {
    initialMeasure = await measureState(playerPage);
    initialPose = await poseState(playerPage);
    if (initialMeasure?.[player.id] && initialPose?.avatars?.[player.id] !== undefined) break;
    await sleep(200);
  }
  await playerPage.screenshot({ path: join(SCREENSHOT_DIR, "00-live-session-baseline.png") });

  check(
    "live session: the player's custom rigged avatar loaded and reports a measurement",
    !!initialMeasure?.[player.id],
    JSON.stringify(initialMeasure)
  );
  check(
    `live session: the player's custom avatar reports posed=${expectPosed} as expected for this fixture`,
    initialPose?.avatars?.[player.id] === expectPosed,
    JSON.stringify(initialPose)
  );
  const baselineScale = initialMeasure?.[player.id]?.scale ?? null;
  const baselineSizeY = initialMeasure?.[player.id]?.sizeY ?? null;
  check(
    // Wide enough to fit either fixture's own real raw proportions
    // (RiggedFigure.glb ~1.17x; RiggedSimple.glb's own raw box is
    // genuinely ~9.15 tall, so its correct scale is ~0.19x — both entirely
    // legitimate, deterministic consequences of AVATAR_HEIGHT/size.y for
    // two DIFFERENT real raw meshes, not a bug) while still catching the
    // reported "huge" order-of-magnitude mis-scale, which would blow well
    // past this on either side.
    "live session: measured scale is sane (not a wild order-of-magnitude mis-scale)",
    typeof baselineScale === "number" && baselineScale > 0.05 && baselineScale < 5,
    JSON.stringify({ baselineScale, baselineSizeY })
  );

  const initialSeatLayout = await seatLayoutState(playerPage);
  const initialSeat = initialSeatLayout?.seats?.find((s) => s.userId === player.id);
  check(
    "live session: the player's seat is away from the world origin (not 'centered')",
    !!initialSeat && Math.hypot(initialSeat.position[0], initialSeat.position[2]) > 0.5,
    JSON.stringify(initialSeat)
  );
  note("baseline", JSON.stringify({ baselineScale, baselineSizeY, initialSeat }));

  // -- 2b. A second, ALREADY-CONNECTED client (the DM) watching the SAME
  //    seat — the original report's own framing ("the DM's avatar
  //    teleports") was about what OTHER clients see, not just the
  //    reloading client's own view. A peer's reload broadcasts nothing
  //    avatar-related on its own (no channel event fires just because one
  //    tab refreshed) — this checks that assumption for real: the DM's own
  //    already-resolved measurement of the player's avatar must stay
  //    completely inert while the player repeatedly reloads. --
  const dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="avatar-measure-state"]', { state: "attached", timeout: 30000 });
  const deadlineDm = Date.now() + 20000;
  let dmViewOfPlayer = null;
  while (Date.now() < deadlineDm) {
    dmViewOfPlayer = await measureState(dmPage);
    if (dmViewOfPlayer?.[player.id]) break;
    await sleep(200);
  }
  check(
    "a second, already-connected DM client also sees the player's custom avatar load correctly",
    !!dmViewOfPlayer?.[player.id] &&
      Math.abs(dmViewOfPlayer[player.id].scale - baselineScale) / baselineScale < 0.1,
    JSON.stringify({ dmView: dmViewOfPlayer?.[player.id], baselineScale })
  );
  // The DM's own seated camera looks ACROSS the table at the player's own
  // seat — unlike the player's own first-person view (which never shows
  // their own body), this is the one camera in this whole test that can
  // ever visually show the player's avatar externally at all, so it's the
  // one screenshot worth taking for a real "does it look huge/centered"
  // visual sanity check, not just the numeric measurement mirror.
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "00b-dm-view-of-player-baseline.png") });

  // -- 3. The precise repro: several REAL page.reload() cycles of this same
  //    now-warm client, watching the transition each time. `waitUntil:
  //    "commit"` returns as soon as the reload actually starts (rather than
  //    waiting for the load event), so the polling loop below can observe
  //    the scene from as close to the very start of the remount as
  //    possible — the "blink to the default/placeholder avatar" window the
  //    report describes, if it's real. --
  const RELOAD_CYCLES = process.env.RELOAD_CYCLES ? Number(process.env.RELOAD_CYCLES) : 10;
  const results = [];
  for (let cycle = 1; cycle <= RELOAD_CYCLES; cycle++) {
    console.log(`\n--- reload cycle ${cycle}/${RELOAD_CYCLES} ---`);
    currentPhase = `reload-${cycle}`;
    await playerPage.reload({ waitUntil: "commit" });
    await playerPage.waitForSelector('[data-testid="avatar-measure-state"]', { state: "attached", timeout: 30000 });

    const detailed = cycle === 1; // full screenshot trail only on the first, slow pass
    const transitions = detailed
      ? await watchReloadTransition(playerPage, player.id, `cycle${cycle}`)
      : await (async () => {
          const deadline = Date.now() + 15000;
          let seenPlaceholder = false;
          while (Date.now() < deadline) {
            const measure = await measureState(playerPage);
            if (!measure?.[player.id]) {
              seenPlaceholder = true;
            } else {
              return [{ seenPlaceholder, measurement: measure[player.id] }];
            }
            await sleep(60);
          }
          return [{ seenPlaceholder, measurement: null, timedOut: true }];
        })();

    await playerPage.waitForTimeout(500); // let one more animation frame settle
    const finalMeasure = await measureState(playerPage);
    const finalPose = await poseState(playerPage);
    const finalSeatLayout = await seatLayoutState(playerPage);
    const finalSeat = finalSeatLayout?.seats?.find((s) => s.userId === player.id);
    const finalScale = finalMeasure?.[player.id]?.scale ?? null;
    const finalSizeY = finalMeasure?.[player.id]?.sizeY ?? null;

    console.log(`  transitions: ${JSON.stringify(transitions)}`);
    console.log(`  final: scale=${finalScale} sizeY=${finalSizeY} seat=${JSON.stringify(finalSeat)}`);

    results.push({ cycle, transitions, finalScale, finalSizeY, finalSeat, finalPose: finalPose?.avatars?.[player.id] ?? null });

    check(
      `reload ${cycle}: final avatar measurement resolved at all`,
      finalMeasure?.[player.id] !== undefined,
      JSON.stringify(finalMeasure)
    );
    check(
      `reload ${cycle}: final scale matches the live-session baseline (within 10%) — no post-reload mis-scale`,
      typeof finalScale === "number" && baselineScale !== null && Math.abs(finalScale - baselineScale) / baselineScale < 0.1,
      JSON.stringify({ baselineScale, finalScale })
    );
    check(
      `reload ${cycle}: final sizeY matches the live-session baseline (within 1%) — same GLB, same measured geometry`,
      typeof finalSizeY === "number" && baselineSizeY !== null && Math.abs(finalSizeY - baselineSizeY) / baselineSizeY < 0.01,
      JSON.stringify({ baselineSizeY, finalSizeY })
    );
    check(
      `reload ${cycle}: final seat position matches the pre-reload seat (still not centered at the world origin)`,
      !!finalSeat &&
        !!initialSeat &&
        Math.hypot(finalSeat.position[0] - initialSeat.position[0], finalSeat.position[2] - initialSeat.position[2]) < 0.05,
      JSON.stringify({ initialSeat, finalSeat })
    );
    check(
      `reload ${cycle}: posed=${expectPosed} still matches this fixture's expectation after reload`,
      finalPose?.avatars?.[player.id] === expectPosed,
      JSON.stringify(finalPose)
    );
    const errorsThisCycle = pageErrors.filter((e) => e.phase === `reload-${cycle}`);
    check(`reload ${cycle}: no uncaught page errors THIS cycle`, errorsThisCycle.length === 0, JSON.stringify(errorsThisCycle));

    // The DM's own already-resolved view of the player's avatar must stay
    // completely inert through a peer's reload — no channel event fires
    // just because another tab refreshed, so if the DM's own measurement
    // ever budges here, something is broadcasting/re-deriving avatar state
    // it shouldn't be.
    const dmViewNow = await measureState(dmPage);
    check(
      `reload ${cycle}: the DM's own (unrelated) view of the player's avatar is untouched by the player's reload`,
      !!dmViewNow?.[player.id] && Math.abs(dmViewNow[player.id].scale - baselineScale) / baselineScale < 0.1,
      JSON.stringify({ dmViewNow: dmViewNow?.[player.id], baselineScale })
    );
    if (cycle === 1) {
      await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "00c-dm-view-of-player-after-players-first-reload.png") });
    }
  }

  await playerPage.screenshot({ path: join(SCREENSHOT_DIR, "99-after-all-reloads.png") });

  console.log("\n=== Full per-cycle transition log (for manual inspection) ===");
  console.log(JSON.stringify(results, null, 2));
  console.log("\n=== All page errors, by phase (for manual inspection) ===");
  console.log(JSON.stringify(pageErrors, null, 2));
} finally {
  await browser.close();
  await admin.from("model_orientation").delete().eq("model_url", `${player.id}/avatar.glb`);
  await admin.storage.from("avatars").remove([`${player.id}/avatar.glb`]);
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already gone.
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll avatar-reload checks passed — no reproduction of the reported blink/mis-scale/centering sequence.");
process.exit(0);
