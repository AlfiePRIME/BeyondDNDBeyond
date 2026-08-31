#!/usr/bin/env node
// Investigation: "Whilst playing my custom seat model glitched out and went
// massive like I said and now [n]o one could see the map. It takes a while
// for this to happen, about 20 minutes." — the FIFTH investigation pass into
// this bug family. Prior passes (see git log):
//   e1922e9 — 150+ join/reload cycles across 4 timing modes, no repro; fixed
//             an unrelated SSR hydration bug in seating.ts, added the
//             avatar-measure-state debug mirror this script reuses.
//   a3d1e92 — a precise custom-model + real page.reload() repro attempt
//             (verify-avatar-reload.mjs), no repro.
//   7a5c082/db6f5b3 — fixed a REAL unrelated bug (unmemoized TableSeat ->
//             infinite render loop -> full freeze), structurally ruled out
//             as this bug's cause (it only ever touched debug-mirror state,
//             never AvatarModel's actual [scene, resolvedPose]-keyed scale
//             memo).
//   7ea72fe/87eb3fa — tested the freeze-fix interaction + 3-avatar
//             concurrency (verify-avatar-reload-multi.mjs), no repro.
//
// Every prior pass tested join/reload/concurrency cycles lasting minutes at
// most. NONE tested a single client sitting connected, without ever
// reloading, for the ~20 continuous real minutes the report describes. This
// script closes exactly that gap:
//   - joins the real Game Room ONCE (a single page.goto per client) and
//     never calls page.reload() or navigates away, for the whole session;
//   - polls SeatAvatar's own onMeasureDebug mirror (avatar-measure-state)
//     and seat-layout-state at regular WALL-CLOCK intervals for the entire
//     session — looking for the moment (if any) drift begins, not just a
//     before/after diff;
//   - polls from BOTH the player's own client and an independently-connected
//     DM client watching the same seat, since the report ("no one could see
//     the map") implies something visible to every connected client, not
//     just the one avatar's owner;
//   - deliberately exercises, repeatedly, over the WHOLE session, the two
//     realtime subscriptions most plausibly wired to repeated avatar-
//     adjacent state churn on a long-lived connection: the live avatar/
//     profile sync feed (GameRoom.tsx's subscribeToProfileChanges ->
//     resolveAvatarUrl -> setRoster, which re-signs and re-applies a FRESH
//     avatar_url string on every fire — a real "does re-resolving the exact
//     same custom avatar over and over ever return a different scale"
//     stress test) and the campaign day/night feed (subscribeToCampaignChanges)
//     — by writing directly to profiles/campaigns via the admin client every
//     POKE_INTERVAL_MS, the same "another tab/device changed a setting" or
//     "the DM flipped day/night mid-session" shape a real 20+ minute session
//     would actually produce.
//
// Default duration is short (DEFAULT_DURATION_MINUTES) so this script doesn't
// become an unusable tax on routine quality-gate runs. Set DURATION_MINUTES
// to a real value to run the actual investigation this bug report needs:
//   DURATION_MINUTES=30 node scripts/db/verify-avatar-long-session.mjs
//
// Needs the shared Supabase stack configured in .env (this repo doesn't run
// a per-worktree local stack). Starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: node scripts/db/verify-avatar-long-session.mjs
//        APP_URL=http://localhost:3100 DURATION_MINUTES=30 node scripts/db/verify-avatar-long-session.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3100";
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
const SCREENSHOT_DIR = join(SCRATCH_DIR, "avatar-long-session-screenshots");
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
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.");
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

