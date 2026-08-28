#!/usr/bin/env node
// Sound Effects SP9 perf benchmark — real measured frame time, weather-audio
// loop channels off vs on, following this project's own established
// rain-frame-time-benchmark.mjs / cloud-frame-time-benchmark.mjs precedent
// (itself following dice-physics-benchmark.mjs's "measure real ms/frame,
// don't trust an estimate" convention): a real production build, a real
// signed-in browser, the real Game Room page with a populated live map (not
// an empty room), sampling real requestAnimationFrame timings.
//
// Deliberate isolation, unlike rain/cloud's own "off vs on" framing: this
// script does NOT change campaigns.weather_kind at all — it stays 'clear'
// for the entire run. Instead it drives SoundControl's own SP1 test-harness
// buttons (sound-test-start-loop-wind_loop / sound-test-start-loop-fire_loop
// — the exact real startLoop() call path every weather-kind transition also
// uses, see src/audio/weatherAudio.ts's applyWeatherAudio) directly, so the
// ONLY thing that differs between the two samples is "are two real Web Audio
// loop channels actively playing," never a confound from switching to a
// weather kind that ALSO activates its own visual effects (thunderstorm's
// Droplets+LightningFlash, firestorm's WeatherParticles — both already have
// their own dedicated frame-time benchmarks/budgets). wind_loop + fire_loop
// together is deliberately the pair sampled for "on" — the exact two-channel
// combination weatherAudio.ts's own resolveWeatherAudio activates
// simultaneously for 'firestorm' (this whole plan's heaviest real audio
// config, tied with thunderstorm's rain+wind), so this brackets the true
// worst case a real session can ever reach.
//
// The expected result here is "no measurable difference at all": starting a
// loop is a one-time call (buffer decode + a few Web Audio node
// constructions), and the actual looping playback happens entirely inside
// the browser's own Web Audio render thread — no per-frame JS work of this
// project's own runs to keep a loop going. This benchmark exists to confirm
// that expectation empirically rather than merely asserting it.
//
// Needs the local Supabase stack running and a production build (`yarn
// build` first, same as render-benchmark.mjs/dice-physics-benchmark.mjs/
// rain-frame-time-benchmark.mjs — perf numbers from `next dev` are not
// representative).
// Usage: yarn build && node scripts/perf/weather-audio-frame-time-benchmark.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { GPU_LAUNCH_ARGS } from "../db/lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));
// Deliberately distinct from rain-frame-time-benchmark.mjs's own fixed 3232
// and cloud-frame-time-benchmark.mjs's own 3233 — the three benchmarks' own
// `yarn start` production servers must never collide if ever run back to
// back without an intervening manual check that the prior one fully exited.
const PORT = 3234;
const APP_URL = `http://localhost:${PORT}`;
const FRAME_COUNT = 180;
const MAP_GRID = 20;
const MAP_OBJECT_COUNT = 6;

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
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY;

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(url);
        if (res.ok || res.status < 500) return resolve();
      } catch {
        /* not up yet */
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Server at ${url} did not start within ${timeoutMs}ms`));
      }
      setTimeout(attempt, 300);
    };
    attempt();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readSoundDebug(page) {
  const text = await page.textContent('[data-testid="sound-manager-debug"]');
  return JSON.parse(text);
}

async function waitForSoundDebug(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readSoundDebug(page);
    if (predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`sound-manager-debug never satisfied predicate — last: ${JSON.stringify(last)}`);
}

async function sampleFrameTimes(page, frameCount) {
  await page.evaluate((count) => {
    const frameTimes = [];
    let lastTime = performance.now();
    let frame = 0;
    function tick() {
      const now = performance.now();
      frameTimes.push(now - lastTime);
      lastTime = now;
      frame++;
      if (frame < count) {
        requestAnimationFrame(tick);
      } else {
        // Drop the first few frames (warm-up jitter), same convention as
        // render-benchmark.mjs/dice-physics-benchmark.mjs/rain-frame-time-
        // benchmark.mjs/cloud-frame-time-benchmark.mjs.
        const warm = frameTimes.slice(5);
        const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
        const max = Math.max(...warm);
        window.__WEATHER_AUDIO_BENCHMARK_RESULT__ = { frameCount: count, avgFrameTimeMs: avg, maxFrameTimeMs: max };
      }
    }
    requestAnimationFrame(tick);
  }, frameCount);
  return page
    .waitForFunction(() => window.__WEATHER_AUDIO_BENCHMARK_RESULT__ ?? false, { timeout: 30_000 })
    .then((handle) => handle.jsonValue())
    .finally(() => page.evaluate(() => { delete window.__WEATHER_AUDIO_BENCHMARK_RESULT__; }));
}

const email = `weather-audio-perf-${Date.now()}@example.test`;
const password = "test-password-1234!";
const { data: userData, error: userError } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (userError) throw new Error(`creating benchmark user: ${userError.message}`);
const userId = userData.user.id;

const campaignId = crypto.randomUUID();
const server = spawn("yarn", ["start", "--port", String(PORT)], { cwd: rootDir, stdio: "ignore" });
// Same background-throttling workaround verify-sound-infra.mjs's own
// development confirmed necessary on this host — a real Web Audio graph can
// otherwise go idle on a backgrounded/occluded page even while this script
// keeps the tab in the foreground throughout.
const AUDIO_THROTTLE_WORKAROUND_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];
const browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS, ...AUDIO_THROTTLE_WORKAROUND_ARGS] });

try {
  await admin.from("profiles").insert({
    id: userId,
    display_name: "Weather Audio Perf Benchmark",
    avatar_source: "preset",
    avatar_ref: "vanguard",
  });
  await admin.from("campaigns").insert({ id: campaignId, name: "Weather audio perf benchmark", creator: userId });
  await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: userId, role: "dm" });

  // A populated live map, same shape as render-benchmark.mjs/rain-frame-
  // time-benchmark.mjs/cloud-frame-time-benchmark.mjs's own — measuring over
  // a genuinely busy scene (not an empty room) is the honest worst case a
  // real session would see, not a best case.
  const { data: mapData, error: mapError } = await admin
    .from("campaign_maps")
    .insert({ campaign_id: campaignId, name: "Weather audio perf map", grid_width: MAP_GRID, grid_height: MAP_GRID })
    .select()
    .single();
  if (mapError) throw new Error(`creating benchmark map: ${mapError.message}`);

  const cells = [];
  for (let y = 0; y < MAP_GRID; y++) {
    for (let x = 0; x < MAP_GRID; x++) {
      cells.push({
        map_id: mapData.id,
        x,
        y,
        elevation: (x + y) % 5,
        terrain_type: (x * 7 + y * 3) % 9 === 0 ? "difficult" : "normal",
      });
    }
  }
  const { error: cellsError } = await admin.from("map_cells").insert(cells);
  if (cellsError) throw new Error(`populating benchmark cells: ${cellsError.message}`);

  const { data: presetAssets, error: assetsError } = await admin
    .from("asset_library")
    .select("id")
    .eq("source_type", "preset")
    .limit(MAP_OBJECT_COUNT);
  if (assetsError) throw new Error(`listing preset assets: ${assetsError.message}`);
  const objects = presetAssets.map((asset, i) => ({
    map_id: mapData.id,
    asset_id: asset.id,
    x: (i * 3 + 2) % MAP_GRID,
    y: (i * 5 + 4) % MAP_GRID,
    elevation: ((i * 3 + 2) % MAP_GRID) % 5 ? 0 : 1,
    rotation: (i * 90) % 360,
  }));
  const { error: objectsError } = await admin.from("map_objects").insert(objects);
  if (objectsError) throw new Error(`placing benchmark objects: ${objectsError.message}`);

  const { error: liveError } = await admin.from("campaigns").update({ live_map: mapData.id }).eq("id", campaignId);
  if (liveError) throw new Error(`setting benchmark live map: ${liveError.message}`);

  await waitForServer(`${APP_URL}/`);

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${APP_URL}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${APP_URL}/`);

  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await page.waitForSelector('[data-testid="weather-audio-state"]', { state: "attached", timeout: 30000 });
  await page.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });
  // Let the scene's first frames settle so the sample measures steady state
  // — same convention as render-benchmark.mjs/rain-frame-time-benchmark.mjs.
  await page.waitForTimeout(1000);

  const weatherAudioState = JSON.parse(await page.textContent('[data-testid="weather-audio-state"]'));
  console.log(`Weather starts 'clear'; weather-audio-state: ${JSON.stringify(weatherAudioState)}`);
  if (weatherAudioState.channels.rain || weatherAudioState.channels.wind || weatherAudioState.channels.fire) {
    throw new Error(`expected zero weather-audio channels on a fresh 'clear' campaign, got ${JSON.stringify(weatherAudioState)}`);
  }
  const initialSoundDebug = await readSoundDebug(page);
  if (Object.keys(initialSoundDebug.activeLoops).length > 0) {
    throw new Error(`expected zero active loop channels before this benchmark starts any, got ${JSON.stringify(initialSoundDebug.activeLoops)}`);
  }

  console.log(`\nSampling ${FRAME_COUNT} frames with weather-audio loops OFF (baseline — weather stays 'clear' throughout)...`);
  const off = await sampleFrameTimes(page, FRAME_COUNT);

  // Start the exact two-channel combination 'firestorm' activates
  // simultaneously (weatherAudio.ts's own resolveWeatherAudio) — via
  // SoundControl's real SP1 test-harness buttons, the identical startLoop()
  // call path applyWeatherAudio itself uses, WITHOUT touching
  // campaigns.weather_kind (which stays 'clear' — see this file's own
  // top-of-file doc comment for why that isolation matters here).
  console.log("Starting wind_loop + fire_loop directly via SoundControl's own test harness (the same startLoop() path applyWeatherAudio uses) — weather_kind stays 'clear' throughout, isolating the audio-loop cost from any visual weather effect...");
  await page.locator('[data-testid="sound-test-start-loop-wind_loop"]').click();
  await page.locator('[data-testid="sound-test-start-loop-fire_loop"]').click();
  const activeSoundDebug = await waitForSoundDebug(
    page,
    (d) =>
      d.activeLoops.wind_loop?.state === "active" &&
      d.activeLoops.wind_loop.gainValue > 0.9 &&
      d.activeLoops.fire_loop?.state === "active" &&
      d.activeLoops.fire_loop.gainValue > 0.9,
    8000
  );
  console.log(`sound-manager-debug after both loops reach full crossfade: ${JSON.stringify(activeSoundDebug.activeLoops)}`);
  // Let both loops run for real, past their own crossfade-in, before
  // sampling — same steady-state reasoning as the initial 1s settle above.
  await page.waitForTimeout(500);

  console.log(`\nSampling ${FRAME_COUNT} frames with weather-audio loops ON (wind_loop + fire_loop both actively playing)...`);
  const on = await sampleFrameTimes(page, FRAME_COUNT);

  const budgetMs = budgets.render3d.maxAvgFrameTimeMs;
  const deltaMs = on.avgFrameTimeMs - off.avgFrameTimeMs;
  const deltaPct = (deltaMs / off.avgFrameTimeMs) * 100;

  console.log(`\nWeather-audio frame-time benchmark (real Game Room scene, ${MAP_GRID}x${MAP_GRID} live map with ${MAP_OBJECT_COUNT} objects, weather_kind fixed at 'clear' throughout):`);
  console.log(`  Loops OFF (0 channels)              — avg ${off.avgFrameTimeMs.toFixed(2)} ms, worst ${off.maxFrameTimeMs.toFixed(2)} ms (${(1000 / off.avgFrameTimeMs).toFixed(1)} fps)`);
  console.log(`  Loops ON  (wind_loop + fire_loop)    — avg ${on.avgFrameTimeMs.toFixed(2)} ms, worst ${on.maxFrameTimeMs.toFixed(2)} ms (${(1000 / on.avgFrameTimeMs).toFixed(1)} fps)`);
  console.log(`  Delta                                — ${deltaMs >= 0 ? "+" : ""}${deltaMs.toFixed(2)} ms/frame (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`);
  console.log(`  Budget (render3d.maxAvgFrameTimeMs): ${budgetMs} ms`);

  let failed = false;
  if (on.avgFrameTimeMs > budgetMs) {
    console.error(`FAIL: loops-ON average frame time ${on.avgFrameTimeMs.toFixed(2)} ms exceeds budget ${budgetMs} ms.`);
    failed = true;
  }
  // The real regression bar this benchmark exists for: two concurrently
  // playing Web Audio loops should cost close to nothing on the main render
  // thread (see this file's own top-of-file doc comment for why). A
  // generous absolute-plus-relative allowance (not a bare-zero requirement,
  // which would make this benchmark flaky against ordinary frame-timing
  // jitter) still catches a genuine regression — e.g. an accidental
  // per-frame poll/allocation this feature's own wiring should never add.
  const REGRESSION_ABS_MS = 0.5;
  const REGRESSION_PCT = 10;
  if (deltaMs > REGRESSION_ABS_MS && deltaPct > REGRESSION_PCT) {
    console.error(
      `FAIL: enabling two weather-audio loop channels added ${deltaMs.toFixed(2)} ms/frame (${deltaPct.toFixed(1)}%) — exceeds the ${REGRESSION_ABS_MS}ms / ${REGRESSION_PCT}% no-meaningful-regression allowance.`
    );
    failed = true;
  }
  if (!failed) console.log("\nPASS — two concurrently playing weather-audio loop channels cause no meaningful frame-time regression.");
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
  server.kill();
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(userId);
}
