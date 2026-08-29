#!/usr/bin/env node
// Regression check for the Game Room audio-leak fix (GameRoom.tsx's mount-
// once cleanup effect, `applyGameMusic(false, ...)` + `applyWeatherAudio
// ("clear")` on unmount): confirms this ALSO covers weather ambience
// (rain/wind/fire), not just calm/combat music — the project owner
// specifically reported weather effects were affected too.
//
// Uses a REAL client-side navigation (clicking the "<- campaignName" Link,
// data-testid="game-room-back-link") to leave the room, not page.goto()
// (which always forces a full page reload and would trivially "fix" this
// by resetting every module's state, including soundManager's own
// activeLoops — the exact bug verify-game-music.mjs's own Part 4 already
// guards against for game music; this script is the weather-audio sibling
// of that same check).
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, non-default port if it isn't already serving.
// Usage: node scripts/db/verify-weather-audio-stops-on-leave.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.WEATHER_LEAVE_APP_PORT ?? 4274);
const APP_URL = `http://localhost:${APP_PORT}`;

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
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
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
  throw new Error(`dev server did not become healthy on :${APP_PORT} within 120s`);
}

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
  const email = `weather-leave-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `WeatherLeave ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function readTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}

const soundDebug = (page) => readTestId(page, "sound-manager-debug");

async function waitForSoundDebug(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await soundDebug(page);
    if (last && predicate(last)) return last;
    await sleep(200);
  }
  return last;
}

// verify-thunderstorm.mjs/verify-weather-audio.mjs's own 3D-book-prop click
// precedent — the DM's book has no 2D DOM control to open it, only a real
// clickable 3D prop, projected to screen coordinates via the dm-book-state
// debug mirror.
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
  const box = await page.locator("canvas:not([aria-hidden])").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  const state = await waitForBookScreenPosition(page);
  const [sx, sy] = state.screen;
  return { x: box.x + sx, y: box.y + sy };
}

async function openDmBook(page) {
  const isOpen = async () => (await page.$('[data-testid="dm-book-panel"]')) !== null;
  if (await isOpen()) return;
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

async function selectWeather(page, kind) {
  await openDmBook(page);
  await page.click('[data-testid="dm-book-tab-dayNight"]');
  await page.click(`[data-testid="weather-select-${kind}"]`);
  await page.click('[data-testid="dm-book-close"]');
}

const AUDIO_THROTTLE_WORKAROUND_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS, ...AUDIO_THROTTLE_WORKAROUND_ARGS] });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Weather leave test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await page.waitForSelector('[data-testid="game-room-back-link"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });

  // Thunderstorm: BOTH rain_loop and wind_loop, the richest real case —
  // if the cleanup missed a channel, this is the one likeliest to expose it.
  await selectWeather(page, "thunderstorm");
  const beforeLeaving = await waitForSoundDebug(
    page,
    (d) =>
      d.activeLoops.rain_loop?.state === "active" &&
      d.activeLoops.rain_loop?.gainValue > 0.9 &&
      d.activeLoops.wind_loop?.state === "active" &&
      d.activeLoops.wind_loop?.gainValue > 0.9
  );
  check(
    "setup: thunderstorm's rain_loop AND wind_loop are genuinely playing before leaving the Game Room",
    beforeLeaving?.activeLoops.rain_loop?.state === "active" && beforeLeaving?.activeLoops.wind_loop?.state === "active",
    beforeLeaving?.activeLoops
  );

  await page.click('[data-testid="game-room-back-link"]');
  await page.waitForURL(`${APP_URL}/campaigns/${campaignId}`, { timeout: 15000 });
  const afterLeaving = await waitForSoundDebug(
    page,
    (d) => d.activeLoops.rain_loop === undefined && d.activeLoops.wind_loop === undefined && d.activeLoops.fire_loop === undefined
  );
  check(
    "leaving the Game Room via a real client-side navigation stops rain_loop (weather ambience, not just game music)",
    afterLeaving?.activeLoops.rain_loop === undefined,
    afterLeaving?.activeLoops
  );
  check(
    "wind_loop is also fully stopped",
    afterLeaving?.activeLoops.wind_loop === undefined,
    afterLeaving?.activeLoops
  );
  check(
    "fire_loop is also fully absent (never started this run, but confirms the cleanup resolves all three channels, not a partial fix)",
    afterLeaving?.activeLoops.fire_loop === undefined,
    afterLeaving?.activeLoops
  );

  check("no uncaught page error occurred during this run", pageErrors.length === 0, pageErrors.join("; "));

  await context.close();
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
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
console.log("\nAll weather-audio-stops-on-leave checks passed.");
process.exit(0);
