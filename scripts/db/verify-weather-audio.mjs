#!/usr/bin/env node
// Sound Effects SP9 verification: weather ambience — resolveWeatherAudio's
// per-weather-kind rain/wind/fire loop channel matrix (src/audio/
// weatherAudio.ts), wired into SP1's own startLoop/stopLoop crossfade API,
// plus the `thunder` one-shot riding the exact same computeLightningFlash
// evaluation every client already runs for the visual flash
// (LightningFlash.tsx).
//
// Shape follows this project's own established weather verify-*.mjs
// precedent, per this feature's own Task description ("mirroring an
// existing weather verify script's own convention"): verify-weather-clouds
// .mjs's own hybrid shape (a service-role client for setup, two real
// signed-in browsers — a DM who drives the UI and an idle second client,
// Alice, who proves this is real per-client rendering, not an echo of the
// clicking client's own local state) and its own WEATHER_CYCLE (cycling
// through all seven kinds, deliberately REVISITING 'clear'/'cloudy' after
// other kinds — the direct generalization of the stale storm-switch bug
// this project already found and fixed in Droplets.tsx, checked here for
// weather audio specifically), plus verify-thunderstorm.mjs's own
// openDmBook/clickBookScreenPoint helpers (aware of Droplets' own second,
// aria-hidden canvas once it's mounted) and its own concurrent-dual-client
// polling technique for proving tight cross-event correlation without
// trusting a single sequential read.
//
// Checks, in order:
//   1. A fresh 'clear' campaign starts with zero weather-audio channels,
//      confirmed BOTH via the pure resolveWeatherAudio read (weather-audio-
//      state) and via the sound manager's own REAL active-loop debug state
//      (sound-manager-debug, SP1's getDebugSnapshot()) — no channel is
//      "expected off" only in theory.
//   2. Cycling through all seven kinds (WEATHER_CYCLE, including revisits)
//      activates EXACTLY the documented channel combination on every single
//      transition, on BOTH the DM's own client and an idle second client
//      (Alice) — with explicit, real dual-channel assertions for
//      thunderstorm (rain+wind together) and firestorm (wind+fire
//      together), not just "at least one channel active."
//   3. Every transition leaves NO stuck/leftover channel: a channel that
//      should be off is fully ABSENT from activeLoops (not merely
//      "stopping"), never lingering from the previous kind.
//   4. A real lightning flash during 'thunderstorm' triggers the `thunder`
//      one-shot on the SAME per-frame computeLightningFlash evaluation
//      every client already runs for the visual flash — verified on TWO
//      independent clients by polling each client's own lightning-state AND
//      sound-manager-debug CONCURRENTLY and confirming the thunder play-log
//      count increments within the same (or immediately following) poll
//      tick as that SAME client's own visual flash starting, for every
//      flash cycle observed, on both clients independently.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, non-default port if it isn't already serving — never APP_URL's
// usual :3000 default, which on this machine is the live production
// server, not a fresh build of this worktree's own changes (this project's
// own hard-won lesson).
// Usage: node scripts/db/verify-weather-audio.mjs
//        WEATHER_AUDIO_APP_PORT=4272 node scripts/db/verify-weather-audio.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.WEATHER_AUDIO_APP_PORT ?? 4272);
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
  const email = `weather-audio-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Weather Audio ${label}` });
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

const weatherAudioState = (page) => readTestId(page, "weather-audio-state");
const soundDebug = (page) => readTestId(page, "sound-manager-debug");
const lightningState = (page) => readTestId(page, "lightning-state");

async function waitForWeatherAudio(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await weatherAudioState(page);
    if (last && predicate(last)) return last;
    await sleep(200);
  }
  return last;
}

async function waitForSoundDebug(page, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await soundDebug(page);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  return last;
}

// The independently-hardcoded expected matrix (weatherAudio.ts's own
// resolveWeatherAudio) — matching verify-weather-clouds.mjs's own
// EXPECTED_CLOUD_PRESETS convention of asserting a REAL, separately-spelled
// -out table rather than just echoing whatever the app happens to compute,
// so this test would actually fail if the real matrix were ever
// accidentally changed without updating this script too.
const EXPECTED_CHANNELS = {
  clear: { rain: false, wind: false, fire: false },
  fog: { rain: false, wind: true, fire: false },
  cloudy: { rain: false, wind: false, fire: false },
  rain: { rain: true, wind: false, fire: false },
  thunderstorm: { rain: true, wind: true, fire: false },
  firestorm: { rain: false, wind: true, fire: true },
  acid_storm: { rain: false, wind: true, fire: false },
};

