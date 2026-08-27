#!/usr/bin/env node
// Dice physics benchmark (docs/design/dice-numbers-and-physics.md §9) — the
// "measure this for real before trusting it" step the design spike itself
// calls for, following the exact existing Playwright-driven convention
// (render-benchmark.mjs/asset-render-benchmark.mjs/map-editor-benchmark.mjs):
// a real production build, a real signed-in browser, the real Game Room
// page, sampling real requestAnimationFrame timings — not a synthetic
// standalone fixture that could drift from what's actually shipped.
//
// Simulates the realistic worst case §9 reasons about: `CLIENT_COUNT`
// (perf-budgets.json's own `realtimeLoad.concurrentClients` — this
// project's already-declared realistic concurrency ceiling) real,
// independently-connected browser sessions in the SAME campaign's Game
// Room, each with its own personal dice tray, each firing a
// `DICE_PER_ROLL`-die freeform roll (matching diceAnimator.ts's own
// MAX_PHYSICS_DICE_PER_ROLL cap — kept here as a plain literal rather than
// an import, since a .mjs script importing a .ts module's runtime constant
// hits the same Node-native-type-stripping extension-resolution issue
// perf-budgets.json's own realtimeLoad._note already flags for
// realtime-load.mjs; keep these two numbers in sync by hand if either
// changes) at (near enough) the same instant — every public roll is played
// immediately at the roller's own tray AND broadcast to every other
// connected client (GameRoom.tsx's own DICE_ROLLED_EVENT wiring), so on ANY
// one client's own screen this really does become `CLIENT_COUNT` personal
// trays × `DICE_PER_ROLL` dice, all physics-tumbling in their own
// independent per-roll Rapier World, simultaneously — exactly the ~240-die
// worst case docs/design/dice-numbers-and-physics.md §9 reasons about.
//
// Frame time is sampled on ONE observer client (the DM's own page, which
// sees all `CLIENT_COUNT` trays) starting the instant every roll is fired,
// for a window sized to sit inside the real physics-heavy tumble phase
// (before LINGER_MS's idle display tail would otherwise dilute the average
// toward baseline and understate the real worst case).
//
// Needs the local Supabase stack running and a production build (`yarn
// build` first, same as render-benchmark.mjs — perf numbers from `next dev`
// are not representative).
// Usage: yarn build && node scripts/perf/dice-physics-benchmark.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));
const PORT = 3230;
const APP_URL = `http://localhost:${PORT}`;

// This project's own already-declared realistic worst-case concurrency
// ceiling (perf-budgets.json) — see docs/design/dice-numbers-and-physics.md
// §9's own reasoning for reusing it here rather than inventing a new number.
const CLIENT_COUNT = budgets.realtimeLoad.concurrentClients;
// Must match diceAnimator.ts's own MAX_PHYSICS_DICE_PER_ROLL — see this
// file's own header comment on why that's a literal, not an import. 8 is
// the value this exact script measured and confirmed (see
// MAX_PHYSICS_DICE_PER_ROLL's own doc comment in diceAnimator.ts for the
// real numbers this script produced at 8/10/12/24, and why 8 was the one
// kept: 10 and 12 already measured right at or over perf-budgets.json's
// render3d budget on a real GPU-backed RTX 4060 Ti sandbox).
const DICE_PER_ROLL = 8;
// ~2 seconds — inside MIN_PHYSICS_SECONDS..MAX_PHYSICS_SECONDS+
// SETTLE_BLEND_SECONDS's own real physics-active window (diceAnimator.ts),
// deliberately short of LINGER_MS's post-settle idle display tail, so the
// sample measures the genuinely busy period, not diluted by idle frames
// that would understate the real worst case.
const FRAME_COUNT = 120;

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

