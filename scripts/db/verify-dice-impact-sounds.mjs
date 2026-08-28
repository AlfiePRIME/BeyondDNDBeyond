#!/usr/bin/env node
// Sound Effects SP8 verification: real per-collision dice_impact playback
// during a physics-tumbled dice roll (diceAnimator.ts's physicsDiceAnimator
// — real Rapier COLLISION_EVENTS, a real EventQueue drained every substep,
// threaded out through useDiceTumble's new `onImpact` callback into
// DiceTumble.tsx's Die component, which applies its own per-die rate limit
// before calling src/audio's playSound(SOUND_KEYS.DICE_IMPACT)).
//
// Real signed-in Playwright browsers throughout — every claim below is
// verified by reading the sound manager's own real state (the hidden
// "sound-manager-debug" JSON mirror — SP1's own playLog, this project's
// established visionDebug/tableSurfaceDebug convention applied to the Web
// Audio graph) or a genuine direct-DB read via the admin/service-role
// client, never a mock or a synthetic event.
//
// Checks:
//   1. A real single-die roll, repeated several times, plays MULTIPLE
//      distinct dice_impact sounds during a single tumble for a real
//      fraction of those rolls — not just once when the die settles.
//   2. Across every recorded multi-impact roll, no two consecutive
//      dice_impact plays for the SAME die are closer together than
//      DiceTumble.tsx's own MIN_DICE_IMPACT_INTERVAL_MS (minus a small
//      tolerance for real async scheduling) — the "no machine-gun spam"
//      rate-limit requirement, checked against REAL recorded timestamps,
//      not a mocked clock.
//   3. A busier multi-die roll (4d6) produces several dice_impact plays in
//      one tumble (more dice = more real collisions = stronger evidence).
//   4. A DM's PRIVATE roll's impact sounds reach the DM's own client but
//      NEVER the other connected player's client at all — a real two-client
//      check, mirroring verify-per-member-dice-trays.mjs's own private-roll
//      visibility convention applied to audio instead of the 3D tray.
//   5. A PUBLIC roll's impact sounds are heard on BOTH the roller's own
//      client AND every other connected client that can see that roll's
//      tray (each client's own independent local physics simulation).
//   6. No uncaught page error during any of the above.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: PORT=3811 node scripts/db/verify-dice-impact-sounds.mjs

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

