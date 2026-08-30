#!/usr/bin/env node
// "Objects so tokens can stand on top of them" — a general per-object
// "standable" setting (map_objects.behavior_config's `standable` key, see
// src/data-access/mapObjects.ts's ObjectMovementConfig doc comment),
// generalizing crossingSurface.ts's bridge/stairs-only lift
// (occupantSurfaceHeight) to ANY object a DM marks standable, using a REAL,
// auto-measured height (src/scene-3d/standableSurface.ts's live Box3
// measurement, cached in model_orientation.standable_surface_height) rather
// than a DM-entered number — see crossingSurface.ts's occupantSurfaceHeight
// doc comment and 0105_standable_surface_height.sql for the full design.
//
// Real signed-in Playwright browser throughout (a single DM client is
// sufficient — nothing under test is per-viewer-masked, the
// verify-crossing-structure-height.mjs precedent this script otherwise
// mirrors), driving the REAL Game Room. Covers:
//   1. Real-measurement cross-check: independently re-measures the ACTUAL
//      public/assets/presets/{chest,rock}.glb files through the same
//      GLTFLoader + Box3 + fit-scale math src/scene-3d/standableSurface.ts
//      applies, and confirms a token standing on each renders exactly that
//      real height above the raw cell floor — not a fixed constant (the
//      Chest and Rock presets have genuinely different real geometry, so
//      the two lift amounts must differ).
//   2. Regression: an object present at a cell but NOT marked standable
//      does not lift a token at all — presence alone was never the trigger.
//   3. Regression: the existing bridge/stairs crossingSurfaceHeight lift is
//      byte-for-byte unaffected by generalizing it into occupantSurfaceHeight.
//   4. Caching: the measured height is actually persisted to
//      model_orientation.standable_surface_height (a real DB round-trip),
//      not just held in one client's memory.
//   5. blocksMovement and standable are fully independent: a
//      standable+blocking object still blocks a real move onto it; a
//      standable+explicitly-non-blocking object allows the move AND lifts
//      the token once it settles there.
//   6. A screenshot of a decorative object placed on the SAME cell as a
//      standable host, showing it rendering lifted onto the host — the same
//      "objects sharing a crossing/standable cell render on top of it, not
//      just tokens" scope the existing crossingSurface mechanism already
//      has (MapSurfaceObject.standSurfaceHeight, resolved through the exact
//      same standSurfaceHeightAt helper GameRoom.tsx already uses for
//      tokens).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its dedicated port isn't already serving.
// Usage: node scripts/db/verify-standable-objects.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { createServer } from "vite";
import path from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port — this machine runs several concurrent agent
// worktrees, each potentially squatting on the common ports with their OWN
// checkout's dev server (verify-pits-and-falling.mjs's own reasoning).
const APP_PORT = Number(process.env.STANDABLE_APP_PORT ?? 49610);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

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

// See verify-crossing-structure-height.mjs's identical comment: Vite's
// programmatically-created server below does NOT load .env into
// process.env itself, so MapSurface.tsx's module graph (-> @/audio ->
// @/data-access/supabase-browser's requireEnv()) throws without this.
Object.assign(process.env, env);

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function must(queryBuilderPromise, label) {
  const { data, error } = await queryBuilderPromise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}