// Same cookie-session-injection technique as scripts/db/verify-*.mjs (this
// script needs `CLIENT_COUNT` real, independently-authenticated browser
// sessions, not one signed-in page like render-benchmark.mjs).
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
  const email = `dice-physics-bench-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating benchmark user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Dice Physics Bench ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in benchmark user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

async function trayLayoutState(page) {
  const text = await page.textContent('[data-testid="dice-tray-layout-state"]');
  return JSON.parse(text ?? '{"radius":0,"trays":[]}');
}

async function waitForTrayCount(page, expectedCount, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await trayLayoutState(page);
    if (last.trays.length >= expectedCount) return last;
    await sleep(250);
  }
  return last;
}

const campaignId = crypto.randomUUID();
const users = [];
const server = spawn("yarn", ["start", "--port", String(PORT)], { cwd: rootDir, stdio: "ignore" });
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const contexts = [];

try {
  console.log(`Creating ${CLIENT_COUNT} benchmark users (1 DM + ${CLIENT_COUNT - 1} players)...`);
  const dm = await makeTestUser("dm");
  users.push(dm);
  for (let i = 0; i < CLIENT_COUNT - 1; i++) {
    users.push(await makeTestUser(`player-${i}`));
  }

  await admin.from("campaigns").insert({ id: campaignId, name: "Dice physics benchmark", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    ...users.slice(1).map((u) => ({ campaign_id: campaignId, user_id: u.id, role: "player" })),
  ]);

  await waitForServer(`${APP_URL}/`);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;
  console.log(`Opening ${CLIENT_COUNT} concurrent browser sessions in the same Game Room...`);
  const pages = [];
  for (const user of users) {
    const context = await browser.newContext();
    contexts.push(context);
    await context.addCookies(sessionCookies(user.session));
    const page = await context.newPage();
    await page.goto(roomUrl);
    await page.waitForSelector('[data-testid="dice-tray-layout-state"]', { state: "attached", timeout: 30_000 });
    pages.push(page);
  }

  // The DM's own page is the "observer" — it sees all CLIENT_COUNT personal
  // trays, exactly the real worst-case view a DM watching the whole table
  // roll at once would have.
  const observerPage = pages[0];
  console.log("Waiting for every connected member's own personal tray to resolve on the observer's client...");
  const trayState = await waitForTrayCount(observerPage, CLIENT_COUNT);
  if (!trayState || trayState.trays.length < CLIENT_COUNT) {
    throw new Error(
      `Only ${trayState?.trays?.length ?? 0}/${CLIENT_COUNT} personal trays resolved on the observer client — cannot benchmark the full worst case.`
    );
  }
  console.log(`All ${trayState.trays.length} personal trays resolved.`);

  async function fireBigRoll(page) {
    await page.fill('[data-testid="freeform-notation-input"]', `${DICE_PER_ROLL}d6`);
    await page.click('[data-testid="freeform-roll-button"]');
  }

  console.log(
    `Firing a ${DICE_PER_ROLL}-die roll from all ${CLIENT_COUNT} clients simultaneously (worst case: ${
      CLIENT_COUNT * DICE_PER_ROLL
    } physics-tumbling dice across ${CLIENT_COUNT} independent trays on the observer's own screen)...`
  );

  const [, result] = await Promise.all([
    Promise.all(pages.map((page) => fireBigRoll(page))),
    observerPage
      .evaluate((frameCount) => {
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
            // Drop the first few frames (this evaluate() call's own warm-up
            // jitter, the same convention render-benchmark.mjs uses) before
            // averaging — the window is already sized to sit inside the
            // real physics-tumble phase, not the post-settle idle tail.
            const warm = frameTimes.slice(5);
            const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
            const max = Math.max(...warm);
            window.__DICE_PHYSICS_BENCHMARK_RESULT__ = { frameCount, avgFrameTimeMs: avg, maxFrameTimeMs: max };
          }
        }
        requestAnimationFrame(tick);
      }, FRAME_COUNT)
      .then(() =>
        observerPage
          .waitForFunction(() => window.__DICE_PHYSICS_BENCHMARK_RESULT__ ?? false, { timeout: 30_000 })
          .then((handle) => handle.jsonValue())
      ),
  ]);

  // Correctness sanity check, alongside the perf number: confirm the
  // observer's own roll (and, via the debug mirror, ideally others too)
  // actually used physicsDiceAnimator, not a silent fallback to
  // scriptedDiceAnimator — a benchmark that accidentally measured the CHEAP
  // path would be worthless as a physics performance signal.
  await sleep(500);
  const faceLabelsText = await observerPage.textContent('[data-testid="dice-face-labels-state"]').catch(() => null);
  let anyPhysicsConfirmed = false;
  if (faceLabelsText) {
    try {
      const state = JSON.parse(faceLabelsText);
      anyPhysicsConfirmed = Object.values(state).some((entry) =>
        Object.values(entry.dice ?? {}).some((die) => die.usedPhysics === true)
      );
    } catch {
      // Leave anyPhysicsConfirmed false — reported below.
    }
  }

  const budgetMs = budgets.render3d.maxAvgFrameTimeMs;
  console.log(
    `\nDice physics benchmark: ${CLIENT_COUNT} concurrent trays × ${DICE_PER_ROLL} dice (${
      CLIENT_COUNT * DICE_PER_ROLL
    } total), ${result.frameCount} sampled frames`
  );
  console.log(`Average frame time: ${result.avgFrameTimeMs.toFixed(2)} ms (budget: ${budgetMs} ms)`);
  console.log(`Worst single frame: ${result.maxFrameTimeMs.toFixed(2)} ms`);
  console.log(`Implied avg fps: ${(1000 / result.avgFrameTimeMs).toFixed(1)}`);
  console.log(`At least one die confirmed to have used real physics (not a scripted fallback): ${anyPhysicsConfirmed}`);

  let failed = false;
  if (!anyPhysicsConfirmed) {
    console.error(
      "FAIL: no die reported usedPhysics === true — this benchmark did not actually exercise the physics animator."
    );
    failed = true;
  }
  if (result.avgFrameTimeMs > budgetMs) {
    console.error(`FAIL: average frame time ${result.avgFrameTimeMs.toFixed(2)} ms exceeds budget ${budgetMs} ms.`);
    failed = true;
  }
  if (!failed) console.log("PASS");
  process.exitCode = failed ? 1 : 0;
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser.close();
  server.kill();
  await admin.from("campaigns").delete().eq("id", campaignId);
  for (const user of users) await admin.auth.admin.deleteUser(user.id).catch(() => undefined);
}