// Must match DiceTumble.tsx's own MIN_DICE_IMPACT_INTERVAL_MS (that
// constant's own doc comment explains the choice: it matches dice_impact's
// real generated clip duration, 0.12s, so two impact sounds never overlap).
// Kept as a plain literal rather than an import for the same reason every
// other verify-*.mjs script in this project keeps its own physics/animation
// constants as literals: a .mjs script importing a .tsx module's runtime
// constant hits Node's native-TS-stripping extension-resolution issue.
const MIN_DICE_IMPACT_INTERVAL_MS = 120;
// Real async scheduling tolerance between the debounce check (performance.
// now() inside DiceTumble.tsx's handleImpact) and the recorded playLog
// timestamp (performance.now() inside soundManager.ts's recordPlay, after
// ensureContext/resolveSoundUrl/loadBuffer's own await chain resolves) — the
// pre-warm step below (Part 0) makes every real play in the timed checks a
// cache-hit (bufferCache already populated), so this only needs to absorb
// microtask-scheduling jitter, not real network/decode latency. Generous on
// purpose: this check exists to catch genuine machine-gun spam (sub-20ms
// gaps), not to nitpick a few milliseconds of scheduling noise.
const RATE_LIMIT_TOLERANCE_MS = 40;
const MIN_ACCEPTABLE_GAP_MS = MIN_DICE_IMPACT_INTERVAL_MS - RATE_LIMIT_TOLERANCE_MS;

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
  const email = `dice-impact-sounds-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Dice Impact ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

/** Reads and JSON.parses a hidden debug-mirror div's text content — the
 * visionDebug/tableSurfaceDebug convention this project uses wherever real
 * state has no DOM of its own to inspect (a WebGL canvas here, same as
 * verify-sound-infra.mjs's own identical helper). */
async function readTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}

const readSoundDebug = (page) => readTestId(page, "sound-manager-debug");

/** performance.now()-based marker on THIS page's own clock — playLog
 * entries are also performance.now()-based (soundManager.ts's recordPlay),
 * so comparing markers and entries from the SAME page is apples-to-apples;
 * never compare a marker from one page against another page's playLog. */
async function markNow(page) {
  return page.evaluate(() => performance.now());
}

/** Every dice_impact playLog entry recorded on `page` at or after `marker`,
 * sorted ascending by `at`. */
async function diceImpactsSince(page, marker) {
  const debug = await readSoundDebug(page);
  return (debug?.playLog ?? [])
    .filter((entry) => entry.key === "dice_impact" && entry.at >= marker)
    .sort((a, b) => a.at - b.at);
}

/** Smallest gap (ms) between consecutive entries, or Infinity if fewer than
 * 2 entries (no gap to measure). */
function minGapMs(entries) {
  if (entries.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 1; i < entries.length; i++) {
    min = Math.min(min, entries[i].at - entries[i - 1].at);
  }
  return min;
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

async function fireFreeform(page, notation) {
  await page.fill('[data-testid="freeform-notation-input"]', notation);
  await page.click('[data-testid="freeform-roll-button"]');
}

// Generous enough to cover a real physics tumble's worst case
// (MAX_PHYSICS_SECONDS 1.2s + SETTLE_BLEND_SECONDS 0.3s) plus LINGER_MS
// (1.1s) plus real scheduling margin, so the NEXT roll fired never overlaps
// the previous one's own still-lingering tray — required for this script's
// own per-roll playLog windows to stay cleanly separated.
const FULL_ROLL_CYCLE_MS = 3200;

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Dice impact sounds test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);
  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  dmPage.on("pageerror", (err) => pageErrors.push(`dm: ${err.message}`));

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  alicePage.on("pageerror", (err) => pageErrors.push(`alice: ${err.message}`));

  await dmPage.goto(roomUrl);
  await dmPage.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });
  await dmPage.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });
  await alicePage.goto(roomUrl);
  await alicePage.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });
  await alicePage.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });

  // Give the WASM physics engine a real moment to finish loading on both
  // clients (DiceTumble.tsx's own preloadDicePhysics mount effect) — a roll
  // fired before it's ready would fall back to scriptedDiceAnimator (no real
  // collisions, no dice_impact at all), which would look like a false
  // failure of every check below.
  await sleep(2000);

  // =========================================================================
  // Part 0 — pre-warm the dice_impact variant-file cache on the DM's own
  // page via SoundControl's real test-harness button (SP1), so every play
  // recorded during the TIMED checks below is a bufferCache hit — removing
  // real network-fetch/decodeAudioData latency as a confound in the
  // rate-limit timestamp check (Part 2). A cold play's real fetch+decode
  // latency has nothing to do with whether the debounce logic itself is
  // spammy; warming the cache first isolates that.
  // =========================================================================
  // 20 random draws from a 3-file pool: P(missing at least one variant) =
  // 3*(2/3)^20 - 3*(1/3)^20 ≈ 0.09% — comfortably reliable, unlike a smaller
  // sample (6 draws measured a real ~26% miss chance during this script's
  // own development — a birthday-paradox-style sampling issue, not a
  // feature bug, since resolveSoundUrl's own random pick is uniform).
  for (let i = 0; i < 20; i++) {
    await dmPage.click('[data-testid="sound-test-play-dice_impact"]');
    await sleep(40);
  }
  const warmDebug = await readSoundDebug(dmPage);
  const warmUrls = new Set(
    (warmDebug?.playLog ?? []).filter((e) => e.key === "dice_impact").map((e) => e.url)
  );
  check(
    "(setup) pre-warmed all 3 dice_impact variant files via the real test-harness button before timed checks",
    warmUrls.size === 3,
    JSON.stringify([...warmUrls])
  );

  // =========================================================================
  // Part 1 & 2 — repeated single-die rolls at the DM's own tray: multiple
  // distinct impact sounds per tumble (not just once at settle), and a real,
  // observable per-die rate limit.
  //
  // Threshold calibration note: a real, direct diagnostic against
  // physicsDiceAnimator directly (this feature's own design investigation,
  // bypassing the browser/audio layer entirely) measured a LONE die's own
  // raw collision-episode count across 20 real tumbles: [1,2,1,2,2,1,1,1,2,
  // 1,2,2,2,1,2,3,2,2,1,3] — 12/20 (60%) genuinely bounce more than once at
  // the PHYSICS level. But the gaps between those episodes are frequently
  // BELOW MIN_DICE_IMPACT_INTERVAL_MS (real measured gaps included several
  // in the 33-117ms range, under the 120ms floor) — a real, single isolated
  // die's own successive bounces often land close enough together that the
  // per-die audio rate limit legitimately collapses them into one sound
  // (exactly its intended job: two impacts 80ms apart would otherwise
  // overlap the 120ms clip). A crowded multi-die roll (Part 3, below) is a
  // much stronger, more reliable source of multiple DISTINCT sounds (more
  // dice means more floor AND die-die contacts, less likely to all cluster
  // within the same ~120ms window) — this single-die section exists to
  // prove the phenomenon is real for a lone die too, not to demand it on
  // every single roll (which the real physics/audio-timing interaction
  // above shows would be an unrealistic bar).
  // =========================================================================
  const REPEATS = 10;
  const perRollCounts = [];
  const allGaps = [];

  for (let attemptNum = 0; attemptNum < REPEATS; attemptNum++) {
    const marker = await markNow(dmPage);
    let rollId = null;
    for (let attempt = 0; attempt < 5 && !rollId; attempt++) {
      await dmPage.click('[data-testid="quick-roll-d20"]');
      await sleep(250);
      const row = await latestRoll(campaignId, dm.id, "1d20");
      if (row) rollId = row.id;
    }
    check(`single-die roll #${attemptNum + 1} produced a real roll_log row`, rollId !== null);
    // Wait out this roll's ENTIRE lifecycle (tumble + settle + linger) before
    // reading playLog or firing the next roll — keeps each repeat's own
    // playLog window cleanly separated from its neighbors.
    await sleep(FULL_ROLL_CYCLE_MS);
    const impacts = await diceImpactsSince(dmPage, marker);
    perRollCounts.push(impacts.length);
    if (impacts.length >= 2) allGaps.push(minGapMs(impacts));
  }

  const multiImpactRolls = perRollCounts.filter((n) => n >= 2).length;
  check(
    `at least one of ${REPEATS} real single-die rolls produced MULTIPLE distinct dice_impact plays during the tumble (not just once at settle) — proves the phenomenon is real even for a lone die, not just a busy multi-die roll`,
    multiImpactRolls >= 1,
    `per-roll counts: ${JSON.stringify(perRollCounts)}`
  );
  check(
    `every one of ${REPEATS} real single-die rolls played at least one dice_impact sound (never silently zero)`,
    perRollCounts.every((n) => n >= 1),
    `per-roll counts: ${JSON.stringify(perRollCounts)}`
  );

  const overallMinGap = allGaps.length > 0 ? Math.min(...allGaps) : Infinity;
  check(
    `no two consecutive dice_impact plays for one die were spaced closer than the real rate limit allows (>= ~${MIN_ACCEPTABLE_GAP_MS}ms, MIN_DICE_IMPACT_INTERVAL_MS=${MIN_DICE_IMPACT_INTERVAL_MS}ms minus scheduling tolerance) — no machine-gun spam`,
    allGaps.length > 0 && overallMinGap >= MIN_ACCEPTABLE_GAP_MS,
    `gaps observed across multi-impact rolls: ${JSON.stringify(allGaps.map((g) => Math.round(g)))}`
  );

  // =========================================================================
  // Part 3 — a busier multi-die roll (4d6): more dice, more real collisions,
  // stronger evidence of several distinct impact sounds in one tumble.
  // =========================================================================
  const busyMarker = await markNow(dmPage);
  let busyRollId = null;
  for (let attempt = 0; attempt < 8 && !busyRollId; attempt++) {
    await fireFreeform(dmPage, "4d6");
    await sleep(250);
    const row = await latestRoll(campaignId, dm.id, "4d6");
    if (row) busyRollId = row.id;
  }
  check("the busier '4d6' roll produced a real roll_log row", busyRollId !== null);
  await sleep(FULL_ROLL_CYCLE_MS);
  const busyImpacts = await diceImpactsSince(dmPage, busyMarker);
  check(
    "the busier 4-die roll produced several distinct dice_impact plays during its tumble",
    busyImpacts.length >= 3,
    `count=${busyImpacts.length}`
  );

  // =========================================================================
  // Part 4 — private-roll visibility: the DM's own private roll's impact
  // sounds reach the DM's own client, and NEVER alice's — real two-client
  // check, mirroring verify-per-member-dice-trays.mjs's own visibility
  // convention applied to audio.
  // =========================================================================
  await dmPage.click('[data-testid="private-roll-toggle"]');
  const dmMarkerPrivate = await markNow(dmPage);
  const aliceMarkerPrivate = await markNow(alicePage);
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
    check("the private roll is persisted with visibility: 'private'", stored?.visibility === "private");
  }
  await sleep(FULL_ROLL_CYCLE_MS);
  const dmPrivateImpacts = await diceImpactsSince(dmPage, dmMarkerPrivate);
  const alicePrivateImpacts = await diceImpactsSince(alicePage, aliceMarkerPrivate);
  check(
    "the DM's own client plays real dice_impact sounds for their own private roll",
    dmPrivateImpacts.length > 0,
    `count=${dmPrivateImpacts.length}`
  );
  check(
    "CRITICAL: the DM's private roll's impact sounds NEVER reach alice's connected client at all — verified via alice's own real play log, not just tray visibility",
    alicePrivateImpacts.length === 0,
    `alice recorded ${alicePrivateImpacts.length} dice_impact play(s) during the DM's private roll: ${JSON.stringify(alicePrivateImpacts)}`
  );
  await dmPage.click('[data-testid="private-roll-toggle"]'); // back OFF

  // =========================================================================
  // Part 5 — a PUBLIC roll's impact sounds are heard on BOTH the roller's
  // own client and every other connected client that can see that roll's
  // tray (each client's own independent local physics simulation of the
  // SAME publicly-visible tray).
  // =========================================================================
  const aliceMarkerPublic = await markNow(alicePage);
  const dmMarkerPublic = await markNow(dmPage);
  let publicRollId = null;
  for (let attempt = 0; attempt < 5 && publicRollId === null; attempt++) {
    await alicePage.click('[data-testid="quick-roll-d20"]');
    await sleep(300);
    const row = await latestRoll(campaignId, alice.id, "1d20");
    if (row) publicRollId = row.id;
  }
  check("alice's public quick-roll creates a real roll_log row", publicRollId !== null);
  await sleep(FULL_ROLL_CYCLE_MS);
  const aliceOwnImpacts = await diceImpactsSince(alicePage, aliceMarkerPublic);
  const dmObservedImpacts = await diceImpactsSince(dmPage, dmMarkerPublic);
  check(
    "alice's own client plays real dice_impact sounds for her own public roll",
    aliceOwnImpacts.length > 0,
    `count=${aliceOwnImpacts.length}`
  );
  check(
    "the DM's client — which can see alice's publicly-visible tray — ALSO plays real dice_impact sounds for alice's public roll (its own independent local physics)",
    dmObservedImpacts.length > 0,
    `count=${dmObservedImpacts.length}`
  );

  check("no uncaught page error occurred during any dice-impact-sound roll", pageErrors.length === 0, pageErrors.join(" | "));
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
console.log("\nAll dice-impact-sound checks passed.");
process.exit(0);
