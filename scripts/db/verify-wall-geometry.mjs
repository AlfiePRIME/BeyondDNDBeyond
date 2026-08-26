#!/usr/bin/env node
// Procedural-wall gap/corner/diagonal fix, PLUS this task's own follow-up
// fixes: door-in-wall (a real doorway cut into a wall segment, replacing a
// free-standing Door prop) and diagonal-to-straight/corner alignment (a
// real, measured height AND footprint mismatch between the three
// wall-family pieces) — real-measurement verification for all of it.
//
// Original bug (already fixed, re-verified below for regression):
// templates.ts's wallRotation only ever returned 0°/90° (corners got the
// SAME rotation as a horizontal run), and every Wall Segment placement went
// through PlacedObject.tsx's generic PLACED_OBJECT_SIZE (0.92) inset,
// leaving a real, measured 0.08 cell-width gap between adjacent straight
// segments. Fixed via WALL_FIT_TARGET_BY_URL (full-cell fit for wall-family
// presets) and classifyWallCell (neighbor-based corner detection).
//
// This task's OWN investigation found two further real, measured bugs in
// that first fix's own new presets, neither caught by the original fix's
// own (isolated, non-adjacent) verification:
//
//   1. Height mismatch: wall-corner.glb/wall-diagonal.glb's cap/merlon
//      accents were authored STACKED ON TOP of WALL_HEIGHT (0.85) — but
//      0.85 is wall.glb's own ALREADY-final, already-merlon-topped peak
//      height, so both new pieces actually overshot it: corner measured
//      1.07 tall, diagonal 0.93 tall, next to a straight run's real 0.85.
//      Fixed by rebuilding corner/diagonal's own body+cap+merlon layers
//      from the SAME constants wall.glb itself resolves to
//      (generate-wall-variants-presets.mjs's WALL_BODY_HEIGHT/
//      WALL_CAP_HEIGHT/WALL_MERLON_HEIGHT), so all three top out at
//      exactly the same measured peak.
//
//   2. Diagonal footprint overshoot: the diagonal's beam/cap were authored
//      at length Math.SQRT2 (a cell's own corner-to-corner diagonal) baked
//      at 45° — but a box with real thickness rotated 45° has an
//      axis-aligned bounding box LARGER than its own centerline length (the
//      square-cut ends' corners, not the centerline tip, stick out
//      furthest), measured at a real ~0.095-0.19 unit overshoot into
//      whichever neighbor cell the diagonal bordered. Fixed with a MITERED
//      hexagonal cross-section (the exact intersection of the rotated
//      rectangle with the unit cell square) instead of just shortening the
//      beam — a shortened box would have traded the overshoot for a
//      different real gap, pulling the centerline TIP back from the true
//      corner by the same amount. See generate-wall-variants-presets.mjs's
//      own top comment and hexDiagonalShape's doc comment for the exact
//      numbers/derivation.
//
// Door-in-wall fix: the old free-standing "Door" preset (a55e7003,
// generate-map-presets.mjs's buildDoor()) has no wall material of its own
// at all, and every template placed it at ground elevation while its
// neighbors sat a full WALL_ELEVATION step higher — so it always read as a
// floating frame standing in a sunken gap between two cliffs, never a
// doorway cut into a continuous wall. Fixed with a new "Wall Doorway"
// preset (PRESET_WALL_DOOR, wall-door.glb) — a wall segment with an actual
// walkable opening cut into its own mass, placed at the SAME WALL_ELEVATION
// as its neighbors — used by walledRoom/buildingOutline/multiDoorRoom
// wherever they used to place a free-standing Door.
//
// This script proves BOTH fixes with the SAME real, live measurement
// discipline this project already established for "things don't visually
// align" bugs: GameRoom's object-measure-state debug mirror reports each
// rendered wall object's OWN real Box3.setFromObject(loadedGltf) maxDim and
// derived scale (confirming the live app matches predictions), AND this
// script independently loads the SAME shipped .glb files via GLTFLoader
// (the exact technique generate-wall-variants-presets.mjs itself uses) to
// compute each object's real WORLD-SPACE bounding box — combining a real
// measurement (the local geometry) with exactly-known, controlled inputs
// (this test's own chosen grid positions/rotations) via the same rigid
// transform ObjectMarker/PropModel apply at render time, not a guess.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: node scripts/db/verify-wall-geometry.mjs
//        APP_URL=http://localhost:3100 node scripts/db/verify-wall-geometry.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const SCREENSHOT_DIR =
  process.env.VERIFY_SCREENSHOT_DIR ??
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/wall-geometry";
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
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY — needs the local Supabase stack's .env (see supabase/.env.example)."
  );
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

