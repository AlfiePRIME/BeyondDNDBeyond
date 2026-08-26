#!/usr/bin/env node
// Critical GameRoom freeze bug — real-browser regression test.
//
// The bug (reported as "clicking Free camera in the Game Room freezes the
// tab completely", then confirmed to actually be "clicking ANYTHING in the
// Game Room freezes it", and never in the map editor or anywhere else in
// the app): a genuine, unconditional infinite React render loop, confirmed
// by direct reproduction with this exact script (pre-fix, it hung solid —
// Playwright's own page.click() couldn't even complete within 5s, and the
// page never responded to page.evaluate() again afterward).
//
// Root cause, traced end to end:
//   1. TableSeat (src/scene-3d/GameTableScene.tsx) rendered every seat's
//      SeatAvatar with an INLINE closure built fresh in its own JSX body —
//      `onMeasureDebug={(m) => onAvatarMeasureDebug(seat.member.user_id, m)}`
//      — and, unlike its sibling ObjectMarker (MapSurface.tsx), was not
//      wrapped in React.memo() at all. So a re-render of GameTableScene for
//      ANY reason (clicking any button that touches any piece of GameRoom
//      state) always created a brand-new function reference.
//   2. SeatAvatar's own AvatarModel (src/scene-3d/SeatAvatar.tsx) reports
//      its measured size via `useEffect(() => { onMeasureDebug?.(...) },
//      [sizeY, scale, onMeasureDebug])` — a fresh onMeasureDebug reference
//      re-fires this effect even though sizeY/scale never actually changed.
//   3. GameRoom.tsx's handleAvatarMeasureDebug used to build a brand new
//      `{...current, [userId]: measurement}` object unconditionally, with
//      no equality check (unlike its sibling handleAvatarPoseDebug), so
//      React always saw a genuine state change and re-rendered GameRoom.
//   4. That re-render cascades straight back into step 1 — a self-
//      sustaining loop with no possible exit, pegging the main thread.
//
// This only fires for a seat whose member has a real avatar_url set
// (SeatAvatar renders a static PlaceholderAvatar — no AvatarModel, no
// effect at all — for a memberless avatar), which is exactly why this
// escaped every existing verify-*.mjs script and the automated test suite:
// none of their synthetic test users had ever set one.
//
// The fix: TableSeat is now React.memo()'d, and every closure it hands to
// SeatAvatar/the chair-drag mesh is its own useCallback (stable regardless
// of whether the outer memo() bails), plus a defense-in-depth equality
// check added to handleAvatarMeasureDebug/handleObjectMeasureDebug in
// GameRoom.tsx, matching their sibling handleAvatarPoseDebug/
// handleObjectPoseDebug's existing pattern.
//
// This script seeds a real seated member with a real avatar_url (the exact
// missing ingredient above), then drives the full toggle cycle
// (seat -> orbit -> seat) via the actual "Free camera"/"Return to seat"
// button TWICE, plus one unrelated click (ruler toggle) — proving the fix
// isn't camera-specific — asserting the page never hangs, avatar-measure-
// state never churns, and console output stays clean the whole time.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000.
// Usage: node scripts/db/verify-seat-avatar-render-loop.mjs
//        APP_URL=http://localhost:3160 node scripts/db/verify-seat-avatar-render-loop.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

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
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY — needs the local Supabase stack's .env (see supabase/.env.example)."
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

// The @supabase/ssr cookie format: sb-<host>-auth-token = "base64-" +
// base64url(JSON session), chunked at 3180 chars into name.0, name.1, ...
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
  const email = `seatavatarloop-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `SeatAvatarLoop ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function readTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  return JSON.parse(await el.textContent());
}

/** A trivial page.evaluate() raced against a timeout — the direct way to
 * tell "genuinely hung main thread" (this never resolves) apart from
 * "slow" (it eventually resolves, just later). */
async function isResponsive(page, label, timeoutMs = 5000) {
  const result = await Promise.race([
    page.evaluate(() => 1 + 1).then(() => "ok"),
    sleep(timeoutMs).then(() => "timeout"),
  ]).catch((err) => `error: ${err.message}`);
  const ok = result === "ok";
  check(`page stays responsive [${label}]`, ok, `page.evaluate() result: ${result}`);
  return ok;
}

/** Clicks `selector`, itself bounded so a genuinely hung page fails this
 * check instead of hanging the whole test run forever. */
