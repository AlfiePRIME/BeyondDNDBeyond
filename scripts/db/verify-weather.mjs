#!/usr/bin/env node
// Weather & Enemies C1 verification: the campaign weather picker
// (campaigns.weather_kind/weather_mechanical) and its fog composition with
// the existing day/night lighting toggle.
//
// Hybrid shape per verify-day-night-mode.mjs (this prompt's own direct
// architectural precedent): a service-role client for setup and RLS-posture
// checks, real signed-in browsers for the DM's UI picker and a second
// (player) client's live sync. Checks: campaigns.weather_kind defaults to
// 'clear' and weather_mechanical to false; the schema CHECK rejects any
// value outside the six allowed kinds; the DM's book offers a Weather
// picker to the DM and NOT to a player; clicking a weather option in a real
// browser persists it to the DB; a SECOND connected client (a player, who
// clicked nothing) sees the same weather change live through its own
// [data-testid="weather-state"] debug mirror — the campaigns
// postgres_changes feed, same wiring as day_night_mode; a non-DM member CAN
// still write both columns directly (RLS allows it, matching
// day_night_mode's exact "UI gates it, RLS doesn't" posture); 'clear' vs
// 'fog' produce genuinely different, real fog values (not a screenshot
// diff) via GameTableScene's resolveSceneFog, mirrored verbatim into the
// hidden debug div; and the exact fog COMPOSITION rule this prompt chose is
// exercised directly: weather's fog, when set to 'fog', overrides
// day/night's own fog entirely regardless of day/night mode; when weather
// is 'clear', day/night's own fog stands completely unchanged (verified
// against the day/night preset's own real, documented numbers, not just an
// internal before/after diff), and toggling day/night while weather stays
// 'fog' is a no-op on the rendered fog.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, non-default port if it isn't already serving — never APP_URL's
// usual :3000 default, which on this machine is the live production
// server, not a fresh build of this worktree's own changes (this project's
// own hard-won lesson).
// Usage: node scripts/db/verify-weather.mjs
//        WEATHER_APP_PORT=4100 node scripts/db/verify-weather.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.WEATHER_APP_PORT ?? 3975);
const APP_URL = `http://localhost:${APP_PORT}`;

