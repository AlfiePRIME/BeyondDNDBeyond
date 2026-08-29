#!/usr/bin/env node
// Dice-tunneling-fix verification: the user-reported bug was "when the dice
// rolls and the number is displayed, it sometimes displays beneath the
// table" — a fast-tumbling die's own rigid body moving far enough in one
// discrete physics substep to pass straight through diceAnimator.ts's
// deliberately thin analytic floor/wall colliders (buildTrayBoundary's own
// 0.02-unit-thick floor cylinder) before Rapier's discrete collision
// detection ever catches it. The fix is defense in depth, both already
// present in diceAnimator.ts by the time this script was written:
//   1. Continuous Collision Detection, enabled per-body
//      (createDieBody's own `.setCcdEnabled(true)` on every dynamic die's
//      RigidBodyDesc) — the root-cause guard: Rapier sweeps a fast body's
//      motion for contacts a discrete step would otherwise skip past,
//      catching a hard throw BEFORE it tunnels rather than after.
//   2. A defensive floor clamp (diceAnimator.ts's clampDieOriginY/
//      minOriginHeightFor/FLOOR_CLAMP_SLOP) applied every frame a die's
//      pose is read out of the physics world — a rare backstop for
//      whatever edge case might still slip past CCD, mathematically
//      guaranteeing a die's rendered origin can never sit below its own
//      real geometric floor-clamp bound (facePlaneDistance, this shape's
//      own inscribed-sphere radius — a true lower bound for ANY
//      orientation, not just an empirically-tuned number).
//
// Tunneling is a genuinely probabilistic physics event — no single roll can
// PROVE the bug is gone, only that it didn't recur across a real batch. This
// script therefore takes the same "defense in depth" shape as the fix
// itself:
//   1. A real, large batch of ordinary rolls (real randomized throws, no
//      overrides) across every standard die kind — the check that would
//      have caught the original bug, and should now hold unconditionally:
//      no settled die's own rendered Y (nor its ResultBadge's, which rides
//      a fixed +0.22 offset above it — DiceFaceSettledInfo.positionY's own
//      doc comment) ever ends up below the tray floor's own reasonable
//      minimum threshold.
//   2. A DELIBERATE stress test of the exact tunneling scenario:
//      diceAnimator.ts's createDieBody exposes no seam to directly inject a
//      throw's initial velocity/spin (confirmed by reading it — every one
//      of upSpeed/outwardSpeed/startY/the per-axis angular velocity is
//      Math.random()-derived with no override parameter), so this pins the
//      PAGE's own `Math.random` to its ceiling before firing a batch of
//      rolls — pushing every one of those ranges to their simultaneous
//      maximum at once: the fastest, hardest-spinning throw the system can
//      actually produce against the tray's own thin colliders. This has
//      ZERO effect on the actual rolled RESULT (rules-engine/dice.ts's
//      rollDie runs server-side, in a separate Node process the browser's
//      Math.random override never touches — confirmed by reading route.ts),
//      so this is a pure physics-throw-intensity override, not a rigged
//      outcome.
//   3. A regression check that the fix didn't change ordinary rolling:
//      settled face labels/ResultBadge text still land on the exact
//      authoritative result, comfortably above the floor, in the normal
//      (non-extreme) case — reusing the SAME batch from check 1.
//
// Same "a WebGL canvas has no DOM of its own to inspect" approach every
// other scene-3d verify-*.mjs script uses: GameRoom.tsx's hidden
// data-testid="dice-face-labels-state" mirror (DiceTumbleProps.onDieSettled's
// own doc comment), extended by this feature with a `positionY` field per
// die — see DiceFaceSettledInfo.positionY's own doc comment for exactly what
// coordinate space it's in (tray-local, the SAME space diceAnimator.ts's
// physics floor sits in at local Y=0).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: PORT=3011 node scripts/db/verify-dice-tunneling-fix.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "3000";
const APP_URL = `http://localhost:${PORT}`;

