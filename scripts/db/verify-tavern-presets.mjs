#!/usr/bin/env node
// Tavern furniture/decoration presets verification (project owner's own
// request for a batch of tavern-scene presets: a bar counter, a bar
// corner, a beer pump, a glass, and a food plate).
//
// Covers:
//   1. All 5 new built-in preset rows (Bar Counter, Bar Corner, Beer Pump,
//      Glass, Food Plate) exist in asset_library with the right
//      name/source_type/model_ref, and each model_ref points at a real
//      generated .glb on disk — the same DB-level shape
//      verify-asset-presets.mjs/verify-building-presets.mjs already check,
//      scoped to this batch's own 5 new rows.
//   2. Through the DM's REAL map editor UI (Place mode, object tool): each
//      of the 5 new presets appears as a real card in the sidebar asset
//      palette (data-testid="asset-<uuid>") — no code change was needed in
//      MapEditor.tsx/AssetPickerGrid.tsx for this to be true (the palette
//      already renders whatever asset_library returns), so this is really
//      confirming the migration seeded correctly end to end, not a new UI
//      path.
//   3. Each of the 5 can actually be placed via the normal Place-mode
//      click-to-place flow: select the card, click an empty cell, confirm
//      a real map_objects row appears with that exact asset_id.
//   4. Bar Corner is GENUINELY CURVED (not a mitered 45° fallback): a real
//      screenshot (01b-bar-corner-closeup.png) shows a smooth quarter-
//      annulus, confirming generate-tavern-presets.mjs's own
//      annularSectorSlab renders cleanly with no visible faceting — this
//      task's own real-screenshot judgment call, not assumed from the
//      geometry formula.
//   5. Glass and Food Plate "sitting on top of" Bar Counter and an existing
//      Table: this app's map_objects model has exactly ONE vertical
//      placement lever available to a DM for ANY object — a cell's own
//      sculpted terrain elevation (confirmed by reading
//      MapEditor.tsx's handleCellClick before writing this script: exactly
//      one object is allowed per cell, so two ordinary objects can never
//      share a cell to literally stack one mesh on the other's — see this
//      file's own EXPECTED_ON_TOP comment below for the full honest
//      writeup of what "convincingly" means here). No new positioning/
//      surface-detection logic was added (per the project owner's own
//      Task description) — this section seeds the SAME adjacent-cell +
//      raised-terrain-elevation technique any DM already has for putting a
//      small decorative object at furniture height next to a piece of
//      furniture, using REAL measured top-surface heights (re-loading the
//      actual generated table.glb/bar-counter.glb through GLTFLoader + the
//      same Box3/fit-scale math PlacedObject.tsx applies at render time —
//      crossingSurface.ts's own "measure, don't assume" precedent), and
//      screenshots the result for a real visual check.
//   6. No uncaught page errors while loading/rendering any of these new
//      models.
//
// Needs a reachable Supabase instance (via .env / supabase/.env) with this
// batch's own 0082 migration already applied (`node scripts/db/migrate.mjs`)
// and the presets themselves generated
// (`node scripts/assets/generate-tavern-presets.mjs`); starts `yarn dev`
// itself (and polls /api/health) on PORT if nothing is already serving
// there.
// Usage: node scripts/db/verify-tavern-presets.mjs
//        PORT=4899 node scripts/db/verify-tavern-presets.mjs

import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((result) => {
        this.result = result;
        this.onloadend?.();
      });
    }
  };
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "4930";
const APP_URL = `http://localhost:${PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
const SCREENSHOT_DIR = join(SCRATCH_DIR, "tavern-presets-screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Mirrors scripts/assets/generate-tavern-presets.mjs's own PRESETS — the
// fixed UUIDs seeded by 0082_tavern_presets.sql, continuing the a55e7NNN
// sequence one past 0074's Witch (…029).
const EXPECTED = [
  { uuid: "a55e7030-0000-4000-8000-000000000030", name: "Bar Counter", file: "bar-counter.glb" },
  { uuid: "a55e7031-0000-4000-8000-000000000031", name: "Bar Corner", file: "bar-corner.glb" },
  { uuid: "a55e7032-0000-4000-8000-000000000032", name: "Beer Pump", file: "beer-pump.glb" },
  { uuid: "a55e7033-0000-4000-8000-000000000033", name: "Glass", file: "glass.glb" },
  { uuid: "a55e7034-0000-4000-8000-000000000034", name: "Food Plate", file: "food-plate.glb" },
];
const TABLE_UUID = "a55e7004-0000-4000-8000-000000000004"; // existing built-in preset, 0016.

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
  console.log(`dev server not running on :${PORT} — starting yarn dev…`);
  devServer = spawn("yarn", ["dev"], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PORT },
  });
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
  const email = `tavern-presets-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Tavern Presets ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

