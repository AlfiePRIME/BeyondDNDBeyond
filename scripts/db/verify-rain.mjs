#!/usr/bin/env node
// Weather & Enemies C2 verification: rain-on-glass Droplets, layered on top
// of C1's weather_kind plumbing.
//
// Hybrid shape per verify-weather.mjs (this prompt's own direct
// architectural precedent): a service-role client seeds the starting
// campaign/members state directly (this project's own hard-won lesson —
// never a blind UI click-scan for setup), then two real signed-in browsers
// exercise the actual DM picker + live sync. Checks: Droplets mounts
// "always present" but inert (ready:true, active:false) while weather is
// 'clear'; the DM's own click to 'rain' both persists to the DB AND
// activates Droplets on the DM's own client; a SECOND, idle client (Alice)
// independently sees weatherKind='rain' live AND independently reports its
// OWN droplets-state ready:true/active:true (not just an echo of the DM's
// screen — every connected client renders its own WebGL instance); normal
// pointer interaction through the overlay still resolves (opening/closing
// the 3D DM book, a real raycasted canvas click, while rain is active —
// Droplets' output canvas is pointer-events:none, so this is the same
// underlying mechanism a cell click or chair drag would use); switching
// back to 'clear' cleanly deactivates Droplets on both clients with no
// lingering visual state. Screenshots are saved for a real visual check
// (an actual WebGL shader effect visible in a screenshot, not a
// placeholder) — this script cannot pixel-diff a screenshot meaningfully on
// its own (matches this project's existing screenshot convention: saved
// for review, not auto-diffed), so the automated PASS/FAIL bar here is the
// droplets-state/weather-state data mirrors, with screenshots as
// supporting evidence reviewed separately.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, non-default port if it isn't already serving — never APP_URL's
// usual :3000 default, which on this machine is the live production
// server, not a fresh build of this worktree's own changes (this project's
// own hard-won lesson).
// Usage: node scripts/db/verify-rain.mjs
//        RAIN_APP_PORT=4100 node scripts/db/verify-rain.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.RAIN_APP_PORT ?? 3976);
const APP_URL = `http://localhost:${APP_PORT}`;
// Matches the established convention across this directory's own verify-*
// scripts (verify-object-tint.mjs, verify-building-presets.mjs, etc.) —
// this project's shared scratch location, not a repo-tracked path.
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
const SCREENSHOT_DIR = join(SCRATCH_DIR, "rain-screenshots");
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
  const email = `rain-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Rain ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function weatherState(page) {
  const text = await page.textContent('[data-testid="weather-state"]');
  return JSON.parse(text);
}

// GameRoom.tsx's droplets-state mirror (Weather & Enemies C2) — WebGL has
// no DOM of its own, same reasoning as weather-state. `ready` proves
// Droplets' own WebGL2 instance genuinely initialized (not silently
// degraded); `active` mirrors what this specific client currently shows.
async function dropletsState(page) {
  const text = await page.textContent('[data-testid="droplets-state"]');
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

async function clickBookScreenPoint(page) {
  // Once Droplets has mounted (weather has been 'rain' at least once this
  // session), the page has TWO canvases — the real R3F scene and
  // Droplets' own decorative output canvas (aria-hidden, matching
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

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Rain test", creator: dm.id });
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

  const aliceContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="weather-state"]', { state: "attached", timeout: 30000 });
  await alicePage.waitForSelector('[data-testid="droplets-state"]', { state: "attached", timeout: 30000 });

  // -- 1. Droplets is lazily mounted — it has NOT been added to the DOM
  //    yet on a fresh campaign that starts 'clear' (see GameRoom.tsx's own
  //    dropletsMounted doc comment for why: mounting it unconditionally
  //    from page load added a second <canvas> to every Game Room page,
  //    which broke every OTHER existing verify-*.mjs script's generic
  //    `page.locator("canvas")` — a real regression caught by actually
  //    running this script during development, fixed by mounting it only
  //    once weather first becomes 'rain', not from page load). --
  const dmInitialDroplets = await dropletsState(dmPage);
  const aliceInitialDroplets = await dropletsState(alicePage);
  check(
    "Droplets has NOT mounted a canvas yet on a fresh 'clear' campaign (lazy mount, no extra DOM footprint until rain is actually used)",
    dmInitialDroplets?.mounted === false &&
      dmInitialDroplets?.ready === false &&
      aliceInitialDroplets?.mounted === false &&
      aliceInitialDroplets?.ready === false,
    JSON.stringify({ dm: dmInitialDroplets, alice: aliceInitialDroplets })
  );

  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "01-rain-off-dm.png") });

  // -- 2. The DM opens the book and clicks Rain in a real browser. --
  await openDmBook(dmPage);
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');
  check(
    "the DM's book offers a Rain option in the Weather picker",
    (await dmPage.$('[data-testid="weather-select-rain"]')) !== null
  );
  await dmPage.click('[data-testid="weather-select-rain"]');

  const dmAfterRain = await waitForWeather(dmPage, (state) => state.kind === "rain");
  check("the DM's own client reflects the click immediately", dmAfterRain?.kind === "rain", JSON.stringify(dmAfterRain));

  const { data: afterDbCheck } = await admin
    .from("campaigns")
    .select("weather_kind")
    .eq("id", campaignId)
    .single();
  check(
    "the DM's click persisted weather_kind='rain' to the database",
    afterDbCheck?.weather_kind === "rain",
    JSON.stringify(afterDbCheck)
  );

  // -- 3. The DM's own Droplets overlay activates. --
  const dmDropletsActive = await waitForDroplets(dmPage, (s) => s.active === true);
  check(
    "the DM's own Droplets overlay activates (ready AND active) when weather is 'rain'",
    dmDropletsActive?.ready === true && dmDropletsActive?.active === true,
    JSON.stringify(dmDropletsActive)
  );

  // -- 4. THE key check: a SECOND, idle client (Alice, who clicked
  //    nothing) sees the weather change live AND independently activates
  //    her OWN Droplets WebGL instance — not merely an echo of the DM's
  //    screen. --
  const aliceAfterRain = await waitForWeather(alicePage, (state) => state.kind === "rain");
  check(
    "a second, idle client sees the rain weather change live via its own debug mirror",
    aliceAfterRain?.kind === "rain",
    JSON.stringify(aliceAfterRain)
  );
  const aliceDropletsActive = await waitForDroplets(alicePage, (s) => s.active === true);
  check(
    "the second client's OWN Droplets overlay independently activates too (every connected client, not just the DM)",
    aliceDropletsActive?.ready === true && aliceDropletsActive?.active === true,
    JSON.stringify(aliceDropletsActive)
  );

  // Let a few real frames render with the shader live before screenshotting
  // — this is also the moment a human/visual reviewer should look at.
  await sleep(500);
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "02-rain-on-dm.png") });
  await alicePage.screenshot({ path: join(SCREENSHOT_DIR, "03-rain-on-alice.png") });

  // -- 5. Normal pointer interaction through the overlay still resolves:
  //    close the 3D DM book (a real raycasted canvas click) WHILE rain is
  //    active — Droplets' own output canvas is pointer-events:none, the
  //    same mechanism a cell click or chair drag would rely on. --
  const bookPointDuringRain = await clickBookScreenPoint(dmPage);
  await dmPage.mouse.click(bookPointDuringRain.x, bookPointDuringRain.y);
  await sleep(300);
  const bookClosedDuringRain = (await dmPage.$('[data-testid="dm-book-panel"]')) === null;
  check(
    "clicking through the active rain overlay still closes the 3D DM book (pointer events reach the scene beneath)",
    bookClosedDuringRain
  );
  // Reopen it (same click-through mechanism) so the next step can switch
  // weather back to clear.
  await dmPage.mouse.click(bookPointDuringRain.x, bookPointDuringRain.y);
  await sleep(300);
  const bookReopenedDuringRain = (await dmPage.$('[data-testid="dm-book-panel"]')) !== null;
  check(
    "clicking through the active rain overlay also reopens the 3D DM book",
    bookReopenedDuringRain
  );
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');

  // -- 6. Switching back to 'clear' removes the effect cleanly on both
  //    clients — no lingering visual/active state. --
  await dmPage.click('[data-testid="weather-select-clear"]');
  const dmBackToClear = await waitForWeather(dmPage, (state) => state.kind === "clear");
  check("the DM's own client reflects the switch back to clear", dmBackToClear?.kind === "clear");

  const dmDropletsInactive = await waitForDroplets(dmPage, (s) => s.active === false);
  check(
    "the DM's own Droplets overlay deactivates cleanly when weather leaves 'rain'",
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

  await sleep(300);
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "04-rain-off-after-dm.png") });

  console.log(`\nScreenshots saved to ${SCREENSHOT_DIR} for visual review:`);
  console.log("  01-rain-off-dm.png       — baseline, weather clear");
  console.log("  02-rain-on-dm.png        — DM's view with rain active");
  console.log("  03-rain-on-alice.png     — Alice's independently-rendered view with rain active");
  console.log("  04-rain-off-after-dm.png — back to clear, overlay gone");
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
console.log("\nAll rain checks passed.");
process.exit(0);