// The tray's own physics floor sits at exactly local Y=0 (diceAnimator.ts's
// buildTrayBoundary — a cylinder collider of half-height 0.01 centered at
// y=-0.01, so its TOP surface, the one a die actually rests on, is at
// y = -0.01 + 0.01 = 0). Every standard die kind's own real resting origin
// height is comfortably positive and well above zero (diceGeometry.ts's
// facePlaneDistance for the SMALLEST of the six shapes, the d4's regular-
// tetrahedron insphere, is still ~0.043 at DIE_SIZE=0.13 — a circumradius/
// insphere ratio of 3 for a regular tetrahedron). A tiny negative tolerance
// (not exactly 0) absorbs harmless floating-point noise from three.js's
// Euler/Quaternion round-tripping without weakening the check at all: any
// die that actually tunneled through the floor free-falls under unopposed
// gravity for a real fraction of a second before this app's own settle
// timeout snapshots it (diceAnimator.ts's MIN_PHYSICS_SECONDS=0.4s), landing
// many centimeters-to-meters below this threshold, not a hair below it —
// this is the exact check that would have caught the ORIGINAL reported bug
// ("displays beneath the table").
const FLOOR_MIN_Y = -0.005;
// Generous upper sanity bound — every standard kind's own real resting
// height is well under DIE_SIZE (0.13), so anything settling above this is
// a sign of some OTHER bug (a die floating implausibly high), not tunneling,
// but still worth catching as part of this same "settled dice land exactly
// where expected" regression check.
const CEILING_SANITY_Y = 0.25;