const LOOP_KEY_BY_CHANNEL = { rain: "rain_loop", wind: "wind_loop", fire: "fire_loop" };

function channelsEqual(actual, expected) {
  return !!actual && actual.rain === expected.rain && actual.wind === expected.wind && actual.fire === expected.fire;
}

/** True once `activeLoops` (sound-manager-debug's real state) matches
 * `expected` EXACTLY: every channel expected ON is present, state "active",
 * and past its own crossfade-in (gainValue > 0.9); every channel expected
 * OFF is fully ABSENT from the map (not merely "stopping") — the direct
 * "no stuck/leftover channel" check. */
function activeLoopsMatch(activeLoops, expected) {
  for (const channel of Object.keys(LOOP_KEY_BY_CHANNEL)) {
    const loopKey = LOOP_KEY_BY_CHANNEL[channel];
    const entry = activeLoops[loopKey];
    if (expected[channel]) {
      if (!entry || entry.state !== "active" || entry.gainValue <= 0.9) return false;
    } else {
      if (entry) return false;
    }
  }
  return true;
}

// Full cycle through every kind, deliberately revisiting 'clear' and
// 'cloudy' after other kinds have been active — verify-weather-clouds.mjs's
// own precedent for exercising "does a transition ever leave something
// stale," not just "does each kind look right starting fresh."
const WEATHER_CYCLE = ["cloudy", "fog", "rain", "clear", "thunderstorm", "firestorm", "acid_storm", "cloudy", "clear"];

// Matches lightning.ts's own LIGHTNING_BUCKET_MS (kept as a plain literal
// here rather than importing TS source into this plain .mjs script, the
// exact convention verify-thunderstorm.mjs already established) — used only
// to size how long this script needs to poll to observe several real flash
// cycles.
const LIGHTNING_BUCKET_MS = 4500;
const OBSERVE_CYCLES = 6;
const OBSERVE_DURATION_MS = LIGHTNING_BUCKET_MS * OBSERVE_CYCLES;
const POLL_MS = 60;
// A flash and its thunder one-shot originate from the SAME tick() call in
// LightningFlash.tsx (see that file's own doc comment) — the only latency
// between them is a few already-resolved-promise microtask ticks (thunder's
// buffer is pre-warmed below before this window starts), utterly negligible
// against this POLL_MS granularity. Two poll ticks of slack is generous
// without being loose enough to mask a real decoupling bug.
const CORRELATION_TOLERANCE_TICKS = 2;

// Phase 5's 3D book prop precedent (verify-weather-clouds.mjs/
// verify-thunderstorm.mjs's own openDmBook).
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
  // scene and Droplets' own decorative output canvas (aria-hidden). `canvas`
  // alone would be a strict-mode Playwright violation at that point — the
  // exact fix verify-thunderstorm.mjs already established.
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

async function selectWeather(page, kind) {
  await openDmBook(page);
  await page.click('[data-testid="dm-book-tab-dayNight"]');
  await page.click(`[data-testid="weather-select-${kind}"]`);
  await page.click('[data-testid="dm-book-close"]');
}

/** Concurrently polls both clients' lightning-state AND sound-manager-debug
 * for `durationMs`, tracking (per client, independently): the poll-tick
 * index each real flash starts at (lightning-state's own `active` flag
 * flipping false->true — a NEW flash beginning) and the poll-tick index the
 * `thunder` play-log entry count increments at. Reading both testids inside
 * the SAME Promise.all per client per tick means a flash and its thunder
 * trigger — genuinely originating from the exact same tick() call
 * (LightningFlash.tsx) — are essentially always observed in the identical
 * poll tick, not merely "close in wall-clock time." */