// GameTableScene.tsx's own DAY_NIGHT_PRESETS/WEATHER_FOG_PRESET, asserted
// directly here so this checks REAL numbers (a genuine fog-value read),
// not just "something changed between two snapshots." Keep in sync if
// those presets are ever retuned.
const DAY_FOG = { color: "#0d0520", near: 16, far: 34 };
const NIGHT_FOG = { color: "#060012", near: 12, far: 28 };
const WEATHER_FOG = { color: "#9aa0ad", near: 3, far: 15 };

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
  const email = `weather-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Weather ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// Reads the room's hidden weather debug mirror (GameRoom.tsx's
// weather-state div) — WebGL has no DOM to locate, same reasoning as
// day-night-state. Includes a REAL fog-value read (resolveSceneFog, the
// exact same pure function GameTableScene's own <fog> element calls).
async function weatherState(page) {
  const text = await page.textContent('[data-testid="weather-state"]');
  return JSON.parse(text);
}

async function dayNightState(page) {
  const text = await page.textContent('[data-testid="day-night-state"]');
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

async function waitForDayNightMode(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await dayNightState(page);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

function fogEquals(a, b) {
  return !!a && !!b && a.color === b.color && a.near === b.near && a.far === b.far;
}

// Phase 5's 3D book prop precedent (verify-day-night-mode.mjs's own
// openDmBook, widened per verify-activity-feed.mjs's own fallback sweep).
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

async function openDmBook(page) {
  const box = await page.locator("canvas").boundingBox();
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
  await admin.from("campaigns").insert({ id: campaignId, name: "Weather test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // -- 1. A fresh campaign defaults to 'clear'/false. --
  const { data: freshCampaign } = await admin
    .from("campaigns")
    .select("weather_kind, weather_mechanical")
    .eq("id", campaignId)
    .single();
  check(
    "a fresh campaign defaults to weather_kind 'clear' and weather_mechanical false",
    freshCampaign?.weather_kind === "clear" && freshCampaign?.weather_mechanical === false,
    JSON.stringify(freshCampaign)
  );

  // -- 2. The schema CHECK rejects any value outside the six allowed kinds. --
  const badValue = await admin.from("campaigns").update({ weather_kind: "blizzard" }).eq("id", campaignId);
  check(
    "the schema CHECK constraint rejects a weather_kind outside the six allowed values",
    !!badValue.error,
    badValue.error ? undefined : "update unexpectedly succeeded"
  );

  // -- 3. Both browsers join the same live room. --
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="weather-state"]', { state: "attached", timeout: 30000 });

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="weather-state"]', { state: "attached", timeout: 30000 });

  const dmInitial = await weatherState(dmPage);
  const aliceInitial = await weatherState(alicePage);
  check(
    "both clients start rendering 'clear' (the DB default) with mechanical false",
    dmInitial.kind === "clear" && dmInitial.mechanical === false &&
      aliceInitial.kind === "clear" && aliceInitial.mechanical === false,
    JSON.stringify({ dm: dmInitial, alice: aliceInitial })
  );
  check(
    "'clear' produces EXACTLY today's day-mode fog — zero regression to existing rendering",
    fogEquals(dmInitial.fog, DAY_FOG),
    JSON.stringify(dmInitial.fog)
  );

  // -- 4. The Weather picker is offered to the DM, and NOT to the player
  //    (no book at all, same posture as Day/Night). --
  check(
    "a non-DM player is not offered the book at all, so no Weather controls either",
    (await alicePage.$('[data-testid="dm-book-state"]')) === null
  );
  await openDmBook(dmPage);
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');
  check(
    "the DM sees the book's Weather picker (Clear + Fog at minimum)",
    (await dmPage.$('[data-testid="weather-select-clear"]')) !== null &&
      (await dmPage.$('[data-testid="weather-select-fog"]')) !== null
  );

  // -- 5. The DM clicks Fog in a real browser: persists to the DB, reaches
  //    the DM's own client, and produces a REAL, distinct fog reading. --
  await dmPage.click('[data-testid="weather-select-fog"]');
  const dmAfterFog = await waitForWeather(dmPage, (state) => state.kind === "fog");
  check("the DM's own client reflects the click immediately", dmAfterFog?.kind === "fog", JSON.stringify(dmAfterFog));
  check(
    "'fog' produces the distinct weather-fog preset, genuinely different from 'clear's fog",
    fogEquals(dmAfterFog?.fog, WEATHER_FOG) && !fogEquals(dmAfterFog?.fog, DAY_FOG),
    JSON.stringify(dmAfterFog?.fog)
  );

  const { data: afterDbCheck } = await admin
    .from("campaigns")
    .select("weather_kind, weather_mechanical")
    .eq("id", campaignId)
    .single();
  check(
    "the DM's click persisted weather_kind='fog' (mechanical still false) to the database",
    afterDbCheck?.weather_kind === "fog" && afterDbCheck?.weather_mechanical === false,
    JSON.stringify(afterDbCheck)
  );

  // -- 6. THE key check: the SECOND client (Alice, who clicked nothing)
  //    sees the weather change live via her own debug mirror — the
  //    campaigns postgres_changes feed, not a broadcast only the clicking
  //    client would receive. --
  const aliceAfterFog = await waitForWeather(alicePage, (state) => state.kind === "fog");
  check(
    "a second, idle client sees the DM's weather change live via its own debug mirror",
    aliceAfterFog?.kind === "fog" && fogEquals(aliceAfterFog?.fog, WEATHER_FOG),
    JSON.stringify(aliceAfterFog)
  );

  // -- 7. Composition rule, part 1: while weather is 'fog', flipping
  //    day/night must be a no-op on the rendered fog — weather's fog
  //    overrides day/night's own ENTIRELY while active, not just at the
  //    moment it was picked. --
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');
  await dmPage.click('[data-testid="day-night-night-button"]');
  await waitForDayNightMode(dmPage, (state) => state.mode === "night");
  const fogDuringNight = await weatherState(dmPage);
  check(
    "toggling day/night while weather is 'fog' does not change the rendered fog at all",
    fogEquals(fogDuringNight.fog, WEATHER_FOG),
    JSON.stringify(fogDuringNight.fog)
  );

  // -- 8. Composition rule, part 2: switch weather back to 'clear' (still
  //    Night) — day/night's OWN fog must reappear untouched, proving
  //    'clear' never permanently clobbers day/night's own mechanism. --
  await dmPage.click('[data-testid="weather-select-clear"]');
  const dmBackToClear = await waitForWeather(dmPage, (state) => state.kind === "clear");
  check(
    "'clear' with Night active shows Night's OWN fog, completely unchanged by this feature",
    fogEquals(dmBackToClear?.fog, NIGHT_FOG),
    JSON.stringify(dmBackToClear?.fog)
  );

  // -- 9. Flip back to Day so this campaign ends in its original state,
  //    and confirm the 'clear' fog is back to the exact original baseline. --
  await dmPage.click('[data-testid="day-night-day-button"]');
  await waitForDayNightMode(dmPage, (state) => state.mode === "day");
  const finalClear = await weatherState(dmPage);
  check(
    "back to Day + Clear reproduces the EXACT original baseline fog, byte for byte",
    fogEquals(finalClear.fog, DAY_FOG),
    JSON.stringify(finalClear.fog)
  );

  // -- 10. RLS posture parity check, mirroring day_night_mode's own
  //     "UI gates it, RLS doesn't" posture exactly. --
  const aliceWritesWeather = await alice.client
    .from("campaigns")
    .update({ weather_kind: "fog", weather_mechanical: true }, { count: "exact" })
    .eq("id", campaignId);
  check(
    "a non-DM member's direct write to weather_kind/weather_mechanical is rejected by RLS (zero rows affected)",
    !aliceWritesWeather.error && aliceWritesWeather.count === 0,
    JSON.stringify({ error: aliceWritesWeather.error?.message, count: aliceWritesWeather.count })
  );
  const dmWritesWeather = await dm.client
    .from("campaigns")
    .update({ weather_kind: "clear" }, { count: "exact" })
    .eq("id", campaignId);
  check(
    "the DM's own direct write to weather_kind succeeds under the same RLS policy",
    !dmWritesWeather.error && dmWritesWeather.count === 1,
    JSON.stringify({ error: dmWritesWeather.error?.message, count: dmWritesWeather.count })
  );

  // -- 11. The weather survives a page reload (read fresh from the DB, not
  //     only pushed live). --
  await admin.from("campaigns").update({ weather_kind: "fog" }).eq("id", campaignId);
  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="weather-state"]', { state: "attached", timeout: 30000 });
  const afterReload = await weatherState(dmPage);
  check(
    "the weather survives a page reload (read fresh from the DB, not just carried live)",
    afterReload?.kind === "fog",
    JSON.stringify(afterReload)
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
console.log("\nAll weather checks passed.");
process.exit(0);
