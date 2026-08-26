#!/usr/bin/env node
// Follow-up to verify-avatar-reload.mjs, run AFTER the critical Game Room
// freeze fix (7a5c082 "Fix critical Game Room freeze: memoize TableSeat to
// stop an infinite render loop", db6f5b3's merge) landed, to test the one
// concrete new hypothesis that fix's own investigation raised but never
// tested: could the SAME unmemoized-TableSeat/unconditional-setState
// mechanism that caused a full freeze have ALSO caused a milder, VISIBLE
// (not hanging) transient mis-render under different timing — e.g. with
// several real avatars loading/reloading at once — that reads as the
// original "teleports to center" / "loads massively" report instead of a
// hard freeze?
//
// Both prior avatar-reload passes (verify-avatar-reload.mjs, still in
// master) drove exactly ONE seated real/custom avatar through a reload at a
// time. This script instead seeds a FULL, real-session-shaped room — three
// simultaneously seated members, each with their OWN real, distinct avatar
// (two different custom rigged uploads plus a DM preset) — then reloads one
// member's client repeatedly while the other two stay connected, checking
// every seat's own measurement/pose/position, not just the reloading
// member's own, on every single poll tick (not just at rest) so a fast
// transient bad frame can't hide between polls the way it could between two
// widely-spaced checks. It also drives two members reloading at
// (approximately) the same instant once, to stress whatever concurrent
// realtime-channel/query traffic a simultaneous double-reload produces that
// a single reload never would.
//
// Needs the shared Supabase stack configured in .env (see
// verify-avatar-reload.mjs's own header comment). Starts `yarn dev` itself
// (and polls /api/health) if the target port isn't already serving.
// Usage: node scripts/db/verify-avatar-reload-multi.mjs
//        APP_URL=http://localhost:3150 node scripts/db/verify-avatar-reload-multi.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3150";
const SCREENSHOT_DIR = join(rootDir, "scripts", "db", "screenshots", "avatar-reload-multi");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

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

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

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
function note(label, detail) {
  console.log(`NOTE  ${label}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  const port = new URL(APP_URL).port || "3000";
  console.log(`dev server not running at ${APP_URL} — starting yarn dev on port ${port}…`);
  devServer = spawn("yarn", ["dev"], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PORT: port },
  });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error("dev server did not become healthy within 120s");
}

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
  const email = `avatar-reload-multi-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `AvatarReloadMulti ${label}` });
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

/** Uploads `glbPath` as `page`'s own custom avatar via the real /account UI
 * (same flow verify-avatar-reload.mjs already validated). */
async function uploadCustomAvatar(page, glbPath) {
  await page.goto(`${APP_URL}/account`);
  await page.getByLabel("Upload a custom avatar model").setInputFiles(glbPath);
  await page.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  await page.click('[data-testid="orientation-confirm"]');
  await page.getByText("Avatar saved.").waitFor({ timeout: 15000 });
}

/**
 * Polls avatar-measure-state and model-pose-state on `page` EVERY tick
 * (not just on distinct-signature changes, unlike verify-avatar-reload.mjs's
 * watchReloadTransition) for ALL of `userIds` simultaneously, for
 * `durationMs`, recording every observed measurement for every user. This is
 * the "closer to a real multiplayer session" check the freeze-fix
 * interaction hypothesis specifically calls for: with three real avatars
 * live at once, does watching userA's own reload ever show userB's or
 * userC's measurement/scale glitch, even for a single fast poll tick, even
 * though neither of them reloaded?
 */
async function pollAllSeats(page, userIds, durationMs, tickMs = 40) {
  const deadline = Date.now() + durationMs;
  const samples = [];
  while (Date.now() < deadline) {
    const measure = await readTestId(page, "avatar-measure-state").catch(() => null);
    const pose = await readTestId(page, "model-pose-state").catch(() => null);
    const seatLayout = await readTestId(page, "seat-layout-state").catch(() => null);
    samples.push({
      tMs: durationMs - (deadline - Date.now()),
      measure: measure ? Object.fromEntries(userIds.map((id) => [id, measure[id] ?? null])) : null,
      posed: pose?.avatars ? Object.fromEntries(userIds.map((id) => [id, pose.avatars[id] ?? null])) : null,
      seats: seatLayout?.seats?.filter((s) => userIds.includes(s.userId)) ?? null,
    });
    await sleep(tickMs);
  }
  return samples;
}