async function collectFlashAndThunder(dmPage, alicePage, durationMs) {
  const deadline = Date.now() + durationMs;
  const history = {
    dm: { flashes: [], thunders: [] },
    alice: { flashes: [], thunders: [] },
  };
  let prevDmActive = false;
  let prevAliceActive = false;
  let prevDmThunderCount = null;
  let prevAliceThunderCount = null;
  let tick = 0;
  while (Date.now() < deadline) {
    const [dmLight, dmSound, aliceLight, aliceSound] = await Promise.all([
      lightningState(dmPage),
      soundDebug(dmPage),
      lightningState(alicePage),
      soundDebug(alicePage),
    ]);
    const dmThunderCount = dmSound.playLog.filter((e) => e.key === "thunder").length;
    const aliceThunderCount = aliceSound.playLog.filter((e) => e.key === "thunder").length;
    if (prevDmThunderCount === null) prevDmThunderCount = dmThunderCount;
    if (prevAliceThunderCount === null) prevAliceThunderCount = aliceThunderCount;

    if (dmLight.active && !prevDmActive) history.dm.flashes.push({ tick, bucket: dmLight.bucket });
    if (dmThunderCount > prevDmThunderCount) history.dm.thunders.push({ tick, count: dmThunderCount });
    if (aliceLight.active && !prevAliceActive) history.alice.flashes.push({ tick, bucket: aliceLight.bucket });
    if (aliceThunderCount > prevAliceThunderCount) history.alice.thunders.push({ tick, count: aliceThunderCount });

    prevDmActive = dmLight.active;
    prevAliceActive = aliceLight.active;
    prevDmThunderCount = dmThunderCount;
    prevAliceThunderCount = aliceThunderCount;
    tick++;
    await sleep(POLL_MS);
  }
  return history;
}

/** For every detected flash, is there a thunder-count increment within
 * CORRELATION_TOLERANCE_TICKS poll ticks? Returns the worst (largest)
 * tick-distance observed, or Infinity if any flash has no matching thunder
 * at all — so a single missing thunder fails loudly rather than being
 * averaged away. */
