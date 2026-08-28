#!/usr/bin/env node
// Sound Effects SP1 verification: the shared audio foundation (src/audio/
// soundManager.ts's playSound/startLoop/stopLoop + its SOUND_KEYS registry)
// plus the master volume/mute control (SoundControl.tsx, backed by
// profiles.ui_preferences.soundSettings — DraggablePanel.tsx's
// PanelLayoutProvider/useSoundSettings).
//
// Real signed-in Playwright browser throughout — every claim below is
// verified by reading the sound manager's own real state (a hidden
// "sound-manager-debug" JSON mirror, this project's established
// visionDebug/tableSurfaceDebug convention applied to the Web Audio graph,
// which — like a WebGL canvas — has no DOM of its own to inspect directly)
// or by a genuine direct-DB read via the admin/service-role client, never a
// mock. SP1 itself wires no real gameplay trigger to sound yet (that's
// SP3-SP8's job) — this script exercises playSound/startLoop/stopLoop via
// SoundControl's own test-harness buttons, driven with a real Playwright
// `.click()` (not a synthetic `dispatchEvent`, which never reached React's
// onClick handler at all in testing — see SoundControl.tsx's own doc
// comment on that harness for why its buttons are tiny/negligible rather
// than `hidden`, which a real pointer-based click can't target).
//
// Needs the local Supabase stack; starts (or reuses) its own dev server on
// a dedicated, pre-confirmed-free port.
// Usage: node scripts/db/verify-sound-infra.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 4795;
const APP_URL = `http://localhost:${PORT}`;

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
  console.log(`dev server not running on :${PORT} — starting yarn dev -p ${PORT}…`);
  devServer = spawn("yarn", ["dev", "-p", String(PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${PORT} within 120s`);
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
  const email = `sound-infra-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Sound Infra ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function readUiPreferences(userId) {
  const { data, error } = await admin.from("profiles").select("ui_preferences").eq("id", userId).single();
  if (error) throw error;
  return data.ui_preferences;
}

async function seedUiPreferences(userId, preferences) {
  const { error } = await admin.from("profiles").update({ ui_preferences: preferences }).eq("id", userId);
  if (error) throw error;
}

/** Reads and JSON.parses a hidden debug-mirror div's text content — the
 * visionDebug/tableSurfaceDebug convention (GameRoom.tsx) this project uses
 * wherever real state has no DOM of its own to inspect. */
async function readTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}

const readSoundDebug = (page) => readTestId(page, "sound-manager-debug");

/** Polls `readSoundDebug` until `predicate` is true or `timeoutMs` elapses
 * — every fade/debounce/realtime-echo check below needs real margin rather
 * than a fixed sleep, the verify-panel-dock.mjs/verify-avatar-reload-multi
 * .mjs "poll with a generous deadline" convention. */
async function waitForSoundDebug(page, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readSoundDebug(page);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  return last;
}

const VIEWPORT = { width: 1440, height: 900 };

await ensureDevServer();

const dm = await makeTestUser("dm");
// Extra flags beyond this project's shared GPU_LAUNCH_ARGS (lib/browser.mjs)
// — the standard Puppeteer/Playwright combination for disabling background/
// occluded-page throttling. Real Web Audio graphs can go idle (their render
// callback effectively stops advancing) after a stretch of pure silence on
// a backgrounded/occluded page even while `.state` still reports "running";
// soundManager.ts's own ensureContext() now also defensively calls
// `.resume()` on every real playback call for the same reason (belt and
// braces — confirmed necessary during this script's own development, since
// the throttling flags alone did not fully resolve it on this host).
const AUDIO_THROTTLE_WORKAROUND_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];
const browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS, ...AUDIO_THROTTLE_WORKAROUND_ARGS] });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Sound infra test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);
  await admin
    .from("campaign_maps")
    .insert({ id: crypto.randomUUID(), campaign_id: campaignId, name: "Sound Infra Map", grid_width: 10, grid_height: 10 });
  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  // =========================================================================
  // Part 0 — the generated files themselves: every registry key's file is
  // real and actually served by the app (not just present on disk). The
  // actual fetch checks run later, through the real authenticated page
  // (Part 2) — see REGISTRY_FILES' own usage below for why: proxy.ts's
  // route matcher does not exempt /sounds/** (only _next/static, _next/
  // image, favicon, and image extensions), so an UNAUTHENTICATED fetch
  // here gets silently 307-redirected to /login and resolves as "ok" with
  // a non-trivial byte count (the login page's own HTML) — a genuine false
  // positive confirmed directly during this script's own development
  // (`res.ok && bytes > 100` was true even though decodeAudioData on that
  // exact response later failed outright). Fetching through the real
  // signed-in page's own cookie jar (Part 2) is what makes this a genuine
  // check of the real, playable file.
  const REGISTRY_FILES = [
    // SP8 turned dice_impact into a 3-file pool (like hit_normal below) —
    // see soundManager.ts's own SOUND_FILES doc comment.
    "dice_impact_1.mp3",
    "dice_impact_2.mp3",
    "dice_impact_3.mp3",
    "pit_fall.mp3",
    "hit_normal_1.mp3",
    "hit_normal_2.mp3",
    "hit_normal_3.mp3",
    "hit_critical.mp3",
    "hit_miss.mp3",
    "token_move.mp3",
    "door_transition.mp3",
    "death.mp3",
    "rain_loop.mp3",
    "wind_loop.mp3",
    "fire_loop.mp3",
    "thunder.mp3",
    "nat_20.mp3",
    "nat_1.mp3",
  ];

  // =========================================================================
  // Part 1 — direct-DB shape check: soundSettings round-trips through
  // profiles.ui_preferences exactly like panelLayout does, and does NOT
  // clobber a coexisting panelLayout (the real lost-update bug this
  // feature's own design had to avoid — see profiles.ts's UiPreferences doc
  // comment and DraggablePanel.tsx's PanelLayoutProvider).
  // =========================================================================
  const freshPrefs = await readUiPreferences(dm.id);
  check(
    "a freshly created profile's ui_preferences has no soundSettings yet (absent, not a stub default)",
    freshPrefs && typeof freshPrefs === "object" && !("soundSettings" in freshPrefs),
    JSON.stringify(freshPrefs)
  );

  await seedUiPreferences(dm.id, {
    panelLayout: { combat: { x: 41, y: 42, collapsed: false } },
    soundSettings: { volume: 0.6, muted: true },
  });
  const roundTripped = await readUiPreferences(dm.id);
  check(
    "soundSettings round-trips byte-for-byte alongside a coexisting panelLayout",
    roundTripped?.soundSettings?.volume === 0.6 &&
      roundTripped?.soundSettings?.muted === true &&
      roundTripped?.panelLayout?.combat?.x === 41,
    JSON.stringify(roundTripped)
  );

  // Reset to a clean slate (a genuinely untouched profile) before the real
  // browser checks below, but seed a DISTINCTIVE panelLayout entry that
  // survives untouched through this whole script — the actual regression
  // guard for the two-independent-writers clobber bug: if either
  // provider's persist() ever regresses to a bare `{ panelLayout }` or `{
  // soundSettings }` write, this value gets silently wiped out somewhere
  // below.
  const SENTINEL_PANEL_LAYOUT = { combat: { x: 321, y: 123, collapsed: false } };
  await seedUiPreferences(dm.id, { panelLayout: SENTINEL_PANEL_LAYOUT });

  // =========================================================================
  // Part 2 — a real browser: the control renders, defaults to full/unmuted
  // on a genuinely untouched profile, and playSound/startLoop/stopLoop
  // produce real, observable Web Audio API state.
  // =========================================================================
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("[PAGEERROR]", err.message, "\n", err.stack));

  await page.goto(roomUrl);
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="sound-control"]', { timeout: 30000 });
  await sleep(500);

  // Real fetch + real decode, through the authenticated page's own cookie
  // jar and its own AudioContext — genuinely confirms each file is served,
  // non-empty, AND actually decodes as playable audio (see REGISTRY_FILES'
  // own doc comment above for why an unauthenticated Node-side fetch would
  // have been a false positive here).
  const fileChecks = await page.evaluate(async (files) => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const results = [];
    for (const file of files) {
      try {
        const res = await fetch(`/sounds/${file}`);
        const arrayBuffer = await res.arrayBuffer();
        const bytes = arrayBuffer.byteLength; // read BEFORE decodeAudioData, which detaches the buffer
        const buffer = await ctx.decodeAudioData(arrayBuffer);
        results.push({ file, ok: res.ok, bytes, duration: buffer.duration });
      } catch (err) {
        results.push({ file, ok: false, error: String(err) });
      }
    }
    return results;
  }, REGISTRY_FILES);
  for (const result of fileChecks) {
    check(
      `public/sounds/${result.file} is served (authenticated), non-empty, and decodes as real playable audio`,
      result.ok && result.bytes > 100 && result.duration > 0,
      JSON.stringify(result)
    );
  }

  check("the volume slider is visible in the top bar", await page.locator('[data-testid="sound-volume-slider"]').isVisible());
  check("the mute toggle is visible in the top bar", await page.locator('[data-testid="sound-mute-toggle"]').isVisible());

  const initialDebug = await readSoundDebug(page);
  check(
    "a genuinely untouched profile defaults to full volume, unmuted",
    initialDebug?.volume === 1 && initialDebug?.muted === false,
    JSON.stringify(initialDebug)
  );
  check(
    "no AudioContext exists yet — nothing has played a sound on this page",
    initialDebug?.audioContextState === "uninitialized",
    JSON.stringify(initialDebug)
  );

  // -- playSound produces genuine, scheduled Web Audio API playback. --
  await page.locator('[data-testid="sound-test-play-token_move"]').click();
  const afterPlay = await waitForSoundDebug(page, (d) => d.playLog.some((entry) => entry.key === "token_move"));
  check(
    "playSound(token_move) is recorded in the manager's own real play log",
    afterPlay?.playLog.some((entry) => entry.key === "token_move" && entry.url === "/sounds/token_move.mp3"),
    JSON.stringify(afterPlay?.playLog)
  );
  check(
    "a real AudioContext now exists (no longer 'uninitialized')",
    afterPlay?.audioContextState === "running" || afterPlay?.audioContextState === "suspended",
    JSON.stringify(afterPlay?.audioContextState)
  );

  // -- startLoop/stopLoop: a real loop channel starts, ramps to full gain,
  //    and — the Droplets.tsx-style discipline this manager's own doc
  //    comment calls out — fully cleans up on stop with no lingering node. --
  await page.locator('[data-testid="sound-test-start-loop-rain_loop"]').click();
  const loopStarting = await waitForSoundDebug(page, (d) => Boolean(d.activeLoops.rain_loop));
  check("startLoop(rain_loop) registers immediately as an active loop channel", Boolean(loopStarting?.activeLoops.rain_loop), JSON.stringify(loopStarting?.activeLoops));

  const loopActive = await waitForSoundDebug(
    page,
    (d) => d.activeLoops.rain_loop?.state === "active" && d.activeLoops.rain_loop.gainValue > 0.9,
    4000
  );
  check(
    "the loop's own gain node ramps up to (near) full gain once its crossfade-in completes",
    loopActive?.activeLoops.rain_loop?.state === "active" && loopActive.activeLoops.rain_loop.gainValue > 0.9,
    JSON.stringify(loopActive?.activeLoops.rain_loop)
  );

  await page.locator('[data-testid="sound-test-stop-loop-rain_loop"]').click();
  const loopStopping = await waitForSoundDebug(page, (d) => d.activeLoops.rain_loop?.state === "stopping", 2000);
  check(
    "stopping the loop transitions it to 'stopping' and its gain begins ramping down (not an instant cut)",
    loopStopping?.activeLoops.rain_loop?.state === "stopping",
    JSON.stringify(loopStopping?.activeLoops.rain_loop)
  );
  const loopStopped = await waitForSoundDebug(page, (d) => !d.activeLoops.rain_loop, 4000);
  check(
    "once the fade-out completes, the loop's audio node is fully torn down — never left lingering (Droplets discipline)",
    loopStopped && !loopStopped.activeLoops.rain_loop,
    JSON.stringify(loopStopped?.activeLoops)
  );

  // =========================================================================
  // Part 3 — master volume/mute measurably drives the REAL master GainNode,
  // including an ALREADY-PLAYING loop's live effective gain, not just future
  // sounds — the specific bar this prompt's acceptance criteria sets.
  // =========================================================================
  await page.locator('[data-testid="sound-test-start-loop-wind_loop"]').click();
  await waitForSoundDebug(page, (d) => d.activeLoops.wind_loop?.state === "active" && d.activeLoops.wind_loop.gainValue > 0.9, 4000);

  await page.locator('[data-testid="sound-volume-slider"]').fill("0");
  const afterVolumeZero = await waitForSoundDebug(page, (d) => d.masterGainValue === 0);
  check(
    "setting volume to 0 measurably drops the REAL master GainNode's gain value to exactly 0, verified directly",
    afterVolumeZero?.masterGainValue === 0,
    JSON.stringify({ volume: afterVolumeZero?.volume, masterGainValue: afterVolumeZero?.masterGainValue })
  );
  check(
    "the already-playing loop's OWN channel gain is untouched (the master stage is what mutes it, not each node individually)",
    afterVolumeZero?.activeLoops.wind_loop?.gainValue > 0.9,
    JSON.stringify(afterVolumeZero?.activeLoops.wind_loop)
  );

  await page.locator('[data-testid="sound-volume-slider"]').fill("1");
  const afterVolumeOne = await waitForSoundDebug(page, (d) => d.masterGainValue === 1);
  check("raising volume back to 1 restores the real master GainNode's gain to 1", afterVolumeOne?.masterGainValue === 1, JSON.stringify(afterVolumeOne?.masterGainValue));

  await page.locator('[data-testid="sound-mute-toggle"]').click();
  const afterMute = await waitForSoundDebug(page, (d) => d.muted === true && d.masterGainValue === 0);
  check(
    "mute=true drops the real master GainNode to 0 even though the volume preference itself is still 1",
    afterMute?.muted === true && afterMute?.masterGainValue === 0 && afterMute?.volume === 1,
    JSON.stringify(afterMute)
  );

  await page.locator('[data-testid="sound-mute-toggle"]').click();
  const afterUnmute = await waitForSoundDebug(page, (d) => d.muted === false && d.masterGainValue === 1);
  check(
    "unmuting restores exactly the previously-set volume (1), not a reset to some other default",
    afterUnmute?.muted === false && afterUnmute?.masterGainValue === 1,
    JSON.stringify(afterUnmute)
  );

  // =========================================================================
  // Part 4 — persistence: debounced write to profiles.ui_preferences, and
  // the specific regression this feature's design had to guard against —
  // persisting soundSettings must NOT clobber a coexisting panelLayout.
  // =========================================================================
  await page.locator('[data-testid="sound-volume-slider"]').fill("0.35");
  await waitForSoundDebug(page, (d) => Math.abs(d.masterGainValue - 0.35) < 0.005);

  let persisted = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    persisted = await readUiPreferences(dm.id);
    if (persisted?.soundSettings) break;
  }
  check(
    "the volume change persists to profiles.ui_preferences after the debounce",
    Math.abs((persisted?.soundSettings?.volume ?? -1) - 0.35) < 0.005 && persisted?.soundSettings?.muted === false,
    JSON.stringify(persisted?.soundSettings)
  );
  check(
    "CRITICAL: persisting soundSettings did NOT clobber the coexisting panelLayout sentinel written before this page ever loaded",
    persisted?.panelLayout?.combat?.x === SENTINEL_PANEL_LAYOUT.combat.x &&
      persisted?.panelLayout?.combat?.y === SENTINEL_PANEL_LAYOUT.combat.y,
    JSON.stringify(persisted?.panelLayout)
  );

  await page.reload();
  await page.waitForSelector('[data-testid="sound-control"]', { timeout: 30000 });
  await sleep(500);
  const afterReload = await readSoundDebug(page);
  check(
    "the persisted volume survives a full page reload",
    Math.abs((afterReload?.volume ?? -1) - 0.35) < 0.01,
    JSON.stringify(afterReload?.volume)
  );

  // Clean up the still-running wind_loop before the cross-tab section below
  // opens a second, independent page.
  await page.locator('[data-testid="sound-test-stop-loop-wind_loop"]').click();
  await waitForSoundDebug(page, (d) => !d.activeLoops.wind_loop, 3000);
  // Restore full/unmuted for a clean starting point for Part 5 — and, since
  // tab 2 (below) reads its OWN initial value via a fresh SSR fetch (not
  // from tab 1's live local state), wait for this restore to actually land
  // in the database before opening it. The verify-panel-dock.mjs precedent:
  // confirm gesture N's write is durably persisted before starting gesture
  // N+1, so two writes close together can't race/echo out of order.
  await page.locator('[data-testid="sound-volume-slider"]').fill("1");
  await waitForSoundDebug(page, (d) => d.masterGainValue === 1);
  let restorePersisted = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    restorePersisted = await readUiPreferences(dm.id);
    if (restorePersisted?.soundSettings?.volume === 1) break;
  }
  check(
    "(setup) the volume-1 restore is durably persisted before opening a second tab",
    restorePersisted?.soundSettings?.volume === 1,
    JSON.stringify(restorePersisted?.soundSettings)
  );

  // =========================================================================
  // Part 5 — cross-tab live sync: a volume change made in one tab reaches a
  // SECOND, already-open tab of the SAME account live (via the existing
  // subscribeToUiPreferencesChanges mechanism), and immediately updates that
  // second tab's own already-playing loop's REAL effective gain — not just
  // a value it happens to apply to the next sound played later.
  // =========================================================================
  const context2 = await browser.newContext({ viewport: VIEWPORT });
  await context2.addCookies(sessionCookies(dm.session));
  const page2 = await context2.newPage();
  page2.on("pageerror", (err) => console.error("[PAGEERROR tab2]", err.message, "\n", err.stack));
  await page2.goto(roomUrl);
  await page2.waitForSelector('[data-testid="sound-control"]', { timeout: 60000 });
  await sleep(500);

  const tab2Initial = await readSoundDebug(page2);
  check("the second tab loads with the already-persisted volume (1, from Part 3's restore)", tab2Initial?.volume === 1, JSON.stringify(tab2Initial?.volume));

  await page2.locator('[data-testid="sound-test-start-loop-fire_loop"]').click();
  await waitForSoundDebug(page2, (d) => d.activeLoops.fire_loop?.state === "active" && d.activeLoops.fire_loop.gainValue > 0.9, 4000);

  await page.locator('[data-testid="sound-volume-slider"]').fill("0.1");
  await waitForSoundDebug(page, (d) => Math.abs(d.masterGainValue - 0.1) < 0.005);

  const tab2AfterSync = await waitForSoundDebug(page2, (d) => Math.abs(d.masterGainValue - 0.1) < 0.02, 10000);
  check(
    "tab 1's volume change reaches tab 2 live via cross-tab sync, updating tab 2's REAL master GainNode",
    tab2AfterSync && Math.abs(tab2AfterSync.masterGainValue - 0.1) < 0.02,
    JSON.stringify({ volume: tab2AfterSync?.volume, masterGainValue: tab2AfterSync?.masterGainValue })
  );
  check(
    "tab 2's already-playing loop (started BEFORE the remote change arrived) is still reported active — the sync updated the master stage live, it didn't restart the loop",
    tab2AfterSync?.activeLoops.fire_loop?.state === "active",
    JSON.stringify(tab2AfterSync?.activeLoops.fire_loop)
  );

  await page2.locator('[data-testid="sound-test-stop-loop-fire_loop"]').click();
  await page.locator('[data-testid="sound-volume-slider"]').fill("1");
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
console.log("\nAll sound infrastructure checks passed.");
process.exit(0);