function msToClock(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

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

// The @supabase/ssr cookie format — see verify-day-night-mode.mjs's identical helper.
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
  const email = `avatar-long-session-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `LongSession ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// Reads GameRoom's hidden avatar-measure-state mirror (SeatAvatar.tsx's
// onMeasureDebug, added by the very first investigation pass). Keyed by
// user_id; a key absent entirely means that member's avatar hasn't finished
// loading (i.e. is showing SeatAvatar's Suspense-fallback placeholder) —
// EXPECTED and momentary right after a poke re-signs that member's
// avatar_url (see the poke loop below), not itself a bug.
async function measureState(page) {
  const el = await page.$('[data-testid="avatar-measure-state"]');
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

function seatPositionFor(layout, userId) {
  const seat = layout?.seats?.find((s) => s.userId === userId);
  return seat ? seat.position : null;
}

function dist3(a, b) {
  if (!a || !b) return null;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

await ensureDevServer();

// RiggedFigure.glb: this repo's own committed real rigged test fixture — the
// report says "my custom seat model" (not a preset), so this exercises the
// exact same skeleton-posing + measured-scale pipeline a real custom upload
// does, same fixture verify-avatar-reload.mjs already validated.
const riggedGlb = join(rootDir, "public", "test-fixtures", "RiggedFigure.glb");

const DEFAULT_DURATION_MINUTES = 3;
const DURATION_MINUTES = process.env.DURATION_MINUTES ? Number(process.env.DURATION_MINUTES) : DEFAULT_DURATION_MINUTES;
const DURATION_MS = DURATION_MINUTES * 60_000;
if (DURATION_MINUTES < 25) {
  note(
    "short-mode",
    `DURATION_MINUTES=${DURATION_MINUTES} — this is the fast quality-gate default, NOT a real reproduction attempt. ` +
      `The reported bug takes "about 20 minutes" — run with DURATION_MINUTES=30 (or more) for a genuine investigation.`
  );
}
// 30-60s polling for a real long run (the brief's own requirement); scales
// down for the short default so it still gets several samples.
const POLL_INTERVAL_MS = process.env.POLL_INTERVAL_MS
  ? Number(process.env.POLL_INTERVAL_MS)
  : DURATION_MS >= 20 * 60_000
    ? 45_000
    : Math.max(10_000, Math.floor(DURATION_MS / 12));
// How often to poke profiles/campaigns to exercise the live avatar-sync and
// campaign-changes realtime subscriptions repeatedly over the session.
const POKE_INTERVAL_MS = process.env.POKE_INTERVAL_MS ? Number(process.env.POKE_INTERVAL_MS) : Math.max(30_000, POLL_INTERVAL_MS * 2);
const SCREENSHOT_INTERVAL_MS = Math.max(60_000, Math.floor(DURATION_MS / 6));

note(
  "config",
  `duration=${DURATION_MINUTES}min pollEvery=${msToClock(POLL_INTERVAL_MS)} pokeEvery=${msToClock(POKE_INTERVAL_MS)} screenshotEvery=${msToClock(SCREENSHOT_INTERVAL_MS)}`
);

const campaignId = crypto.randomUUID();
const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const NAME_LABEL_COLOR_A = "#ede0ff";
const NAME_LABEL_COLOR_B = "#ffd8a8";

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Avatar long-session test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  const playerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await playerContext.addCookies(sessionCookies(player.session));
  const playerPage = await playerContext.newPage();
  const dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();

  // Phase-labeled page errors (as verify-avatar-reload.mjs does) so a stale
  // one-time error from setup can't be mistaken for a fresh one recurring
  // during the long polling window.
  const pageErrors = [];
  let currentPhase = "startup";
  playerPage.on("pageerror", (err) => pageErrors.push({ who: "player", phase: currentPhase, t: Date.now(), err: String(err) }));
  dmPage.on("pageerror", (err) => pageErrors.push({ who: "dm", phase: currentPhase, t: Date.now(), err: String(err) }));

  // -- 1. Upload the rigged model as the PLAYER's own custom avatar via the
  //    real account UI, exactly as verify-avatar-reload.mjs does. --
  currentPhase = "account-upload";
  await playerPage.goto(`${APP_URL}/account`);
  await playerPage.getByLabel("Upload a custom avatar model").setInputFiles(riggedGlb);
  await playerPage.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  await playerPage.click('[data-testid="orientation-confirm"]');
  await playerPage.getByText("Avatar saved.").waitFor({ timeout: 15000 });

  const { data: profileRow } = await admin.from("profiles").select("avatar_source, avatar_ref").eq("id", player.id).maybeSingle();
  check(
    "the player's profile now points at a custom avatar",
    profileRow?.avatar_source === "custom" && !!profileRow?.avatar_ref,
    JSON.stringify(profileRow)
  );

  // -- 2. BOTH clients join the real Game Room — ONCE each. Neither ever
  //    reloads or navigates away again for the rest of this script: the one
  //    genuinely untested variable this investigation targets. --
  currentPhase = "initial-room-load";
  await playerPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await playerPage.waitForSelector('[data-testid="avatar-measure-state"]', { state: "attached", timeout: 30000 });
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="avatar-measure-state"]', { state: "attached", timeout: 30000 });

  const deadlineInitial = Date.now() + 20000;
  let initialMeasure = null;
  let initialSeatLayout = null;
  while (Date.now() < deadlineInitial) {
    initialMeasure = await measureState(playerPage);
    initialSeatLayout = await seatLayoutState(playerPage);
    if (initialMeasure?.[player.id] && seatPositionFor(initialSeatLayout, player.id)) break;
    await sleep(200);
  }
  await playerPage.screenshot({ path: join(SCREENSHOT_DIR, "00-player-baseline.png") });
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "00-dm-baseline.png") });

  const baselineScale = initialMeasure?.[player.id]?.scale ?? null;
  const baselineSizeY = initialMeasure?.[player.id]?.sizeY ?? null;
  const baselineSeatPosition = seatPositionFor(initialSeatLayout, player.id);

  check(
    "baseline: the player's custom rigged avatar loaded and reports a measurement",
    !!initialMeasure?.[player.id],
    JSON.stringify(initialMeasure)
  );
  check(
    "baseline: measured scale is sane (not already a wild mis-scale)",
    typeof baselineScale === "number" && baselineScale > 0.05 && baselineScale < 5,
    JSON.stringify({ baselineScale, baselineSizeY })
  );
  check("baseline: seat position is away from the world origin", !!baselineSeatPosition && Math.hypot(baselineSeatPosition[0], baselineSeatPosition[2]) > 0.5, JSON.stringify(baselineSeatPosition));

  // Polled like the player's own baseline above, not a single unpolled
  // read — the DM's client loads the player's avatar model independently
  // (its own separate GLTF fetch/parse), so reading it at the exact instant
  // the player's own poll loop happens to exit is a real startup race, not
  // a signal about this feature's own drift-over-time behavior under test.
  const deadlineDmInitial = Date.now() + 20000;
  let dmInitialMeasureOfPlayer = null;
  while (Date.now() < deadlineDmInitial) {
    dmInitialMeasureOfPlayer = await measureState(dmPage);
    if (dmInitialMeasureOfPlayer?.[player.id]) break;
    await sleep(200);
  }
  check(
    "baseline: the already-connected DM client also sees the player's avatar at the same scale",
    !!dmInitialMeasureOfPlayer?.[player.id] && Math.abs(dmInitialMeasureOfPlayer[player.id].scale - baselineScale) / baselineScale < 0.01,
    JSON.stringify({ dmView: dmInitialMeasureOfPlayer?.[player.id], baselineScale })
  );

  note("baseline", JSON.stringify({ baselineScale, baselineSizeY, baselineSeatPosition }));

  // -- 3. The long, unbroken polling window. Neither client reloads or
  //    navigates for the rest of the script — this loop just watches wall
  //    clock time pass on an already-live session, exactly as a real 20+
  //    minute game session would, while periodically poking
  //    profiles/campaigns to exercise the realtime subscriptions the brief
  //    flagged as the most plausible "fires repeatedly over a long
  //    connection" mechanism. --
  currentPhase = "long-session";
  const startedAt = Date.now();
  const deadline = startedAt + DURATION_MS;
  let nextPollAt = startedAt + POLL_INTERVAL_MS;
  let nextPokeAt = startedAt + POKE_INTERVAL_MS;
  let nextScreenshotAt = startedAt + SCREENSHOT_INTERVAL_MS;
  let pokeToggle = false;
  let pokeCount = 0;
  const samples = [];
  let maxScaleDriftPct = 0;
  let maxSeatDrift = 0;
  let anyUnexpectedNullAfterSettling = false;

  console.log(`\n--- entering the long unbroken session: ${DURATION_MINUTES} real minute(s), no reloads ---\n`);

  while (Date.now() < deadline) {
    await sleep(1000);
    const now = Date.now();

    if (now >= nextPokeAt && now < deadline) {
      pokeToggle = !pokeToggle;
      pokeCount++;
      currentPhase = `poke-${pokeCount}`;
      // Exercises GameRoom's live avatar/profile sync feed
      // (subscribeToProfileChanges -> resolveAvatarUrl -> setRoster): every
      // fire re-signs a FRESH avatar_url for the SAME custom model, and
      // re-derives default_pawn_color/name_label_color — the "another
      // tab/device changed a setting" shape a real long session sees. Also
      // toggles the campaign's day_night_mode to exercise
      // subscribeToCampaignChanges repeatedly (the "DM flipped lighting
      // mid-session" shape), a second, independent long-lived subscription.
      await admin.from("profiles").update({ name_label_color: pokeToggle ? NAME_LABEL_COLOR_B : NAME_LABEL_COLOR_A }).eq("id", player.id);
      await admin.from("campaigns").update({ day_night_mode: pokeToggle ? "night" : "day" }).eq("id", campaignId);
      note(
        "poke",
        `t=${msToClock(now - startedAt)} poke #${pokeCount}: re-signed profile (name_label_color) + toggled campaign day_night_mode — exercising subscribeToProfileChanges/subscribeToCampaignChanges live, mid-session`
      );
      nextPokeAt = now + POKE_INTERVAL_MS;
    }

    if (now >= nextScreenshotAt && now < deadline) {
      const tag = msToClock(now - startedAt).replace(/[^0-9a-zA-Z]/g, "");
      await playerPage.screenshot({ path: join(SCREENSHOT_DIR, `t-${tag}-player-view.png`) }).catch(() => undefined);
      await dmPage.screenshot({ path: join(SCREENSHOT_DIR, `t-${tag}-dm-view.png`) }).catch(() => undefined);
      nextScreenshotAt = now + SCREENSHOT_INTERVAL_MS;
    }

    if (now >= nextPollAt) {
      currentPhase = "long-session-poll";
      const elapsedMs = now - startedAt;
      const ownMeasure = await measureState(playerPage).catch(() => null);
      const dmMeasureOfPlayer = await measureState(dmPage).catch(() => null);
      const ownSeatLayout = await seatLayoutState(playerPage).catch(() => null);
      const dmSeatLayoutOfPlayer = await seatLayoutState(dmPage).catch(() => null);

      const ownScale = ownMeasure?.[player.id]?.scale ?? null;
      const ownSizeY = ownMeasure?.[player.id]?.sizeY ?? null;
      const dmScale = dmMeasureOfPlayer?.[player.id]?.scale ?? null;
      const dmSizeY = dmMeasureOfPlayer?.[player.id]?.sizeY ?? null;
      const ownSeatPos = seatPositionFor(ownSeatLayout, player.id);
      const dmSeatPos = seatPositionFor(dmSeatLayoutOfPlayer, player.id);

      const ownScaleDriftPct = typeof ownScale === "number" ? (Math.abs(ownScale - baselineScale) / baselineScale) * 100 : null;
      const dmScaleDriftPct = typeof dmScale === "number" ? (Math.abs(dmScale - baselineScale) / baselineScale) * 100 : null;
      const ownSeatDrift = dist3(ownSeatPos, baselineSeatPosition);
      const dmSeatDrift = dist3(dmSeatPos, baselineSeatPosition);

      if (typeof ownScaleDriftPct === "number") maxScaleDriftPct = Math.max(maxScaleDriftPct, ownScaleDriftPct);
      if (typeof dmScaleDriftPct === "number") maxScaleDriftPct = Math.max(maxScaleDriftPct, dmScaleDriftPct);
      if (typeof ownSeatDrift === "number") maxSeatDrift = Math.max(maxSeatDrift, ownSeatDrift);
      if (typeof dmSeatDrift === "number") maxSeatDrift = Math.max(maxSeatDrift, dmSeatDrift);
      // A null measurement more than 5s after the most recent poke is NOT
      // the expected transient re-suspend window — flag it.
      if ((ownScale === null || dmScale === null) && now - nextPokeAt + POKE_INTERVAL_MS > 5000) {
        anyUnexpectedNullAfterSettling = true;
      }

      const sample = {
        elapsedMs,
        elapsed: msToClock(elapsedMs),
        pokeCount,
        ownScale,
        ownSizeY,
        ownScaleDriftPct: ownScaleDriftPct === null ? null : Number(ownScaleDriftPct.toFixed(4)),
        dmScale,
        dmSizeY,
        dmScaleDriftPct: dmScaleDriftPct === null ? null : Number(dmScaleDriftPct.toFixed(4)),
        ownSeatPos,
        dmSeatPos,
        ownSeatDrift,
        dmSeatDrift,
      };
      samples.push(sample);
      console.log(
        `t=${sample.elapsed.padEnd(8)} ownScale=${ownScale ?? "null"} (drift=${sample.ownScaleDriftPct ?? "n/a"}%)  dmView=${dmScale ?? "null"} (drift=${sample.dmScaleDriftPct ?? "n/a"}%)  ownSeatDrift=${ownSeatDrift ?? "n/a"}  dmSeatDrift=${dmSeatDrift ?? "n/a"}`
      );
      nextPollAt = now + POLL_INTERVAL_MS;
    }
  }

  currentPhase = "post-session";
  console.log(`\n--- exited the long session after ${DURATION_MINUTES} real minute(s); ${samples.length} poll sample(s), ${pokeCount} poke(s) ---\n`);

  await playerPage.screenshot({ path: join(SCREENSHOT_DIR, "99-player-final.png") });
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "99-dm-final.png") });

  const finalMeasure = await measureState(playerPage);
  const finalDmMeasureOfPlayer = await measureState(dmPage);
  const finalSeatLayout = await seatLayoutState(playerPage);
  const finalSeatPos = seatPositionFor(finalSeatLayout, player.id);

  check("post-session: samples were actually collected", samples.length > 0, `${samples.length} samples`);
  check(
    "post-session: the player's own final measurement is still present (never permanently lost)",
    !!finalMeasure?.[player.id],
    JSON.stringify(finalMeasure)
  );
  check(
    "post-session: final scale still matches the session-start baseline (within 1%) — no drift over the whole session",
    typeof finalMeasure?.[player.id]?.scale === "number" && Math.abs(finalMeasure[player.id].scale - baselineScale) / baselineScale < 0.01,
    JSON.stringify({ baselineScale, finalScale: finalMeasure?.[player.id]?.scale })
  );
  check(
    "post-session: the DM's independently-connected view also still matches baseline (within 1%)",
    typeof finalDmMeasureOfPlayer?.[player.id]?.scale === "number" &&
      Math.abs(finalDmMeasureOfPlayer[player.id].scale - baselineScale) / baselineScale < 0.01,
    JSON.stringify({ baselineScale, finalDmScale: finalDmMeasureOfPlayer?.[player.id]?.scale })
  );
  check(
    "post-session: seat position never drifted from baseline (< 0.1 units) across the whole session",
    maxSeatDrift < 0.1,
    `max observed seat drift: ${maxSeatDrift}`
  );
  check(
    "post-session: the player's final seat position still matches the session-start baseline",
    dist3(finalSeatPos, baselineSeatPosition) !== null && dist3(finalSeatPos, baselineSeatPosition) < 0.1,
    JSON.stringify({ baselineSeatPosition, finalSeatPos })
  );
  check(
    "post-session: measured scale never drifted more than 1% from baseline at ANY poll during the session (not just start/end)",
    maxScaleDriftPct < 1,
    `max observed scale drift across all samples: ${maxScaleDriftPct.toFixed(4)}%`
  );
  check(
    "post-session: no measurement ever went unexpectedly missing outside a poke's own brief re-suspend window",
    !anyUnexpectedNullAfterSettling,
    "see per-sample log above"
  );

  const errorsDuringSession = pageErrors.filter((e) => e.phase === "long-session" || e.phase === "long-session-poll" || e.phase.startsWith("poke-"));
  check("post-session: no uncaught page errors from either client during the long session", errorsDuringSession.length === 0, JSON.stringify(errorsDuringSession));

  console.log("\n=== Full per-poll sample log (the moment-by-moment record this investigation exists to produce) ===");
  console.log(JSON.stringify(samples, null, 2));
  console.log("\n=== All page errors, by phase ===");
  console.log(JSON.stringify(pageErrors, null, 2));
  console.log(`\n=== Summary: max scale drift observed = ${maxScaleDriftPct.toFixed(4)}% | max seat-position drift = ${maxSeatDrift} units ===`);
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
console.log("\nAll avatar-long-session checks passed — no scale/position drift observed over the full unbroken session.");
process.exit(0);
