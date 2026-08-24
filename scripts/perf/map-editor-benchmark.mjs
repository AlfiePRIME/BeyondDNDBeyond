#!/usr/bin/env node
// Map editor render benchmark (Prompt 26). Same real-page approach as
// render-benchmark.mjs: throwaway DM + campaign, but pointed at the map
// editor with a fully populated 20x20 map (varied elevations, scattered
// difficult terrain — every cell holding a stored row, worse than the
// sparse-storage common case). Samples requestAnimationFrame while the
// mouse sweeps across the grid, so the number includes per-move raycasts
// against all 400 cell blocks and live paint updates, not just an idle
// redraw of a static scene.
//
// Usage: yarn build && node scripts/perf/map-editor-benchmark.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));
const PORT = 3220;
const FRAME_COUNT = 180;
const GRID = 20;

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

const email = `map-editor-benchmark-${Date.now()}@example.test`;
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
// Same GPU flags as render-benchmark.mjs, for the same reason: measure real
// GPU rendering via ANGLE/Vulkan where available, not SwiftShader.
const browser = await chromium.launch({
  args: ["--use-angle=vulkan", "--ignore-gpu-blocklist", "--enable-gpu"],
});

try {
  await admin.from("profiles").insert({ id: userId, display_name: "Map Editor Benchmark" });
  const { error: campaignError } = await admin
    .from("campaigns")
    .insert({ id: campaignId, name: "Map editor benchmark", creator: userId });
  if (campaignError) throw new Error(`creating benchmark campaign: ${campaignError.message}`);
  await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: userId, role: "dm" });

  const { data: mapData, error: mapError } = await admin
    .from("campaign_maps")
    .insert({ campaign_id: campaignId, name: "Benchmark 20x20", grid_width: GRID, grid_height: GRID })
    .select()
    .single();
  if (mapError) throw new Error(`creating benchmark map: ${mapError.message}`);

  const cells = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
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

  await waitForServer(`http://localhost:${PORT}/`);

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://localhost:${PORT}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`http://localhost:${PORT}/`);

  await page.goto(`http://localhost:${PORT}/campaigns/${campaignId}/maps/${mapData.id}/edit`);
  await page.waitForSelector("canvas");
  await page.waitForTimeout(1000);

  const sampling = page.evaluate((frameCount) => {
    const frameTimes = [];
    let lastTime = performance.now();
    let frame = 0;
    return new Promise((resolve) => {
      function tick() {
        const now = performance.now();
        frameTimes.push(now - lastTime);
        lastTime = now;
        frame++;
        if (frame < frameCount) {
          requestAnimationFrame(tick);
        } else {
          const warm = frameTimes.slice(5);
          const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
          window.__BENCHMARK_RESULT__ = { frameCount, avgFrameTimeMs: avg };
          resolve();
        }
      }
      requestAnimationFrame(tick);
    });
  }, FRAME_COUNT);

  // Sweep the pointer over the grid (with a paint stroke) while sampling so
  // the measurement includes hover raycasts and cell-edit re-renders.
  const sweep = (async () => {
    await page.mouse.move(340, 360);
    await page.mouse.down();
    for (let i = 0; i <= 40; i++) {
      await page.mouse.move(340 + i * 15, 300 + Math.sin(i / 4) * 120, { steps: 3 });
      await page.waitForTimeout(15);
    }
    await page.mouse.up();
  })();

  await Promise.all([sampling, sweep]);
  const result = await page.evaluate(() => window.__BENCHMARK_RESULT__);

  const budgetMs = budgets.render3d.maxAvgFrameTimeMs;
  console.log(
    `Map editor render benchmark (real editor page, ${GRID}x${GRID} fully populated map, painting sweep): ${result.frameCount} frames`
  );
  console.log(`Average frame time: ${result.avgFrameTimeMs.toFixed(2)} ms (budget: ${budgetMs} ms)`);
  console.log(`Implied fps: ${(1000 / result.avgFrameTimeMs).toFixed(1)}`);

  if (result.avgFrameTimeMs > budgetMs) {
    console.error(`FAIL: average frame time ${result.avgFrameTimeMs.toFixed(2)} ms exceeds budget ${budgetMs} ms.`);
    process.exitCode = 1;
  } else {
    console.log("PASS");
  }
} finally {
  await browser.close();
  server.kill();
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(userId);
}
