#!/usr/bin/env node
// Bridges and stairs surface-height + stairs tilt (a post-roadmap addition
// on top of 0053_crossing_structures.sql's map_objects.crossing_type):
// verifies the fix for "a token standing on a bridge/stairs cell renders at
// the underlying terrain's raw elevation, embedded in/at-the-foot of the
// model instead of on its visible walkable surface" — see
// src/scene-3d/crossingSurface.ts's own top-of-file doc comment for the full
// root-cause writeup and the "computed constant, not a DB column" design
// choice.
//
// Real signed-in Playwright browser throughout (a single DM client is
// sufficient — nothing under test is per-viewer-masked, the exact
// verify-bridges-and-stairs.mjs precedent this script otherwise mirrors),
// driving the REAL Game Room. Covers:
//   1. Real-measurement cross-check: re-loads the ACTUAL generated
//      public/assets/presets/{bridge,stairs}.glb through three.js's
//      GLTFLoader + the SAME Box3/fit-scale math PlacedObject.tsx applies at
//      render time, and confirms crossingSurface.ts's own hardcoded
//      constants still match that real geometry — catches a future
//      regeneration of either preset with different proportions silently
//      going stale (crossingSurface.ts's own doc comment promises this).
//   2. A token standing on a BRIDGE renders ABOVE the raw cell floor by
//      exactly the bridge deck's own real measured surface height, and does
//      NOT tilt (pitch/yaw both 0) — read from the token's own ACTUAL
//      rendered transform (MapSurfaceProps.onTokenTransformDebug), not just
//      the props that were fed in.
//   3. A token standing on STAIRS renders above the raw cell floor by the
//      stairs' own real measured surface height, AND tilts by the flight's
//      own real incline angle, yawed to match that stairs object's own
//      placement rotation (checked at rotation 0 AND 90 — proves the yaw
//      genuinely tracks the object, not a hardcoded direction).
//   4. Regression: a token on ordinary elevated terrain with NO crossing
//      structure renders at EXACTLY today's height (raw elevation only, no
//      offset) with no tilt — MapPlan P5's raise/lower feature unregressed.
//   5. A token on flat ground with no crossing structure and no elevation
//      change is completely unaffected (topY = baseHeight exactly, no
//      tilt).
//   6. A real move (click-select-to-move) from plain ground onto a stairs
//      cell — screenshots the in-flight moment and the settled result, and
//      confirms the FINAL settled tilt is correct (the smooth blend itself
//      is unit-tested in tokenSlide.test.ts's shortestAngleLerp/lerp
//      coverage; this proves the same useTokenSlide clock that already
//      drives topY without popping is the SAME one driving tilt).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its dedicated port isn't already serving.
// Usage: node scripts/db/verify-crossing-structure-height.mjs

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
const APP_PORT = Number(process.env.CROSSING_HEIGHT_APP_PORT ?? 49333);
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

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

/** Awaits a Supabase query builder and throws loudly on `.error` — a bare
 * `await admin.from(...).insert(...)` silently swallows a constraint
 * violation (this script's own first real bug: one bad row in a batch
 * insert failed the WHOLE batch with no visible error, leaving "no tokens
 * on the table" a mystery until this wrapper was added). Every admin write
 * below goes through this. */
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