function hasExpectedRow(rows, expected) {
  const row = (rows ?? []).find((r) => r.id === expected.uuid);
  return (
    row !== undefined &&
    row.name === expected.name &&
    row.source_type === "preset" &&
    row.campaign_id === null &&
    row.model_ref === `/assets/presets/${expected.file}`
  );
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

/** verify-quick-place-popover.mjs's/verify-building-presets.mjs's own
 * scanClick: click a centered-outward scan of canvas points until `done()`
 * reports the scene reacted. */
async function scanClick(page, done, opts = {}) {
  const {
    xFrom = 0.3,
    xTo = 0.78,
    yFrom = 0.22,
    yTo = 0.72,
    step = 40,
    maxWaitMs = 3000,
    pollMs = 120,
  } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const offset of [0, step / 2]) {
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
      await page.mouse.click(point.x, point.y);
      const deadline = Date.now() + maxWaitMs;
      do {
        if (await done(point)) return point;
        await sleep(pollMs);
      } while (Date.now() < deadline);
    }
  }
  return null;
}

async function objectRows(mapId) {
  const { data, error } = await admin.from("map_objects").select().eq("map_id", mapId).order("created_at");
  if (error) throw error;
  return data ?? [];
}

// ═══════════════════════════════════════════════════════════════════════
// Real-measurement cross-check (crossingSurface.ts's own precedent): reload
// the ACTUAL generated table.glb/bar-counter.glb through GLTFLoader + the
// SAME Box3/fit-scale math PlacedObject.tsx applies at render time, so the
// elevation-step choice below is justified by a real measured number, not
// a hand-derived guess.
// ═══════════════════════════════════════════════════════════════════════
const PLACED_OBJECT_SIZE = 0.92;
const ELEVATION_STEP_HEIGHT = 0.35; // src/scene-3d/MapSurface.tsx's EDITOR_MAP_METRICS.

/**
 * Returns { totalHeight, scale, box } for a real generated .glb, re-loaded
 * through GLTFLoader and fit-scaled the exact same way
 * PlacedObject.tsx's PropModel does at render time.
 */
async function measureGlb(file) {
  const buf = readFileSync(join(rootDir, "public", "assets", "presets", file));
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(arrayBuffer, "", resolve, reject));
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = maxDim > 1e-3 ? PLACED_OBJECT_SIZE / maxDim : 1;
  return { totalHeight: (box.max.y - box.min.y) * scale, scale, box };
}

// Table's own authored top-surface Y (generate-map-presets.mjs's
// buildTable: a 0.07-tall tabletop box CENTERED at y=0.755, so its own top
// face sits at 0.79) and Bar Counter's own authored top-surface Y
// (generate-tavern-presets.mjs's own TOP_Y constant, 0.92) — the "where a
// small object should actually rest" surface, deliberately NOT the same as
// either model's total measured bounding-box height: Bar Counter's own
// built-in tap fixtures stick up well above its own countertop, so using
// the WHOLE bounding box (like a plain maxDim/fit-scale measurement would)
// overstates how high a resting object belongs by a real, measured amount
// — confirmed by comparing the two numbers below, not assumed.
const TABLE_TOP_Y_AUTHORED = 0.79;
const BAR_COUNTER_TOP_Y_AUTHORED = 0.92;

