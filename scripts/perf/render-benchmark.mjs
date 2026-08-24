#!/usr/bin/env node
// 3D render benchmark (Prompt 2, re-pointed at the real scene in Prompt 19).
//
// Measures average frame time of the REAL Game Room page — not a standalone
// fixture that could drift from what's shipped. Needs the local Supabase
// stack running and a production build (`yarn build` first, same as
// lighthouse.mjs): creates a throwaway user + campaign, signs in through the
// real /login form in headless Chromium (WebGL needs a real browser, not
// just Node), navigates to the campaign's Game Room, and samples
// requestAnimationFrame timings once the scene is up.
//
// Usage: yarn build && node scripts/perf/render-benchmark.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));
const PORT = 3200;
const FRAME_COUNT = 180;

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

const email = `render-benchmark-${Date.now()}@example.test`;
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
// Headless Chromium defaults to SwiftShader (software rasterization) even on
// machines with a GPU, which would benchmark the CPU rasterizer — something
// no player actually runs. These flags opt into real GPU rendering via
// ANGLE/Vulkan where available and fall back to SwiftShader where not.
const browser = await chromium.launch({
  args: ["--use-angle=vulkan", "--ignore-gpu-blocklist", "--enable-gpu"],
});

// Prompt 21: the benchmark measures a populated table — every seat holding a
// loaded preset avatar model — not an empty room.
const SEATED_PLAYER_COUNT = 5;
const PRESET_IDS = ["vanguard", "mystic", "warden", "corsair", "ember"];
const extraUserIds = [];

try {
  await admin.from("profiles").insert({
    id: userId,
    display_name: "Render Benchmark",
    avatar_source: "preset",
    avatar_ref: PRESET_IDS[0],
  });
  const { error: campaignError } = await admin
    .from("campaigns")
    .insert({ id: campaignId, name: "Render benchmark", creator: userId });
  if (campaignError) throw new Error(`creating benchmark campaign: ${campaignError.message}`);
  await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: userId, role: "dm" });

  for (let i = 0; i < SEATED_PLAYER_COUNT; i++) {
    const { data: playerData, error: playerError } = await admin.auth.admin.createUser({
      email: `render-benchmark-player-${i}-${Date.now()}@example.test`,
      password,
      email_confirm: true,
    });
    if (playerError) throw new Error(`creating benchmark player ${i}: ${playerError.message}`);
    const playerId = playerData.user.id;
    extraUserIds.push(playerId);
    await admin.from("profiles").insert({
      id: playerId,
      display_name: `Benchmark Player ${i + 1}`,
      avatar_source: "preset",
      avatar_ref: PRESET_IDS[(i + 1) % PRESET_IDS.length],
    });
    await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: playerId, role: "player" });
  }

  await waitForServer(`http://localhost:${PORT}/`);

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://localhost:${PORT}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`http://localhost:${PORT}/`);

  await page.goto(`http://localhost:${PORT}/campaigns/${campaignId}/room`);
  await page.waitForSelector("canvas");
  // Let the scene's first frames (shader compile, texture upload) settle so
  // the sample measures steady state.
  await page.waitForTimeout(1000);

  await page.evaluate((frameCount) => {
    const frameTimes = [];
    let lastTime = performance.now();
    let frame = 0;
    function tick() {
      const now = performance.now();
      frameTimes.push(now - lastTime);
      lastTime = now;
      frame++;
      if (frame < frameCount) {
        requestAnimationFrame(tick);
      } else {
        // Drop the first few frames (warm-up jitter) before averaging.
        const warm = frameTimes.slice(5);
        const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
        window.__BENCHMARK_RESULT__ = { frameCount, avgFrameTimeMs: avg, frameTimes: warm };
      }
    }
    requestAnimationFrame(tick);
  }, FRAME_COUNT);

  const result = await page
    .waitForFunction(() => window.__BENCHMARK_RESULT__ ?? false, { timeout: 30_000 })
    .then((handle) => handle.jsonValue());

  const budgetMs = budgets.render3d.maxAvgFrameTimeMs;

  console.log(`3D render benchmark (real Game Room scene): ${result.frameCount} frames`);
  console.log(`Average frame time: ${result.avgFrameTimeMs.toFixed(2)} ms (budget: ${budgetMs} ms)`);
  console.log(`Implied fps: ${(1000 / result.avgFrameTimeMs).toFixed(1)}`);

  if (result.avgFrameTimeMs > budgetMs) {
    console.error(
      `FAIL: average frame time ${result.avgFrameTimeMs.toFixed(2)} ms exceeds budget ${budgetMs} ms.`
    );
    process.exitCode = 1;
  } else {
    console.log("PASS");
  }
} finally {
  await browser.close();
  server.kill();
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(userId);
  for (const extraUserId of extraUserIds) await admin.auth.admin.deleteUser(extraUserId);
}
