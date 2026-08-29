#!/usr/bin/env node
// Sound Effects SP9 regression: a real-user bug report — "the weather audio
// doesn't stop after being started sometimes, I just loaded into the game
// room and turned on the thunderstorm, then changed it to clear but the rain
// sound was playing." Intermittent, so this stress-tests the ACTUAL race
// window rather than asserting a single sequential cycle the way
// verify-weather-audio.mjs already does (that script is NOT extended in
// place — this is a dedicated script per this feature's own task
// description, since a many-trial stress harness has a genuinely different
// shape than a single deterministic cycle-through-every-kind check).
//
// Two things this script does that verify-weather-audio.mjs deliberately
// does not:
//   1. Configures REAL admin sound_overrides rows (rain_loop/wind_loop/
//      fire_loop) via the real /admin upload flow (setInputFiles against
//      SoundEffectsSection.tsx's own file input — the same mechanism
//      verify-sound-overrides.mjs already proves works), not a faked
//      shortcut. This matters because it's confirmed real-world admin setup
//      (the project owner's own campaigns have these), and it makes
//      resolveSoundUrl's per-loop lookup a REAL Supabase query plus a REAL
//      Storage fetch on every startLoop call instead of a same-origin static
//      asset read — meaningfully longer, more variable latency that widens
//      whatever timing window causes this bug in real play.
//   2. Fires MANY rapid on->off weather transitions through the real DM
//      book UI (handleSetWeather's own real click path, not a raw DB write —
//      the bug is about the CLIENT's own audio-loop state, which a raw DB
//      write would never exercise), sweeping a range of delays between the
//      "on" click and the "off" click — including a genuinely-simultaneous
//      "sync double click" variant (two native .click() calls issued inside
//      a single page.evaluate with no await between them, to probe whether
//      React's disabled-button re-render can actually be outraced) — and
//      asserting, after each one, via the sound manager's own real
//      getDebugSnapshot(), that every loop channel resolveWeatherAudio
//      ("clear") says should be silent is genuinely gone: not "active", not
//      "starting", not even lingering in "stopping" once its own fade
//      (DEFAULT_LOOP_FADE_MS + 50ms) has had time to complete.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on a
// fixed, non-default port if it isn't already serving.
// Usage: node scripts/db/verify-weather-audio-rapid-transitions.mjs
//        WEATHER_AUDIO_RAPID_APP_PORT=4276 node scripts/db/verify-weather-audio-rapid-transitions.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.WEATHER_AUDIO_RAPID_APP_PORT ?? 4276);
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
  throw new Error(`dev server did not become healthy within 120s`);
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
  const email = `weather-audio-rapid-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Weather Audio Rapid ${label}` });
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
const weatherAudioState = (page) => readTestId(page, "weather-audio-state");

const LOOP_KEYS = ["rain_loop", "wind_loop", "fire_loop"];

/** True once every loop key resolveWeatherAudio('clear') says should be
 * silent is genuinely ABSENT from activeLoops — not "active", not
 * "starting", not lingering in "stopping". This is the exact "no stuck/
 * leftover channel" bar verify-weather-audio.mjs's own activeLoopsMatch
 * already established. */
function allChannelsSilent(activeLoops) {
  return LOOP_KEYS.every((key) => activeLoops[key] === undefined);
}

// verify-weather-audio.mjs/verify-weather-audio-stops-on-leave.mjs's own 3D
// book-prop click precedent.
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

const VIEWPORT = { width: 1280, height: 800 };
const AUDIO_THROTTLE_WORKAROUND_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

// A real, existing, decodable audio file reused as the "replacement" upload
// for all three channels — verify-sound-overrides.mjs's own precedent
// (content doesn't matter for this stress test, only that resolveSoundUrl's
// override path is REAL: a real DB row plus a real Storage object fetch).
const REPLACEMENT_FILE_PATH = join(rootDir, "public", "sounds", "thunder.mp3");

const OVERRIDE_KEYS = ["rain_loop", "wind_loop", "fire_loop"];

