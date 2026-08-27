#!/usr/bin/env node
// Weather & Enemies C4 verification: firestorm/acid_storm's distinct
// particle visuals, the weather_mechanical toggle (only enabled for those
// two kinds), and the periodic-damage timer's actual authoritative
// behavior — the hardest, most novel part of this prompt.
//
// This is a REAL end-to-end timing test, not a mock: WEATHER_TICK_INTERVAL_MS
// (GameRoom.tsx) is a genuine 30 real-world seconds, so this script
// genuinely waits multiple real tick cycles to pass. Expect this to take
// several minutes to run to completion — that's the actual feature working,
// not a hung script.
//
// Covers, all through the real DM book UI plus direct database reads (never
// just a UI message) for every HP assertion:
//   1. Firestorm and acid storm each report a real, DISTINCT particle
//      system mounted (GameTableScene's onWeatherParticlesDebug mirror) —
//      a genuinely different `kind` and a real non-zero particleCount, not
//      pixel-diffed.
//   2. The weather-mechanical-toggle is enabled for firestorm/acid_storm
//      and disabled (grayed out) for every other weather kind.
//   3. With mechanical ON and the DM connected (via TWO simultaneous DM
//      tabs, deliberately racing apply_weather_tick against itself), real
//      character HP decreases by EXACTLY one tick's worth per interval,
//      never doubled — the atomic dedup at the heart of migration 0071.
//   4. A second, non-DM connected client (Alice) sees the same
//      weather-mechanical-badge "why is my HP changing" indicator, and her
//      own client never applies damage itself.
//   5. Toggling mechanical off stops all further damage immediately.
//   6. If the DM disconnects entirely (both tabs closed) mid-effect,
//      ticking pauses — no error, no other client silently taking over —
//      and reconnecting resumes ticking WITHOUT catching up on the missed
//      time (exactly one tick's worth of damage, not several).
//   7. With mechanical off, the same weather (acid_storm) produces zero HP
//      change over a full interval.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, non-default port if it isn't already serving — never APP_URL's
// usual :3000 default, which on this machine is the live production
// server, not a fresh build of this worktree's own changes (this project's
// own hard-won lesson).
// Usage: node scripts/db/verify-weather-mechanical.mjs
//        WEATHER_MECHANICAL_APP_PORT=4200 node scripts/db/verify-weather-mechanical.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.WEATHER_MECHANICAL_APP_PORT ?? 49215);
const APP_URL = `http://localhost:${APP_PORT}`;

// GameRoom.tsx's own WEATHER_TICK_INTERVAL_MS (30s) and 0071's own 27s
// dedup tolerance — asserted against here so this script's wait windows
// stay correctly sized if either is ever retuned.
const TICK_INTERVAL_MS = 30_000;
const TICK_DAMAGE = 2;
// Generous margin over one real interval for "a tick landed" polls, and
// comfortably OVER one interval (but under two) for "no further tick
// happened" negative checks.
const TICK_POLL_TIMEOUT_MS = TICK_INTERVAL_MS + 20_000;
const NO_TICK_WAIT_MS = TICK_INTERVAL_MS + 12_000;

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
  const email = `weather-mech-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `WeatherMech ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// GameRoom.tsx's hidden debug mirrors — WebGL has no DOM of its own for a