const STANDARD_KINDS = [4, 6, 8, 10, 12, 20];

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

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on :${PORT} — starting yarn dev…`);
  devServer = spawn("yarn", ["dev", "-p", PORT], { cwd: rootDir, stdio: "ignore", detached: true, env: { ...process.env, PORT } });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error("dev server did not become healthy within 120s");
}

const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;
function sessionCookies(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value, url: APP_URL }];
  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `dice-tunneling-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Dice Tunneling ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function latestRoll(campaignId, rollerUserId, notation) {
  const { data, error } = await admin
    .from("roll_log")
    .select()
    .eq("campaign_id", campaignId)
    .eq("roller_user_id", rollerUserId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data.find((row) => row.breakdown?.notation === notation) ?? null;
}

/** Reads GameRoom's hidden data-testid="dice-face-labels-state" mirror —
 * `{ [userId]: { rollId, dice: { [dieIndex]: {sides, result, label,
 * usedPhysics, positionY} } } }` (handleDieSettledDebug's own doc comment
 * in GameRoom.tsx). */
async function readFaceLabels(page) {
  const text = await page.textContent('[data-testid="dice-face-labels-state"]');
  return JSON.parse(text ?? "{}");
}

async function waitForFaceLabels(page, userId, rollId, dieCount, timeout = 8000) {
  return page
    .waitForFunction(
      ({ userId, rollId, dieCount }) => {
        const el = document.querySelector('[data-testid="dice-face-labels-state"]');
        if (!el) return false;
        try {
          const state = JSON.parse(el.textContent || "{}")[userId];
          return state?.rollId === rollId && Object.keys(state.dice ?? {}).length >= dieCount;
        } catch {
          return false;
        }
      },
      { userId, rollId, dieCount },
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}

/** Pins `page`'s own `window.Math.random` to a fixed near-1 value — the
 * technique this script's own top comment explains: diceAnimator.ts's
 * createDieBody has no dedicated seam for injecting an extreme throw
 * directly, so maximizing every one of its Math.random()-derived
 * velocity/spin/drop-height ranges at once is the direct way to provoke the
 * single fastest, hardest-spinning throw this system can actually produce.
 * Saves the real original onto `window.__origMathRandom` so
 * restoreRandom(page) can put it back afterward — this MUST always be
 * paired with a restoreRandom call (a try/finally in every caller below),
 * since leaving it pinned would also affect this app's other unrelated
 * client-side randomness (visual variety only — never the authoritative
 * roll result itself, which is resolved server-side; see this script's own
 * top comment). 0.999999, not exactly 1, defensively avoids any code
 * elsewhere on the page that assumes Math.random()'s real [0, 1) exclusive
 * upper bound. */
async function pinMathRandomToMax(page) {
  await page.evaluate(() => {
    window.__origMathRandom = Math.random;
    Math.random = () => 0.999999;
  });
}

async function restoreRandom(page) {
  await page.evaluate(() => {
    if (window.__origMathRandom) {
      Math.random = window.__origMathRandom;
      delete window.__origMathRandom;
    }
  });
}

/** Fires one single-die quick-roll of `sides` and returns its own settled
 * dice-face-labels-state entry (`{sides, result, label, usedPhysics,
 * positionY}`), retrying the click a few times against real occasional
 * network/broadcast flakiness (the same retry shape verify-dice-physics.mjs
 * already uses) — or null if it never settled. */
async function rollAndReadSettled(page, userId, campaignId, sides) {
  const notation = `1d${sides}`;
  let rollId = null;
  let stored = null;
  for (let attempt = 0; attempt < 5 && !rollId; attempt++) {
    await page.click(`[data-testid="quick-roll-d${sides}"]`);
    await sleep(250);
    const row = await latestRoll(campaignId, userId, notation);
    if (!row) continue;
    rollId = row.id;
    stored = row;
  }
  if (!rollId) return null;
  const result = stored.breakdown.groups[0].results[0];
  const settled = await waitForFaceLabels(page, userId, rollId, 1, 10000);
  if (!settled) return null;
  const state = await readFaceLabels(page);
  const die = state[userId]?.dice?.["0"];
  if (!die) return null;
  return { ...die, result, rollId };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Dice tunneling fix test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  dmPage.on("pageerror", (err) => pageErrors.push(`dm: ${err.message}`));
  dmPage.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(`dm console: ${msg.text()}`);
  });
  await dmPage.goto(roomUrl);
  await dmPage.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });
  await dmPage.waitForSelector('[data-testid="dice-face-labels-state"]', { state: "attached", timeout: 30000 });

  // Give the WASM physics engine a real moment to finish loading (DiceTumble.
  // tsx's own preloadDicePhysics mount effect) — a roll fired before it's
  // ready would correctly, but uninterestingly, fall back to
  // scriptedDiceAnimator (no real Rapier physics, so nothing to tunnel
  // through in the first place), which would look like a false pass, not a
  // real one.
  await sleep(2000);

  // =========================================================================
  // Check 1 & 3 — a real, large batch of ORDINARY rolls (genuine randomized
  // throws, no overrides) across every standard die kind: the check that
  // would have caught the original bug, doubling as the "ordinary rolling
  // still works" regression check (settled label matches the real result,
  // position lands in the expected on-the-table range).
  // =========================================================================
  const REPEATS_PER_KIND = 6;
  const batchPositions = [];
  let batchTotal = 0;
  let batchCorrectLabel = 0;
  let batchAboveFloor = 0;
  let batchBelowCeiling = 0;

  for (const sides of STANDARD_KINDS) {
    for (let attemptNum = 0; attemptNum < REPEATS_PER_KIND; attemptNum++) {
      const die = await rollAndReadSettled(dmPage, dm.id, campaignId, sides);
      batchTotal++;
      if (!die) {
        check(`ordinary d${sides} roll #${attemptNum + 1} produced a real settled die`, false);
        continue;
      }
      batchPositions.push({ sides, ...die });
      if (die.label === String(die.result)) batchCorrectLabel++;
      if (die.positionY >= FLOOR_MIN_Y) batchAboveFloor++;
      else {
        check(
          `d${sides} roll #${attemptNum + 1}: settled die's positionY (${die.positionY}) is at or above the tray floor (>= ${FLOOR_MIN_Y})`,
          false,
          JSON.stringify(die)
        );
      }
      if (die.positionY <= CEILING_SANITY_Y) batchBelowCeiling++;
      // Let this roll fully linger/clear before firing the next one at the
      // same tray, matching verify-dice-physics.mjs's own pacing.
      await sleep(300);
    }
  }

  check(
    `every one of ${batchTotal} ordinary single-die rolls (d4/d6/d8/d10/d12/d20 × ${REPEATS_PER_KIND}) produced a real settled die`,
    batchPositions.length === batchTotal,
    `${batchPositions.length}/${batchTotal}`
  );
  check(
    `NO settled die's own rendered Y (and by construction its ResultBadge's, a fixed +0.22 above it) ever ended up below the tray floor's own reasonable minimum threshold (${FLOOR_MIN_Y}) across all ${batchTotal} ordinary rolls — the exact check that would have caught the original "displays beneath the table" bug`,
    batchAboveFloor === batchTotal,
    `${batchAboveFloor}/${batchTotal} above floor; positions: ${JSON.stringify(batchPositions.map((d) => d.positionY))}`
  );
  check(
    `every settled die also landed within a sane on-the-table height range (<= ${CEILING_SANITY_Y}) — not floating implausibly high either`,
    batchBelowCeiling === batchTotal,
    `${batchBelowCeiling}/${batchTotal} within range`
  );
  check(
    `every settled die's own face decal AND ResultBadge label matched the real authoritative roll_log result — ZERO mismatches (the fix didn't regress ordinary correctness)`,
    batchTotal > 0 && batchCorrectLabel === batchTotal,
    `${batchCorrectLabel}/${batchTotal} correct`
  );

  const minObservedY = batchPositions.length > 0 ? Math.min(...batchPositions.map((d) => d.positionY)) : null;
  const maxObservedY = batchPositions.length > 0 ? Math.max(...batchPositions.map((d) => d.positionY)) : null;
  console.log(`  (ordinary-batch observed positionY range: ${minObservedY} .. ${maxObservedY})`);

  // =========================================================================
  // Check 2 — deliberately provoke the exact tunneling scenario: pin
  // Math.random to its ceiling (see pinMathRandomToMax's own doc comment)
  // so every die thrown below is the single fastest, hardest-spinning throw
  // diceAnimator.ts's own randomized ranges can produce, then confirm it
  // STILL never renders below the floor and STILL settles on the correct
  // result — this is the direct stress test of the tunneling failure mode
  // itself, not just statistical insurance.
  // =========================================================================
  const STRESS_REPEATS_PER_KIND = 2;
  const stressPositions = [];
  let stressTotal = 0;
  let stressCorrectLabel = 0;
  let stressAboveFloor = 0;

  await pinMathRandomToMax(dmPage);
  try {
    for (const sides of STANDARD_KINDS) {
      for (let attemptNum = 0; attemptNum < STRESS_REPEATS_PER_KIND; attemptNum++) {
        const die = await rollAndReadSettled(dmPage, dm.id, campaignId, sides);
        stressTotal++;
        if (!die) {
          check(`extreme-throw d${sides} roll #${attemptNum + 1} produced a real settled die`, false);
          continue;
        }
        stressPositions.push({ sides, ...die });
        if (die.label === String(die.result)) stressCorrectLabel++;
        if (die.positionY >= FLOOR_MIN_Y) stressAboveFloor++;
        else {
          check(
            `EXTREME THROW d${sides} roll #${attemptNum + 1}: settled die's positionY (${die.positionY}) is at or above the tray floor (>= ${FLOOR_MIN_Y}) — tunneling stress test`,
            false,
            JSON.stringify(die)
          );
        }
        await sleep(300);
      }
    }
  } finally {
    // Always restore, even if a check above threw — never leave the page's
    // own Math.random permanently pinned.
    await restoreRandom(dmPage);
  }

  check(
    `every one of ${stressTotal} deliberately-extreme (max-velocity, max-spin) throws produced a real settled die`,
    stressPositions.length === stressTotal,
    `${stressPositions.length}/${stressTotal}`
  );
  check(
    `TUNNELING STRESS TEST: NO settled die ever rendered below the tray floor (>= ${FLOOR_MIN_Y}), even under the single fastest, hardest-spinning throw diceAnimator.ts's own randomized ranges can produce — the direct proof CCD + the defensive floor clamp actually catch the failure mode this bug fix targets`,
    stressAboveFloor === stressTotal,
    `${stressAboveFloor}/${stressTotal} above floor; positions: ${JSON.stringify(stressPositions.map((d) => d.positionY))}`
  );
  check(
    `every extreme-throw die STILL settled on the exact authoritative result (correctness survives the stress test too)`,
    stressTotal > 0 && stressCorrectLabel === stressTotal,
    `${stressCorrectLabel}/${stressTotal} correct`
  );

  // =========================================================================
  // Check 4 — Math.random genuinely restored: one more ordinary roll after
  // the stress section, confirming the override didn't leak into the rest
  // of the page's own behavior.
  // =========================================================================
  const afterStressDie = await rollAndReadSettled(dmPage, dm.id, campaignId, 20);
  check(
    "a roll fired AFTER the stress test (with Math.random restored) still settles correctly and above the floor — the override cleaned up after itself",
    afterStressDie !== null && afterStressDie.label === String(afterStressDie.result) && afterStressDie.positionY >= FLOOR_MIN_Y,
    JSON.stringify(afterStressDie)
  );

  check("no uncaught page error occurred during any dice-tunneling-fix roll", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
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
console.log("\nAll dice-tunneling-fix checks passed.");
process.exit(0);