// The stress matrix: delay is measured from the moment the "on" click is
// issued to the moment the "off" (clear) click is issued. `null` means "no
// explicit wait — click clear immediately, let Playwright's own
// actionability wait (button re-enables once weatherBusy clears) provide
// whatever the real minimum gap is." `"sync"` means a single page.evaluate
// firing BOTH native .click() calls with no await between them at all —
// probing whether two clicks can land inside the same pre-render window
// before React ever paints weatherBusy=true's disabled attribute.
const DELAYS_MS = [null, 0, 10, 30, 60, 120, 250, 500];
const REPEATS_PER_DELAY = 8;
const ON_KINDS = ["thunderstorm", "firestorm"];
const SYNC_REPEATS = 8;

async function clickWeather(page, kind) {
  await page.click(`[data-testid="weather-select-${kind}"]`);
}

async function syncDoubleClick(page, onKind, offKind) {
  await page.evaluate(
    ({ onKind, offKind }) => {
      const onBtn = document.querySelector(`[data-testid="weather-select-${onKind}"]`);
      const offBtn = document.querySelector(`[data-testid="weather-select-${offKind}"]`);
      onBtn?.click();
      offBtn?.click();
    },
    { onKind, offKind }
  );
}

const SETTLE_MS = 1400; // comfortably more than DEFAULT_LOOP_FADE_MS (700) + 50
const RECOVERY_SETTLE_MS = 2000;

const reproductions = [];

async function runTrial(page, { onKind, delayMs, sync }, index) {
  const label = sync ? `${onKind} -> clear (sync double-click)` : `${onKind} -> clear (delay=${delayMs}ms)`;

  if (sync) {
    await syncDoubleClick(page, onKind, "clear");
  } else if (delayMs === null) {
    await clickWeather(page, onKind);
    await clickWeather(page, "clear");
  } else {
    await clickWeather(page, onKind);
    await sleep(delayMs);
    await clickWeather(page, "clear");
  }

  await sleep(SETTLE_MS);
  const snapshot = await soundDebug(page);
  const audioState = await weatherAudioState(page);
  const ok = snapshot && allChannelsSilent(snapshot.activeLoops) && audioState?.kind === "clear";

  if (!ok) {
    const failure = {
      trial: index,
      label,
      activeLoops: snapshot?.activeLoops,
      weatherAudioStateKind: audioState?.kind,
    };
    reproductions.push(failure);
    console.error(`  REPRO #${reproductions.length} on trial ${index} (${label}): ${JSON.stringify(failure)}`);

    // Recovery attempt for diagnostic value: does an explicit fresh 'clear'
    // click fix it (self-heals given a clean input), or does it stay stuck
    // even after another direct attempt (a genuinely wedged state)?
    await clickWeather(page, "clear");
    await sleep(RECOVERY_SETTLE_MS);
    const recovered = await soundDebug(page);
    const recoveredAudioState = await weatherAudioState(page);
    const didRecover = recovered && allChannelsSilent(recovered.activeLoops) && recoveredAudioState?.kind === "clear";
    console.error(
      `    recovery after an extra explicit 'clear' click: ${didRecover ? "recovered" : "STILL STUCK"} — ${JSON.stringify(recovered?.activeLoops)}`
    );
    failure.recovered = didRecover;
  }

  return ok;
}

let browser = null;
const cleanupUserIds = [];
const cleanupOverrideKeys = [];