function closeTo(a, b, eps, label, detail) {
  check(label, Math.abs(a - b) < eps, detail ?? `a=${a} b=${b} eps=${eps}`);
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

const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  map: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `standable-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await must(
    admin.from("profiles").insert({
      id: data.user.id,
      display_name: `Standable ${label}`,
      ui_preferences: { panelLayout: COLLAPSED_PANEL_LAYOUT },
    }),
    `inserting profile for ${label}`
  );
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function isCanvasPoint(page, point) {
  return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS", [point.x, point.y]);
}

/** Blind center-out scan over the canvas (verify-pits-and-falling.mjs's own
 * `scanClick`, copied verbatim — no way to compute a WebGL raycast target
 * from camera math, so this discovers a working screen point empirically). */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.25, xTo = 0.75, yFrom = 0.3, yTo = 0.75, step = 16, settleMs = 110, exclude = [], onMiss, label = "" } = opts;
  let box = await page.locator("canvas").boundingBox();
  const viewport = page.viewportSize();
  const minSize = viewport ? Math.min(viewport.width, viewport.height) * 0.5 : 400;
  for (let i = 0; i < 20 && (!box || box.width < minSize || box.height < minSize); i++) {
    await sleep(200);
    box = await page.locator("canvas").boundingBox();
  }
  if (!box) throw new Error("no canvas on the page");
  for (const [offset, settle] of [
    [0, settleMs],
    [step / 2, settleMs * 1.5],
  ]) {
    const points = [];
    for (let y = box.y + box.height * yFrom + offset; y <= box.y + box.height * yTo; y += step) {
      for (let x = box.x + box.width * xFrom + offset; x <= box.x + box.width * xTo; x += step) {
        points.push({ x, y });
      }
    }
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.5;
    points.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
    for (const point of points) {
      if (exclude.some((e) => Math.hypot(e.x - point.x, e.y - point.y) < (e.radius ?? 20))) continue;
      if (!(await isCanvasPoint(page, point))) continue;
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) {
        console.log(`  scanClick${label ? ` (${label})` : ""}: found`);
        return point;
      }
      if (onMiss) await onMiss(point);
    }
  }
  console.log(`  scanClick${label ? ` (${label})` : ""}: exhausted every candidate point — not found`);
  return null;
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

async function pollUntil(fn, { timeoutMs = 10000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

async function tokenRow(id) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

async function modelOrientationRow(modelUrl) {
  const { data, error } = await admin.from("model_orientation").select().eq("model_url", modelUrl).maybeSingle();
  if (error) throw error;
  return data;
}

async function voidExcept(dmClient, mapId, width, height, keep) {
  const keepKeys = new Set(keep.map(({ x, y }) => `${x},${y}`));
  const rows = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (keepKeys.has(`${x},${y}`)) continue;
      rows.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "void", light_level: "bright" });
    }
  }
  const { error } = await admin.from("map_cells").upsert(rows, { onConflict: "map_id,x,y" });
  if (error) throw error;
}

async function upsertCells(rows) {
  const { error } = await admin.from("map_cells").upsert(
    rows.map((row) => ({ ground_type: "default", water_flow_direction: null, ...row })),
    { onConflict: "map_id,x,y" }
  );
  if (error) throw new Error(`upserting map_cells failed: ${error.message}`);
}

await ensureDevServer();

// ════════════════════════════════════════════════════════════════════
// Phase 0 — real-measurement cross-check: independently measure the ACTUAL
// generated public/assets/presets/{chest,rock}.glb files through the exact
// GLTFLoader + Box3 + fit-scale math standableSurface.ts applies at
// runtime — catches a future regeneration of either preset with different
// proportions silently going stale, and proves the two presets really do
// have different real geometry (so a two-different-heights check downstream
// is meaningful, not a coincidence).
// ════════════════════════════════════════════════════════════════════
const PLACED_OBJECT_SIZE = 0.92; // src/scene-3d/PlacedObject.tsx's own constant

function measureGlb(buffer) {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, "", (gltf) => {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = PLACED_OBJECT_SIZE / maxDim;
      resolve({ size, maxDim, scale, standHeight: size.y * scale });
    }, reject);
  });
}

const chestMeasured = await measureGlb(readFileSync(join(rootDir, "public", "assets", "presets", "chest.glb")));
const rockMeasured = await measureGlb(readFileSync(join(rootDir, "public", "assets", "presets", "rock.glb")));
check(
  "Chest and Rock really do have different real measured heights (so a two-different-lift-amounts check downstream is meaningful, not incidental)",
  Math.abs(chestMeasured.standHeight - rockMeasured.standHeight) > 0.05,
  `chest=${chestMeasured.standHeight} rock=${rockMeasured.standHeight}`
);
console.log(
  `  real measured standable heights: chest=${chestMeasured.standHeight.toFixed(4)} rock=${rockMeasured.standHeight.toFixed(4)}`
);

const vite = await createServer({
  root: rootDir,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  resolve: { alias: { "@": path.resolve(rootDir, "src") } },
});
const crossingSurfaceModule = await vite.ssrLoadModule("/src/scene-3d/crossingSurface.ts");
const mapFitModule = await vite.ssrLoadModule("/src/scene-3d/mapFit.ts");
const { STAIRS_URL } = crossingSurfaceModule;

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

// Snapshot + clear any pre-existing model_orientation rows for the two real
// preset urls under test — presets are GLOBAL, shared across every
// campaign on this shared dev Supabase stack, so this is a real, if narrow,
// shared-state mutation. Cleared here so this run exercises the real
// measure-then-persist path fresh (proving the CACHING mechanism itself,
// not just that a value happens to already be cached from a previous run),
// and fully restored in the `finally` below either way.
const CHEST_URL = "/assets/presets/chest.glb";
const ROCK_URL = "/assets/presets/rock.glb";
const priorChestRow = await modelOrientationRow(CHEST_URL);
const priorRockRow = await modelOrientationRow(ROCK_URL);
if (priorChestRow) await must(admin.from("model_orientation").delete().eq("model_url", CHEST_URL), "clearing prior chest orientation row");
if (priorRockRow) await must(admin.from("model_orientation").delete().eq("model_url", ROCK_URL), "clearing prior rock orientation row");

try {
  const campaignId = crypto.randomUUID();
  await must(
    admin.from("campaigns").insert({
      id: campaignId,
      name: "Standable objects test",
      creator: dm.id,
      action_economy_strict: false,
    }),
    "inserting campaign"
  );
  await must(
    admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]),
    "inserting campaign_members"
  );

  const { data: presetAssets } = await admin
    .from("asset_library")
    .select("id, name")
    .eq("source_type", "preset")
    .in("name", ["Chest", "Rock", "Torch", "Stairs"]);
  const chestAssetId = presetAssets?.find((a) => a.name === "Chest")?.id;
  const rockAssetId = presetAssets?.find((a) => a.name === "Rock")?.id;
  const torchAssetId = presetAssets?.find((a) => a.name === "Torch")?.id;
  const stairsAssetId = presetAssets?.find((a) => a.name === "Stairs")?.id;
  check(
    "the Chest, Rock, Torch, and Stairs preset assets all exist",
    Boolean(chestAssetId) && Boolean(rockAssetId) && Boolean(torchAssetId) && Boolean(stairsAssetId),
    JSON.stringify(presetAssets)
  );

  // ════════════════════════════════════════════════════════════════════
  // Layout — one static map covering the lift checks + co-located-object
  // screenshot (no movement involved, so nothing here needs isolating):
  //     (0,0) nothing                                → tokenBaseline (fully unaffected)
  //     (1,0) Chest, NOT standable ({} config)        → tokenChestNotStandable (regression)
  //     (2,0) Chest, standable:true                   → tokenChestStandable
  //     (3,0) Rock, standable:true                    → tokenRockStandable
  //     (4,0) Stairs (existing crossing_type feature) → tokenStairsRegression
  //     (0,1) Chest (standable host) + Torch (co-located object) at the SAME cell
  //
  // The blocksMovement/standable independence checks live on their OWN,
  // separate, minimal maps further down (moveBlockedMapId/moveAllowedMapId)
  // — NOT extra rows on this same map. A real click-select-to-move scan is
  // blind (scanClick has no way to compute a WebGL raycast target from
  // camera math) and this token's own move range can reach any nearby real
  // cell, not just the one cell under test; sharing a map with other real,
  // reachable cells risks the blind scan's own candidate clicks moving the
  // token somewhere UNINTENDED before ever trying the actual cell under
  // test — an artifact of the test methodology, not a real product
  // question. Each move scenario gets a map with EXACTLY one other real
  // cell (the object's own), so there is nowhere else for a stray click to
  // send the token — the same total-isolation shape
  // verify-crossing-structure-height.mjs's own Phase 2 move-transition map
  // already uses for exactly this reason.
  // ════════════════════════════════════════════════════════════════════
  const gridWidth = 5;
  const gridHeight = 2;
  const mapId = crypto.randomUUID();
  await must(
    admin.from("campaign_maps").insert({
      id: mapId,
      campaign_id: campaignId,
      name: "Standable objects — static layout",
      grid_width: gridWidth,
      grid_height: gridHeight,
    }),
    "inserting map"
  );
  const keepCells = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 },
    { x: 0, y: 1 },
  ];
  await upsertCells(
    keepCells.map(({ x, y }) => ({ map_id: mapId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright" }))
  );
  await voidExcept(dm.client, mapId, gridWidth, gridHeight, keepCells);

  await must(
    admin.from("map_objects").insert([
      { map_id: mapId, asset_id: chestAssetId, x: 1, y: 0, elevation: 0, rotation: 0, crossing_type: null, behavior_config: {} },
      { map_id: mapId, asset_id: chestAssetId, x: 2, y: 0, elevation: 0, rotation: 0, crossing_type: null, behavior_config: { standable: true } },
      { map_id: mapId, asset_id: rockAssetId, x: 3, y: 0, elevation: 0, rotation: 0, crossing_type: null, behavior_config: { standable: true } },
      { map_id: mapId, asset_id: stairsAssetId, x: 4, y: 0, elevation: 0, rotation: 0, crossing_type: "stairs", behavior_config: {} },
      // Object sharing a cell with a standable host (direct DB insert
      // bypasses the Map Editor's own one-freestanding-object-per-cell UI
      // constraint, the same "construct it directly, verify visually"
      // precedent verify-tavern-followup.mjs already uses for its own
      // object-on-object stacking screenshot).
      { map_id: mapId, asset_id: chestAssetId, x: 0, y: 1, elevation: 0, rotation: 0, crossing_type: null, behavior_config: { standable: true } },
      { map_id: mapId, asset_id: torchAssetId, x: 0, y: 1, elevation: 0, rotation: 0, crossing_type: null, behavior_config: {} },
    ]),
    "inserting map_objects"
  );

  const tokenBaseline = crypto.randomUUID();
  const tokenChestNotStandable = crypto.randomUUID();
  const tokenChestStandable = crypto.randomUUID();
  const tokenRockStandable = crypto.randomUUID();
  const tokenStairsRegression = crypto.randomUUID();

  await must(
    admin.from("map_tokens").insert([
      { id: tokenBaseline, map_id: mapId, npc_name: "Baseline", x: 0, y: 0, elevation: 0, allegiance: "neutral" },
      { id: tokenChestNotStandable, map_id: mapId, npc_name: "On non-standable Chest", x: 1, y: 0, elevation: 0, allegiance: "neutral" },
      { id: tokenChestStandable, map_id: mapId, npc_name: "On standable Chest", x: 2, y: 0, elevation: 0, allegiance: "neutral" },
      { id: tokenRockStandable, map_id: mapId, npc_name: "On standable Rock", x: 3, y: 0, elevation: 0, allegiance: "neutral" },
      { id: tokenStairsRegression, map_id: mapId, npc_name: "On Stairs (regression)", x: 4, y: 0, elevation: 0, allegiance: "neutral" },
    ]),
    "inserting map_tokens"
  );
  await must(admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId), "updating live_map");

  const ROOM_VIEWPORT = { width: 1920, height: 1080 };
  const dmContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  dmRoom.on("console", (msg) => {
    if (msg.type() === "error") console.error("  [page console error]", msg.text());
  });
  dmRoom.on("pageerror", (err) => console.error("  [page error]", err.message));
  await dmRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  // Real, deterministic settle wait — every token here mounts already at
  // its target with no move in flight (crossing-structure-height.mjs's own
  // TOKEN_SLIDE_SECONDS reasoning), generous headroom for the standable
  // measure-then-persist round trip too (a real network fetch + parse +
  // Supabase upsert, not instant).
  await sleep(1500);

  const metrics = mapFitModule.computeTableMapMetrics(gridWidth, gridHeight);
  const baseHeight0 = metrics.baseHeight;
  const stairsSurface = crossingSurfaceModule.crossingSurfaceHeight(STAIRS_URL) * metrics.cellSize;
  const TOPY_EPS = 1e-3;

  // ════════════════════════════════════════════════════════════════════
  // Lift checks (row y=0) — poll until the measure-then-cache effect has
  // had a chance to run (a real async round trip), not a fixed sleep.
  // ════════════════════════════════════════════════════════════════════
  const allLiftTokenIds = [tokenBaseline, tokenChestNotStandable, tokenChestStandable, tokenRockStandable, tokenStairsRegression];
  let lastSeenState = null;
  const transformState = await pollUntil(
    async () => {
      const state = await readMirror(dmRoom, "token-transform-state");
      lastSeenState = state;
      const expectedTopY = baseHeight0 + chestMeasured.standHeight * metrics.cellSize;
      const measured = state[tokenChestStandable]?.topY;
      // Keep polling until the standable Chest token's own topY has
      // actually settled at the real measured height (not just present at
      // some interim value — the lazy measure-then-persist effect renders
      // at height 0 the instant the token mounts, then "pops in" once the
      // real Box3 measurement resolves).
      const ready = allLiftTokenIds.every((id) => id in state) && measured !== undefined && Math.abs(measured - expectedTopY) < 0.01;
      return ready ? state : null;
    },
    { timeoutMs: 20000, intervalMs: 300 }
  );
  check(
    "every lift-check token settles at its real, measured topY within 20s (the auto-measure-then-cache round trip completes)",
    transformState !== null,
    `last seen: ${JSON.stringify(lastSeenState)}`
  );

  if (transformState) {
    closeTo(
      transformState[tokenBaseline].topY,
      baseHeight0,
      TOPY_EPS,
      "a token with no object at all on its cell renders at exactly baseHeight — fully unaffected"
    );

    closeTo(
      transformState[tokenChestNotStandable].topY,
      baseHeight0,
      TOPY_EPS,
      "REGRESSION: an object present at a cell but NOT marked standable does not lift a token at all — presence alone was never the trigger"
    );

    const expectedChestTopY = baseHeight0 + chestMeasured.standHeight * metrics.cellSize;
    closeTo(
      transformState[tokenChestStandable].topY,
      expectedChestTopY,
      0.01,
      `a token on a standable Chest renders at baseHeight + Chest's own REAL measured height (expected ${expectedChestTopY}, got ${transformState[tokenChestStandable].topY})`
    );
    check(
      "the standable Chest token renders ABOVE the raw cell floor",
      transformState[tokenChestStandable].topY > baseHeight0 + TOPY_EPS
    );

    const expectedRockTopY = baseHeight0 + rockMeasured.standHeight * metrics.cellSize;
    closeTo(
      transformState[tokenRockStandable].topY,
      expectedRockTopY,
      0.01,
      `a token on a standable Rock renders at baseHeight + Rock's own REAL measured height (expected ${expectedRockTopY}, got ${transformState[tokenRockStandable].topY})`
    );

    check(
      "Chest and Rock produce two DIFFERENT real lift amounts, genuinely derived from each asset's own geometry — not a fixed constant shared by every standable object",
      Math.abs(transformState[tokenChestStandable].topY - transformState[tokenRockStandable].topY) > 0.02,
      `chest topY=${transformState[tokenChestStandable].topY} rock topY=${transformState[tokenRockStandable].topY}`
    );

    closeTo(
      transformState[tokenStairsRegression].topY,
      baseHeight0 + stairsSurface,
      TOPY_EPS,
      `REGRESSION: the existing Stairs crossing-structure lift is unaffected by generalizing crossingSurfaceHeight into occupantSurfaceHeight (expected ${baseHeight0 + stairsSurface}, got ${transformState[tokenStairsRegression].topY})`
    );
  }

  // ════════════════════════════════════════════════════════════════════
  // Caching — the measured heights actually reached model_orientation, a
  // real DB round trip, not just this one client's own in-memory state.
  //
  // migration 0105_standable_surface_height.sql (the new column this needs)
  // is deliberately NOT applied to the live DB yet — the project owner has
  // asked to hold every migration in this batch until all ~9 related fixes
  // are done, and this script must never apply one itself. Detected here
  // (rather than assumed) so this reports as a clearly-labeled BLOCKED
  // precondition, not a false failure, exactly like the brief's own
  // "some verify scripts may show BLOCKED checks related to [pending]
  // migrations" note — the render-side checks above already prove the
  // measurement and lift are correct independent of whether this specific
  // write lands.
  // ════════════════════════════════════════════════════════════════════
  const { error: schemaProbeError } = await admin
    .from("model_orientation")
    .select("standable_surface_height")
    .limit(1);
  const migrationApplied = !schemaProbeError;
  if (!migrationApplied) {
    console.log(
      `BLOCKED  model_orientation.standable_surface_height caching checks — migration 0105_standable_surface_height.sql is not yet applied to the live DB (expected; held per the project owner's batch-migration request). Detail: ${schemaProbeError.message}`
    );
  } else {
    const chestRow = await pollUntil(() => modelOrientationRow(CHEST_URL), { timeoutMs: 10000 });
    const rockRow = await pollUntil(() => modelOrientationRow(ROCK_URL), { timeoutMs: 10000 });
    check("the Chest preset's real measured height was persisted to model_orientation", Boolean(chestRow), JSON.stringify(chestRow));
    check("the Rock preset's real measured height was persisted to model_orientation", Boolean(rockRow), JSON.stringify(rockRow));
    if (chestRow) {
      closeTo(
        chestRow.standable_surface_height,
        chestMeasured.standHeight,
        1e-3,
        "the PERSISTED Chest height matches the independent fresh Box3 measurement exactly"
      );
    }
    if (rockRow) {
      closeTo(
        rockRow.standable_surface_height,
        rockMeasured.standHeight,
        1e-3,
        "the PERSISTED Rock height matches the independent fresh Box3 measurement exactly"
      );
    }
  }

  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "standable-lift-row.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "standable-lift-row.png")}`);

  // ════════════════════════════════════════════════════════════════════
  // blocksMovement/standable independence — TWO separate, minimal (2-real-
  // cell) maps, one per direction, so a blind scanClick attempt has
  // NOWHERE ELSE it could possibly send the token — see this section's own
  // top comment (declared alongside gridWidth/gridHeight above) for why.
  // ════════════════════════════════════════════════════════════════════
  const selectionState = () => readMirror(dmRoom, "token-selection-state");

  async function loadRoom() {
    await dmRoom.reload();
    await dmRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
    await sleep(800);
  }

  // A tighter, smaller scan region/step than scanClick's own defaults —
  // used ONLY for the "prove this destination can never be reached" check
  // below, which (by design) must exhaust every candidate before
  // concluding "not found". A 2-real-cell map renders those two cells
  // fairly centrally and close together, so this smaller box still covers
  // them while cutting the exhaustive scan's own candidate count (and
  // total runtime) substantially versus scanClick's full-canvas default.
  const TIGHT_SCAN = { xFrom: 0.35, xTo: 0.65, yFrom: 0.35, yTo: 0.65, step: 24 };

  // ---- Blocked: standable:true + blocksMovement:true must still block. ----
  const moveBlockedMapId = crypto.randomUUID();
  await must(
    admin.from("campaign_maps").insert({
      id: moveBlockedMapId,
      campaign_id: campaignId,
      name: "Standable objects — move blocked",
      grid_width: 2,
      grid_height: 1,
    }),
    "inserting move-blocked map"
  );
  await upsertCells([
    { map_id: moveBlockedMapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
    { map_id: moveBlockedMapId, x: 1, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
  ]);
  await voidExcept(dm.client, moveBlockedMapId, 2, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  await must(
    admin.from("map_objects").insert({
      map_id: moveBlockedMapId,
      asset_id: chestAssetId,
      x: 1,
      y: 0,
      elevation: 0,
      rotation: 0,
      crossing_type: null,
      behavior_config: { standable: true, blocksMovement: true },
    }),
    "inserting move-blocked Chest"
  );
  const moveBlockedToken = crypto.randomUUID();
  await must(
    admin.from("map_tokens").insert({
      id: moveBlockedToken,
      map_id: moveBlockedMapId,
      npc_name: "Move-blocked",
      x: 0,
      y: 0,
      elevation: 0,
      allegiance: "neutral",
    }),
    "inserting move-blocked token"
  );
  await must(admin.from("campaigns").update({ live_map: moveBlockedMapId }).eq("id", campaignId), "switching to move-blocked map");
  await loadRoom();

  const blockedTokenPoint = await scanClick(
    dmRoom,
    async () => (await selectionState()).selectedTokenId === moveBlockedToken,
    { label: "select move-blocked token" }
  );
  check("the move-blocked token can be click-selected", blockedTokenPoint !== null);
  const beforeBlockedRow = await tokenRow(moveBlockedToken);
  // Checks for the token landing EXACTLY on the chest's own cell (1,0) —
  // NOT just "did its position change at all". With only ONE other real
  // cell on this entire map (the chest's own), there is nowhere else a
  // stray click could send it, so this doubles as the "stayed put" proof
  // too — no separate before/after position check needed.
  const blockedDestPoint = await scanClick(
    dmRoom,
    async () => {
      const row = await tokenRow(moveBlockedToken);
      return row.x === 1 && row.y === 0;
    },
    {
      label: "attempt move onto standable+blocking Chest",
      exclude: blockedTokenPoint ? [{ ...blockedTokenPoint, radius: 14 }] : [],
      ...TIGHT_SCAN,
    }
  );
  check(
    "standable:true does NOT waive blocksMovement:true — a token cannot reach a standable+blocking object's own cell (no leaking special-casing between the two flags)",
    blockedDestPoint === null
  );
  const afterBlockedRow = await tokenRow(moveBlockedToken);
  check(
    "the move-blocked token's position is exactly unchanged after the blocked attempt",
    afterBlockedRow.x === beforeBlockedRow.x && afterBlockedRow.y === beforeBlockedRow.y,
    `before=(${beforeBlockedRow.x},${beforeBlockedRow.y}) after=(${afterBlockedRow.x},${afterBlockedRow.y})`
  );
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "standable-move-blocked.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "standable-move-blocked.png")}`);

  // ---- Allowed: standable:true + explicit blocksMovement:false must move + lift. ----
  const moveAllowedMapId = crypto.randomUUID();
  await must(
    admin.from("campaign_maps").insert({
      id: moveAllowedMapId,
      campaign_id: campaignId,
      name: "Standable objects — move allowed",
      grid_width: 2,
      grid_height: 1,
    }),
    "inserting move-allowed map"
  );
  await upsertCells([
    { map_id: moveAllowedMapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
    { map_id: moveAllowedMapId, x: 1, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
  ]);
  await voidExcept(dm.client, moveAllowedMapId, 2, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  await must(
    admin.from("map_objects").insert({
      map_id: moveAllowedMapId,
      asset_id: rockAssetId,
      x: 1,
      y: 0,
      elevation: 0,
      rotation: 0,
      crossing_type: null,
      behavior_config: { standable: true, blocksMovement: false },
    }),
    "inserting move-allowed Rock"
  );
  const moveAllowedToken = crypto.randomUUID();
  await must(
    admin.from("map_tokens").insert({
      id: moveAllowedToken,
      map_id: moveAllowedMapId,
      npc_name: "Move-allowed",
      x: 0,
      y: 0,
      elevation: 0,
      allegiance: "neutral",
    }),
    "inserting move-allowed token"
  );
  await must(admin.from("campaigns").update({ live_map: moveAllowedMapId }).eq("id", campaignId), "switching to move-allowed map");
  await loadRoom();

  const allowedTokenPoint = await scanClick(
    dmRoom,
    async () => (await selectionState()).selectedTokenId === moveAllowedToken,
    { label: "select move-allowed token" }
  );
  check("the move-allowed token can be click-selected", allowedTokenPoint !== null);
  const allowedDestPoint = await scanClick(
    dmRoom,
    async () => {
      const row = await tokenRow(moveAllowedToken);
      return row.x === 1 && row.y === 0;
    },
    {
      label: "move onto standable+explicitly-non-blocking Rock",
      exclude: allowedTokenPoint ? [{ ...allowedTokenPoint, radius: 14 }] : [],
    }
  );
  check(
    "an explicit blocksMovement:false override still allows the move even though the object is ALSO standable — the two flags never imply each other",
    allowedDestPoint !== null
  );

  if (allowedDestPoint) {
    await sleep(1000); // well past TOKEN_SLIDE_SECONDS — fully settled
    const allowedMetrics = mapFitModule.computeTableMapMetrics(2, 1);
    const afterMoveTransform = await pollUntil(
      async () => {
        const state = await readMirror(dmRoom, "token-transform-state");
        const expectedTopY = allowedMetrics.baseHeight + rockMeasured.standHeight * allowedMetrics.cellSize;
        const t = state[moveAllowedToken];
        return t && Math.abs(t.topY - expectedTopY) < 0.01 ? t : null;
      },
      { timeoutMs: 15000 }
    );
    check("the moved token's settled transform is reported at the Rock's own real lift", afterMoveTransform !== null);
  }

  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "standable-move-allowed.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "standable-move-allowed.png")}`);

  // Back to the static layout map for the co-located-object screenshot below.
  await must(admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId), "switching back to static layout map");
  await loadRoom();

  // ════════════════════════════════════════════════════════════════════
  // Objects sharing a cell with a standable host (row y=2) — screenshot
  // proof, the same "construct it directly via the DB, verify visually"
  // precedent verify-tavern-followup.mjs already uses for object-on-object
  // stacking (there is no numeric object-topY debug mirror in this app —
  // MapSurfaceObject.standSurfaceHeight is resolved through the exact same
  // standSurfaceHeightAt/occupantSurfaceHeight code path already proven
  // correct above for tokens, see GameRoom.tsx's objects-loop doc comment).
  // ════════════════════════════════════════════════════════════════════
  const coLocatedRows = await must(
    admin.from("map_objects").select("id, asset_id, x, y, behavior_config").eq("map_id", mapId).eq("x", 0).eq("y", 1),
    "reading co-located row 2 objects"
  );
  check(
    "the Chest (standable host) and Torch (ordinary object) really do share the SAME cell in the DB, as set up",
    coLocatedRows.length === 2,
    JSON.stringify(coLocatedRows)
  );
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "standable-colocated-object.png") });
  console.log(
    `screenshot (visual proof the Torch renders lifted onto the standable Chest sharing its cell): ${join(SCRATCH_DIR, "standable-colocated-object.png")}`
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  // Cleanup — this shared dev Supabase stack runs many concurrent
  // worktrees. Deleting the campaign CASCADEs its maps/objects/tokens
  // (campaign_maps.campaign_id, map_objects.map_id, map_tokens.map_id are
  // all ON DELETE CASCADE per their own FKs).
  await admin.from("campaigns").delete().eq("name", "Standable objects test").eq("creator", dm.id);
  // Restore model_orientation's shared, GLOBAL rows for the two real preset
  // urls to exactly their pre-test state — these presets are used by every
  // real campaign on this stack, so this run must leave zero net trace on
  // them either way, regardless of pass/fail above.
  if (priorChestRow) {
    await admin.from("model_orientation").upsert(priorChestRow);
  } else {
    await admin.from("model_orientation").delete().eq("model_url", CHEST_URL);
  }
  if (priorRockRow) {
    await admin.from("model_orientation").upsert(priorRockRow);
  } else {
    await admin.from("model_orientation").delete().eq("model_url", ROCK_URL);
  }
  await vite.close();
  await browser.close();
  if (devServer) devServer.kill();
}