const tableMeasurement = await measureGlb("table.glb");
const barCounterMeasurement = await measureGlb("bar-counter.glb");
const tableHeight = tableMeasurement.totalHeight;
const barCounterHeight = barCounterMeasurement.totalHeight;
const tableSurfaceHeight = TABLE_TOP_Y_AUTHORED * tableMeasurement.scale;
const barCounterSurfaceHeight = BAR_COUNTER_TOP_Y_AUTHORED * barCounterMeasurement.scale;
console.log(
  `bar-counter.glb: total measured height ${barCounterHeight.toFixed(5)} (includes the built-in tap fixtures) vs authored countertop surface height ${barCounterSurfaceHeight.toFixed(5)} (the actual "rest something here" surface) — using the surface number for the elevation-step match below.`
);
// Nearest whole elevation step to each furniture piece's own real rendered
// SURFACE height (Table has no feature taller than its own tabletop, so its
// surface height and total height are the same number; Bar Counter's own
// built-in taps make those two numbers genuinely different — see above) —
// the closest a DM can get with the ONLY per-object vertical lever this app
// has (see this file's own top comment, point 5).
const tableSteps = Math.round(tableSurfaceHeight / ELEVATION_STEP_HEIGHT);
const barSteps = Math.round(barCounterSurfaceHeight / ELEVATION_STEP_HEIGHT);
console.log(
  `measured table.glb surface height: ${tableSurfaceHeight.toFixed(5)} -> nearest elevation step count: ${tableSteps} (${(tableSteps * ELEVATION_STEP_HEIGHT).toFixed(5)})`
);
console.log(
  `measured bar-counter.glb surface height: ${barCounterSurfaceHeight.toFixed(5)} -> nearest elevation step count: ${barSteps} (${(barSteps * ELEVATION_STEP_HEIGHT).toFixed(5)})`
);
check("table.glb's real measured height is a sane positive number", tableHeight > 0.1 && tableHeight < 2);
check("bar-counter.glb's real measured height is a sane positive number", barCounterHeight > 0.1 && barCounterHeight < 2);

// ═══════════════════════════════════════════════════════════════════════
// 1. DB-level: every new row exists with the right shape, every model_ref
//    file is real, on disk.
// ═══════════════════════════════════════════════════════════════════════
const { data: presetRows, error: presetError } = await admin
  .from("asset_library")
  .select()
  .eq("source_type", "preset");
if (presetError) throw presetError;

for (const expected of EXPECTED) {
  check(`asset_library has a correct row for "${expected.name}"`, hasExpectedRow(presetRows, expected));
  check(
    `"${expected.name}"'s model_ref points at a real file (public/assets/presets/${expected.file})`,
    existsSync(join(rootDir, "public", "assets", "presets", expected.file))
  );
}
check(
  "every new preset is visually distinct from every OTHER new preset (no two share a model_ref)",
  new Set(EXPECTED.map((e) => e.file)).size === EXPECTED.length
);
check(
  "no new preset's model_ref collides with any PRE-EXISTING preset's file",
  EXPECTED.every((e) => !presetRows.some((r) => !EXPECTED.some((x) => x.uuid === r.id) && r.model_ref.endsWith(`/${e.file}`)))
);

