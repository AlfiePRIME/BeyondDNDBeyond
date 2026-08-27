#!/usr/bin/env node
// Weather & Enemies C2 perf benchmark — real measured frame time, rain off
// vs. rain on, following this project's own established precedent from the
// dice-physics work (scripts/perf/dice-physics-benchmark.mjs, which
// benchmarked actual ms/frame to empirically set MAX_PHYSICS_DICE_PER_ROLL
// rather than trusting an estimate) and render-benchmark.mjs's own single-
// client shape: a real production build, a real signed-in browser, the
// real Game Room page with a populated live map (not an empty room),
// sampling real requestAnimationFrame timings.
//
// Rain is toggled via a direct admin DB write (campaigns.weather_kind),
// exactly the live-sync path a real DM's own click already exercises
// (verify-rain.mjs proves the click path itself works) — this script only
// cares about the RENDERING cost, not re-proving the UI wiring.
//
// Needs the local Supabase stack running and a production build (`yarn
// build` first, same as render-benchmark.mjs/dice-physics-benchmark.mjs —
// perf numbers from `next dev` are not representative).
// Usage: yarn build && node scripts/perf/rain-frame-time-benchmark.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { GPU_LAUNCH_ARGS } from "../db/lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));
const PORT = 3232;
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

async function dropletsState(page) {
  const text = await page.textContent('[data-testid="droplets-state"]');
  return JSON.parse(text);
}

async function waitForDroplets(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await dropletsState(page);
    if (predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`droplets-state never satisfied predicate — last: ${JSON.stringify(last)}`);
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
        // render-benchmark.mjs/dice-physics-benchmark.mjs.
        const warm = frameTimes.slice(5);
        const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
        const max = Math.max(...warm);
        window.__RAIN_BENCHMARK_RESULT__ = { frameCount: count, avgFrameTimeMs: avg, maxFrameTimeMs: max };
      }
    }
    requestAnimationFrame(tick);
  }, frameCount);
  return page
    .waitForFunction(() => window.__RAIN_BENCHMARK_RESULT__ ?? false, { timeout: 30_000 })
    .then((handle) => handle.jsonValue())
    .finally(() => page.evaluate(() => { delete window.__RAIN_BENCHMARK_RESULT__; }));
}

const email = `rain-perf-${Date.now()}@example.test`;
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
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  await admin.from("profiles").insert({
    id: userId,
    display_name: "Rain Perf Benchmark",
    avatar_source: "preset",
    avatar_ref: "vanguard",
  });
  await admin.from("campaigns").insert({ id: campaignId, name: "Rain perf benchmark", creator: userId });
  await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: userId, role: "dm" });

  // A populated live map, same shape as render-benchmark.mjs's own — rain
  // is a full-screen screen-space cost, but measuring it over a genuinely
  // busy scene (not an empty room) is the honest worst case a real session
  // would see, not a best case.
  const { data: mapData, error: mapError } = await admin
    .from("campaign_maps")
    .insert({ campaign_id: campaignId, name: "Rain perf map", grid_width: MAP_GRID, grid_height: MAP_GRID })
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
  await page.waitForSelector('[data-testid="droplets-state"]', { state: "attached", timeout: 30000 });
  // Let the scene's first frames (shader compile, texture upload) settle so
  // the sample measures steady state — same convention as render-benchmark.mjs.
  await page.waitForTimeout(1000);

  const initialDroplets = await dropletsState(page);
  console.log(`Weather starts 'clear'; droplets-state: ${JSON.stringify(initialDroplets)}`);

  console.log(`\nSampling ${FRAME_COUNT} frames with rain OFF (baseline)...`);
  const off = await sampleFrameTimes(page, FRAME_COUNT);

  console.log("Setting weather to 'rain' via direct DB write (same live-sync path a real DM's click already uses)...");
  const { error: rainError } = await admin.from("campaigns").update({ weather_kind: "rain" }).eq("id", campaignId);
  if (rainError) throw new Error(`setting weather to rain: ${rainError.message}`);
  const activeDroplets = await waitForDroplets(page, (s) => s.ready === true && s.active === true);
  console.log(`droplets-state after activation: ${JSON.stringify(activeDroplets)}`);
  // Let the shader run for real for a beat before sampling — same
  // steady-state reasoning as the initial 1s settle above.
  await page.waitForTimeout(500);

  console.log(`\nSampling ${FRAME_COUNT} frames with rain ON...`);
  const on = await sampleFrameTimes(page, FRAME_COUNT);

  const budgetMs = budgets.render3d.maxAvgFrameTimeMs;
  const deltaMs = on.avgFrameTimeMs - off.avgFrameTimeMs;
  const deltaPct = (deltaMs / off.avgFrameTimeMs) * 100;

  console.log(`\nRain frame-time benchmark (real Game Room scene, ${MAP_GRID}x${MAP_GRID} live map with ${MAP_OBJECT_COUNT} objects):`);
  console.log(`  Rain OFF — avg ${off.avgFrameTimeMs.toFixed(2)} ms, worst ${off.maxFrameTimeMs.toFixed(2)} ms (${(1000 / off.avgFrameTimeMs).toFixed(1)} fps)`);
  console.log(`  Rain ON  — avg ${on.avgFrameTimeMs.toFixed(2)} ms, worst ${on.maxFrameTimeMs.toFixed(2)} ms (${(1000 / on.avgFrameTimeMs).toFixed(1)} fps)`);
  console.log(`  Delta    — ${deltaMs >= 0 ? "+" : ""}${deltaMs.toFixed(2)} ms/frame (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`);
  console.log(`  Budget (render3d.maxAvgFrameTimeMs): ${budgetMs} ms`);

  let failed = false;
  if (on.avgFrameTimeMs > budgetMs) {
    console.error(`FAIL: rain-ON average frame time ${on.avgFrameTimeMs.toFixed(2)} ms exceeds budget ${budgetMs} ms.`);
    failed = true;
  }
  if (!failed) console.log("\nPASS");
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
  server.kill();
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(userId);
}
