#!/usr/bin/env node
// Weather & Enemies C3 verification: thunderstorm — C2's Droplets rain
// overlay reused as-is, plus a synchronized lightning flash on top.
//
// Same hybrid shape as verify-rain.mjs (this prompt's own direct
// architectural precedent, itself following verify-weather.mjs): a
// service-role client seeds the starting campaign/members state directly
// (this project's own hard-won lesson — never a blind UI click-scan for
// setup), then two real signed-in browsers exercise the actual DM picker,
// live sync, and the rain/lightning overlays each client independently
// renders.
//
// The one thing genuinely worth real care here (per the C3 prompt's own
// Notes) is proving the DM and a player see the EXACT SAME lightning flash
// at the EXACT SAME moment — not two independently-randomized schedules
// that happen to look similar. This script proves that directly: it polls
// BOTH clients' `lightning-state` hidden mirrors concurrently (Promise.all,
// not sequential — minimizes the read-skew between the two samples) for
// long enough to observe several real flash cycles, records the moment
// each client's own `active` flag flips false->true (a real flash
// beginning), and asserts that for every flash cycle observed by both
// clients: (a) the deterministic `bucket` index matches exactly — proof
// they are evaluating the IDENTICAL schedule, not just coincidentally
// close — and (b) the detected start moments are within a tight wall-clock
// tolerance of each other.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, non-default port if it isn't already serving — never APP_URL's
// usual :3000 default, which on this machine is the live production
// server, not a fresh build of this worktree's own changes (this project's
// own hard-won lesson).
// Usage: node scripts/db/verify-thunderstorm.mjs
//        THUNDERSTORM_APP_PORT=4101 node scripts/db/verify-thunderstorm.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.THUNDERSTORM_APP_PORT ?? 3977);
const APP_URL = `http://localhost:${APP_PORT}`;
// Matches the established convention across this directory's own verify-*
// scripts (verify-rain.mjs, verify-object-tint.mjs, etc.) — this project's
// shared scratch location, not a repo-tracked path.
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
const SCREENSHOT_DIR = join(SCRATCH_DIR, "thunderstorm-screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Matches lightning.ts's own LIGHTNING_BUCKET_MS (kept as a plain literal
// here rather than importing TS source into this plain .mjs script) — used
// only to size how long this script needs to poll to observe several real
// flash cycles, not to compute the schedule itself.
const LIGHTNING_BUCKET_MS = 4500;
const OBSERVE_CYCLES = 6;
const OBSERVE_DURATION_MS = LIGHTNING_BUCKET_MS * OBSERVE_CYCLES;
const POLL_MS = 60;
// Generous relative to POLL_MS/the LightningFlash debug-tick throttle
// (40ms) — see this file's own top comment: this is checking "did the two
// clients' detected flash-start moments land close together", not
// asserting sub-frame precision.
const SYNC_TOLERANCE_MS = 300;

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
  console.log(`dev server not running on :${APP_PORT} — starting this worktree's own…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
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
  const email = `thunderstorm-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Storm ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function weatherState(page) {
  const text = await page.textContent('[data-testid="weather-state"]');
  return JSON.parse(text);
}

// GameRoom.tsx's droplets-state mirror (Weather & Enemies C2, reused as-is
// for C3's own rain layer) — WebGL has no DOM of its own, same reasoning as
// weather-state.
async function dropletsState(page) {
  const text = await page.textContent('[data-testid="droplets-state"]');
  return JSON.parse(text);
}

// GameRoom.tsx's lightning-state mirror (Weather & Enemies C3) — the plain
// DOM overlay div also has no state a test can read deterministically
// (opacity is written straight onto the node via a ref, bypassing React,
// per LightningFlash.tsx's own doc comment) — `bucket` is the deterministic
// schedule index every client's own computeLightningFlash resolves `now`
// to; `active`/`opacity` are that same computation's momentary result.
async function lightningState(page) {
  const text = await page.textContent('[data-testid="lightning-state"]');
  return JSON.parse(text);
}

async function waitForWeather(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await weatherState(page);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

async function waitForDroplets(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await dropletsState(page);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

// Phase 5's 3D book prop precedent (verify-rain.mjs's own openDmBook).
async function readDmBookState(page) {
  const el = await page.$('[data-testid="dm-book-state"]');
  if (!el) return null;
  return JSON.parse(await el.textContent());
}

async function waitForBookScreenPosition(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readDmBookState(page);
    if (last?.screen) return last;
    await sleep(100);
  }
  throw new Error(`dm-book-state never reported a screen projection — last: ${JSON.stringify(last)}`);
}

async function clickBookScreenPoint(page) {
  // Once Droplets has mounted (weather has been 'rain'/'thunderstorm' at
  // least once this session), the page has TWO canvases — the real R3F
  // scene and Droplets' own decorative output canvas (aria-hidden, matching
  // Glitch/VHS/ForceField's own convention). `canvas` alone would be a
  // strict-mode violation at that point, so target the real scene canvas
  // explicitly.
  const box = await page.locator("canvas:not([aria-hidden])").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  const state = await waitForBookScreenPosition(page);
  const [sx, sy] = state.screen;
  return { x: box.x + sx, y: box.y + sy };
}

async function openDmBook(page) {
  const isOpen = async () => (await page.$('[data-testid="dm-book-panel"]')) !== null;
  const point = await clickBookScreenPoint(page);
  const offsets = [
    [0, 0],
    [20, 0], [-20, 0], [0, 20], [0, -20],
    [40, 0], [-40, 0], [0, 40], [0, -40],
    [30, 30], [-30, 30], [30, -30], [-30, -30],
  ];
  for (const [dx, dy] of offsets) {
    await page.mouse.click(point.x + dx, point.y + dy);
    await sleep(200);
    if (await isOpen()) return;
  }
  throw new Error(`could not click the 3D book open (tried screen point=${JSON.stringify(point)})`);
}

// Polls both clients' lightning-state CONCURRENTLY (Promise.all, not
// sequential reads) for `durationMs`, recording the wall-clock moment each
// client's own `active` flag flips false->true (the moment THAT client
// believes a flash just started) plus the deterministic `bucket` it landed
// in. Returns { dm: [{t, bucket}], alice: [{t, bucket}] }.
async function collectFlashTransitions(dmPage, alicePage, durationMs) {
  const deadline = Date.now() + durationMs;
  const history = { dm: [], alice: [] };
  let wasActive = { dm: false, alice: false };
  while (Date.now() < deadline) {
    const now = Date.now();
    const [dmState, aliceState] = await Promise.all([lightningState(dmPage), lightningState(alicePage)]);
    if (dmState.active && !wasActive.dm) history.dm.push({ t: now, bucket: dmState.bucket });
    if (aliceState.active && !wasActive.alice) history.alice.push({ t: now, bucket: aliceState.bucket });
    wasActive = { dm: dmState.active, alice: aliceState.active };
    await sleep(POLL_MS);
  }
  return history;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Thunderstorm test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="weather-state"]', { state: "attached", timeout: 30000 });
  await dmPage.waitForSelector('[data-testid="droplets-state"]', { state: "attached", timeout: 30000 });
  await dmPage.waitForSelector('[data-testid="lightning-state"]', { state: "attached", timeout: 30000 });

  const aliceContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="weather-state"]', { state: "attached", timeout: 30000 });
  await alicePage.waitForSelector('[data-testid="droplets-state"]', { state: "attached", timeout: 30000 });
  await alicePage.waitForSelector('[data-testid="lightning-state"]', { state: "attached", timeout: 30000 });

  // -- 1. Fresh 'clear' campaign: no lightning, Droplets not yet mounted. --
  const dmInitialLightning = await lightningState(dmPage);
  const aliceInitialLightning = await lightningState(alicePage);
  check(
    "lightning is inactive on a fresh 'clear' campaign on both clients",
    dmInitialLightning?.active === false && aliceInitialLightning?.active === false,
    JSON.stringify({ dm: dmInitialLightning, alice: aliceInitialLightning })
  );

  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "01-clear-dm.png") });

  // -- 2. The DM opens the book and clicks Thunderstorm in a real browser. --
  await openDmBook(dmPage);
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');
  check(
    "the DM's book offers a Thunderstorm option in the Weather picker",
    (await dmPage.$('[data-testid="weather-select-thunderstorm"]')) !== null
  );
  await dmPage.click('[data-testid="weather-select-thunderstorm"]');

  const dmAfterStorm = await waitForWeather(dmPage, (state) => state.kind === "thunderstorm");
  check(
    "the DM's own client reflects the click immediately",
    dmAfterStorm?.kind === "thunderstorm",
    JSON.stringify(dmAfterStorm)
  );

  const { data: afterDbCheck } = await admin
    .from("campaigns")
    .select("weather_kind")
    .eq("id", campaignId)
    .single();
  check(
    "the DM's click persisted weather_kind='thunderstorm' to the database",
    afterDbCheck?.weather_kind === "thunderstorm",
    JSON.stringify(afterDbCheck)
  );

  // -- 3. C2's Droplets rain layer is reused as-is: it activates on BOTH
  //    clients exactly like plain 'rain' does. Waits for BOTH `active` AND
  //    `ready` together (not `active` alone, then a separate snapshot read
  //    of `ready`) — Droplets is mounting for the FIRST time this session
  //    right here (dropletsMounted's own doc comment), and `active` (a
  //    plain derivation of weatherKind) can genuinely go true a render or
  //    two before the freshly-mounted WebGL2 instance's own `ready` catches
  //    up; checking them as a single joint predicate avoids ever observing
  //    that brief, real gap as a false failure. --
  const dmDropletsActive = await waitForDroplets(dmPage, (s) => s.active === true && s.ready === true);
  check(
    "the DM's own Droplets rain overlay activates under 'thunderstorm' too (reused from C2)",
    dmDropletsActive?.ready === true && dmDropletsActive?.active === true,
    JSON.stringify(dmDropletsActive)
  );
  const aliceAfterStorm = await waitForWeather(alicePage, (state) => state.kind === "thunderstorm");
  check(
    "a second, idle client sees the thunderstorm weather change live via its own debug mirror",
    aliceAfterStorm?.kind === "thunderstorm",
    JSON.stringify(aliceAfterStorm)
  );
  const aliceDropletsActive = await waitForDroplets(alicePage, (s) => s.active === true && s.ready === true);
  check(
    "the second client's OWN Droplets overlay independently activates too",
    aliceDropletsActive?.ready === true && aliceDropletsActive?.active === true,
    JSON.stringify(aliceDropletsActive)
  );

  // -- 4. THE key check: poll both clients' lightning-state CONCURRENTLY
  //    for several real flash cycles and prove they see the exact same
  //    flash at the exact same moment — not independently randomized. --
  console.log(
    `\nObserving lightning for ${(OBSERVE_DURATION_MS / 1000).toFixed(1)}s (~${OBSERVE_CYCLES} flash cycles) on both clients...`
  );
  const history = await collectFlashTransitions(dmPage, alicePage, OBSERVE_DURATION_MS);

  check(
    `the DM's client observed multiple real flashes (${history.dm.length} detected)`,
    history.dm.length >= OBSERVE_CYCLES - 2,
    JSON.stringify(history.dm)
  );
  check(
    `Alice's client observed multiple real flashes (${history.alice.length} detected)`,
    history.alice.length >= OBSERVE_CYCLES - 2,
    JSON.stringify(history.alice)
  );

  const dmByBucket = new Map(history.dm.map((entry) => [entry.bucket, entry.t]));
  const aliceByBucket = new Map(history.alice.map((entry) => [entry.bucket, entry.t]));
  const commonBuckets = [...dmByBucket.keys()].filter((bucket) => aliceByBucket.has(bucket));
  check(
    `both clients agree on which deterministic schedule "bucket" each flash landed in (${commonBuckets.length} shared flash cycles) — proof they're running the IDENTICAL schedule, not two independently-randomized ones`,
    commonBuckets.length >= OBSERVE_CYCLES - 2,
    JSON.stringify({ dmBuckets: [...dmByBucket.keys()], aliceBuckets: [...aliceByBucket.keys()] })
  );

  let maxSkewMs = 0;
  const skewDetails = [];
  for (const bucket of commonBuckets) {
    const skew = Math.abs(dmByBucket.get(bucket) - aliceByBucket.get(bucket));
    skewDetails.push({ bucket, dmT: dmByBucket.get(bucket), aliceT: aliceByBucket.get(bucket), skewMs: skew });
    maxSkewMs = Math.max(maxSkewMs, skew);
  }
  check(
    `every shared flash's detected start moment agrees between the DM and Alice within ${SYNC_TOLERANCE_MS}ms (max observed skew: ${maxSkewMs}ms)`,
    maxSkewMs <= SYNC_TOLERANCE_MS,
    JSON.stringify(skewDetails)
  );

  await sleep(200);
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "02-thunderstorm-dm.png") });
  await alicePage.screenshot({ path: join(SCREENSHOT_DIR, "03-thunderstorm-alice.png") });

  // -- 5. Normal pointer interaction through the overlays still resolves:
  //    close the 3D DM book (a real raycasted canvas click) WHILE
  //    thunderstorm (rain + lightning) is active. --
  const bookPointDuringStorm = await clickBookScreenPoint(dmPage);
  await dmPage.mouse.click(bookPointDuringStorm.x, bookPointDuringStorm.y);
  await sleep(300);
  const bookClosedDuringStorm = (await dmPage.$('[data-testid="dm-book-panel"]')) === null;
  check(
    "clicking through the active rain+lightning overlays still closes the 3D DM book (pointer events reach the scene beneath)",
    bookClosedDuringStorm
  );
  await dmPage.mouse.click(bookPointDuringStorm.x, bookPointDuringStorm.y);
  await sleep(300);
  const bookReopenedDuringStorm = (await dmPage.$('[data-testid="dm-book-panel"]')) !== null;
  check("clicking through the active overlays also reopens the 3D DM book", bookReopenedDuringStorm);
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');

  // -- 6. Switching away from thunderstorm stops BOTH the rain and the
  //    flashes cleanly on every client — and STAYS stopped (not just
  //    "happened to be between flashes" when we checked). --
  await dmPage.click('[data-testid="weather-select-clear"]');
  const dmBackToClear = await waitForWeather(dmPage, (state) => state.kind === "clear");
  check("the DM's own client reflects the switch back to clear", dmBackToClear?.kind === "clear");

  const dmDropletsInactive = await waitForDroplets(dmPage, (s) => s.active === false);
  check(
    "the DM's own Droplets rain overlay deactivates when weather leaves 'thunderstorm'",
    dmDropletsInactive?.ready === true && dmDropletsInactive?.active === false,
    JSON.stringify(dmDropletsInactive)
  );
  const aliceAfterClear = await waitForWeather(alicePage, (state) => state.kind === "clear");
  const aliceDropletsInactive = await waitForDroplets(alicePage, (s) => s.active === false);
  check(
    "the second client sees 'clear' live and its own Droplets overlay also deactivates",
    aliceAfterClear?.kind === "clear" &&
      aliceDropletsInactive?.ready === true &&
      aliceDropletsInactive?.active === false,
    JSON.stringify({ alice: aliceAfterClear, aliceDroplets: aliceDropletsInactive })
  );

  // Watch for a while — long enough to have spanned at least one more
  // would-be flash cycle if lightning were (incorrectly) still scheduled —
  // and confirm it NEVER reports active again on either client.
  const postClearDeadline = Date.now() + LIGHTNING_BUCKET_MS * 1.5;
  let sawLightningAfterClear = false;
  while (Date.now() < postClearDeadline) {
    const [dmState, aliceState] = await Promise.all([lightningState(dmPage), lightningState(alicePage)]);
    if (dmState.active || aliceState.active) {
      sawLightningAfterClear = true;
      break;
    }
    await sleep(150);
  }
  check(
    "no further lightning flash occurs on either client after switching away from thunderstorm",
    sawLightningAfterClear === false
  );

  await sleep(200);
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "04-clear-after-dm.png") });

  console.log(`\nScreenshots saved to ${SCREENSHOT_DIR} for visual review:`);
  console.log("  01-clear-dm.png             — baseline, weather clear");
  console.log("  02-thunderstorm-dm.png      — DM's view with rain + lightning active");
  console.log("  03-thunderstorm-alice.png   — Alice's independently-rendered view, same storm");
  console.log("  04-clear-after-dm.png       — back to clear, both overlays gone");
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
console.log("\nAll thunderstorm checks passed.");
process.exit(0);
