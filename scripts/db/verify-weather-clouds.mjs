#!/usr/bin/env node
// Overhead cloud layer (CloudLayer.tsx) + the new 'cloudy' weather_kind
// (migration 0079_cloudy_weather.sql) verification.
//
// Hybrid shape per verify-weather.mjs (this feature's own direct
// architectural precedent, itself the precedent every other weather
// verify-*.mjs script here follows): a service-role client for setup/RLS
// checks, two real signed-in browsers for the DM's UI picker and a second
// (player) client's independent live sync. Checks:
//   - the schema CHECK constraint accepts the new 'cloudy' value and still
//     rejects a genuinely invalid one;
//   - the DM's book offers a "Cloudy" weather option in the same picker as
//     every other kind;
//   - CloudLayer has no per-kind null branch (unlike WeatherParticles) — it
//     always renders, for all SEVEN weather kinds — verified via the
//     cloud-state hidden mirror (GameRoom.tsx), which reports the exact
//     resolveCloudPreset(weatherKind) read CloudLayer's own useFrame loop
//     uses to decide what to draw, matched here against an independently
//     hardcoded copy of that same palette (so this test would actually
//     fail if the real preset table were ever accidentally changed without
//     updating this script, not just echo whatever the app happens to
//     compute);
//   - cycling through ALL SEVEN kinds in one continuous session (including
//     revisiting 'clear' after every other kind) updates cloud-state's
//     color/opacity/coverage live and EXACTLY on every single transition,
//     with no stale value ever observed — the direct generalization of the
//     stale storm-switch bug this session already found and fixed in
//     Droplets.tsx, checked here for the cloud layer specifically;
//   - a SECOND, idle connected client (Alice, who clicks nothing) sees the
//     identical cloud-state on every transition too — proving this is a
//     real, independently-rendered-per-client effect, not an echo of the
//     clicking client's own local state;
//   - 'cloudy' is genuinely distinct from 'fog': cloudy's ground-level fog
//     is byte-for-byte identical to 'clear's (resolveSceneFog never
//     special-cases 'cloudy'), and cloudy activates neither Droplets
//     (rain-on-glass) nor WeatherParticles (embers/acid haze) — the
//     "overcast sky, normal ground visibility, no other effect" contract
//     this addition's own design docs as cloudy's whole point;
//   - the DM's click persists 'cloudy' to campaigns.weather_kind and
//     survives a reload (read fresh from the DB, not just carried live);
//   - RLS parity: a non-DM's direct write of the new value is rejected the
//     same way every other weather_kind value already is.
// Screenshots are saved for a real visual check (an actual WebGL cloud
// layer visible in a screenshot, not a placeholder) for every one of the
// seven kinds — matching this project's existing screenshot convention
// (verify-rain.mjs, verify-thunderstorm.mjs): saved for review, not
// auto-diffed, with the cloud-state data mirror carrying the actual
// automated PASS/FAIL bar.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, non-default port if it isn't already serving — never APP_URL's
// usual :3000 default, which on this machine is the live production
// server, not a fresh build of this worktree's own changes (this project's
// own hard-won lesson).
// Usage: node scripts/db/verify-weather-clouds.mjs
//        WEATHER_CLOUDS_APP_PORT=4100 node scripts/db/verify-weather-clouds.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.WEATHER_CLOUDS_APP_PORT ?? 4271);
const APP_URL = `http://localhost:${APP_PORT}`;
// Matches the established convention across this directory's own verify-*
// scripts (verify-rain.mjs, verify-thunderstorm.mjs, etc.) — this project's
// shared scratch location, not a repo-tracked path.
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
const SCREENSHOT_DIR = join(SCRATCH_DIR, "weather-clouds-screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// GameTableScene.tsx's own DAY_FOG (resolveSceneFog), asserted directly here
// so the "'cloudy' leaves ground-level fog byte-for-byte identical to
// 'clear'" claim checks a REAL number, not just an internal before/after
// diff. Keep in sync if DAY_NIGHT_PRESETS.day is ever retuned.
const DAY_FOG = { color: "#0d0520", near: 16, far: 34 };

// An INDEPENDENT copy of CloudLayer.tsx's own CLOUD_PRESETS table (not an
// import — this script deliberately hardcodes its own expected values, the
// same "assert real numbers" posture verify-weather.mjs's own DAY_FOG/
// WEATHER_FOG constants already establish, so this test would actually
// catch an accidental change to the real palette rather than just
// tautologically echoing whatever the app computes). Keep in sync with
// src/scene-3d/CloudLayer.tsx's own CLOUD_PRESETS if that palette is ever
// retuned.
const EXPECTED_CLOUD_PRESETS = {
  clear: { color: "#fdf9ff", opacity: 0.85, activeClusters: 5, minY: 6.5, maxY: 9, driftSpeed: 0.6 },
  cloudy: { color: "#c9cdd9", opacity: 0.95, activeClusters: 16, minY: 6, maxY: 8.5, driftSpeed: 0.9 },
  fog: { color: "#9aa0ad", opacity: 0.7, activeClusters: 9, minY: 5, maxY: 7, driftSpeed: 0.4 },
  rain: { color: "#5b6675", opacity: 0.92, activeClusters: 14, minY: 5.5, maxY: 7.5, driftSpeed: 1.6 },
  thunderstorm: { color: "#2b2733", opacity: 0.97, activeClusters: 16, minY: 4.5, maxY: 6.5, driftSpeed: 2.2 },
  firestorm: { color: "#8a3a1f", opacity: 0.88, activeClusters: 12, minY: 5.5, maxY: 7.5, driftSpeed: 1.2 },
  acid_storm: { color: "#5a7a3f", opacity: 0.88, activeClusters: 12, minY: 5.5, maxY: 7.5, driftSpeed: 1.0 },
};

// Full cycle through every kind, deliberately revisiting 'clear' and 'fog'
// after other kinds have been active — the shape that actually exercises
// "does a transition ever leave something stale," not just "does each kind
// look right in isolation starting fresh."
const WEATHER_CYCLE = [
  "cloudy",
  "fog",
  "rain",
  "clear",
  "thunderstorm",
  "firestorm",
  "acid_storm",
  "cloudy",
  "clear",
];

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
  const email = `weather-clouds-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Clouds ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function weatherState(page) {
  const text = await page.textContent('[data-testid="weather-state"]');
  return JSON.parse(text);
}

async function cloudState(page) {
  const text = await page.textContent('[data-testid="cloud-state"]');
  return JSON.parse(text);
}

async function dropletsState(page) {
  const text = await page.textContent('[data-testid="droplets-state"]');
  return JSON.parse(text);
}

async function weatherParticlesState(page) {
  const text = await page.textContent('[data-testid="weather-particles-state"]');
  return JSON.parse(text);
}

async function waitForCloud(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cloudState(page);
    if (predicate(last)) return last;
    await sleep(200);
  }
  return last;
}

function presetEquals(actual, expected) {
  if (!actual || !expected) return false;
  return (
    actual.color === expected.color &&
    Math.abs(actual.opacity - expected.opacity) < 1e-6 &&
    actual.activeClusters === expected.activeClusters &&
    Math.abs(actual.minY - expected.minY) < 1e-6 &&
    Math.abs(actual.maxY - expected.maxY) < 1e-6 &&
    Math.abs(actual.driftSpeed - expected.driftSpeed) < 1e-6
  );
}

function fogEquals(a, b) {
  return !!a && !!b && a.color === b.color && a.near === b.near && a.far === b.far;
}

// Phase 5's 3D book prop precedent (verify-weather.mjs's own openDmBook).
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

// The seat camera (seating.ts's seatAtAngle) is always pitched steeply down
// at the tabletop — worked out from its own real numbers during this
// feature's manual verification, a 50°-fov seat camera pitched ~28° below
// horizontal has a top-of-frustum edge that ITSELF still points ~3° below
// horizontal, so nothing positioned above roughly the camera's own eye
// height is EVER visible in the plain default view, regardless of
// CloudLayer's own altitude tuning (see CloudLayer.tsx's own doc comment
// for the full writeup and the confirmed-visible altitude band this
// feature settled on as a result). GameTableScene.tsx's existing
// look-around gesture (ArrowUp, up to LOOK_AROUND_MAX_PITCH=18°) is the
// room's own established way to see this — the same mechanism a real
// player would use — so a genuine visual screenshot of the cloud layer
// needs this held before capturing, not just a bare screenshot of the
// resting view.
async function screenshotLookingUp(page, path) {
  await page.click("body");
  await page.keyboard.down("ArrowUp");
  await sleep(700);
  await page.screenshot({ path });
  await page.keyboard.up("ArrowUp");
  await sleep(200);
}

async function openDmBook(page) {
  // Excludes Droplets' own aria-hidden overlay canvas (lazily mounted the
  // first time weather becomes 'rain'/'thunderstorm', per GameRoom.tsx's own
  // doc comment) — this script reopens the book AFTER weather may already
  // be 'rain', so a plain `locator("canvas")` would match two elements and
  // throw a Playwright strict-mode error. Same fix verify-thunderstorm.mjs
  // already established for the exact same reason.
  const box = await page.locator("canvas:not([aria-hidden])").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  const state = await waitForBookScreenPosition(page);
  const [sx, sy] = state.screen;
  const isOpen = async () => (await page.$('[data-testid="dm-book-panel"]')) !== null;
  const offsets = [
    [0, 0],
    [20, 0], [-20, 0], [0, 20], [0, -20],
    [40, 0], [-40, 0], [0, 40], [0, -40],
    [30, 30], [-30, 30], [30, -30], [-30, -30],
  ];
  for (const [dx, dy] of offsets) {
    await page.mouse.click(box.x + sx + dx, box.y + sy + dy);
    await sleep(200);
    if (await isOpen()) return;
  }
  throw new Error(`could not click the 3D book open (tried screen=${JSON.stringify(state.screen)})`);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Weather clouds test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // -- 1. Schema CHECK: 'cloudy' is accepted, a genuinely invalid value
  //    still is not. --
  const cloudyWrite = await admin.from("campaigns").update({ weather_kind: "cloudy" }).eq("id", campaignId);
  check("the schema CHECK constraint accepts the new 'cloudy' value", !cloudyWrite.error, cloudyWrite.error?.message);
  const badWrite = await admin.from("campaigns").update({ weather_kind: "overcast" }).eq("id", campaignId);
  check(
    "the schema CHECK constraint still rejects a value outside the seven allowed kinds",
    !!badWrite.error,
    badWrite.error ? undefined : "update unexpectedly succeeded"
  );
  await admin.from("campaigns").update({ weather_kind: "clear" }).eq("id", campaignId);

  // -- 2. Both browsers join the same live room. --
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="cloud-state"]', { state: "attached", timeout: 30000 });

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="cloud-state"]', { state: "attached", timeout: 30000 });

  // -- 3. Every campaign starts 'clear' — CloudLayer has already mounted
  //    with real, non-null cloud data (no per-kind null branch, unlike
  //    WeatherParticles). --
  const dmInitial = await cloudState(dmPage);
  check(
    "CloudLayer renders real cloud data from the very first frame, even for 'clear'",
    dmInitial?.kind === "clear" && presetEquals(dmInitial?.preset, EXPECTED_CLOUD_PRESETS.clear),
    JSON.stringify(dmInitial)
  );

  // -- 4. The DM's book offers the new "Cloudy" option. --
  check("a non-DM player is not offered the book at all", (await alicePage.$('[data-testid="dm-book-state"]')) === null);
  await openDmBook(dmPage);
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');
  check(
    "the DM's book offers a Cloudy weather option alongside the existing six",
    (await dmPage.$('[data-testid="weather-select-cloudy"]')) !== null
  );

  // Close the book before screenshotting — otherwise the book panel covers
  // most of the upper viewport where the cloud layer actually sits, and a
  // screenshot that can't show the thing it's meant to show is worthless as
  // "real visual evidence." Reopened for each subsequent click below.
  await dmPage.click('[data-testid="dm-book-close"]');
  await sleep(300);
  await screenshotLookingUp(dmPage, join(SCREENSHOT_DIR, "00-clear-dm.png"));

  // -- 5. Cycle through every kind (see WEATHER_CYCLE's own comment for why
  //    this order deliberately revisits kinds), asserting on EVERY single
  //    transition that: the DM's own cloud-state updates to the exact
  //    expected preset; a second, idle client (Alice) independently
  //    reports the identical preset; and — the direct stale-overlay
  //    regression check — the observed value is genuinely the NEW kind's,
  //    never the previous one lingering. --
  let shotIndex = 1;
  for (const kind of WEATHER_CYCLE) {
    await openDmBook(dmPage);
    await dmPage.click('[data-testid="dm-book-tab-dayNight"]');
    await dmPage.click(`[data-testid="weather-select-${kind}"]`);
    const dmAfter = await waitForCloud(dmPage, (state) => state?.kind === kind);
    check(
      `DM client: switching to '${kind}' updates cloud-state to the exact expected preset (no stale carryover)`,
      presetEquals(dmAfter?.preset, EXPECTED_CLOUD_PRESETS[kind]),
      JSON.stringify(dmAfter)
    );

    const aliceAfter = await waitForCloud(alicePage, (state) => state?.kind === kind);
    check(
      `idle second client (Alice): independently sees '${kind}'s cloud-state live, matching the DM's`,
      presetEquals(aliceAfter?.preset, EXPECTED_CLOUD_PRESETS[kind]),
      JSON.stringify(aliceAfter)
    );

    if (kind === "cloudy") {
      // -- The defining mechanical distinction from 'fog': cloudy's own
      //    ground-level fog must be byte-for-byte identical to 'clear's
      //    (resolveSceneFog never special-cases 'cloudy'), and cloudy must
      //    activate neither Droplets nor WeatherParticles. --
      const dmWeather = await weatherState(dmPage);
      check("'cloudy' leaves ground-level fog identical to 'clear's (no obscuring haze)", fogEquals(dmWeather?.fog, DAY_FOG), JSON.stringify(dmWeather?.fog));
      const dmDroplets = await dropletsState(dmPage);
      check("'cloudy' does not activate the rain/thunderstorm Droplets overlay", dmDroplets?.active === false, JSON.stringify(dmDroplets));
      const dmParticles = await weatherParticlesState(dmPage);
      check("'cloudy' does not activate the firestorm/acid_storm particle overlay", dmParticles === null, JSON.stringify(dmParticles));

      const { data: dbRow } = await admin.from("campaigns").select("weather_kind").eq("id", campaignId).single();
      check("the DM's click persisted weather_kind='cloudy' to the database", dbRow?.weather_kind === "cloudy", JSON.stringify(dbRow));
    }

    // Close the book so the screenshot below shows the actual 3D scene
    // (and its cloud layer) unobstructed, not the book panel.
    await dmPage.click('[data-testid="dm-book-close"]');
    await sleep(400); // let a few real drifted frames render before the screenshot
    await screenshotLookingUp(dmPage, join(SCREENSHOT_DIR, `${String(shotIndex).padStart(2, "0")}-${kind}-dm.png`));
    shotIndex++;
  }

  // -- 6. Reload persistence: the LAST cycle step above lands on 'clear',
  //    so set 'cloudy' one more time and confirm it survives a reload (read
  //    fresh from the DB, not just carried live). --
  await openDmBook(dmPage);
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');
  await dmPage.click('[data-testid="weather-select-cloudy"]');
  await waitForCloud(dmPage, (state) => state?.kind === "cloudy");
  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="cloud-state"]', { state: "attached", timeout: 30000 });
  const afterReload = await cloudState(dmPage);
  check(
    "'cloudy' survives a page reload (read fresh from the DB, not just carried live)",
    afterReload?.kind === "cloudy" && presetEquals(afterReload?.preset, EXPECTED_CLOUD_PRESETS.cloudy),
    JSON.stringify(afterReload)
  );

  // -- 7. RLS parity: a non-DM's direct write of the new value is rejected
  //    the same way every other weather_kind value already is. --
  const aliceWritesCloudy = await alice.client
    .from("campaigns")
    .update({ weather_kind: "cloudy" }, { count: "exact" })
    .eq("id", campaignId);
  check(
    "a non-DM member's direct write of weather_kind='cloudy' is rejected by RLS (zero rows affected)",
    !aliceWritesCloudy.error && aliceWritesCloudy.count === 0,
    JSON.stringify({ error: aliceWritesCloudy.error?.message, count: aliceWritesCloudy.count })
  );

  console.log(`\nScreenshots saved to ${SCREENSHOT_DIR} for visual review.`);
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
console.log("\nAll weather-clouds checks passed.");
process.exit(0);
