#!/usr/bin/env node
// Seated look-around verification: a seated viewer can turn their camera's
// LOOK DIRECTION away from the table center using the arrow keys
// (GameTableScene.tsx's lookAroundKeysRef/lookAroundYawRef/lookAroundPitchRef
// and its own per-frame useFrame — see that file's "Seated look-around"
// block comment), auto-recentering after 30 continuous seconds of no
// input, and never moving the camera's POSITION (which stays owned by the
// seat/turn-camera/chair-drag logic — see computeTurnCameraPosition).
//
// Real end-to-end browser checks against a live app + live DB, not just a
// unit test of the pure angle math — this script proves the camera's
// reported look-around state actually changes smoothly frame over frame in
// a real running scene, actually clamps, actually ignores arrow keys typed
// into a REAL focused text input, actually stays off in orbit mode, and
// actually auto-recenters on real wall-clock timing.
//
// Checks:
//   1. Holding an arrow key rotates smoothly (multiple increasing samples,
//      never an instant jump to a final value) and stops the INSTANT the
//      key is released (two post-release samples ~300ms apart are
//      identical).
//   2. The yaw/pitch offset is clamped — holding a key far longer than
//      needed to reach the documented bound never exceeds it.
//   3. All four directions rotate the correct way (right/up increase,
//      left/down decrease).
//   4. Composing with the turn camera (the brief's own explicit judgment
//      call): with this viewer's own combat turn already active
//      (turnCameraActive), look-around still rotates the camera, and the
//      camera's POSITION (chair-drag-state's own ownCamera mirror) never
//      moves by even a millimeter while the look direction is being
//      rotated — proving this feature is pure rotation, composed on top of
//      whichever position source is currently in effect.
//   5. Arrow keys pressed while a REAL focused text `<input>` has focus do
//      NOT rotate the camera at all, and do NOT prevent the input's own
//      normal caret movement (selectionStart moves exactly as it would
//      with no listener present at all).
//   6. Switching to orbit mode resets the look-around offset to centered
//      and holding arrow keys there never moves it — orbit mode's own
//      OrbitControls already provides free look via the mouse.
//   7. Switching back to seat mode re-enables arrow-key look-around from a
//      fresh centered start.
//   8. After releasing all arrow keys, the offset holds steady for the
//      whole idle window and only begins easing back to center once
//      ~30 real seconds of no input have elapsed (not sooner).
//   9. That easing is itself gradual (multiple decreasing samples), not an
//      instant snap.
//  10. Pressing an arrow key mid-recenter immediately takes back control —
//      the offset moves further AWAY from center under the fresh key
//      press, which the passive recenter alone could never do.
//  11. Going idle again afterward fully recenters back to {yaw:0,pitch:0}
//      within a bounded time of the next 30s idle window elapsing, with no
//      user action required.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000. This script's own
// long real-time waits (the 30-second idle threshold, twice) make it
// deliberately slow (~2 minutes) — an intentional trade against a faked/
// shortened timer, since the whole point is proving the REAL threshold.
// Usage: node scripts/db/verify-look-around.mjs
//        APP_URL=http://localhost:3131 node scripts/db/verify-look-around.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3131";

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

// ---------------------------------------------------------------------------
// Real geometry/timing constants, replayed (not imported) from
// GameTableScene.tsx — this script family's own "trust nothing not directly
// observed, and replay real constants rather than trusting them by
// reference" convention (verify-turn-camera.mjs/verify-chair-drag.mjs).
// ---------------------------------------------------------------------------
const LOOK_AROUND_MAX_YAW = (65 * Math.PI) / 180;
const LOOK_AROUND_MAX_PITCH = (18 * Math.PI) / 180;
const LOOK_AROUND_IDLE_MS = 30_000;

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
  const email = `lookaround-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `LookAround ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

/** GameTableScene's own look-around debug mirror (GameRoom.tsx's
 * look-around-state div) — {yaw, pitch} in radians. */
async function lookAroundState(page) {
  const text = await page.textContent('[data-testid="look-around-state"]');
  return JSON.parse(text);
}

/** GameRoom's own hidden mirror of this client's own seated camera position
 * (movable-chair drag feature, reused unmodified here to prove position
 * never moves while the look direction rotates). */