try {
  await ensureDevServer();
  browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS, ...AUDIO_THROTTLE_WORKAROUND_ARGS] });

  // =========================================================================
  // Setup 1: configure REAL sound_overrides rows for rain_loop/wind_loop/
  // fire_loop via the real /admin upload flow — mirrors the project owner's
  // own confirmed production setup, and this is what turns resolveSoundUrl's
  // per-key check into a real Supabase query + real Storage fetch on every
  // startLoop call, not a same-origin static asset read.
  // =========================================================================
  const adminUser = await makeTestUser("admin");
  cleanupUserIds.push(adminUser.id);
  await admin.from("profiles").update({ is_admin: true }).eq("id", adminUser.id);

  const adminContext = await browser.newContext({ viewport: VIEWPORT });
  await adminContext.addCookies(sessionCookies(adminUser.session));
  const adminPage = await adminContext.newPage();
  await adminPage.goto(`${APP_URL}/admin`, { waitUntil: "load" });
  await adminPage.waitForSelector('[data-testid="sound-effects-admin-section"]', { timeout: 30000 });

  for (const key of OVERRIDE_KEYS) {
    await adminPage.setInputFiles(`[data-testid="sound-override-file-input-${key}"]`, REPLACEMENT_FILE_PATH);
    await adminPage.waitForSelector(`[data-testid="sound-override-reset-${key}"]`, { timeout: 15000 });
    cleanupOverrideKeys.push(key);
  }
  console.log(`Configured real sound_overrides rows for: ${OVERRIDE_KEYS.join(", ")}`);
  await adminContext.close();

  // =========================================================================
  // Setup 2: the DM's own room, driven entirely through the real book UI.
  // =========================================================================
  const dm = await makeTestUser("dm");
  cleanupUserIds.push(dm.id);
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Weather audio rapid-transitions test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const dmContext = await browser.newContext({ viewport: VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  const pageErrors = [];
  dmPage.on("pageerror", (err) => pageErrors.push(String(err)));

  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });
  await dmPage.waitForSelector('[data-testid="weather-audio-state"]', { state: "attached", timeout: 30000 });

  const initial = await soundDebug(dmPage);
  check("fresh room starts with no weather-audio channels active", allChannelsSilent(initial?.activeLoops ?? {}), initial?.activeLoops);

  await openDmBook(dmPage);
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');
  // Deliberately left open for the whole stress run — DmBook's own weather
  // buttons don't require the book to be reopened between clicks, and
  // reopening it every trial (verify-weather-audio.mjs's own per-cycle
  // convention) would make a many-trial stress run far too slow to run
  // enough repetitions to have a real chance at a rare race.

  // =========================================================================
  // The stress loop.
  // =========================================================================
  let trialIndex = 0;
  const totalTrials = ON_KINDS.length * DELAYS_MS.length * REPEATS_PER_DELAY + ON_KINDS.length * SYNC_REPEATS;
  console.log(`\nRunning ${totalTrials} rapid on->off weather transition trials...\n`);

  for (const onKind of ON_KINDS) {
    for (const delayMs of DELAYS_MS) {
      for (let rep = 0; rep < REPEATS_PER_DELAY; rep++) {
        trialIndex++;
        await runTrial(dmPage, { onKind, delayMs }, trialIndex);
      }
    }
    for (let rep = 0; rep < SYNC_REPEATS; rep++) {
      trialIndex++;
      await runTrial(dmPage, { onKind, sync: true }, trialIndex);
    }
  }

  console.log(`\nCompleted ${trialIndex} trials. Reproductions: ${reproductions.length}.`);
  check(
    `no rapid on->off weather transition ever leaves a loop channel stuck active/starting (${trialIndex} trials across delays ${JSON.stringify(DELAYS_MS)} plus ${SYNC_REPEATS * ON_KINDS.length} sync double-clicks, kinds ${JSON.stringify(ON_KINDS)})`,
    reproductions.length === 0,
    reproductions
  );
  check("no uncaught page errors occurred during the stress run", pageErrors.length === 0, pageErrors.join("\n"));

  await dmContext.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const id of cleanupUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  // Sound overrides are a GLOBAL table (not scoped per campaign) — this
  // Supabase instance is shared with other work, so clean these up
  // regardless of how the run ended (belt-and-braces, verify-sound-
  // overrides.mjs's own precedent).
  for (const key of cleanupOverrideKeys) {
    try {
      const { data: row } = await admin.from("sound_overrides").select().eq("sound_key", key).maybeSingle();
      if (row) {
        await admin.storage.from("sound-overrides").remove([row.storage_ref]);
        await admin.from("sound_overrides").delete().eq("sound_key", key);
      }
    } catch {
      // Best-effort cleanup — never let this mask the real check results above.
    }
  }
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already gone.
    }
  }
}

if (reproductions.length > 0) {
  console.error(`\n${reproductions.length} reproduction(s) of the stuck-weather-audio bug found:`);
  console.error(JSON.stringify(reproductions, null, 2));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll weather-audio rapid-transition checks passed — no reproduction found.");
process.exit(0);