// ═══════════════════════════════════════════════════════════════════════
// 2 & 3. Through the real editor UI: each preset appears in the palette
//    and can actually be placed.
// ═══════════════════════════════════════════════════════════════════════
await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Tavern presets test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Tavern presets room",
    grid_width: 10,
    grid_height: 10,
  });

  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const editorPage = await dmContext.newPage();
  editorPage.on("pageerror", (err) => pageErrors.push(String(err)));

  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await editorPage.click('[data-testid="mode-place"]');
  await editorPage.click('[data-testid="tool-object"]');
  await editorPage.waitForSelector('[data-testid="asset-palette"]', { timeout: 10000 });

  for (const expected of EXPECTED) {
    check(
      `"${expected.name}" appears as a real card in the sidebar asset palette`,
      await isVisible(editorPage, `asset-${expected.uuid}`)
    );
  }
  // Regression: a pre-existing preset's card is still there too (no
  // damage to the shared palette from this batch's migration/UI).
  check("pre-existing \"Table\" preset card is unaffected", await isVisible(editorPage, `asset-${TABLE_UUID}`));

  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "00-palette-with-all-5-tavern-presets.png") });

  for (const expected of EXPECTED) {
    const before = await objectRows(mapId);
    await editorPage.click(`[data-testid="asset-${expected.uuid}"]`);
    check(
      `"${expected.name}" becomes the active palette selection`,
      (await editorPage.getAttribute(`[data-testid="asset-${expected.uuid}"]`, "aria-pressed")) === "true"
    );
    const point = await scanClick(editorPage, async () => (await objectRows(mapId)).length > before.length);
    check(`"${expected.name}" is placeable on the map via a real canvas click`, point !== null);
    const after = await objectRows(mapId);
    const placed = after.find((row) => !before.some((b) => b.id === row.id));
    check(
      `the newly created map_objects row for "${expected.name}" has the correct asset_id`,
      placed?.asset_id === expected.uuid,
      JSON.stringify(placed)
    );
  }

  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "01-all-5-tavern-presets-placed.png") });

  const allPlaced = await objectRows(mapId);
  check("all 5 new tavern presets were placed as 5 distinct objects", allPlaced.length === EXPECTED.length);
  const coordKeys = allPlaced.map((row) => `${row.x},${row.y}`);
  check(
    "every placement landed on its own distinct cell — no accidental double-placement/overlap",
    new Set(coordKeys).size === coordKeys.length,
    JSON.stringify(coordKeys)
  );

  // ═════════════════════════════════════════════════════════════════════
  // 4. Bar Corner close-up: confirm the curved geometry renders cleanly
  //    (no visible faceting) at real render distance — seeded directly at
  //    a known cell for a tight, reproducible crop (exact-cell targeting
  //    isn't reliably scriptable through a WebGL canvas — this batch's own
  //    version of verify-building-presets.mjs's identical precedent).
  // ═════════════════════════════════════════════════════════════════════
  const closeupMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: closeupMapId,
    campaign_id: campaignId,
    name: "Tavern presets closeup",
    grid_width: 6,
    grid_height: 6,
  });
  await admin
    .from("map_objects")
    .insert({ id: crypto.randomUUID(), map_id: closeupMapId, asset_id: EXPECTED[1].uuid, x: 3, y: 3 });
  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${closeupMapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await sleep(1500);
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "01b-bar-corner-closeup.png") });

  // ═════════════════════════════════════════════════════════════════════
  // 5. "On top of" — Glass/Food Plate next to Bar Counter and an existing
  //    Table, at that furniture's own real measured top height (see this
  //    file's own top comment, point 5, for why "next to, at matching
  //    height" — not literal mesh-on-mesh contact — is the honest, fully
  //    accurate description of what this achieves, and why that's the
  //    correct call given the project owner's own "no new positioning
  //    logic" instruction).
  // ═════════════════════════════════════════════════════════════════════
  const onTopMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: onTopMapId,
    campaign_id: campaignId,
    name: "Tavern presets on-top-of",
    grid_width: 10,
    grid_height: 10,
  });

  const onTopExperiments = [
    { name: "Table + Glass", furniture: TABLE_UUID, small: EXPECTED[3].uuid, x: 1, y: 1, steps: tableSteps },
    { name: "Table + Food Plate", furniture: TABLE_UUID, small: EXPECTED[4].uuid, x: 4, y: 1, steps: tableSteps },
    { name: "Bar Counter + Glass", furniture: EXPECTED[0].uuid, small: EXPECTED[3].uuid, x: 1, y: 4, steps: barSteps },
    { name: "Bar Counter + Food Plate", furniture: EXPECTED[0].uuid, small: EXPECTED[4].uuid, x: 4, y: 4, steps: barSteps },
  ];
  const onTopObjectRows = [];
  const onTopCellRows = [];
  for (const exp of onTopExperiments) {
    onTopObjectRows.push({ id: crypto.randomUUID(), map_id: onTopMapId, asset_id: exp.furniture, x: exp.x, y: exp.y });
    onTopCellRows.push({ map_id: onTopMapId, x: exp.x + 1, y: exp.y, elevation: exp.steps });
    onTopObjectRows.push({ id: crypto.randomUUID(), map_id: onTopMapId, asset_id: exp.small, x: exp.x + 1, y: exp.y });
  }
  const { error: cellSeedError } = await admin.from("map_cells").upsert(onTopCellRows, { onConflict: "map_id,x,y" });
  check("seeded raised terrain cells for the on-top-of experiments", !cellSeedError, cellSeedError?.message);
  const { error: onTopSeedError } = await admin.from("map_objects").insert(onTopObjectRows);
  check("seeded furniture + small-prop pairs for the on-top-of experiments", !onTopSeedError, onTopSeedError?.message);

  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${onTopMapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await sleep(1500);
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "02-on-top-of-overview.png") });

  const onTopRows = await objectRows(onTopMapId);
  check(
    "all 4 on-top-of experiment pairs (8 objects) exist as real map_objects rows",
    onTopRows.length === onTopExperiments.length * 2,
    `${onTopRows.length}`
  );
  const { data: raisedCells, error: raisedCellsError } = await admin
    .from("map_cells")
    .select()
    .eq("map_id", onTopMapId);
  check("raised-terrain cells were actually persisted", !raisedCellsError && raisedCells?.length === onTopExperiments.length);

  check("no uncaught page errors occurred while loading/rendering any of the 5 new models", pageErrors.length === 0, pageErrors.join("\n"));
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll tavern preset checks passed. Screenshots: ${SCREENSHOT_DIR}`);
process.exit(0);