// verify-bridges-and-stairs.mjs's own collapsed-panel-layout fix: keeps the
// small test map's cells clickable for the one real move this script makes.
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  map: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `crossing-height-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await must(
    admin.from("profiles").insert({
      id: data.user.id,
      display_name: `Crossing Height ${label}`,
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
  return page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS",
    [point.x, point.y]
  );
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

/** Voids every cell in a WxH grid except the ones in `keep` — the
 * verify-bridges-and-stairs.mjs precedent for making a blind click
 * deterministic. */
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
// Phase 0 — real-measurement cross-check: crossingSurface.ts's own
// hardcoded constants against a FRESH load of the actual generated .glb
// files, through the exact Box3/fit-scale math PlacedObject.tsx applies at
// render time — catches a future regeneration of either preset silently
// going stale.
// ════════════════════════════════════════════════════════════════════
const PLACED_OBJECT_SIZE = 0.92; // src/scene-3d/PlacedObject.tsx's own constant

function measureGlb(buffer) {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, "", (gltf) => {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      resolve({ box, size, maxDim, scale: PLACED_OBJECT_SIZE / maxDim });
    }, reject);
  });
}

const bridgeMeasured = await measureGlb(readFileSync(join(rootDir, "public", "assets", "presets", "bridge.glb")));
const stairsMeasured = await measureGlb(readFileSync(join(rootDir, "public", "assets", "presets", "stairs.glb")));

// The app's REAL crossingSurface.ts module, loaded through vite exactly the
// way verify-bridges-and-stairs.mjs loads movement.ts — the structural
// checks below run the SAME crossingSurfaceHeight/STAIRS_TILT_PITCH_RADIANS
// the Game Room actually renders with, not a hand-rolled lookalike.
const vite = await createServer({
  root: rootDir,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  // mapFit.ts/MapSurface.tsx's own module graph reaches tokenSlide.ts's
  // `@/rules-engine` import — same tsconfig.json "paths" alias vitest.config.ts
  // already resolves for the real test suite.
  resolve: { alias: { "@": path.resolve(rootDir, "src") } },
});
const crossingSurfaceModule = await vite.ssrLoadModule("/src/scene-3d/crossingSurface.ts");
const mapFitModule = await vite.ssrLoadModule("/src/scene-3d/mapFit.ts");

// Bridge: the deck plank mesh's own top face (raw y=0.13, buildBridge()'s
// `BoxGeometry(0.92, 0.06, 0.7)` centered at y=0.1), rebased against the
// model's own real measured minimum (the hanging support posts' bottom),
// scaled by the model's own real measured fit factor.
const bridgeExpected = (0.13 - bridgeMeasured.box.min.y) * bridgeMeasured.scale;
closeTo(
  crossingSurfaceModule.crossingSurfaceHeight("bridge"),
  bridgeExpected,
  1e-6,
  "crossingSurface.ts's bridge surface height matches a FRESH measurement of the real bridge.glb"
);

// Stairs: the whole model's own real measured top (the tallest tread),
// scaled by the model's own real measured fit factor.
const stairsExpected = stairsMeasured.box.max.y * stairsMeasured.scale;
closeTo(
  crossingSurfaceModule.crossingSurfaceHeight("stairs"),
  stairsExpected,
  1e-6,
  "crossingSurface.ts's stairs surface height matches a FRESH measurement of the real stairs.glb"
);

check(
  "crossingSurfaceHeight(null) and (undefined) are both exactly 0 — no crossing structure changes nothing",
  crossingSurfaceModule.crossingSurfaceHeight(null) === 0 && crossingSurfaceModule.crossingSurfaceHeight(undefined) === 0
);

check(
  "the stairs incline is a real, substantial angle (not near-flat, not near-vertical)",
  (() => {
    const deg = (crossingSurfaceModule.STAIRS_SLOPE_RADIANS * 180) / Math.PI;
    return deg > 20 && deg < 60;
  })()
);

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await must(
    admin.from("campaigns").insert({
      id: campaignId,
      name: "Crossing structure height test",
      creator: dm.id,
      action_economy_strict: false,
    }),
    "inserting campaign"
  );
  await must(
    admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]),
    "inserting campaign_members"
  );

  const ariaId = crypto.randomUUID();
  await must(
    admin.from("characters").insert({
    id: ariaId,
    campaign_id: campaignId,
    owner_id: dm.id,
    name: "Aria Spanwell",
    race: "Human",
    class: "Adventurer",
    level: 1,
    strength: 10,
    dexterity: 14,
    constitution: 14,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 100,
    max_hp: 100,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
    }),
    "inserting character"
  );

  const { data: presetAssets } = await admin
    .from("asset_library")
    .select("id, name")
    .eq("source_type", "preset")
    .in("name", ["Bridge", "Stairs"]);
  const bridgeAssetId = presetAssets?.find((a) => a.name === "Bridge")?.id;
  const stairsAssetId = presetAssets?.find((a) => a.name === "Stairs")?.id;
  check(
    "the Bridge and Stairs preset assets both exist",
    Boolean(bridgeAssetId) && Boolean(stairsAssetId),
    JSON.stringify(presetAssets)
  );

  const ROOM_VIEWPORT = { width: 1920, height: 1080 };
  const dmContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));

  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — static layout covering every acceptance scenario at once:
  //   (0,0) flat, no crossing, no elevation      → token D (fully unaffected)
  //   (1,0) elevation 2, NO crossing object       → token C (regression: raw elevation only)
  //   (2,0) elevation 0, Bridge (rotation 0)       → token A (height offset, NO tilt)
  //   (3,0) elevation 2, Stairs (rotation 0)       → token B (height offset + tilt, yaw 0)
  //   (3,1) elevation 2, Stairs (rotation 90)      → token E (same tilt magnitude, yaw 90)
  // ════════════════════════════════════════════════════════════════════
  const gridWidth = 4;
  const gridHeight = 2;
  const mapId = crypto.randomUUID();
  await must(
    admin.from("campaign_maps").insert({
      id: mapId,
      campaign_id: campaignId,
      name: "Crossing structure height — static layout",
      grid_width: gridWidth,
      grid_height: gridHeight,
    }),
    "inserting static-layout map"
  );
  await upsertCells([
    { map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 1, y: 0, elevation: 2, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 2, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 3, y: 0, elevation: 2, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 3, y: 1, elevation: 2, terrain_type: "normal", light_level: "bright" },
  ]);
  await voidExcept(dm.client, mapId, gridWidth, gridHeight, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 3, y: 0 },
    { x: 3, y: 1 },
  ]);
  await must(
    admin.from("map_objects").insert([
      { map_id: mapId, asset_id: bridgeAssetId, x: 2, y: 0, elevation: 0, rotation: 0, crossing_type: "bridge" },
      { map_id: mapId, asset_id: stairsAssetId, x: 3, y: 0, elevation: 2, rotation: 0, crossing_type: "stairs" },
      { map_id: mapId, asset_id: stairsAssetId, x: 3, y: 1, elevation: 2, rotation: 90, crossing_type: "stairs" },
    ]),
    "inserting bridge/stairs map_objects"
  );
  const tokenD = crypto.randomUUID(); // flat, unaffected
  const tokenC = crypto.randomUUID(); // ordinary elevated, no crossing (regression)
  const tokenA = crypto.randomUUID(); // bridge
  const tokenB = crypto.randomUUID(); // stairs, rotation 0
  const tokenE = crypto.randomUUID(); // stairs, rotation 90
  {
    // map_tokens_pc_xor_npc (0019_map_tokens.sql): a token is a PC
    // (character_id set, npc_name null) or an NPC (character_id null,
    // npc_name set) — never neither. `.throwOnError()` so a violation here
    // fails loudly instead of silently inserting zero rows (a single bad
    // row fails the WHOLE batch, which is exactly what happened the first
    // time this script ran without it).
    const { error } = await admin.from("map_tokens").insert([
      { id: tokenD, map_id: mapId, character_id: ariaId, x: 0, y: 0, elevation: 0, allegiance: "party" },
      { id: tokenC, map_id: mapId, npc_name: "Control (elevated, no crossing)", x: 1, y: 0, elevation: 2, allegiance: "neutral" },
      { id: tokenA, map_id: mapId, npc_name: "Bridge token", x: 2, y: 0, elevation: 0, allegiance: "neutral" },
      { id: tokenB, map_id: mapId, npc_name: "Stairs token (rotation 0)", x: 3, y: 0, elevation: 2, allegiance: "hostile" },
      { id: tokenE, map_id: mapId, npc_name: "Stairs token (rotation 90)", x: 3, y: 1, elevation: 2, allegiance: "hostile" },
    ]);
    if (error) throw new Error(`inserting map_tokens failed: ${error.message}`);
  }
  await must(
    admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId),
    "updating live_map to static-layout map"
  );

  const dmRoom = await dmContext.newPage();
  dmRoom.on("console", (msg) => {
    if (msg.type() === "error") console.error("  [page console error]", msg.text());
  });
  dmRoom.on("pageerror", (err) => console.error("  [page error]", err.message));
  await loadRoom(dmRoom);
  // Real, deterministic settle wait (TOKEN_SLIDE_SECONDS is 0.32s; every
  // token here mounts already at its target with no move in flight, so
  // this is generous headroom, not a fragile race) — every mirror read
  // below is still a synchronous check against the DOM once this resolves,
  // not a background poll reporting "done" on its own.
  await sleep(1500);

  let lastSeenState = null;
  const transformState = await pollUntil(
    async () => {
      const state = await readMirror(dmRoom, "token-transform-state");
      lastSeenState = state;
      return [tokenD, tokenC, tokenA, tokenB, tokenE].every((id) => id in state) ? state : null;
    },
    { timeoutMs: 15000 }
  );
  check(
    "every token's transform is reported by the debug mirror",
    transformState !== null,
    `one or more tokens never settled/reported — last seen: ${JSON.stringify(lastSeenState)}`
  );
  if (!transformState) {
    await dmRoom.screenshot({ path: join(SCRATCH_DIR, "crossing-height-DEBUG-no-transform.png") });
    console.log(`DEBUG screenshot: ${join(SCRATCH_DIR, "crossing-height-DEBUG-no-transform.png")}`);
    const surfaceState = await readMirror(dmRoom, "table-surface-state").catch((e) => `error: ${e.message}`);
    console.log("table-surface-state:", JSON.stringify(surfaceState));
    const tokenSelState = await readMirror(dmRoom, "token-selection-state").catch((e) => `error: ${e.message}`);
    console.log("token-selection-state:", JSON.stringify(tokenSelState));
    console.log(`\n${failures} CHECK(S) FAILED (debug run)`);
    process.exitCode = 1;
    await vite.close();
    await browser.close();
    if (devServer) devServer.kill();
    process.exit(1);
  }

  const metrics = mapFitModule.computeTableMapMetrics(gridWidth, gridHeight);
  const baseHeight0 = metrics.baseHeight;
  const step2 = metrics.baseHeight + 2 * metrics.elevationStepHeight;
  const bridgeSurface = crossingSurfaceModule.crossingSurfaceHeight("bridge") * metrics.cellSize;
  const stairsSurface = crossingSurfaceModule.crossingSurfaceHeight("stairs") * metrics.cellSize;
  const stairsTiltDeg = Math.abs((crossingSurfaceModule.STAIRS_TILT_PITCH_RADIANS * 180) / Math.PI);

  const TOPY_EPS = 1e-3;
  const ANGLE_EPS = 0.5; // degrees

  // Scenario D — flat ground, no crossing, no elevation: fully unaffected.
  closeTo(transformState[tokenD].topY, baseHeight0, TOPY_EPS, "flat/no-crossing token renders at exactly baseHeight");
  closeTo(transformState[tokenD].pitchDeg, 0, ANGLE_EPS, "flat/no-crossing token has no pitch");
  closeTo(transformState[tokenD].yawDeg, 0, ANGLE_EPS, "flat/no-crossing token has no yaw");

  // Scenario C — ordinary elevated terrain, NO crossing structure: exactly
  // today's raw-elevation height, zero regression for MapPlan P5.
  closeTo(
    transformState[tokenC].topY,
    step2,
    TOPY_EPS,
    "ordinary elevated terrain (no crossing structure) renders at EXACTLY raw elevation height — no offset, unregressed"
  );
  closeTo(transformState[tokenC].pitchDeg, 0, ANGLE_EPS, "ordinary elevated terrain: no tilt");

  // Scenario A — bridge: height offset present, NEVER tilts.
  closeTo(
    transformState[tokenA].topY,
    baseHeight0 + bridgeSurface,
    TOPY_EPS,
    `bridge token should render at baseHeight + bridge surface height (expected ${baseHeight0 + bridgeSurface}, got ${transformState[tokenA].topY})`
  );
  check(
    "a token on a bridge renders ABOVE the raw cell floor (on top of the model, not inside it)",
    transformState[tokenA].topY > baseHeight0 + TOPY_EPS
  );
  closeTo(transformState[tokenA].pitchDeg, 0, ANGLE_EPS, "a token on a BRIDGE does not tilt (pitch)");
  closeTo(transformState[tokenA].yawDeg, 0, ANGLE_EPS, "a token on a BRIDGE does not tilt (yaw)");

  // Scenario B — stairs, rotation 0: height offset + tilt, yaw matches 0°.
  closeTo(
    transformState[tokenB].topY,
    step2 + stairsSurface,
    TOPY_EPS,
    `stairs token should render at raw-elevation height + stairs surface height (expected ${step2 + stairsSurface}, got ${transformState[tokenB].topY})`
  );
  check(
    "a token on stairs renders ABOVE the raw cell floor (on top of the model, not inside it)",
    transformState[tokenB].topY > step2 + TOPY_EPS
  );
  closeTo(
    Math.abs(transformState[tokenB].pitchDeg),
    stairsTiltDeg,
    ANGLE_EPS,
    `a token on STAIRS (rotation 0°) tilts by the flight's real incline angle (expected magnitude ${stairsTiltDeg}°, got ${transformState[tokenB].pitchDeg}°)`
  );
  closeTo(transformState[tokenB].yawDeg, 0, ANGLE_EPS, "stairs at rotation 0° yaws the tilt to 0°");

  // Scenario E — stairs, rotation 90: SAME tilt magnitude, yaw tracks the
  // object's own placement rotation (proves it isn't hardcoded).
  closeTo(
    Math.abs(transformState[tokenE].pitchDeg),
    stairsTiltDeg,
    ANGLE_EPS,
    "a token on STAIRS (rotation 90°) tilts by the SAME real incline angle regardless of the object's own rotation"
  );
  closeTo(transformState[tokenE].yawDeg, 90, ANGLE_EPS, "stairs at rotation 90° yaws the tilt to 90° — tracks the object, not hardcoded");

  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "crossing-height-static-layout.png"), fullPage: false });
  console.log(`screenshot: ${join(SCRATCH_DIR, "crossing-height-static-layout.png")}`);

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — a real move (click-select-to-move) from plain ground onto a
  // stairs cell: screenshots the in-flight moment and the settled result.
  // ════════════════════════════════════════════════════════════════════
  const moveMapId = crypto.randomUUID();
  await must(
    admin.from("campaign_maps").insert({
      id: moveMapId,
      campaign_id: campaignId,
      name: "Crossing structure height — move transition",
      grid_width: 3,
      grid_height: 3,
    }),
    "inserting move-transition map"
  );
  await upsertCells([
    { map_id: moveMapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
    { map_id: moveMapId, x: 1, y: 0, elevation: 2, terrain_type: "normal", light_level: "bright" },
  ]);
  await voidExcept(dm.client, moveMapId, 3, 3, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  await must(
    admin.from("map_objects").insert({
      map_id: moveMapId,
      asset_id: stairsAssetId,
      x: 1,
      y: 0,
      elevation: 2,
      rotation: 0,
      crossing_type: "stairs",
    }),
    "inserting move-transition stairs object"
  );
  const moveTokenId = crypto.randomUUID();
  await must(
    admin.from("map_tokens").insert({
      id: moveTokenId,
      map_id: moveMapId,
      character_id: ariaId,
      x: 0,
      y: 0,
      elevation: 0,
      allegiance: "party",
    }),
    "inserting move-transition token"
  );
  await must(
    admin.from("campaigns").update({ live_map: moveMapId }).eq("id", campaignId),
    "updating live_map to move-transition map"
  );
  await dmRoom.reload();
  await dmRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await sleep(800);

  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "crossing-height-before-move.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "crossing-height-before-move.png")}`);

  const selectionState = () => readMirror(dmRoom, "token-selection-state");
  const tokenPoint = await scanClick(
    dmRoom,
    async () => (await selectionState()).selectedTokenId === moveTokenId,
    { label: "select move token" }
  );
  check("the move-transition token can be click-selected", tokenPoint !== null);
  const destPoint = await scanClick(
    dmRoom,
    async () => {
      const row = await tokenRow(moveTokenId);
      return row.x === 1 && row.y === 0;
    },
    { label: "confirm move onto stairs cell", exclude: tokenPoint ? [{ ...tokenPoint, radius: 14 }] : [] }
  );
  check("the token can be moved onto the stairs cell", destPoint !== null);
  // No sleep before this screenshot: TOKEN_SLIDE_SECONDS is 0.32s, so
  // capturing immediately after the confirming click has a real chance of
  // landing mid-tween — a visual "smoothly transitioning, not popped"
  // sample, not a numeric guarantee (the lerp math itself is what
  // tokenSlide.test.ts's shortestAngleLerp/plain-lerp coverage proves).
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "crossing-height-mid-move.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "crossing-height-mid-move.png")}`);

  await sleep(1000); // well past TOKEN_SLIDE_SECONDS — fully settled
  const afterMoveTransform = await pollUntil(async () => {
    const state = await readMirror(dmRoom, "token-transform-state");
    return moveTokenId in state ? state[moveTokenId] : null;
  });
  check("the moved token's settled transform is reported", afterMoveTransform !== null);
  if (afterMoveTransform) {
    // This map is a DIFFERENT size (3×3) than Phase 1's (4×2) — mapFit.ts's
    // computeTableMapMetrics fits cellSize to whichever grid axis is
    // tighter against the table's fixed footprint, so baseHeight/
    // elevationStepHeight/cellSize all genuinely differ here. Re-deriving
    // the expectation from THIS map's own metrics (not reusing Phase 1's
    // `step2`/`stairsSurface`) is what actually matches what the Game Room
    // renders for this specific map.
    const moveMetrics = mapFitModule.computeTableMapMetrics(3, 3);
    const moveStep2 = moveMetrics.baseHeight + 2 * moveMetrics.elevationStepHeight;
    const moveStairsSurface = crossingSurfaceModule.crossingSurfaceHeight("stairs") * moveMetrics.cellSize;
    closeTo(
      afterMoveTransform.topY,
      moveStep2 + moveStairsSurface,
      TOPY_EPS,
      `after a REAL move onto stairs, the token settles at raw-elevation height + stairs surface height (expected ${moveStep2 + moveStairsSurface}, got ${afterMoveTransform.topY})`
    );
    closeTo(
      Math.abs(afterMoveTransform.pitchDeg),
      stairsTiltDeg,
      ANGLE_EPS,
      "after a REAL move onto stairs, the token settles at the flight's real incline angle"
    );
  }

  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "crossing-height-after-move.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "crossing-height-after-move.png")}`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await vite.close();
  await browser.close();
  if (devServer) devServer.kill();
}