function worstFlashThunderSkew(flashes, thunders) {
  if (flashes.length === 0) return Infinity;
  let worst = 0;
  for (const flash of flashes) {
    let best = Infinity;
    for (const thunder of thunders) {
      const distance = Math.abs(thunder.tick - flash.tick);
      if (distance < best) best = distance;
    }
    if (best === Infinity) return Infinity;
    worst = Math.max(worst, best);
  }
  return worst;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
// Same background-throttling workaround verify-sound-infra.mjs's own
// development confirmed necessary on this host — a real Web Audio graph can
// otherwise go idle on a backgrounded/occluded page even while `.state`
// still reports "running."
const AUDIO_THROTTLE_WORKAROUND_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];
const browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS, ...AUDIO_THROTTLE_WORKAROUND_ARGS] });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Weather audio test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="weather-audio-state"]', { state: "attached", timeout: 30000 });
  await dmPage.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });

  const aliceContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="weather-audio-state"]', { state: "attached", timeout: 30000 });
  await alicePage.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });

  // -- 1. A fresh 'clear' campaign starts with zero weather-audio channels,
  //    confirmed both as the pure "should be" read and the real "is"
  //    active-loop state. --
  const dmInitialAudio = await weatherAudioState(dmPage);
  check(
    "resolveWeatherAudio reports zero channels for a fresh 'clear' campaign",
    dmInitialAudio?.kind === "clear" && channelsEqual(dmInitialAudio?.channels, EXPECTED_CHANNELS.clear),
    JSON.stringify(dmInitialAudio)
  );
  const dmInitialSound = await soundDebug(dmPage);
  check(
    "the sound manager's own real active-loop debug state also reports zero weather channels initially",
    Object.keys(dmInitialSound?.activeLoops ?? { x: 1 }).length === 0,
    JSON.stringify(dmInitialSound?.activeLoops)
  );

  // -- 2/3. Cycle through every kind, asserting on EVERY transition: the
  //    exact expected channel combo (pure read, both clients), the exact
  //    REAL active-loop state matching it (no stuck/leftover channel), and
  //    — for the two dual-channel kinds — an explicit BOTH-channels-at-once
  //    assertion. --
  for (const kind of WEATHER_CYCLE) {
    await selectWeather(dmPage, kind);

    const dmAudio = await waitForWeatherAudio(dmPage, (state) => state.kind === kind);
    check(
      `DM client: switching to '${kind}' updates weather-audio-state to the exact expected channel combination`,
      channelsEqual(dmAudio?.channels, EXPECTED_CHANNELS[kind]),
      JSON.stringify(dmAudio)
    );

    const aliceAudio = await waitForWeatherAudio(alicePage, (state) => state.kind === kind);
    check(
      `idle second client (Alice): independently sees '${kind}'s expected channel combination live, matching the DM's`,
      channelsEqual(aliceAudio?.channels, EXPECTED_CHANNELS[kind]),
      JSON.stringify(aliceAudio)
    );

    const dmLoops = await waitForSoundDebug(dmPage, (d) => activeLoopsMatch(d.activeLoops, EXPECTED_CHANNELS[kind]), 6000);
    check(
      `DM client: the REAL active-loop state (getDebugSnapshot) matches '${kind}'s expected channels exactly — no stuck/leftover channel from the previous kind`,
      activeLoopsMatch(dmLoops?.activeLoops ?? {}, EXPECTED_CHANNELS[kind]),
      JSON.stringify(dmLoops?.activeLoops)
    );

    const aliceLoops = await waitForSoundDebug(alicePage, (d) => activeLoopsMatch(d.activeLoops, EXPECTED_CHANNELS[kind]), 6000);
    check(
      `second client (Alice): her OWN independently-rendered real active-loop state also matches '${kind}'s expected channels exactly`,
      activeLoopsMatch(aliceLoops?.activeLoops ?? {}, EXPECTED_CHANNELS[kind]),
      JSON.stringify(aliceLoops?.activeLoops)
    );

    if (kind === "thunderstorm") {
      check(
        "thunderstorm activates BOTH rain AND wind simultaneously (a real dual-channel case, not just 'at least one')",
        dmLoops?.activeLoops.rain_loop?.state === "active" && dmLoops?.activeLoops.wind_loop?.state === "active",
        JSON.stringify(dmLoops?.activeLoops)
      );
      check(
        "thunderstorm does NOT activate the fire channel",
        dmLoops?.activeLoops.fire_loop === undefined,
        JSON.stringify(dmLoops?.activeLoops)
      );
    }

    if (kind === "firestorm") {
      check(
        "firestorm activates BOTH wind AND fire simultaneously (a real dual-channel case, not just 'at least one')",
        dmLoops?.activeLoops.wind_loop?.state === "active" && dmLoops?.activeLoops.fire_loop?.state === "active",
        JSON.stringify(dmLoops?.activeLoops)
      );
      check(
        "firestorm does NOT activate the rain channel",
        dmLoops?.activeLoops.rain_loop === undefined,
        JSON.stringify(dmLoops?.activeLoops)
      );
    }
  }

  // -- 4. The synchronized thunder one-shot: pre-warm the thunder buffer on
  //    both clients (a real decode/fetch only needs to happen once ever —
  //    doing it here keeps the timing-sensitive correlation window below
  //    from being skewed by the FIRST play's own network/decode latency,
  //    which every subsequent cached play never pays), switch to
  //    'thunderstorm', then prove the flash and its thunder trigger stay
  //    tightly correlated on BOTH clients independently. --
  await dmPage.locator('[data-testid="sound-test-play-thunder"]').click();
  await alicePage.locator('[data-testid="sound-test-play-thunder"]').click();
  await waitForSoundDebug(dmPage, (d) => d.playLog.some((e) => e.key === "thunder"));
  await waitForSoundDebug(alicePage, (d) => d.playLog.some((e) => e.key === "thunder"));

  await selectWeather(dmPage, "thunderstorm");
  await waitForWeatherAudio(dmPage, (state) => state.kind === "thunderstorm");
  await waitForWeatherAudio(alicePage, (state) => state.kind === "thunderstorm");

  console.log(
    `\nObserving lightning+thunder for ${(OBSERVE_DURATION_MS / 1000).toFixed(1)}s (~${OBSERVE_CYCLES} flash cycles) on both clients...`
  );
  const history = await collectFlashAndThunder(dmPage, alicePage, OBSERVE_DURATION_MS);

  check(
    `the DM's client observed multiple real flashes (${history.dm.flashes.length} detected)`,
    history.dm.flashes.length >= OBSERVE_CYCLES - 2,
    JSON.stringify(history.dm.flashes)
  );
  check(
    `Alice's client observed multiple real flashes (${history.alice.flashes.length} detected)`,
    history.alice.flashes.length >= OBSERVE_CYCLES - 2,
    JSON.stringify(history.alice.flashes)
  );
  check(
    `the DM's client observed a matching number of thunder triggers (${history.dm.thunders.length} thunders vs ${history.dm.flashes.length} flashes)`,
    history.dm.thunders.length >= history.dm.flashes.length,
    JSON.stringify(history.dm)
  );
  check(
    `Alice's client observed a matching number of thunder triggers (${history.alice.thunders.length} thunders vs ${history.alice.flashes.length} flashes)`,
    history.alice.thunders.length >= history.alice.flashes.length,
    JSON.stringify(history.alice)
  );

  const dmSkew = worstFlashThunderSkew(history.dm.flashes, history.dm.thunders);
  check(
    `the DM's OWN client: every detected flash has a matching thunder trigger within ${CORRELATION_TOLERANCE_TICKS} poll ticks (~${CORRELATION_TOLERANCE_TICKS * POLL_MS}ms) — the SAME per-frame computeLightningFlash evaluation drives both (worst observed skew: ${dmSkew} ticks)`,
    dmSkew <= CORRELATION_TOLERANCE_TICKS,
    JSON.stringify(history.dm)
  );
  const aliceSkew = worstFlashThunderSkew(history.alice.flashes, history.alice.thunders);
  check(
    `Alice's OWN, independently-rendered client shows the identical tight flash-thunder correlation (worst observed skew: ${aliceSkew} ticks) — proof this is per-client evaluation, not an echo of the DM's`,
    aliceSkew <= CORRELATION_TOLERANCE_TICKS,
    JSON.stringify(history.alice)
  );

  const dmBuckets = [...new Set(history.dm.flashes.map((f) => f.bucket))];
  const commonBuckets = dmBuckets.filter((bucket) => history.alice.flashes.some((f) => f.bucket === bucket));
  check(
    `both clients agree on which deterministic schedule "bucket" each flash landed in (${commonBuckets.length} shared cycles) — the same zero-cross-client-skew guarantee lightning.ts's own visual flash already has, extended here to its paired thunder trigger`,
    commonBuckets.length >= OBSERVE_CYCLES - 2,
    JSON.stringify({ dm: history.dm.flashes, alice: history.alice.flashes })
  );

  // -- Switching away from thunderstorm stops both channels cleanly and no
  //    further thunder ever fires again. --
  await selectWeather(dmPage, "clear");
  const dmClearAudio = await waitForWeatherAudio(dmPage, (state) => state.kind === "clear");
  check("switching back to 'clear' updates weather-audio-state", channelsEqual(dmClearAudio?.channels, EXPECTED_CHANNELS.clear));
  const dmClearLoops = await waitForSoundDebug(dmPage, (d) => activeLoopsMatch(d.activeLoops, EXPECTED_CHANNELS.clear), 6000);
  check(
    "leaving thunderstorm fully stops BOTH rain_loop and wind_loop — no stuck/leftover channel",
    activeLoopsMatch(dmClearLoops?.activeLoops ?? {}, EXPECTED_CHANNELS.clear),
    JSON.stringify(dmClearLoops?.activeLoops)
  );

  const preClearThunderCount = (await soundDebug(dmPage)).playLog.filter((e) => e.key === "thunder").length;
  const postClearDeadline = Date.now() + LIGHTNING_BUCKET_MS * 1.5;
  let sawExtraThunder = false;
  while (Date.now() < postClearDeadline) {
    const current = await soundDebug(dmPage);
    if (current.playLog.filter((e) => e.key === "thunder").length > preClearThunderCount) {
      sawExtraThunder = true;
      break;
    }
    await sleep(150);
  }
  check("no further thunder fires after switching away from thunderstorm", !sawExtraThunder);
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
console.log("\nAll weather-audio checks passed.");
process.exit(0);