async function chairDragState(page) {
  const text = await page.textContent('[data-testid="chair-drag-state"]');
  return JSON.parse(text);
}

async function turnCameraState(page) {
  const text = await page.textContent('[data-testid="turn-camera-state"]');
  return JSON.parse(text);
}

function magnitude(state) {
  return Math.hypot(state.yaw, state.pitch);
}

function closeVec(a, b, tol = 0.01) {
  return a && b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;
}

async function waitFor(fn, predicate, timeoutMs = 15000, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await sleep(pollMs);
  }
  return last;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");

const browser = await chromium.launch({
  args: [
    ...GPU_LAUNCH_ARGS,
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
  ],
});

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Look-around test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice PC",
    race: "Human",
    class: "Fighter",
    level: 3,
    strength: 16,
    dexterity: 14,
    constitution: 13,
    intelligence: 10,
    wisdom: 12,
    charisma: 8,
    current_hp: 30,
    max_hp: 30,
    armor_class: 15,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  // A bare map purely to satisfy map_tokens' FK.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Look-around arena",
    grid_width: 20,
    grid_height: 20,
  });
  const aliceTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: aliceTokenId,
    map_id: mapId,
    character_id: aliceCharacterId,
    x: 1,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });

  // Combat seeded directly with ALICE'S OWN combatant as the only (and
  // therefore already-current, current_turn_index defaults to 0) entry —
  // deliberately seeded BEFORE her page ever loads, so her very first
  // refreshCombat/fetch-on-mount already sees an active combat with her
  // own turn current, and turnCameraActive is true from the moment the
  // scene renders — no live DM action needed to prove the composition
  // check (#4 in the header comment above).
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  await admin.from("combat_combatants").insert([
    { encounter_id: encounterId, token_id: aliceTokenId, character_id: aliceCharacterId, initiative: 20 },
  ]);

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="look-around-state"]', { state: "attached", timeout: 30000 });
  await alicePage.waitForSelector('[data-testid="turn-camera-state"]', { state: "attached", timeout: 30000 });

  // ---------------------------------------------------------------------
  // Baseline: turn camera already active (the composition precondition),
  // look-around centered.
  // ---------------------------------------------------------------------
  const turnState0 = await waitFor(() => turnCameraState(alicePage), (s) => s.isMyTurn, 15000);
  check(
    "alice's own turn is active from the moment her page loads (combat seeded before load)",
    turnState0?.isMyTurn === true && turnState0?.active === true,
    JSON.stringify(turnState0)
  );

  const look0 = await lookAroundState(alicePage);
  check("look-around starts centered", look0.yaw === 0 && look0.pitch === 0, JSON.stringify(look0));

  const camElevated = (await waitFor(() => chairDragState(alicePage), (s) => Array.isArray(s.ownCamera), 15000))
    .ownCamera;
  check("alice reports a real (turn-camera-elevated) camera position", Array.isArray(camElevated));

  // ---------------------------------------------------------------------
  // 1 & 3 & 4. Smooth, continuous yaw rotation (ArrowRight), position
  // unchanged throughout (proving composition with the active turn
  // camera), stopping the instant the key releases.
  // ---------------------------------------------------------------------
  await alicePage.keyboard.down("ArrowRight");
  await sleep(150);
  const yawSample1 = await lookAroundState(alicePage);
  await sleep(300);
  const yawSample2 = await lookAroundState(alicePage);
  const camMidRotate = (await chairDragState(alicePage)).ownCamera;
  check(
    "holding ArrowRight rotates yaw smoothly (progressively, not an instant jump)",
    yawSample1.yaw > 0.01 && yawSample2.yaw > yawSample1.yaw,
    JSON.stringify({ yawSample1, yawSample2 })
  );
  check(
    "the camera's POSITION never moves while the look direction rotates, even with the turn camera active",
    closeVec(camMidRotate, camElevated, 0.002),
    JSON.stringify({ camMidRotate, camElevated })
  );
  await sleep(1200); // long enough to reach the documented clamp from here (65°/1.4rad/s ≈ 0.8s of travel)
  const yawClamped = await lookAroundState(alicePage);
  check(
    "yaw clamps at (and never exceeds) the documented max range",
    yawClamped.yaw <= LOOK_AROUND_MAX_YAW + 1e-6 && yawClamped.yaw >= LOOK_AROUND_MAX_YAW - 0.05,
    JSON.stringify({ yawClamped, LOOK_AROUND_MAX_YAW })
  );
  await alicePage.keyboard.up("ArrowRight");
  const afterReleaseA = await lookAroundState(alicePage);
  await sleep(300);
  const afterReleaseB = await lookAroundState(alicePage);
  check(
    "rotation stops the instant the key is released (no drift/momentum afterward)",
    Math.abs(afterReleaseA.yaw - afterReleaseB.yaw) < 0.005,
    JSON.stringify({ afterReleaseA, afterReleaseB })
  );
  const camAfterRelease = (await chairDragState(alicePage)).ownCamera;
  check(
    "the camera position is still exactly the turn-camera-elevated position after the whole rotation",
    closeVec(camAfterRelease, camElevated, 0.002),
    JSON.stringify({ camAfterRelease, camElevated })
  );

  // ---------------------------------------------------------------------
  // 2 & 3. Pitch: smooth + clamps too (ArrowUp), then direction checks for
  // the other two keys (ArrowLeft swings yaw negative, ArrowDown swings
  // pitch negative), each verified to clamp at the corresponding bound.
  // ---------------------------------------------------------------------
  await alicePage.keyboard.down("ArrowUp");
  await sleep(150);
  const pitchSample1 = await lookAroundState(alicePage);
  await sleep(1200); // 18°/0.9rad/s ≈ 0.35s of travel — plenty of margin to hit the clamp
  const pitchClamped = await lookAroundState(alicePage);
  await alicePage.keyboard.up("ArrowUp");
  check(
    "holding ArrowUp increases pitch smoothly then clamps at the documented max",
    pitchSample1.pitch > 0.01 &&
      pitchClamped.pitch <= LOOK_AROUND_MAX_PITCH + 1e-6 &&
      pitchClamped.pitch >= LOOK_AROUND_MAX_PITCH - 0.02,
    JSON.stringify({ pitchSample1, pitchClamped, LOOK_AROUND_MAX_PITCH })
  );

  await alicePage.keyboard.down("ArrowLeft");
  await sleep(2000); // from +MAX_YAW to -MAX_YAW is ~2×MAX_YAW of travel at 1.4rad/s ≈ 1.6s
  const yawNegClamped = await lookAroundState(alicePage);
  await alicePage.keyboard.up("ArrowLeft");
  check(
    "ArrowLeft rotates yaw the opposite direction and clamps at the documented negative bound",
    yawNegClamped.yaw <= -LOOK_AROUND_MAX_YAW + 0.05 && yawNegClamped.yaw >= -LOOK_AROUND_MAX_YAW - 1e-6,
    JSON.stringify({ yawNegClamped, LOOK_AROUND_MAX_YAW })
  );

  await alicePage.keyboard.down("ArrowDown");
  await sleep(1500); // from +MAX_PITCH to -MAX_PITCH is ~2×MAX_PITCH of travel at 0.9rad/s ≈ 0.7s
  const pitchNegClamped = await lookAroundState(alicePage);
  await alicePage.keyboard.up("ArrowDown");
  check(
    "ArrowDown rotates pitch the opposite direction and clamps at the documented negative bound",
    pitchNegClamped.pitch <= -LOOK_AROUND_MAX_PITCH + 0.02 && pitchNegClamped.pitch >= -LOOK_AROUND_MAX_PITCH - 1e-6,
    JSON.stringify({ pitchNegClamped, LOOK_AROUND_MAX_PITCH })
  );

  // ---------------------------------------------------------------------
  // 5. The concrete bug the brief calls out: a REAL focused text input
  // must swallow the arrow keys for its own normal caret movement, and the
  // camera must not react at all. A plain <input> appended straight to the
  // live page and given real DOM focus is indistinguishable, from the
  // guard's own point of view (it checks the real KeyboardEvent's
  // event.target via `.closest("input, textarea, select, [contenteditable]")`
  // — GameTableScene.tsx's isTypingTarget), from the DM's notes or any
  // other real text field elsewhere on the page.
  // ---------------------------------------------------------------------
  const stateBeforeTyping = await lookAroundState(alicePage);
  await alicePage.evaluate(() => {
    const el = document.createElement("input");
    el.type = "text";
    el.value = "hello world";
    el.setAttribute("data-testid", "look-around-guard-probe");
    document.body.appendChild(el);
    el.focus();
    el.setSelectionRange(5, 5); // caret right after "hello"
  });
  const probe = alicePage.locator('[data-testid="look-around-guard-probe"]');
  const focused = await probe.evaluate((el) => document.activeElement === el);
  check("the injected probe input genuinely holds real DOM focus", focused);

  await alicePage.keyboard.press("ArrowLeft");
  await alicePage.keyboard.press("ArrowLeft");
  await alicePage.keyboard.press("ArrowLeft");
  const caretAfterLeft = await probe.evaluate((el) => el.selectionStart);
  await alicePage.keyboard.press("ArrowRight");
  const caretAfterRight = await probe.evaluate((el) => el.selectionStart);
  const valueAfter = await probe.evaluate((el) => el.value);
  const stateWhileTyping = await lookAroundState(alicePage);

  check(
    "3x ArrowLeft in the focused input moves its caret left exactly as normal (not hijacked)",
    caretAfterLeft === 2,
    `caretAfterLeft=${caretAfterLeft}`
  );
  check(
    "ArrowRight in the focused input moves its caret back right exactly as normal",
    caretAfterRight === 3,
    `caretAfterRight=${caretAfterRight}`
  );
  check("the focused input's own value is completely untouched", valueAfter === "hello world", valueAfter);
  check(
    "none of those arrow presses rotated the camera at all while the text input had focus",
    stateWhileTyping.yaw === stateBeforeTyping.yaw && stateWhileTyping.pitch === stateBeforeTyping.pitch,
    JSON.stringify({ stateBeforeTyping, stateWhileTyping })
  );

  await alicePage.evaluate(() => {
    const el = document.querySelector('[data-testid="look-around-guard-probe"]');
    el?.blur();
    el?.remove();
  });
  await alicePage.click("body");

  // ---------------------------------------------------------------------
  // 6 & 7. Orbit mode never responds to arrow keys, and resets to
  // centered on entry; seat mode picks back up fresh on return.
  // ---------------------------------------------------------------------
  await alicePage.click('[data-testid="camera-mode-toggle"]'); // seat -> orbit
  const orbitState = await waitFor(() => turnCameraState(alicePage), (s) => s.cameraMode === "orbit", 10000);
  check("camera mode actually switched to orbit", orbitState?.cameraMode === "orbit", JSON.stringify(orbitState));
  const lookInOrbitStart = await waitFor(
    () => lookAroundState(alicePage),
    (s) => s.yaw === 0 && s.pitch === 0,
    5000
  );
  check(
    "entering orbit mode resets the look-around offset to centered",
    lookInOrbitStart?.yaw === 0 && lookInOrbitStart?.pitch === 0,
    JSON.stringify(lookInOrbitStart)
  );

  await alicePage.keyboard.down("ArrowRight");
  await alicePage.keyboard.down("ArrowUp");
  await sleep(1000);
  const lookDuringOrbitHold = await lookAroundState(alicePage);
  await alicePage.keyboard.up("ArrowRight");
  await alicePage.keyboard.up("ArrowUp");
  check(
    "holding arrow keys in orbit mode never rotates the look-around offset at all",
    lookDuringOrbitHold.yaw === 0 && lookDuringOrbitHold.pitch === 0,
    JSON.stringify(lookDuringOrbitHold)
  );

  await alicePage.click('[data-testid="camera-mode-toggle"]'); // orbit -> seat
  const seatAgain = await waitFor(() => turnCameraState(alicePage), (s) => s.cameraMode === "seat", 10000);
  check("camera mode switched back to seat", seatAgain?.cameraMode === "seat", JSON.stringify(seatAgain));
  const lookBackInSeat = await lookAroundState(alicePage);
  check(
    "re-entering seat mode starts fresh at centered, not some stale offset",
    lookBackInSeat.yaw === 0 && lookBackInSeat.pitch === 0,
    JSON.stringify(lookBackInSeat)
  );

  await alicePage.keyboard.down("ArrowRight");
  await sleep(500);
  const lookReenabled = await lookAroundState(alicePage);
  await alicePage.keyboard.up("ArrowRight");
  check(
    "arrow keys rotate the camera again once back in seat mode",
    lookReenabled.yaw > 0.05,
    JSON.stringify(lookReenabled)
  );

  // ---------------------------------------------------------------------
  // 8, 9 & 10. Auto-recenter: holds steady for the whole idle window,
  // only starts easing back (gradually, not an instant snap) once ~30
  // real seconds of no input have elapsed, and a fresh key press
  // immediately takes back control mid-recenter.
  // ---------------------------------------------------------------------
  // Build a clear, well-away-from-zero baseline to recenter FROM (also
  // exercises ArrowDown for one more direction check along the way).
  await alicePage.keyboard.down("ArrowLeft");
  await alicePage.keyboard.down("ArrowDown");
  await sleep(700);
  await alicePage.keyboard.up("ArrowLeft");
  await alicePage.keyboard.up("ArrowDown");
  const recenterBaseline = await lookAroundState(alicePage);
  const baselineMag = magnitude(recenterBaseline);
  check(
    "a fresh non-zero baseline is established before the idle-timeout test",
    baselineMag > 0.2,
    JSON.stringify(recenterBaseline)
  );

  const idleStart = Date.now();
  let recenterStartedAtMs = null;
  let prematureDrift = null;
  const IDLE_TOLERANCE_MS = 3000;
  while (Date.now() - idleStart < 40000) {
    const elapsed = Date.now() - idleStart;
    const state = await lookAroundState(alicePage);
    const mag = magnitude(state);
    if (elapsed < LOOK_AROUND_IDLE_MS - IDLE_TOLERANCE_MS) {
      if (Math.abs(mag - baselineMag) > 0.02) {
        prematureDrift = { elapsed, state, baselineMag };
        break;
      }
    } else if (mag < baselineMag - 0.03) {
      recenterStartedAtMs = elapsed;
      break;
    }
    await sleep(elapsed < LOOK_AROUND_IDLE_MS - IDLE_TOLERANCE_MS ? 2000 : 300);
  }
  check("the look-around offset never drifts before the idle threshold elapses", prematureDrift === null, JSON.stringify(prematureDrift));
  check(
    `auto-recenter begins close to the documented ${LOOK_AROUND_IDLE_MS}ms idle threshold, not sooner and not much later`,
    recenterStartedAtMs !== null && Math.abs(recenterStartedAtMs - LOOK_AROUND_IDLE_MS) <= IDLE_TOLERANCE_MS + 500,
    `recenterStartedAtMs=${recenterStartedAtMs}`
  );

  const recenterSample1 = await lookAroundState(alicePage);
  await sleep(500);
  const recenterSample2 = await lookAroundState(alicePage);
  check(
    "the recenter itself eases gradually — multiple decreasing samples, not an instant snap to zero",
    magnitude(recenterSample2) < magnitude(recenterSample1) && magnitude(recenterSample2) > 0.02,
    JSON.stringify({ recenterSample1, recenterSample2 })
  );

  // Mid-recenter override: yaw is currently negative and INCREASING back
  // toward zero under the passive recenter — pressing ArrowLeft pushes it
  // MORE negative, the opposite direction from where the recenter alone
  // was taking it, so any observed decrease is unambiguously the key
  // press taking back control, not the recenter continuing on its own.
  await alicePage.keyboard.down("ArrowLeft");
  await sleep(500);
  const duringOverride = await lookAroundState(alicePage);
  await alicePage.keyboard.up("ArrowLeft");
  check(
    "pressing an arrow key mid-recenter immediately takes back control from the auto-recenter",
    duringOverride.yaw < recenterSample2.yaw - 0.05,
    JSON.stringify({ recenterSample2, duringOverride })
  );

  // Going idle again afterward fully recenters all the way back to
  // {yaw:0, pitch:0} — the plain, no-user-action-required acceptance
  // criterion — once the (fresh, restarted-by-that-last-press) 30s idle
  // window elapses.
  await sleep(LOOK_AROUND_IDLE_MS + 1000);
  const fullyRecentered = await waitFor(
    () => lookAroundState(alicePage),
    (s) => magnitude(s) < 0.02,
    12000,
    400
  );
  check(
    "the camera fully returns to looking at the table center on its own, with no user action required",
    fullyRecentered !== null && magnitude(fullyRecentered) < 0.02,
    JSON.stringify(fullyRecentered)
  );
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
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
console.log("\nAll look-around checks passed.");
process.exit(0);
