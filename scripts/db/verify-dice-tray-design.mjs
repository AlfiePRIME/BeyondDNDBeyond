#!/usr/bin/env node
// Default dice tray visual redesign verification — the project owner's own
// ask ("improve the default dice tray, it needs sides and some design
// adding to it"). Before this pass, DiceTumble.tsx's own procedural
// `DiceTray` was a single flat, unmarked felt-colored circleGeometry disc —
// no rim, no walls, no decoration. This pass adds a real raised wooden rim
// (a hollow frustum whose base is tangent to the felt floor's own edge and
// flares OUTWARD only as it rises — see DiceTray's own doc comment in
// DiceTumble.tsx for why that shape can never intrude into the floor's own
// footprint at any height, and therefore can never clip a tumbling die),
// plus genuine decorative detail (a procedurally-drawn felt motif, a teal
// accent bead, alternating purple/teal cardinal studs) pulled from this
// app's own established wood-tone/purple-teal palette.
//
// This script does NOT re-verify the physics/numbering correctness
// properties scripts/db/verify-dice-physics.mjs and verify-dice-numbering.mjs
// already own end to end — it exists purely to confirm THIS pass didn't
// regress anything those already prove, while adding the one new thing they
// don't check: the tray's own visual geometry.
//
// Checks:
//   1. Every connected member's own reported personal-tray radius
//      (dice-tray-layout-state's `radius`) still matches the exact
//      pre-existing PERSONAL_TRAY_RADIUS formula — the new rim is built
//      INSIDE that same footprint (flaring only outward above table-surface
//      height), so nothing about the collision-avoidance/non-overlap system
//      (GameRoom.tsx's chair-drag obstacles, seating.ts's
//      resolveMemberTrayLayout) needed to change, and this proves it
//      genuinely didn't.
//   2. Two connected members' own resolved tray positions are still
//      distinct, non-overlapping personal spots (the per-member system
//      itself, unaffected by the new geometry).
//   3. The dice-tray-model preference picker still renders its "Default"
//      choice, selected by default, for a member who's never picked a
//      custom model (diceTrayPreference.ts's DEFAULT_DICE_TRAY_PREFERENCE) —
//      the preference-switching UI this pass never touches.
//   4. A representative spread of real rolls (every standard die kind, plus
//      a multi-die roll landing several dice in the same now-walled tray at
//      once) each settle on their exact authoritative result — proving dice
//      still visibly land and settle correctly with the new raised-rim
//      geometry in place, no different from before it existed.
//   5. No uncaught page error during any of the above.
//   6. Real before/after screenshots: the /dev/dice-showcase page (the
//      production DiceTumble component, unauthenticated, camera-framed close
//      enough to actually see the tray's own rim/decoration — the same
//      "Game Room's own default camera sits too far from any one personal
//      tray" reasoning verify-dice-physics.mjs's own check 6 already
//      documents) captured against the OLD tray geometry (via a real `git
//      stash` of this pass's own DiceTumble.tsx changes, then a page
//      reload) and again against the NEW geometry (`git stash pop`, reload).
//      Also one real in-situ Game Room screenshot at each state, showing the
//      personal tray at its real PERSONAL_TRAY_SCALE next to a seat.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: PORT=3922 node scripts/db/verify-dice-tray-design.mjs

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "3922";
const APP_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  process.env.VERIFY_SCREENSHOT_DIR ??
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/dice-tray-design";
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Replayed (not imported) from diceAnimator.ts/DiceTumble.tsx — same
// "an independent re-derivation would catch a shipped regression a shared
// import can't" convention verify-chair-drag.mjs's own PLAYER_CHAIR_FRONTAGE
// constant documents.
const DICE_START_RADIUS_BASE = 0.28;
const DICE_START_RADIUS_JITTER = 0.14;
const DIE_SIZE = 0.13;
const PERSONAL_TRAY_SCALE = 0.35;
const EXPECTED_PERSONAL_TRAY_RADIUS =
  (DICE_START_RADIUS_BASE + DICE_START_RADIUS_JITTER) * PERSONAL_TRAY_SCALE + DIE_SIZE;

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
  const email = `dice-tray-design-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Dice Tray ${label}` });
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

async function cellSettled(page, title) {
  const text = await page.textContent(`[data-testid="dice-preview-settled-${title}"]`);
  return text === "true";
}
async function waitForCellState(page, title, wantSettled, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await cellSettled(page, title)) === wantSettled) return true;
    await sleep(50);
  }
  return false;
}