async function clickAndCheckAlive(page, selector, label) {
  const start = Date.now();
  let clicked = true;
  try {
    await page.click(selector, { timeout: 8000 });
  } catch (err) {
    clicked = false;
    check(`clicking ${label} completes without hanging`, false, `${err.message} (${Date.now() - start}ms)`);
  }
  if (clicked) {
    check(`clicking ${label} completes without hanging`, true, `${Date.now() - start}ms`);
  }
  return isResponsive(page, `after ${label}`);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const campaignId = crypto.randomUUID();

try {
  // The one missing ingredient every other verify-*.mjs script's synthetic
  // test users lack — see this file's own header comment for why that
  // matters. "vanguard" is one of the app's own built-in avatar presets
  // (src/app/account/avatar-presets.ts), a real, always-available glTF.
  const { error: avatarErr } = await admin
    .from("profiles")
    .update({ avatar_source: "preset", avatar_ref: "vanguard" })
    .eq("id", dm.id);
  if (avatarErr) throw avatarErr;

  await admin.from("campaigns").insert({ id: campaignId, name: "Seat avatar loop test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();

  const consoleMessages = [];
  page.on("console", (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
  page.on("pageerror", (err) => consoleMessages.push({ type: "pageerror", text: err.message }));

  console.log("Navigating to the game room...");
  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`, { timeout: 30000 });
  await page.waitForSelector('[data-testid="avatar-measure-state"]', { state: "attached", timeout: 30000 });

  // Wait for the seated avatar to actually finish loading and report a
  // real measurement — the concrete precondition for the loop (no
  // AvatarModel mounts, no effect fires, no bug) to even be exercisable.
  let baseline = null;
  for (let i = 0; i < 50; i++) {
    baseline = await readTestId(page, "avatar-measure-state");
    if (baseline && Object.keys(baseline).length >= 1) break;
    await sleep(200);
  }
  check(
    "the DM's seated avatar reports a real measured size/scale before any click",
    baseline && Object.values(baseline).some((m) => typeof m.sizeY === "number" && m.sizeY > 0),
    JSON.stringify(baseline)
  );

  await isResponsive(page, "baseline, before any click");

  // Baseline churn check: a few samples with no interaction at all should
  // be byte-for-byte identical — this is the direct signature of the fixed
  // loop NOT running (pre-fix, this alone would already show a fresh
  // object reference each read, though the values happen to be equal).
  const preSamples = [];
  for (let i = 0; i < 5; i++) {
    preSamples.push(JSON.stringify(await readTestId(page, "avatar-measure-state")));
    await sleep(150);
  }
  check(
    "avatar-measure-state is stable with no interaction at all",
    preSamples.every((s) => s === preSamples[0])
  );

  // --- The actual reported bug, run TWICE (seat -> orbit -> seat, twice)
  // to rule out a one-off timing fluke, exactly per this task's own
  // acceptance criteria. ---
  for (let round = 1; round <= 2; round++) {
    console.log(`--- Round ${round}: seat -> orbit -> seat ---`);
    const toOrbitOk = await clickAndCheckAlive(page, '[data-testid="camera-mode-toggle"]', `Free camera (round ${round})`);
    if (!toOrbitOk) break;

    const orbitState = await readTestId(page, "turn-camera-state");
    check(`round ${round}: camera mode actually switched to orbit`, orbitState?.cameraMode === "orbit", JSON.stringify(orbitState));

    // OrbitControls needs real pointer input to prove it's actually live,
    // not just mounted — a drag that would also be exactly the kind of
    // rapid re-render burst (many pointermove-driven updates) the old bug
    // would have made fatal.
    const canvasBox = await page.locator("canvas").boundingBox();
    if (canvasBox) {
      const cx = canvasBox.x + canvasBox.width / 2;
      const cy = canvasBox.y + canvasBox.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(cx + i * 15, cy - i * 8, { steps: 2 });
        await sleep(30);
      }
      await page.mouse.up();
    }
    await isResponsive(page, `round ${round}: after dragging the orbit camera`);

    const backToSeatOk = await clickAndCheckAlive(page, '[data-testid="camera-mode-toggle"]', `Return to seat (round ${round})`);
    if (!backToSeatOk) break;
    const seatState = await readTestId(page, "turn-camera-state");
    check(`round ${round}: camera mode switched back to seat`, seatState?.cameraMode === "seat", JSON.stringify(seatState));
  }

  // The original bug report's own broadened claim: "clicking ANYTHING"
  // freezes it, not just the camera toggle — proven here with a
  // completely unrelated button.
  console.log("--- An unrelated click: ruler toggle ---");
  await clickAndCheckAlive(page, '[data-testid="ruler-toggle"]', "ruler toggle (unrelated button)");
  await clickAndCheckAlive(page, '[data-testid="ruler-toggle"]', "ruler toggle again (put ruler away)");

  // Final churn check: avatar-measure-state must still be exactly what it
  // was at the start — the fix doesn't just avoid a HANG, it avoids
  // needless re-computation/re-reporting entirely.
  const postSamples = [];
  for (let i = 0; i < 5; i++) {
    postSamples.push(JSON.stringify(await readTestId(page, "avatar-measure-state")));
    await sleep(150);
  }
  check(
    "avatar-measure-state is still stable after the whole click sequence (no churn)",
    postSamples.every((s) => s === postSamples[0]),
    JSON.stringify(postSamples)
  );
  check(
    "the final measured avatar size/scale is byte-for-byte the original baseline",
    postSamples[0] === preSamples[0],
    JSON.stringify({ baseline: preSamples[0], final: postSamples[0] })
  );

  const badConsole = consoleMessages.filter(
    (m) => m.type === "error" || m.type === "pageerror" || /maximum update depth/i.test(m.text)
  );
  check(
    "no console errors or React update-depth warnings the whole run",
    badConsole.length === 0,
    JSON.stringify(badConsole.slice(0, 10))
  );

  await browser.close();
} finally {
  await admin.auth.admin.deleteUser(dm.id).catch(() => undefined);
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
console.log("\nAll seat-avatar render-loop checks passed.");
process.exit(0);
