#!/usr/bin/env node
// Dice physics verification (docs/design/dice-numbers-and-physics.md §6-§9 —
// the physics-backed DiceAnimator implementation): real, repeated rolls, in
// a real Game Room, confirming the single non-negotiable correctness
// property this whole feature exists to guarantee — a physics-tumbled die
// ALWAYS visibly settles on the exact authoritative rolled result, never
// occasionally the wrong one — plus the perf-safeguard cap's own fallback
// behavior, plus that physics didn't regress the pre-existing personal-tray
// system (per-member attribution, public/private visibility).
//
// Same "a WebGL canvas has no DOM of its own to inspect" approach every
// other scene-3d verify-*.mjs script uses: GameRoom.tsx's hidden
// data-testid="dice-face-labels-state"/"dice-tray-layout-state" mirrors
// (DiceTumbleProps.onDieSettled/onQueueChange's own doc comments). The
// settled-face mirror now also carries `usedPhysics` (DiceFaceSettledInfo,
// added by this feature) — true only when that die's tumble actually ran
// through physicsDiceAnimator, false for a scriptedDiceAnimator fallback —
// so this script can confirm real physics genuinely ran, not just that the
// (always-correct-either-way) result happened to be right.
//
// Checks:
//   1. Every standard die kind (d4/d6/d8/d10/d12/d20), repeated several
//      times each: the physics-tumbled die's settled face label always
//      matches the real roll_log result, and usedPhysics is true (a
//      single-die roll is always <= MAX_PHYSICS_DICE_PER_ROLL and physics
//      has had time to finish loading by then).
//   2. A roll AT the physics cap (MAX_PHYSICS_DICE_PER_ROLL dice) uses real
//      physics for every one of its dice, all correct.
//   3. A roll ABOVE the physics cap falls back to scriptedDiceAnimator for
//      its ENTIRE tumble (usedPhysics false for every die, never a partial
//      mix) — and is STILL correct, proving the fallback itself isn't
//      broken by this change.
//   4. A percentile ("1d100") roll — the immediately-preceding numbering
//      feature's own centerpiece scenario — still decomposes correctly now
//      that its two dice tumble via real physics instead of the scripted
//      animator.
//   5. No regression to the personal-tray system: a player's own public
//      roll still reaches every other connected client's copy of THAT
//      player's own tray (never anyone else's), and the DM's private-roll
//      mechanism still never reaches any other client at all — the exact
//      guarantees scripts/db/verify-per-member-dice-trays.mjs already
//      established, re-checked here with physics now in the mix.
//   6. Real screenshots of a physics tumble mid-air (genuinely airborne,
//      not resting) and settled on the correct face.
//   7. No uncaught page error during any of the above.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: PORT=3011 node scripts/db/verify-dice-physics.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "3000";
const APP_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  process.env.VERIFY_SCREENSHOT_DIR ??
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/dice-physics";
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Must match diceAnimator.ts's own MAX_PHYSICS_DICE_PER_ROLL (see that
// constant's own doc comment for the real measured numbers this value came
// from) — kept as a plain literal for the same reason
// scripts/perf/dice-physics-benchmark.mjs's own DICE_PER_ROLL is: a .mjs
// script can't cleanly import a .ts module's runtime constant here (Node's
// native TS-stripping loader needs explicit relative extensions throughout
// the whole import graph, which diceAnimator.ts's own "./diceGeometry"
// import doesn't have).
const MAX_PHYSICS_DICE_PER_ROLL = 8;

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
  devServer = spawn("yarn", ["dev"], { cwd: rootDir, stdio: "ignore", detached: true, env: { ...process.env, PORT } });
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
  const email = `dice-physics-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Dice Physics ${label}` });
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
 * usedPhysics} } } }` (handleDieSettledDebug's own doc comment in
 * GameRoom.tsx). */
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

async function trayLayoutState(page) {
  const text = await page.textContent('[data-testid="dice-tray-layout-state"]');
  return JSON.parse(text ?? '{"radius":0,"trays":[]}');
}

async function waitForTrayField(page, userId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const state = await trayLayoutState(page);
    const tray = state.trays.find((t) => t.userId === userId);
    last = tray;
    if (tray && predicate(tray)) return tray;
    await sleep(200);
  }
  return last;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Dice physics test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

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

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  alicePage.on("pageerror", (err) => pageErrors.push(`alice: ${err.message}`));
  await alicePage.goto(roomUrl);
  await alicePage.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });

  // Give the WASM physics engine a real moment to finish loading on both
  // clients (DiceTumble.tsx's own preloadDicePhysics mount effect) before
  // any of the checks below — a roll fired before it's ready would
  // correctly, but uninterestingly, fall back to scriptedDiceAnimator for
  // that one roll, which would look like a false failure of check 1 below.
  await sleep(2000);

  // -------------------------------------------------------------------
  // 1. Every standard die kind, repeated several times each: physics
  //    genuinely ran, and the settled face always matches the real result.
  // -------------------------------------------------------------------
  const REPEATS_PER_KIND = 10;
  let totalSingleRolls = 0;
  let correctSingleRolls = 0;
  let physicsUsedCount = 0;

  for (const sides of [4, 6, 8, 10, 12, 20]) {
    for (let attemptNum = 0; attemptNum < REPEATS_PER_KIND; attemptNum++) {
      let rollId = null;
      let stored = null;
      for (let attempt = 0; attempt < 5 && !rollId; attempt++) {
        await dmPage.click(`[data-testid="quick-roll-d${sides}"]`);
        await sleep(250);
        const row = await latestRoll(campaignId, dm.id, `1d${sides}`);
        if (!row) continue;
        rollId = row.id;
        stored = row;
      }
      if (!rollId) {
        check(`d${sides} roll #${attemptNum + 1} produced a real roll_log row`, false);
        continue;
      }
      const result = stored.breakdown.groups[0].results[0];
      const settled = await waitForFaceLabels(dmPage, dm.id, rollId, 1);
      if (!settled) {
        check(`d${sides} roll #${attemptNum + 1}: settled face label reached the client`, false);
        continue;
      }
      const state = await readFaceLabels(dmPage);
      const die = state[dm.id]?.dice?.["0"];
      totalSingleRolls++;
      if (die?.usedPhysics === true) physicsUsedCount++;
      if (die?.label === String(result)) correctSingleRolls++;
      else {
        check(
          `d${sides} roll #${attemptNum + 1}: settled face label ("${die?.label}") matches real result ("${result}")`,
          false,
          JSON.stringify(die)
        );
      }
      // Let this roll fully linger/clear before firing the next one at the
      // same tray, matching verify-dice-numbering.mjs's own pacing.
      await sleep(300);
    }
  }
  check(
    `every one of ${totalSingleRolls} single-die rolls (d4/d6/d8/d10/d12/d20 × ${REPEATS_PER_KIND}) settled on the exact authoritative result — ZERO mismatches`,
    totalSingleRolls > 0 && correctSingleRolls === totalSingleRolls,
    `${correctSingleRolls}/${totalSingleRolls} correct`
  );
  check(
    `real physics (not a scripted fallback) was used for effectively all single-die rolls (a single die is always <= the ${MAX_PHYSICS_DICE_PER_ROLL}-die cap)`,
    totalSingleRolls > 0 && physicsUsedCount >= totalSingleRolls * 0.9,
    `${physicsUsedCount}/${totalSingleRolls} used physics`
  );

  // -------------------------------------------------------------------
  // 2. A roll AT the physics cap: every one of its dice uses real physics,
  //    all correct.
  // -------------------------------------------------------------------
  async function fireFreeform(page, notation) {
    await page.fill('[data-testid="freeform-notation-input"]', notation);
    await page.click('[data-testid="freeform-roll-button"]');
  }

  const atCapNotation = `${MAX_PHYSICS_DICE_PER_ROLL}d6`;
  let atCapRoll = null;
  for (let i = 0; i < 10 && !atCapRoll; i++) {
    await fireFreeform(dmPage, atCapNotation);
    await sleep(250);
    atCapRoll = await latestRoll(campaignId, dm.id, atCapNotation);
  }
  check(`the "${atCapNotation}" (at-cap) roll produced a real roll_log row`, atCapRoll !== null);
  if (atCapRoll) {
    const results = atCapRoll.breakdown.groups[0].results;
    const settled = await waitForFaceLabels(dmPage, dm.id, atCapRoll.id, MAX_PHYSICS_DICE_PER_ROLL, 12000);
    check(`all ${MAX_PHYSICS_DICE_PER_ROLL} dice of the at-cap roll settled`, settled);
    if (settled) {
      const state = await readFaceLabels(dmPage);
      const dice = state[dm.id]?.dice ?? {};
      const allCorrect = results.every((r, i) => dice[i]?.label === String(r));
      const allPhysics = results.every((_, i) => dice[i]?.usedPhysics === true);
      check(`every die in the at-cap roll settled on its exact authoritative result`, allCorrect, JSON.stringify({ results, dice }));
      check(`every die in the at-cap roll used real physics`, allPhysics, JSON.stringify(dice));
    }
    await sleep(1500); // let it fully linger/clear
  }

  // -------------------------------------------------------------------
  // 3. A roll ABOVE the physics cap falls back to scriptedDiceAnimator for
  //    its ENTIRE tumble (never a partial mix), and is STILL correct.
  // -------------------------------------------------------------------
  const aboveCapCount = MAX_PHYSICS_DICE_PER_ROLL + 4;
  const aboveCapNotation = `${aboveCapCount}d6`;
  let aboveCapRoll = null;
  for (let i = 0; i < 10 && !aboveCapRoll; i++) {
    await fireFreeform(dmPage, aboveCapNotation);
    await sleep(250);
    aboveCapRoll = await latestRoll(campaignId, dm.id, aboveCapNotation);
  }
  check(`the "${aboveCapNotation}" (above-cap) roll produced a real roll_log row`, aboveCapRoll !== null);
  if (aboveCapRoll) {
    const results = aboveCapRoll.breakdown.groups[0].results;
    const settled = await waitForFaceLabels(dmPage, dm.id, aboveCapRoll.id, aboveCapCount, 12000);
    check(`all ${aboveCapCount} dice of the above-cap roll settled`, settled);
    if (settled) {
      const state = await readFaceLabels(dmPage);
      const dice = state[dm.id]?.dice ?? {};
      const allCorrect = results.every((r, i) => dice[i]?.label === String(r));
      const nonePhysics = results.every((_, i) => dice[i]?.usedPhysics === false);
      check(
        `an above-cap roll falls back to scriptedDiceAnimator for EVERY die (never a partial mix)`,
        nonePhysics,
        JSON.stringify(dice)
      );
      check(`the above-cap (scripted-fallback) roll is STILL exactly correct`, allCorrect, JSON.stringify({ results, dice }));
    }
    await sleep(1500);
  }

  // -------------------------------------------------------------------
  // 4. A percentile ("1d100") roll — the numbering feature's own
  //    centerpiece scenario — still decomposes correctly with physics.
  // -------------------------------------------------------------------
  let percentileRoll = null;
  for (let i = 0; i < 10 && !percentileRoll; i++) {
    await fireFreeform(dmPage, "1d100");
    await sleep(250);
    percentileRoll = await latestRoll(campaignId, dm.id, "1d100");
  }
  check(`the "1d100" roll produced a real roll_log row`, percentileRoll !== null);
  if (percentileRoll) {
    const r = percentileRoll.breakdown.groups[0].results[0];
    const settled = await waitForFaceLabels(dmPage, dm.id, percentileRoll.id, 2, 8000);
    check(`both percentile dice (tens + ones) settled`, settled);
    if (settled) {
      const state = await readFaceLabels(dmPage);
      const dice = state[dm.id]?.dice ?? {};
      const tensValue = r === 100 ? 0 : Math.floor(r / 10) * 10;
      const onesValue = r === 100 ? 0 : r % 10;
      const expectedTensLabel = tensValue === 0 ? "00" : String(tensValue);
      const expectedOnesLabel = String(onesValue);
      check(
        `percentile tens/ones dice both settled on the exact expected labels for real result ${r}`,
        dice["0"]?.label === expectedTensLabel && dice["1"]?.label === expectedOnesLabel,
        JSON.stringify(dice)
      );
      check(`both percentile dice used real physics`, dice["0"]?.usedPhysics === true && dice["1"]?.usedPhysics === true);
    }
    await sleep(1500);
  }

  // -------------------------------------------------------------------
  // 5. No regression to the personal-tray system: public roll attribution
  //    and private-roll visibility, now with physics active.
  // -------------------------------------------------------------------
  let aliceRollId = null;
  let syncOk = false;
  for (let attempt = 0; attempt < 5 && !syncOk; attempt++) {
    await alicePage.click('[data-testid="quick-roll-d20"]');
    await sleep(300);
    const row = await latestRoll(campaignId, alice.id, "1d20");
    if (!row) continue;
    aliceRollId = row.id;
    syncOk = (await waitForTrayField(dmPage, alice.id, (t) => t.queue.includes(aliceRollId), 4000)) !== null;
  }
  check("alice's own public roll reaches the DM's copy of ALICE'S OWN tray (cross-client attribution unaffected by physics)", syncOk);
  if (aliceRollId) {
    const dmView = await trayLayoutState(dmPage);
    const dmEntry = dmView.trays.find((t) => t.userId === dm.id);
    check("alice's roll never enters the DM's own tray queue", dmEntry ? !dmEntry.queue.includes(aliceRollId) : true);
    await waitForTrayField(dmPage, alice.id, (t) => !t.queue.includes(aliceRollId), 8000);
  }

  await dmPage.click('[data-testid="private-roll-toggle"]');
  let privateRollId = null;
  for (let attempt = 0; attempt < 5 && privateRollId === null; attempt++) {
    await dmPage.click('[data-testid="quick-roll-d12"]');
    await sleep(300);
    const row = await latestRoll(campaignId, dm.id, "1d12");
    if (row) privateRollId = row.id;
  }
  check("the DM's private quick-roll creates a real roll_log row", privateRollId !== null);
  if (privateRollId) {
    const { data: stored } = await admin.from("roll_log").select().eq("id", privateRollId).single();
    check("the private roll is persisted with visibility: 'private' (RLS/visibility unchanged by physics)", stored?.visibility === "private");
    await sleep(1500); // generous settle window — nothing should ever arrive on alice's client
    const aliceView = await trayLayoutState(alicePage);
    const anyoneGotIt = aliceView.trays.some((t) => t.queue.includes(privateRollId));
    check("the DM's private roll never reaches alice's connected client at all, even with physics active", !anyoneGotIt);
    await waitForTrayField(dmPage, dm.id, (t) => !t.queue.includes(privateRollId), 8000);
  }
  await dmPage.click('[data-testid="private-roll-toggle"]'); // back OFF

  // -------------------------------------------------------------------
  // 6. Real screenshots: a physics tumble genuinely airborne mid-tumble,
  //    and settled on the correct face. The Game Room's own default camera
  //    sits too far from any one personal tray, and the DM's own tray sits
  //    directly behind that DM's own control panels — the exact framing
  //    problem /dev/dice-showcase's own doc comment already names — so the
  //    clear, close-up evidence comes from that dev-only page instead: a
  //    tight fixed camera around the REAL production DiceTumble component
  //    (no mockup), unauthenticated, looping the same roll continuously.
  //    Physics still genuinely runs there (DiceTumble.tsx's own
  //    preloadDicePhysics mount effect fires unconditionally, and a single
  //    die is always <= MAX_PHYSICS_DICE_PER_ROLL), so this is real evidence
  //    of the actual physics-backed animator, not a separate code path.
  // -------------------------------------------------------------------
  const showcasePage = await dmContext.newPage();
  showcasePage.on("pageerror", (err) => pageErrors.push(`showcase: ${err.message}`));
  await showcasePage.goto(`${APP_URL}/dev/dice-showcase`);
  await showcasePage.waitForSelector('[data-testid="dice-preview-d20"]', { timeout: 30000 });

  async function cellSettled(page, title) {
    const text = await page.textContent(`[data-testid="dice-preview-settled-${title}"]`);
    return text === "true";
  }
  async function waitForCellState(page, title, wantSettled, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await cellSettled(page, title)) === wantSettled) return true;
      await sleep(50);
    }
    return false;
  }

  // Wait for the d20 cell's current loop iteration to finish settling, then
  // catch it right at the START of its next automatic re-roll (the
  // showcase's own "requeue the instant the queue drains" loop) — genuinely
  // mid-air, not a stale settled frame.
  await waitForCellState(showcasePage, "d20", true, 8000);
  const caughtRestart = await waitForCellState(showcasePage, "d20", false, 3000);
  check("caught the dice-showcase d20 cell at the start of a fresh physics tumble", caughtRestart);
  await showcasePage.screenshot({ path: join(SCREENSHOT_DIR, "physics-tumble-mid-air.png") });

  const settledAgain = await waitForCellState(showcasePage, "d20", true, 6000);
  check("the same physics tumble settled again shortly after", settledAgain);
  await showcasePage.screenshot({ path: join(SCREENSHOT_DIR, "physics-tumble-settled.png") });

  // A wide shot of every standard kind (plus the percentile pair) all
  // settled at once — real physics-driven settles across every die type in
  // a single frame of evidence.
  for (const title of ["d4", "d6", "d8", "d10", "d12", "d20"]) {
    await waitForCellState(showcasePage, title, true, 8000);
  }
  await showcasePage.screenshot({ path: join(SCREENSHOT_DIR, "physics-all-kinds-settled.png"), fullPage: true });
  console.log(`Screenshots written to ${SCREENSHOT_DIR}`);

  check("no uncaught page error occurred during any dice-physics roll", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id).catch(() => undefined);
  await admin.auth.admin.deleteUser(alice.id).catch(() => undefined);
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
console.log("\nAll dice physics checks passed.");
process.exit(0);