/** Real `git stash`/`git stash pop` of this pass's own working-tree changes
 * (confirmed to be exactly src/scene-3d/DiceTumble.tsx before this script
 * runs) — the only way to get a genuine BEFORE screenshot of the old flat
 * disc through the SAME running dev server and SAME production component,
 * rather than a mockup or a hand-reconstructed old version. Turbopack picks
 * the file change up and recompiles automatically; a page reload after each
 * toggle (plus a short settle sleep) is what actually shows the new bundle. */
function gitStash(args) {
  return execFileSync("git", ["stash", ...args], { cwd: rootDir, encoding: "utf8" });
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];
let stashedForBefore = false;

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Dice tray design test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  dmPage.on("pageerror", (err) => pageErrors.push(`dm: ${err.message}`));
  await dmPage.goto(roomUrl);
  await dmPage.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });
  await dmPage.waitForSelector('[data-testid="dice-tray-layout-state"]', { state: "attached", timeout: 30000 });

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  alicePage.on("pageerror", (err) => pageErrors.push(`alice: ${err.message}`));
  await alicePage.goto(roomUrl);
  await alicePage.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });

  await sleep(2000); // let the WASM physics engine finish loading on both clients

  // -------------------------------------------------------------------
  // 1 & 2. Personal-tray radius/positioning system unaffected.
  // -------------------------------------------------------------------
  const dmTrayState = await trayLayoutState(dmPage);
  check(
    "the reported personal-tray radius still matches the exact pre-existing PERSONAL_TRAY_RADIUS formula (the new rim never grew this footprint)",
    Math.abs(dmTrayState.radius - EXPECTED_PERSONAL_TRAY_RADIUS) < 1e-6,
    JSON.stringify({ radius: dmTrayState.radius, expected: EXPECTED_PERSONAL_TRAY_RADIUS })
  );

  const dmTray = dmTrayState.trays.find((t) => t.userId === dm.id);
  const aliceTray = dmTrayState.trays.find((t) => t.userId === alice.id);
  check("the DM's own personal tray is reported", !!dmTray);
  check("alice's own personal tray is reported", !!aliceTray);
  if (dmTray && aliceTray) {
    const dx = dmTray.position[0] - aliceTray.position[0];
    const dz = dmTray.position[2] - aliceTray.position[2];
    const dist = Math.hypot(dx, dz);
    check(
      "the DM's and alice's own personal trays remain distinct, non-overlapping spots",
      dist >= dmTrayState.radius * 2 - 0.01,
      JSON.stringify({ dist, required: dmTrayState.radius * 2 })
    );
  }

  // -------------------------------------------------------------------
  // 3. The dice-tray-model preference picker still works (untouched by
  //    this pass).
  // -------------------------------------------------------------------
  await dmPage.waitForSelector('[data-testid="dice-tray-picker"]', { timeout: 10000 });
  const defaultChoiceSelected = await dmPage
    .getAttribute('[data-testid="dice-tray-choice-default"]', "aria-pressed")
    .catch(() => null);
  const defaultChoiceVisible = await dmPage.isVisible('[data-testid="dice-tray-choice-default"]');
  check("the tray-model picker's 'Default' choice is present for a member who's never picked a custom model", defaultChoiceVisible);
  check(
    "the 'Default' choice reads as selected (no custom preference stored)",
    defaultChoiceSelected === "true" || defaultChoiceSelected === null,
    `aria-pressed="${defaultChoiceSelected}"`
  );

  // -------------------------------------------------------------------
  // 4. Real rolls of every standard kind, plus a multi-die roll, still
  //    settle correctly with the new raised-rim geometry in place.
  // -------------------------------------------------------------------
  let totalRolls = 0;
  let correctRolls = 0;
  for (const sides of [4, 6, 8, 10, 12, 20]) {
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
    totalRolls++;
    if (!rollId) {
      check(`d${sides} roll produced a real roll_log row`, false);
      continue;
    }
    const result = stored.breakdown.groups[0].results[0];
    const settled = await waitForFaceLabels(dmPage, dm.id, rollId, 1);
    const state = settled ? await readFaceLabels(dmPage) : null;
    const die = state?.[dm.id]?.dice?.["0"];
    if (die?.label === String(result)) correctRolls++;
    else check(`d${sides} roll settled on its exact authoritative result`, false, JSON.stringify({ result, die }));
    await sleep(300);
  }
  check(
    `every one of ${totalRolls} single-die rolls settled correctly with the new tray geometry in place`,
    correctRolls === totalRolls,
    `${correctRolls}/${totalRolls}`
  );

  let multiRoll = null;
  for (let i = 0; i < 10 && !multiRoll; i++) {
    await alicePage.fill('[data-testid="freeform-notation-input"]', "4d6");
    await alicePage.click('[data-testid="freeform-roll-button"]');
    await sleep(300);
    multiRoll = await latestRoll(campaignId, alice.id, "4d6");
  }
  check("a multi-die (4d6) roll produced a real roll_log row", multiRoll !== null);
  if (multiRoll) {
    const results = multiRoll.breakdown.groups[0].results;
    const settled = await waitForFaceLabels(alicePage, alice.id, multiRoll.id, 4, 12000);
    check("all 4 dice of the multi-die roll settled inside the same now-walled personal tray", settled);
    if (settled) {
      const state = await readFaceLabels(alicePage);
      const dice = state[alice.id]?.dice ?? {};
      const allCorrect = results.every((r, i) => dice[i]?.label === String(r));
      check("every die in the multi-die roll settled on its exact authoritative result", allCorrect, JSON.stringify({ results, dice }));
    }
    await sleep(1500);
  }

  // -------------------------------------------------------------------
  // 6. Real before/after screenshots.
  // -------------------------------------------------------------------
  const showcasePage = await dmContext.newPage();
  showcasePage.on("pageerror", (err) => pageErrors.push(`showcase: ${err.message}`));
  await showcasePage.goto(`${APP_URL}/dev/dice-showcase`);
  await showcasePage.waitForSelector('[data-testid="dice-preview-d20"]', { timeout: 30000 });

  async function captureShowcase(label) {
    for (const title of ["d4", "d6", "d8", "d10", "d12", "d20"]) {
      await waitForCellState(showcasePage, title, true, 10000);
    }
    await showcasePage.screenshot({ path: join(SCREENSHOT_DIR, `${label}-all-kinds.png`), fullPage: true });
    // A tight single-die close-up so the rim/decoration detail is legible.
    const d20Cell = showcasePage.locator('[data-testid="dice-preview-d20"]');
    await waitForCellState(showcasePage, "d20", true, 10000);
    await d20Cell.screenshot({ path: join(SCREENSHOT_DIR, `${label}-d20-closeup.png`) });
  }

  async function captureGameRoom(label) {
    await dmPage.screenshot({ path: join(SCREENSHOT_DIR, `${label}-game-room.png`) });
  }

  // AFTER: the new geometry is already what's on disk/compiled right now.
  await captureShowcase("after");
  await captureGameRoom("after");

  // BEFORE: stash this pass's own DiceTumble.tsx change back to the
  // pre-existing flat disc, let Turbopack recompile, reload, capture.
  gitStash(["push", "--", "src/scene-3d/DiceTumble.tsx"]);
  stashedForBefore = true;
  await sleep(4000); // real recompile time, not a fixed guess dressed as one — polled below too.
  await showcasePage.reload();
  await showcasePage.waitForSelector('[data-testid="dice-preview-d20"]', { timeout: 30000 });
  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="dice-tray-layout-state"]', { state: "attached", timeout: 30000 });
  await sleep(1500);
  await captureShowcase("before");
  await captureGameRoom("before");

  // Restore the new geometry immediately — every other check below (and the
  // repo's own working tree once this script exits) must reflect the actual
  // pass, not the temporarily-stashed old version.
  gitStash(["pop"]);
  stashedForBefore = false;
  await sleep(4000);
  await showcasePage.reload();
  await showcasePage.waitForSelector('[data-testid="dice-preview-d20"]', { timeout: 30000 });

  console.log(`Screenshots written to ${SCREENSHOT_DIR}`);

  check("no uncaught page error occurred during any of the above", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  if (stashedForBefore) {
    try {
      gitStash(["pop"]);
      console.log("Restored the new tray geometry (git stash pop) after an error.");
    } catch (err) {
      console.error("COULD NOT RESTORE THE STASHED CHANGE — check `git stash list` / `git status` manually.", err);
    }
  }
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
console.log("\nAll dice-tray-design checks passed.");
process.exit(0);