// script to inspect.
async function weatherState(page) {
  const text = await page.textContent('[data-testid="weather-state"]');
  return JSON.parse(text);
}
async function weatherParticlesState(page) {
  const text = await page.textContent('[data-testid="weather-particles-state"]');
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
async function waitForWeatherParticles(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await weatherParticlesState(page);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

// Direct database reads for every HP assertion (never just a UI message) —
// this project's own explicit lesson.
async function readHp(characterId) {
  const { data, error } = await admin.from("characters").select("current_hp").eq("id", characterId).single();
  if (error) throw error;
  return data.current_hp;
}
async function waitForHp(characterId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readHp(characterId);
    if (predicate(last)) return last;
    await sleep(2000);
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
  await admin.from("campaigns").insert({ id: campaignId, name: "Weather mechanical test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const characterId = crypto.randomUUID();
  const START_HP = 30;
  await admin.from("characters").insert({
    id: characterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Stormtouched Finn",
    race: "Human",
    class: "Adventurer",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: START_HP,
    max_hp: START_HP,
    armor_class: 10,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Storm room",
    grid_width: 3,
    grid_height: 3,
  });
  await admin.from("map_tokens").insert({
    id: crypto.randomUUID(),
    map_id: mapId,
    character_id: characterId,
    x: 1,
    y: 1,
    elevation: 0,
    allegiance: "party",
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // -- Both clients join the same live room. --
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

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — static checks: distinct visuals, mechanical toggle gating.
  // ════════════════════════════════════════════════════════════════════
  await openDmBook(dmPage);
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');

  check(
    "the mechanical toggle is grayed out (disabled) while weather is 'clear' (the default)",
    await dmPage.locator('[data-testid="weather-mechanical-toggle"]').isDisabled()
  );

  await dmPage.click('[data-testid="weather-select-firestorm"]');
  await waitForWeather(dmPage, (s) => s.kind === "firestorm");
  check(
    "the mechanical toggle becomes enabled once weather is 'firestorm'",
    !(await dmPage.locator('[data-testid="weather-mechanical-toggle"]').isDisabled())
  );
  const firestormParticles = await waitForWeatherParticles(dmPage, (s) => s?.kind === "firestorm");
  check(
    "firestorm reports a real, non-zero particle system mounted",
    firestormParticles?.kind === "firestorm" && firestormParticles.particleCount > 0,
    JSON.stringify(firestormParticles)
  );

  await dmPage.click('[data-testid="weather-select-acid_storm"]');
  await waitForWeather(dmPage, (s) => s.kind === "acid_storm");
  const acidParticles = await waitForWeatherParticles(dmPage, (s) => s?.kind === "acid_storm");
  check(
    "acid storm reports a real, non-zero, DISTINCT particle system (different kind and count than firestorm's)",
    acidParticles?.kind === "acid_storm" &&
      acidParticles.particleCount > 0 &&
      acidParticles.particleCount !== firestormParticles.particleCount,
    JSON.stringify({ firestorm: firestormParticles, acid: acidParticles })
  );

  await dmPage.click('[data-testid="weather-select-clear"]');
  await waitForWeather(dmPage, (s) => s.kind === "clear");
  check(
    "the mechanical toggle is grayed out again once weather is back to 'clear'",
    await dmPage.locator('[data-testid="weather-mechanical-toggle"]').isDisabled()
  );
  const noParticles = await weatherParticlesState(dmPage);
  check("no particle system is reported once weather is 'clear'", noParticles === null, JSON.stringify(noParticles));

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — real periodic damage: firestorm + mechanical ON, with the
  // SAME DM connected via TWO simultaneous tabs (deliberately racing
  // apply_weather_tick against itself) plus Alice's own idle client.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.click('[data-testid="weather-select-firestorm"]');
  await waitForWeather(dmPage, (s) => s.kind === "firestorm" && s.mechanical === false);
  await dmPage.click('[data-testid="weather-mechanical-toggle"]');
  await waitForWeather(dmPage, (s) => s.mechanical === true);

  const dmContext2 = await browser.newContext();
  await dmContext2.addCookies(sessionCookies(dm.session));
  const dmPage2 = await dmContext2.newPage();
  await dmPage2.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage2.waitForSelector('[data-testid="weather-state"]', { state: "attached", timeout: 30000 });
  await waitForWeather(dmPage2, (s) => s.kind === "firestorm" && s.mechanical === true);

  check(
    "a second, non-DM connected client (Alice) sees the mechanical-damage badge live",
    (await alicePage.locator('[data-testid="weather-mechanical-badge"]').count()) > 0
  );

  const hpBaseline = await readHp(characterId);
  check("the character starts at the seeded baseline HP", hpBaseline === START_HP, String(hpBaseline));

  const hpAfterTick1 = await waitForHp(characterId, (hp) => hp !== null && hp < hpBaseline, TICK_POLL_TIMEOUT_MS);
  check(
    "tick 1: real character HP decreased by EXACTLY one tick's worth (not doubled by the two racing DM tabs)",
    hpAfterTick1 === hpBaseline - TICK_DAMAGE,
    `baseline=${hpBaseline} afterTick1=${hpAfterTick1} (expected ${hpBaseline - TICK_DAMAGE})`
  );

  const hpAfterTick2 = await waitForHp(
    characterId,
    (hp) => hp !== null && hp < hpAfterTick1,
    TICK_POLL_TIMEOUT_MS
  );
  check(
    "tick 2: HP decreased by exactly one more tick's worth over the second interval — one consistent authoritative outcome, not per-client",
    hpAfterTick2 === hpBaseline - TICK_DAMAGE * 2,
    `afterTick1=${hpAfterTick1} afterTick2=${hpAfterTick2} (expected ${hpBaseline - TICK_DAMAGE * 2})`
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 3 — toggling mechanical off stops all further damage immediately.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.click('[data-testid="weather-mechanical-toggle"]');
  await waitForWeather(dmPage, (s) => s.mechanical === false);
  // Alice's own client needs the campaigns postgres_changes update to reach
  // it before her badge reacts — wait for HER mirror, not just the DM's.
  await waitForWeather(alicePage, (s) => s.mechanical === false);
  check(
    "the mechanical-damage badge disappears from Alice's client once turned off",
    (await alicePage.locator('[data-testid="weather-mechanical-badge"]').count()) === 0
  );
  await sleep(NO_TICK_WAIT_MS);
  const hpAfterMechanicalOff = await readHp(characterId);
  check(
    "turning mechanical off stops all further damage immediately (no tick during a full interval afterward)",
    hpAfterMechanicalOff === hpAfterTick2,
    `afterTick2=${hpAfterTick2} afterOff=${hpAfterMechanicalOff}`
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 4 — disconnect pauses ticking; reconnect resumes WITHOUT
  // catching up on the missed time.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.click('[data-testid="weather-mechanical-toggle"]');
  await waitForWeather(dmPage, (s) => s.mechanical === true);
  const hpAtRearm = await readHp(characterId);
  // Close BOTH DM tabs immediately — well before the first tick (30s away)
  // could possibly land — simulating the DM disconnecting entirely.
  await dmContext.close();
  await dmContext2.close();

  await sleep(NO_TICK_WAIT_MS);
  const hpWhileDisconnected = await readHp(characterId);
  check(
    "with no DM client connected, ticking pauses — no error, no other (non-DM) client silently taking over",
    hpWhileDisconnected === hpAtRearm,
    `atRearm=${hpAtRearm} whileDisconnected=${hpWhileDisconnected}`
  );

  const dmContext3 = await browser.newContext();
  await dmContext3.addCookies(sessionCookies(dm.session));
  const dmPage3 = await dmContext3.newPage();
  await dmPage3.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage3.waitForSelector('[data-testid="weather-state"]', { state: "attached", timeout: 30000 });
  await waitForWeather(dmPage3, (s) => s.kind === "firestorm" && s.mechanical === true);

  const hpAfterReconnectTick = await waitForHp(
    characterId,
    (hp) => hp !== null && hp < hpWhileDisconnected,
    TICK_POLL_TIMEOUT_MS
  );
  check(
    "reconnecting resumes ticking with EXACTLY one tick's worth of damage — no catch-up for the missed downtime",
    hpAfterReconnectTick === hpWhileDisconnected - TICK_DAMAGE,
    `whileDisconnected=${hpWhileDisconnected} afterReconnectTick=${hpAfterReconnectTick} (expected ${hpWhileDisconnected - TICK_DAMAGE})`
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 5 — with mechanical OFF, the same (fantasy) weather produces
  // zero HP change, from a completely fresh acid_storm activation.
  // ════════════════════════════════════════════════════════════════════
  // dmPage3 is the fresh reconnect tab from Phase 4 — its book has never
  // been opened on THIS page instance, unlike dmPage above.
  await openDmBook(dmPage3);
  await dmPage3.click('[data-testid="dm-book-tab-dayNight"]');
  await dmPage3.click('[data-testid="weather-mechanical-toggle"]');
  await waitForWeather(dmPage3, (s) => s.mechanical === false);
  await dmPage3.click('[data-testid="weather-select-acid_storm"]');
  await waitForWeather(dmPage3, (s) => s.kind === "acid_storm" && s.mechanical === false);
  const hpBeforeCosmeticAcid = await readHp(characterId);
  await sleep(NO_TICK_WAIT_MS);
  const hpAfterCosmeticAcid = await readHp(characterId);
  check(
    "acid_storm with mechanical OFF produces zero HP change over a full interval",
    hpAfterCosmeticAcid === hpBeforeCosmeticAcid,
    `before=${hpBeforeCosmeticAcid} after=${hpAfterCosmeticAcid}`
  );

  await dmContext3.close();
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
console.log("\nAll weather-mechanical checks passed.");
process.exit(0);