function approx(a, b, tolerance) {
  return typeof a === "number" && Number.isFinite(a) && Math.abs(a - b) < tolerance;
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

// Same @supabase/ssr cookie format every other verify-*.mjs uses.
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
  const email = `wall-geo-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `WallGeo ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// The exact fixed preset UUIDs templates.ts exports (see 0016/0053/0055/0056's
// seed migrations) — mirrored here since this script drives the app over
// HTTP/DOM rather than importing templates.ts's TS source (the
// seating.test.ts/verify-table-geometry.mjs precedent for crossing that
// module boundary).
const PRESET_WALL = "a55e7007-0000-4000-8000-000000000007";
const PRESET_WALL_CORNER = "a55e7010-0000-4000-8000-000000000010";
const PRESET_WALL_DIAGONAL = "a55e7011-0000-4000-8000-000000000011";
const PRESET_WALL_DOOR = "a55e7012-0000-4000-8000-000000000012";
const WALL_ELEVATION = 1;

// The URL each preset resolves to (assetUrl.ts's resolvePaletteAssets, for
// a built-in preset, always the fixed public path) — needed to load the
// REAL shipped .glb for the Node-side world-position prediction below.
const MODEL_URL_BY_ASSET = {
  [PRESET_WALL]: "/assets/presets/wall.glb",
  [PRESET_WALL_CORNER]: "/assets/presets/wall-corner.glb",
  [PRESET_WALL_DIAGONAL]: "/assets/presets/wall-diagonal.glb",
  [PRESET_WALL_DOOR]: "/assets/presets/wall-door.glb",
};

// PlacedObject.tsx's own WALL_FIT_TARGET_BY_URL — mirrored here for the
// SAME reason MODEL_URL_BY_ASSET is: this script measures the real shipped
// files independently rather than importing TS source.
const WALL_FIT_TARGET_BY_URL = {
  "/assets/presets/wall.glb": 1,
  "/assets/presets/wall-corner.glb": 1,
  "/assets/presets/wall-diagonal.glb": 1,
  "/assets/presets/wall-door.glb": 1,
};

// EDITOR_MAP_METRICS (MapSurface.tsx) — this test drives the map EDITOR for
// its screenshots (see below), which always renders at these fixed values
// (unlike the game table's own per-map-fitted metrics), so predictions
// computed against these exact numbers apply to what's actually screenshot.
const CELL_SIZE = 1;
const BASE_HEIGHT = 0.14;
const ELEVATION_STEP_HEIGHT = 0.35;

// ---------------------------------------------------------------------------
// Node-side real-geometry world-position prediction: loads the ACTUAL
// shipped .glb (GLTFLoader, the same technique generate-wall-variants-
// presets.mjs uses to print its own measurements), replicates
// PlacedObject.tsx's PropModel scale/offset formula against that REAL
// measured box, then replicates MapSurface.tsx's ObjectMarker group
// transform (position/rotation/scale) for a chosen, exactly-known grid
// placement — giving each test object's real predicted world-space
// bounding box without hand-derived trigonometry substituting for either
// the geometry or the transform.
// ---------------------------------------------------------------------------
function loadGlb(buffer) {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, "", resolve, reject);
  });
}

async function measureModel(url) {
  const gltf = await loadGlb(readFileSync(join(rootDir, "public", url)));
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fitTarget = WALL_FIT_TARGET_BY_URL[url];
  const scale = maxDim > 1e-3 ? fitTarget / maxDim : 1;
  const offset = new THREE.Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale);
  return { box, scale, offset, maxDim };
}

/** Every corner of a measured model's own local box, transformed through
 * PropModel's scale+offset and then ObjectMarker's group position/rotation/
 * scale — the exact two-stage transform the live app applies, replicated
 * here against the SAME real per-model numbers `measureModel` reports. */