/** Flags any sample where a userId that had already resolved to a real
 * measurement on an EARLIER sample suddenly shows a wildly different
 * scale/sizeY, OR moves to a seat position far from its own earlier
 * position — the direct signature of a transient bad frame this whole
 * script is hunting for, whether or not it happens to still be visible on
 * the very next sample. */
function findAnomalies(samples, userIds, baselines) {
  const anomalies = [];
  const lastGood = { ...baselines };
  for (const sample of samples) {
    for (const id of userIds) {
      const m = sample.measure?.[id];
      const base = lastGood[id];
      if (!m || !base) continue;
      const scaleRatio = m.scale / base.scale;
      const sizeYRatio = m.sizeY / base.sizeY;
      // Wide-but-real thresholds: a genuine mis-scale bug report describes
      // "massively" wrong — order-of-magnitude, not a few percent of
      // floating-point/recompute jitter.
      if (scaleRatio > 3 || scaleRatio < 0.33 || sizeYRatio > 3 || sizeYRatio < 0.33) {
        anomalies.push({ tMs: sample.tMs, userId: id, kind: "scale/sizeY", observed: m, baseline: base });
      } else {
        lastGood[id] = m;
      }
      const seat = sample.seats?.find((s) => s.userId === id);
      const baseSeat = base.seat;
      if (seat && baseSeat) {
        const dist = Math.hypot(seat.position[0] - baseSeat.position[0], seat.position[2] - baseSeat.position[2]);
        if (dist > 0.1) {
          anomalies.push({ tMs: sample.tMs, userId: id, kind: "seat-position", observed: seat, baseline: baseSeat });
        }
      }
    }
  }
  return anomalies;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const p1 = await makeTestUser("p1");
const p2 = await makeTestUser("p2");
const users = { dm, p1, p2 };
const userIds = [dm.id, p1.id, p2.id];

const riggedFigure = join(rootDir, "public", "test-fixtures", "RiggedFigure.glb");
const riggedSimple = join(rootDir, "public", "test-fixtures", "RiggedSimple.glb");

const campaignId = crypto.randomUUID();
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Avatar reload multi test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: p1.id, role: "player" },
    { campaign_id: campaignId, user_id: p2.id, role: "player" },
  ]);
  // DM gets a real built-in preset (a known-good asset, so any anomaly
  // involving the DM's own seat isolates to the shared render path, not to
  // a bad custom upload) — the two players get two DIFFERENT real custom
  // rigged uploads, so this room has three simultaneously seated members
  // each rendering through AvatarModel with a genuinely different loaded
  // scene/skeleton, the "closer to a real multiplayer session" shape this
  // pass specifically needs that the single-avatar prior passes never ran.
  const { error: presetErr } = await admin.from("profiles").update({ avatar_source: "preset", avatar_ref: "vanguard" }).eq("id", dm.id);
  if (presetErr) throw presetErr;

  const contexts = {};
  const pages = {};
  for (const [label, user] of Object.entries(users)) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addCookies(sessionCookies(user.session));
    contexts[label] = context;
    pages[label] = await context.newPage();
    pages[label]._errors = [];
    pages[label].on("pageerror", (err) => pages[label]._errors.push(String(err)));
  }

  // -- Upload each player's own custom avatar via the real account UI. --
  note("phase", "account-upload p1");
  await uploadCustomAvatar(pages.p1, riggedFigure);
  note("phase", "account-upload p2");
  await uploadCustomAvatar(pages.p2, riggedSimple);

  // -- All three join the room live, simultaneously seated. --
  for (const label of ["dm", "p1", "p2"]) {
    await pages[label].goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await pages[label].waitForSelector('[data-testid="avatar-measure-state"]', { state: "attached", timeout: 30000 });
  }

  // Wait until EVERY client's own view reports all three avatars measured —
  // the real "3 seats, 3 real avatars, all live at once" baseline.
  const baselines = {};
  for (const label of ["dm", "p1", "p2"]) {
    const page = pages[label];
    const deadline = Date.now() + 25000;
    let measure = null;
    let seatLayout = null;
    while (Date.now() < deadline) {
      measure = await readTestId(page, "avatar-measure-state");
      seatLayout = await readTestId(page, "seat-layout-state");
      if (userIds.every((id) => measure?.[id])) break;
      await sleep(200);
    }
    check(
      `[${label}'s own view] all three seated members' avatars report a measurement`,
      userIds.every((id) => measure?.[id]),
      JSON.stringify(measure)
    );
    if (label === "dm") {
      // Establish the shared baseline (position/scale/sizeY per user) from
      // the DM's own view — used by findAnomalies below for every client.
      for (const id of userIds) {
        const seat = seatLayout?.seats?.find((s) => s.userId === id);
        baselines[id] = { scale: measure[id]?.scale, sizeY: measure[id]?.sizeY, seat };
      }
      check(
        "baseline: no seated member's measured scale is a wild order-of-magnitude outlier",
        userIds.every((id) => typeof baselines[id]?.scale === "number" && baselines[id].scale > 0.05 && baselines[id].scale < 5),
        JSON.stringify(baselines)
      );
      check(
        "baseline: no seated member sits at (or on top of) the world origin/table center",
        userIds.every((id) => baselines[id]?.seat && Math.hypot(baselines[id].seat.position[0], baselines[id].seat.position[2]) > 0.5),
        JSON.stringify(baselines)
      );
    }
  }
  await pages.dm.screenshot({ path: join(SCREENSHOT_DIR, "00-three-seat-baseline-from-dm.png") });
  note("baselines", JSON.stringify(baselines));

  // -- The main repro: reload p1's client repeatedly while dm/p2 stay
  //    connected, polling EVERY seat (not just p1's own) on EVERY tick
  //    throughout each reload, on ALL THREE clients' own views. --
  const RELOAD_CYCLES = process.env.RELOAD_CYCLES ? Number(process.env.RELOAD_CYCLES) : 6;
  const allAnomalies = [];
  for (let cycle = 1; cycle <= RELOAD_CYCLES; cycle++) {
    console.log(`\n--- reload cycle ${cycle}/${RELOAD_CYCLES} (p1 reloads; dm/p2 stay connected) ---`);
    await pages.p1.reload({ waitUntil: "commit" });
    await pages.p1.waitForSelector('[data-testid="avatar-measure-state"]', { state: "attached", timeout: 30000 }).catch(() => undefined);

    // Poll ALL THREE clients' own views concurrently through the reload
    // window — a bad transient frame on the DM's or p2's ALREADY-SETTLED
    // view of p1 (or of each other) is just as reportable a bug as one on
    // p1's own reloading view.
    const [samplesP1, samplesDm, samplesP2] = await Promise.all([
      pollAllSeats(pages.p1, userIds, 6000),
      pollAllSeats(pages.dm, userIds, 6000),
      pollAllSeats(pages.p2, userIds, 6000),
    ]);

    const anomaliesP1 = findAnomalies(samplesP1, userIds, baselines);
    const anomaliesDm = findAnomalies(samplesDm, userIds, baselines);
    const anomaliesP2 = findAnomalies(samplesP2, userIds, baselines);
    allAnomalies.push({ cycle, view: "p1-own-reloading-view", anomalies: anomaliesP1 });
    allAnomalies.push({ cycle, view: "dm-observing-view", anomalies: anomaliesDm });
    allAnomalies.push({ cycle, view: "p2-observing-view", anomalies: anomaliesP2 });

    check(`reload ${cycle}: no scale/position anomaly in p1's own reloading view`, anomaliesP1.length === 0, JSON.stringify(anomaliesP1));
    check(`reload ${cycle}: no scale/position anomaly in the DM's (unaffected) observing view`, anomaliesDm.length === 0, JSON.stringify(anomaliesDm));
    check(`reload ${cycle}: no scale/position anomaly in p2's (unaffected) observing view`, anomaliesP2.length === 0, JSON.stringify(anomaliesP2));

    if (anomaliesP1.length || anomaliesDm.length || anomaliesP2.length) {
      await pages.p1.screenshot({ path: join(SCREENSHOT_DIR, `anomaly-cycle${cycle}-p1.png`) }).catch(() => undefined);
      await pages.dm.screenshot({ path: join(SCREENSHOT_DIR, `anomaly-cycle${cycle}-dm.png`) }).catch(() => undefined);
      await pages.p2.screenshot({ path: join(SCREENSHOT_DIR, `anomaly-cycle${cycle}-p2.png`) }).catch(() => undefined);
    }

    const errs = pages.p1._errors.length + pages.dm._errors.length + pages.p2._errors.length;
    check(`reload ${cycle}: no uncaught page errors on any of the three clients`, errs === 0, JSON.stringify({
      p1: pages.p1._errors, dm: pages.dm._errors, p2: pages.p2._errors,
    }));
    pages.p1._errors = [];
    pages.dm._errors = [];
    pages.p2._errors = [];
  }

  // -- One near-simultaneous DOUBLE reload (p1 and p2 both reload at once) —
  //    the extra concurrency (two simultaneous fresh mounts, two bursts of
  //    realtime/query traffic at once) a single-reload test structurally
  //    can't produce. --
  console.log("\n--- simultaneous double reload: p1 and p2 both reload at once ---");
  const reloadBoth = Promise.all([
    pages.p1.reload({ waitUntil: "commit" }),
    pages.p2.reload({ waitUntil: "commit" }),
  ]);
  await reloadBoth;
  await Promise.all([
    pages.p1.waitForSelector('[data-testid="avatar-measure-state"]', { state: "attached", timeout: 30000 }).catch(() => undefined),
    pages.p2.waitForSelector('[data-testid="avatar-measure-state"]', { state: "attached", timeout: 30000 }).catch(() => undefined),
  ]);
  const [samplesP1b, samplesDmb, samplesP2b] = await Promise.all([
    pollAllSeats(pages.p1, userIds, 7000),
    pollAllSeats(pages.dm, userIds, 7000),
    pollAllSeats(pages.p2, userIds, 7000),
  ]);
  const anomaliesP1b = findAnomalies(samplesP1b, userIds, baselines);
  const anomaliesDmb = findAnomalies(samplesDmb, userIds, baselines);
  const anomaliesP2b = findAnomalies(samplesP2b, userIds, baselines);
  check("double reload: no scale/position anomaly in p1's own view", anomaliesP1b.length === 0, JSON.stringify(anomaliesP1b));
  check("double reload: no scale/position anomaly in the DM's observing view", anomaliesDmb.length === 0, JSON.stringify(anomaliesDmb));
  check("double reload: no scale/position anomaly in p2's own view", anomaliesP2b.length === 0, JSON.stringify(anomaliesP2b));
  allAnomalies.push({ cycle: "double", view: "p1", anomalies: anomaliesP1b });
  allAnomalies.push({ cycle: "double", view: "dm", anomalies: anomaliesDmb });
  allAnomalies.push({ cycle: "double", view: "p2", anomalies: anomaliesP2b });

  await pages.dm.screenshot({ path: join(SCREENSHOT_DIR, "99-final-dm-view.png") });

  const totalAnomalies = allAnomalies.reduce((sum, a) => sum + a.anomalies.length, 0);
  console.log(`\n=== Total anomalies observed across all cycles/views: ${totalAnomalies} ===`);
  if (totalAnomalies > 0) {
    console.log(JSON.stringify(allAnomalies.filter((a) => a.anomalies.length > 0), null, 2));
  }
} finally {
  await browser.close();
  await admin.from("model_orientation").delete().eq("model_url", `${p1.id}/avatar.glb`);
  await admin.from("model_orientation").delete().eq("model_url", `${p2.id}/avatar.glb`);
  await admin.storage.from("avatars").remove([`${p1.id}/avatar.glb`, `${p2.id}/avatar.glb`]);
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id).catch(() => undefined);
  await admin.auth.admin.deleteUser(p1.id).catch(() => undefined);
  await admin.auth.admin.deleteUser(p2.id).catch(() => undefined);
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
console.log("\nAll multi-avatar reload checks passed — no reproduction of the reported teleport/mis-scale sequence with 3 simultaneous real avatars.");
process.exit(0);