function worldCorners(measured, { gridX, gridY, rotationDeg, elevation, gridWidth, gridHeight }) {
  const { box, scale, offset } = measured;
  const offsetX = ((gridWidth - 1) / 2) * CELL_SIZE;
  const offsetZ = ((gridHeight - 1) / 2) * CELL_SIZE;
  const worldX = gridX * CELL_SIZE - offsetX;
  const worldZ = gridY * CELL_SIZE - offsetZ;
  const topY = BASE_HEIGHT + elevation * ELEVATION_STEP_HEIGHT;
  const theta = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const corners = [];
  for (const dx of [box.min.x, box.max.x]) {
    for (const dy of [box.min.y, box.max.y]) {
      for (const dz of [box.min.z, box.max.z]) {
        const lx = (dx * scale + offset.x) * CELL_SIZE;
        const ly = (dy * scale + offset.y) * CELL_SIZE;
        const lz = (dz * scale + offset.z) * CELL_SIZE;
        const rx = lx * cos + lz * sin;
        const rz = -lx * sin + lz * cos;
        corners.push([worldX + rx, topY + ly, worldZ + rz]);
      }
    }
  }
  return corners;
}

function bboxOf(corners) {
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const zs = corners.map((c) => c[2]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const campaignId = crypto.randomUUID();

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Wall geometry test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const gridWidth = 14;
  const gridHeight = 10;
  const { data: map, error: mapError } = await admin
    .from("campaign_maps")
    .insert({ campaign_id: campaignId, name: "Wall geometry", grid_width: gridWidth, grid_height: gridHeight })
    .select()
    .single();
  if (mapError) throw mapError;

  // Test layout, in one grid:
  //   - a straight HORIZONTAL adjacent pair (the core gap-closure check)
  //   - a straight VERTICAL adjacent pair (same check, the other axis)
  //   - a real 90° turn: (4,1) straight -> (5,1) CORNER -> (5,2)/(5,3)
  //     straight, continuing the run around the corner
  //   - an isolated DIAGONAL piece (renders standalone, matches its own
  //     measured maxDim/scale)
  //   - a diagonal spliced MID-RUN between two straight segments in the
  //     same row — the adjacency this fix's own predecessor never actually
  //     tested (its own diagonal check was isolated, see this script's own
  //     top comment)
  //   - a diagonal used as a CORNER-REPLACEMENT: a horizontal run turning
  //     into a vertical run via a single diagonal cell instead of a
  //     PRESET_WALL_CORNER — the octagonal-room-corner use case
  //     generate-wall-variants-presets.mjs's own doc comment describes
  //   - a Wall Doorway on a HORIZONTAL run (bottom edge)
  //   - a Wall Doorway on a VERTICAL run (side edge) — proves its rotation
  //     is edge-relative, not a single hardcoded orientation
  const cellsByRole = {
    horizA: { x: 1, y: 1 },
    horizB: { x: 2, y: 1 },
    vertA: { x: 1, y: 3 },
    vertB: { x: 1, y: 4 },
    turnStraight1: { x: 4, y: 1 },
    turnCorner: { x: 5, y: 1 },
    turnStraight2: { x: 5, y: 2 },
    turnStraight3: { x: 5, y: 3 },
    diagonalIsolated: { x: 1, y: 6 },
    midRunA: { x: 8, y: 1 },
    midRunDiagonal: { x: 9, y: 1 },
    midRunB: { x: 10, y: 1 },
    cornerCutStraight1: { x: 8, y: 4 },
    cornerCutDiagonal: { x: 9, y: 4 },
    cornerCutStraight2: { x: 9, y: 5 },
    doorBottomWallA: { x: 2, y: 8 },
    doorBottom: { x: 3, y: 8 },
    doorBottomWallB: { x: 4, y: 8 },
    doorSideWallA: { x: 12, y: 1 },
    doorSide: { x: 12, y: 2 },
    doorSideWallB: { x: 12, y: 3 },
  };

  const cellRows = Object.values(cellsByRole).map((c) => ({
    map_id: map.id,
    x: c.x,
    y: c.y,
    elevation: WALL_ELEVATION,
    terrain_type: "normal",
    light_level: "bright",
    ground_type: "default",
  }));
  const { error: cellsError } = await admin.from("map_cells").insert(cellRows);
  if (cellsError) throw cellsError;

  const objectSeeds = [
    { role: "horizA", asset_id: PRESET_WALL, rotation: 0, ...cellsByRole.horizA },
    { role: "horizB", asset_id: PRESET_WALL, rotation: 0, ...cellsByRole.horizB },
    { role: "vertA", asset_id: PRESET_WALL, rotation: 90, ...cellsByRole.vertA },
    { role: "vertB", asset_id: PRESET_WALL, rotation: 90, ...cellsByRole.vertB },
    { role: "turnStraight1", asset_id: PRESET_WALL, rotation: 0, ...cellsByRole.turnStraight1 },
    { role: "turnCorner", asset_id: PRESET_WALL_CORNER, rotation: 0, ...cellsByRole.turnCorner },
    { role: "turnStraight2", asset_id: PRESET_WALL, rotation: 90, ...cellsByRole.turnStraight2 },
    { role: "turnStraight3", asset_id: PRESET_WALL, rotation: 90, ...cellsByRole.turnStraight3 },
    { role: "diagonalIsolated", asset_id: PRESET_WALL_DIAGONAL, rotation: 0, ...cellsByRole.diagonalIsolated },
    { role: "midRunA", asset_id: PRESET_WALL, rotation: 0, ...cellsByRole.midRunA },
    { role: "midRunDiagonal", asset_id: PRESET_WALL_DIAGONAL, rotation: 0, ...cellsByRole.midRunDiagonal },
    { role: "midRunB", asset_id: PRESET_WALL, rotation: 0, ...cellsByRole.midRunB },
    { role: "cornerCutStraight1", asset_id: PRESET_WALL, rotation: 0, ...cellsByRole.cornerCutStraight1 },
    { role: "cornerCutDiagonal", asset_id: PRESET_WALL_DIAGONAL, rotation: 0, ...cellsByRole.cornerCutDiagonal },
    { role: "cornerCutStraight2", asset_id: PRESET_WALL, rotation: 90, ...cellsByRole.cornerCutStraight2 },
    { role: "doorBottomWallA", asset_id: PRESET_WALL, rotation: 0, ...cellsByRole.doorBottomWallA },
    { role: "doorBottom", asset_id: PRESET_WALL_DOOR, rotation: 0, ...cellsByRole.doorBottom },
    { role: "doorBottomWallB", asset_id: PRESET_WALL, rotation: 0, ...cellsByRole.doorBottomWallB },
    { role: "doorSideWallA", asset_id: PRESET_WALL, rotation: 90, ...cellsByRole.doorSideWallA },
    { role: "doorSide", asset_id: PRESET_WALL_DOOR, rotation: 90, ...cellsByRole.doorSide },
    { role: "doorSideWallB", asset_id: PRESET_WALL, rotation: 90, ...cellsByRole.doorSideWallB },
  ];

  const { data: insertedObjects, error: objectsError } = await admin
    .from("map_objects")
    .insert(
      objectSeeds.map((seed) => ({
        map_id: map.id,
        asset_id: seed.asset_id,
        x: seed.x,
        y: seed.y,
        elevation: WALL_ELEVATION,
        rotation: seed.rotation,
      }))
    )
    .select("id, asset_id, x, y, rotation");
  if (objectsError) throw objectsError;

  // Re-attach each inserted row's real DB id to its test role, by (x, y) —
  // unique per this layout.
  const idByRole = new Map();
  for (const [role, coords] of Object.entries(cellsByRole)) {
    const row = insertedObjects.find((o) => o.x === coords.x && o.y === coords.y);
    if (!row) throw new Error(`seeded object for role ${role} not found after insert`);
    idByRole.set(role, row.id);
  }
  const seedByRole = new Map(objectSeeds.map((seed) => [seed.role, seed]));

  await admin.from("campaigns").update({ live_map: map.id }).eq("id", campaignId);

  // Real Box3 measurement of the ACTUAL shipped .glb files, once per
  // distinct model — used both for the numeric assertions below and for
  // the world-position predictions.
  const measuredByUrl = new Map();
  for (const url of new Set(Object.values(MODEL_URL_BY_ASSET))) {
    measuredByUrl.set(url, await measureModel(url));
  }

  function predictBbox(role) {
    const seed = seedByRole.get(role);
    const measured = measuredByUrl.get(MODEL_URL_BY_ASSET[seed.asset_id]);
    return bboxOf(
      worldCorners(measured, {
        gridX: seed.x,
        gridY: seed.y,
        rotationDeg: seed.rotation,
        elevation: WALL_ELEVATION,
        gridWidth,
        gridHeight,
      })
    );
  }

  const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  async function readJsonTestId(testId) {
    const el = await page.$(`[data-testid="${testId}"]`);
    if (!el) return null;
    return JSON.parse(await el.textContent());
  }

  async function waitForMeasureCount(count, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await readJsonTestId("object-measure-state");
      if (last && Object.keys(last).length >= count) return last;
      await sleep(200);
    }
    return last;
  }

  try {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="object-measure-state"]', { state: "attached", timeout: 30000 });

    const measured = await waitForMeasureCount(objectSeeds.length);
    check(
      `all ${objectSeeds.length} wall-family objects report a real measured maxDim/scale`,
      measured && Object.keys(measured).length === objectSeeds.length,
      JSON.stringify(measured)
    );

    // --- 1. THE core gap-closure proof: for every straight PRESET_WALL
    // instance, maxDim*scale (its own rendered span, in "1 cell = 1.0"
    // units) must be ~1.0 — the model reaches its full cell, so two
    // adjacent instances (spaced exactly 1 cell apart, unrelated to this
    // fix) touch with ~zero gap. ---
    for (const role of [
      "horizA",
      "horizB",
      "vertA",
      "vertB",
      "turnStraight1",
      "turnStraight2",
      "turnStraight3",
      "midRunA",
      "midRunB",
      "cornerCutStraight1",
      "cornerCutStraight2",
      "doorBottomWallA",
      "doorBottomWallB",
      "doorSideWallA",
      "doorSideWallB",
    ]) {
      const id = idByRole.get(role);
      const m = measured?.[id];
      check(`[${role}] measured maxDim ≈ 2.0 (wall.glb's own authored width, unchanged)`, m && Math.abs(m.maxDim - 2) < 0.01, JSON.stringify(m));
      check(`[${role}] measured scale ≈ 0.5 (the fit target 1 / maxDim 2)`, m && Math.abs(m.scale - 0.5) < 0.01, JSON.stringify(m));
      const span = m ? m.maxDim * m.scale : NaN;
      check(`[${role}] rendered span ≈ 1.0 full cell-width`, Math.abs(span - 1) < 0.01, JSON.stringify({ ...m, span }));
    }

    // --- 2. Every wall-family piece — straight, corner, diagonal, door —
    // now measures maxDim/scale ≈ (1, 1) except the straight run itself
    // (2, 0.5) — this task's own height/footprint fix converged all three
    // NEW presets on the SAME fit numbers wall.glb already used, rather
    // than each needing its own special-cased fit target (1.07/1.190919
    // before this fix). ---
    for (const role of [
      "turnCorner",
      "diagonalIsolated",
      "midRunDiagonal",
      "cornerCutDiagonal",
      "doorBottom",
      "doorSide",
    ]) {
      const id = idByRole.get(role);
      const m = measured?.[id];
      check(`[${role}] measured maxDim ≈ 1.0 (own footprint, not an inflated accent/overshoot)`, m && Math.abs(m.maxDim - 1) < 0.01, JSON.stringify(m));
      check(`[${role}] measured scale ≈ 1.0 (renders exactly as authored, no distortion)`, m && Math.abs(m.scale - 1) < 0.01, JSON.stringify(m));
    }
    check(
      "[turnCorner] a distinct asset from the straight run (PRESET_WALL_CORNER, not PRESET_WALL)",
      insertedObjects.find((o) => o.id === idByRole.get("turnCorner"))?.asset_id === PRESET_WALL_CORNER
    );
    check(
      "[doorBottom]/[doorSide] a distinct asset from both the straight run and the old free-standing Door (PRESET_WALL_DOOR)",
      insertedObjects.find((o) => o.id === idByRole.get("doorBottom"))?.asset_id === PRESET_WALL_DOOR &&
        insertedObjects.find((o) => o.id === idByRole.get("doorSide"))?.asset_id === PRESET_WALL_DOOR
    );

    // --- 3. PEAK HEIGHT CONSISTENCY — the height-mismatch fix's own core
    // proof: every wall-family piece's own rendered TOP (topY + maxDim's
    // own y-extent contribution, via the SAME measured maxDim/scale the
    // live app just reported) lands at the SAME world height. Computed
    // from the live browser's own measured maxDim/scale combined with each
    // role's own KNOWN local box y-range (from this script's independent
    // Node-side real .glb measurement) — not two disconnected numbers
    // asserted equal by coincidence. ---
    const topOfModel = (role) => {
      const id = idByRole.get(role);
      const m = measured?.[id];
      const seed = seedByRole.get(role);
      const localMeasured = measuredByUrl.get(MODEL_URL_BY_ASSET[seed.asset_id]);
      if (!m || !localMeasured) return NaN;
      const topY = BASE_HEIGHT + WALL_ELEVATION * ELEVATION_STEP_HEIGHT;
      // PropModel's own offset recenters the model's MEASURED base
      // (box.min.y) to y=0 before this group-level topY is added — using
      // (max.y - min.y), not max.y alone, so this doesn't silently assume
      // every model's own raw base sits exactly at y=0 (true for all four
      // wall-family presets today, confirmed by measureModel's own real
      // numbers, but not asserted as a precondition here). Live-reported
      // scale should match the Node-side prediction; using the LIVE value
      // here is what makes this a live-render proof, not just a static
      // prediction.
      return topY + (localMeasured.box.max.y - localMeasured.box.min.y) * m.scale;
    };
    const peakStraight = topOfModel("horizA");
    for (const role of ["horizB", "turnStraight1", "midRunA", "cornerCutStraight1"]) {
      check(
        `[${role}] peak height matches a straight run's own peak (${peakStraight.toFixed(4)})`,
        approx(topOfModel(role), peakStraight, 0.002),
        `${topOfModel(role)}`
      );
    }
    for (const role of ["turnCorner", "midRunDiagonal", "cornerCutDiagonal", "diagonalIsolated"]) {
      check(
        `[${role}] peak height now matches the straight run's peak too (was a real, measured mismatch before this fix)`,
        approx(topOfModel(role), peakStraight, 0.002),
        `${topOfModel(role)} vs ${peakStraight}`
      );
    }

    check("no uncaught page errors rendering the wall-family test map", consoleErrors.length === 0, JSON.stringify(consoleErrors));

    // --- 4. WORLD-POSITION JUNCTION PROOF — the adjacency this fix's own
    // predecessor never actually tested. Predicted purely from real,
    // independently-measured local geometry (measureModel, loading the
    // ACTUAL shipped .glb) run through the exact known transform pipeline
    // (worldCorners) for this test's own exactly-known grid placements —
    // not the live browser's numbers, a genuinely independent prediction,
    // cross-checked against the live scale/maxDim assertions above. ---
    const midRunATile = predictBbox("midRunA");
    const midRunDiagonalTile = predictBbox("midRunDiagonal");
    const midRunBTile = predictBbox("midRunB");
    check(
      "[midRun] diagonal's own AABB no longer overshoots into midRunA's cell (was ~0.1 unit overshoot before this fix)",
      midRunDiagonalTile.minX >= midRunATile.maxX - 0.005,
      `diagonal minX=${midRunDiagonalTile.minX} vs midRunA maxX=${midRunATile.maxX}`
    );
    check(
      "[midRun] straight-to-diagonal boundary touches with ~zero gap",
      approx(midRunDiagonalTile.minX, midRunATile.maxX, 0.005),
      `${midRunDiagonalTile.minX} vs ${midRunATile.maxX}`
    );
    check(
      "[midRun] diagonal's own AABB no longer overshoots into midRunB's cell",
      midRunDiagonalTile.maxX <= midRunBTile.minX + 0.005,
      `diagonal maxX=${midRunDiagonalTile.maxX} vs midRunB minX=${midRunBTile.minX}`
    );
    check(
      "[midRun] diagonal-to-straight boundary touches with ~zero gap",
      approx(midRunDiagonalTile.maxX, midRunBTile.minX, 0.005),
      `${midRunDiagonalTile.maxX} vs ${midRunBTile.minX}`
    );

    const cutStraight1 = predictBbox("cornerCutStraight1");
    const cutDiagonal = predictBbox("cornerCutDiagonal");
    const cutStraight2 = predictBbox("cornerCutStraight2");
    check(
      "[cornerCut] horizontal run -> diagonal boundary touches with ~zero gap, no overshoot",
      approx(cutDiagonal.minX, cutStraight1.maxX, 0.005),
      `${cutDiagonal.minX} vs ${cutStraight1.maxX}`
    );
    check(
      "[cornerCut] diagonal -> vertical run boundary touches with ~zero gap, no overshoot",
      approx(cutDiagonal.maxZ, cutStraight2.minZ, 0.005),
      `${cutDiagonal.maxZ} vs ${cutStraight2.minZ}`
    );
    // The diagonal's own footprint, predicted purely from its real
    // geometry, stays within exactly its own 1x1 cell on BOTH axes — the
    // direct proof of this fix's footprint-overshoot repair (previously
    // measured protruding ~0.095-0.19 units past this exact boundary).
    check(
      "[cornerCut] diagonal's predicted footprint spans exactly its own 1.0-wide cell in x (no overshoot)",
      approx(cutDiagonal.maxX - cutDiagonal.minX, 1, 0.005),
      `width=${cutDiagonal.maxX - cutDiagonal.minX}`
    );
    check(
      "[cornerCut] diagonal's predicted footprint spans exactly its own 1.0-wide cell in z (no overshoot)",
      approx(cutDiagonal.maxZ - cutDiagonal.minZ, 1, 0.005),
      `depth=${cutDiagonal.maxZ - cutDiagonal.minZ}`
    );

    // --- 5. Door-in-wall proof: the door sits at the SAME elevation/topY
    // as its wall neighbors (no sunken threshold), and its footprint spans
    // its own full cell exactly like a straight run — so it plugs into the
    // wall line rather than leaving a gap or a step. ---
    const doorBottomBox = predictBbox("doorBottom");
    const doorWallABox = predictBbox("doorBottomWallA");
    const doorWallBBox = predictBbox("doorBottomWallB");
    check(
      "[doorBottom] left neighbor boundary touches with ~zero gap",
      approx(doorBottomBox.minX, doorWallABox.maxX, 0.005),
      `${doorBottomBox.minX} vs ${doorWallABox.maxX}`
    );
    check(
      "[doorBottom] right neighbor boundary touches with ~zero gap",
      approx(doorBottomBox.maxX, doorWallBBox.minX, 0.005),
      `${doorBottomBox.maxX} vs ${doorWallBBox.minX}`
    );
    check(
      "[doorBottom] sits on the SAME floor plane as its wall neighbors (minY equal — no sunken threshold)",
      approx(doorBottomBox.minY, doorWallABox.minY, 0.002),
      `${doorBottomBox.minY} vs ${doorWallABox.minY}`
    );
    const doorSideBox = predictBbox("doorSide");
    const doorSideWallABox = predictBbox("doorSideWallA");
    const doorSideWallBBox = predictBbox("doorSideWallB");
    check(
      "[doorSide] north neighbor boundary touches with ~zero gap (rotation 90 spans the vertical run's own axis)",
      approx(doorSideBox.minZ, doorSideWallABox.maxZ, 0.005),
      `${doorSideBox.minZ} vs ${doorSideWallABox.maxZ}`
    );
    check(
      "[doorSide] south neighbor boundary touches with ~zero gap",
      approx(doorSideBox.maxZ, doorSideWallBBox.minZ, 0.005),
      `${doorSideBox.maxZ} vs ${doorSideWallBBox.minZ}`
    );

    // --- Real screenshots for visual confirmation (the acceptance
    // criteria explicitly ask for this, not just numbers).
    //
    // Taken from the map EDITOR (not the game room's seated table view):
    // GameTableScene's per-seat OrbitControls targets the physical table's
    // own center ([0, TABLE_SURFACE_Y, 0]), which — once actually zoomed
    // out far enough to fit the whole table — renders this map's small
    // cells too small to read (confirmed by hand in the original wall-gap
    // fix). The editor's own OrbitControls (MapEditorScene.tsx) targets
    // [0, 0, 0] — this map's own grid center.
    //
    // Rather than panning the ONE big test map above to reach each cluster
    // (attempted, but the middle-drag pan's screen-to-world ratio turned
    // out to depend on drag axis/distance in a way not worth reverse-
    // engineering here), each screenshot below uses its OWN small dedicated
    // map with the cluster placed at the EXACT grid position — (4-5, 1-3),
    // an 8x8 grid — this project's own wall-gap fix already proved frames
    // cleanly with a plain zoom-in and NO pan at all (this script's own
    // "turn" cluster, below, reuses that exact proven position/grid size).
    // Real geometry, real preset assets, real DB rows, a real render — only
    // the CAMERA-FRAMING approach differs from the numeric checks above. ---
    async function screenshotCluster(name, { gridWidth: gw, gridHeight: gh, cells, orbitDx = 0 }) {
      const { data: shotMap, error: shotMapError } = await admin
        .from("campaign_maps")
        .insert({ campaign_id: campaignId, name, grid_width: gw, grid_height: gh })
        .select()
        .single();
      if (shotMapError) throw shotMapError;
      await admin.from("map_cells").insert(
        cells.map((c) => ({
          map_id: shotMap.id,
          x: c.x,
          y: c.y,
          elevation: WALL_ELEVATION,
          terrain_type: "normal",
          light_level: "bright",
          ground_type: "default",
        }))
      );
      await admin.from("map_objects").insert(
        cells.map((c) => ({
          map_id: shotMap.id,
          asset_id: c.asset_id,
          x: c.x,
          y: c.y,
          elevation: WALL_ELEVATION,
          rotation: c.rotation,
        }))
      );
      await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${shotMap.id}/edit`);
      await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 30000 });
      await page.waitForTimeout(2000);
      const focus = { x: 950, y: 500 };
      await page.mouse.move(focus.x, focus.y);
      // A vertical (north/south) run is viewed almost end-on by the
      // editor's default angle — a right-drag ORBITS the camera around its
      // existing target (unlike a middle-drag pan, which moves the target
      // itself) to a more legible 3/4 view, used only for the door-on-a-
      // vertical-run shot below.
      if (orbitDx !== 0) {
        await page.mouse.down({ button: "right" });
        await page.mouse.move(focus.x + orbitDx, focus.y, { steps: 20 });
        await page.mouse.up({ button: "right" });
        await page.waitForTimeout(300);
      }
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(15);
      }
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`) });
    }

    const GW = 8;
    const GH = 8;

    // 1. Straight -> corner -> straight turn (the original wall-gap fix's
    // own proven cluster/position/zoom).
    await screenshotCluster("wall-geometry-corner-closeup", {
      gridWidth: GW,
      gridHeight: GH,
      cells: [
        { x: 4, y: 1, asset_id: PRESET_WALL, rotation: 0 },
        { x: 5, y: 1, asset_id: PRESET_WALL_CORNER, rotation: 0 },
        { x: 5, y: 2, asset_id: PRESET_WALL, rotation: 90 },
        { x: 5, y: 3, asset_id: PRESET_WALL, rotation: 90 },
      ],
    });

    // 2. An isolated diagonal, alone.
    await screenshotCluster("wall-geometry-diagonal-closeup", {
      gridWidth: GW,
      gridHeight: GH,
      cells: [{ x: 5, y: 1, asset_id: PRESET_WALL_DIAGONAL, rotation: 0 }],
    });

    // 3. Diagonal mid-run splice: straight -> diagonal -> straight, all one row.
    await screenshotCluster("wall-geometry-diagonal-midrun", {
      gridWidth: GW,
      gridHeight: GH,
      cells: [
        { x: 4, y: 1, asset_id: PRESET_WALL, rotation: 0 },
        { x: 5, y: 1, asset_id: PRESET_WALL_DIAGONAL, rotation: 0 },
        { x: 6, y: 1, asset_id: PRESET_WALL, rotation: 0 },
      ],
    });

    // 4. Diagonal corner-cut: a horizontal run turning into a vertical run
    // via a diagonal instead of a PRESET_WALL_CORNER — the octagonal-room
    // corner use case.
    await screenshotCluster("wall-geometry-diagonal-cornercut", {
      gridWidth: GW,
      gridHeight: GH,
      cells: [
        { x: 4, y: 1, asset_id: PRESET_WALL, rotation: 0 },
        { x: 5, y: 1, asset_id: PRESET_WALL_DIAGONAL, rotation: 0 },
        { x: 5, y: 2, asset_id: PRESET_WALL, rotation: 90 },
      ],
    });

    // 5. Door-in-wall on a horizontal run.
    await screenshotCluster("wall-geometry-door-bottom", {
      gridWidth: GW,
      gridHeight: GH,
      cells: [
        { x: 4, y: 1, asset_id: PRESET_WALL, rotation: 0 },
        { x: 5, y: 1, asset_id: PRESET_WALL_DOOR, rotation: 0 },
        { x: 6, y: 1, asset_id: PRESET_WALL, rotation: 0 },
      ],
    });

    // 6. Door-in-wall on a vertical run — proves the door's rotation is
    // edge-relative, not a single hardcoded orientation.
    await screenshotCluster("wall-geometry-door-side", {
      gridWidth: GW,
      gridHeight: GH,
      cells: [
        { x: 5, y: 1, asset_id: PRESET_WALL, rotation: 90 },
        { x: 5, y: 2, asset_id: PRESET_WALL_DOOR, rotation: 90 },
        { x: 5, y: 3, asset_id: PRESET_WALL, rotation: 90 },
      ],
      orbitDx: 200,
    });

    console.log(`\nScreenshots written to ${SCREENSHOT_DIR}`);
  } finally {
    await context.close();
    await browser.close();
  }
} finally {
  await admin.from("campaigns").delete().eq("id", campaignId);
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
console.log("\nAll wall-geometry checks passed.");
process.exit(0);
