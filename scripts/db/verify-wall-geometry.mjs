#!/usr/bin/env node
// Procedural-wall gap/corner/diagonal fix — real-measurement verification.
//
// The bug: templates.ts's wallRotation only ever returned 0°/90° (corners
// got the SAME rotation as a horizontal run — no distinct corner geometry
// at all), and every Wall Segment placement went through PlacedObject.tsx's
// generic PLACED_OBJECT_SIZE (0.92) inset — deliberately correct for a
// movable prop that must never overhang its own cell, but wrong for a
// continuous wall run, which needs ZERO margin between adjacent segments to
// look connected.
//
// Confirmed via real vertex-level measurement (not assumption) BEFORE
// fixing anything: wall.glb's authored main box (generate-map-presets.mjs's
// buildWall()) is 2 world-units wide — the model's own unique maxDim — so
// PropModel's `scale = PLACED_OBJECT_SIZE / maxDim` = 0.92/2 = 0.46, landing
// each segment's rendered length at 0.92 of ONE cell instead of the full
// cell. Two adjacent segments, each centered in its own cell, then leave a
// real, measured 1 - 0.92 = 0.08 cell-width gap between them (0.04 short of
// the shared edge on each side).
//
// The fix (src/scene-3d/PlacedObject.tsx's WALL_FIT_TARGET_BY_URL) gives
// wall-family presets their own fit target instead of the shared inset, and
// templates.ts's new classifyWallCell picks a proper corner piece
// (PRESET_WALL_CORNER) or leaves a diagonal piece (PRESET_WALL_DIAGONAL,
// manually placed via the editor) available. This script proves the fix
// with the SAME real, live measurement discipline this project already
// established for "things don't visually align" bugs (verify-table-
// geometry.mjs): GameRoom's new object-measure-state debug mirror reports
// each rendered wall object's OWN real Box3.setFromObject(loadedGltf)
// maxDim and derived scale — the literal numbers PropModel computes to
// size the model, not a re-derived formula in isolation. Since
// maxDim*scale is, by construction, the object's own rendered span in
// "one cell = 1.0" units, and MapSurface places adjacent grid cells exactly
// 1 cell-size apart regardless of the live table's actual cellSize, proving
// maxDim*scale ≈ 1.0 for a straight wall proves its gap-to-neighbor ≈ 0 —
// no cellSize/world-position math needed, and no assumption that the
// formula was actually wired to the real rendered object (a real gltf, not
// a stub, is loaded through a real browser).
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

// The exact fixed preset UUIDs templates.ts exports (see 0016/0053/0054's
// seed migrations) — mirrored here since this script drives the app over
// HTTP/DOM rather than importing templates.ts's TS source (the
// seating.test.ts/verify-table-geometry.mjs precedent for crossing that
// module boundary).
const PRESET_WALL = "a55e7007-0000-4000-8000-000000000007";
const PRESET_WALL_CORNER = "a55e7010-0000-4000-8000-000000000010";
const PRESET_WALL_DIAGONAL = "a55e7011-0000-4000-8000-000000000011";
const WALL_ELEVATION = 1;

async function readJsonTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  return JSON.parse(await el.textContent());
}

async function waitForMeasureCount(page, count, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readJsonTestId(page, "object-measure-state");
    if (last && Object.keys(last).length >= count) return last;
    await sleep(200);
  }
  return last;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const campaignId = crypto.randomUUID();

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Wall geometry test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const gridWidth = 8;
  const gridHeight = 8;
  const { data: map, error: mapError } = await admin
    .from("campaign_maps")
    .insert({ campaign_id: campaignId, name: "Wall geometry", grid_width: gridWidth, grid_height: gridHeight })
    .select()
    .single();
  if (mapError) throw mapError;

  // Test layout, in one small grid:
  //   - a straight HORIZONTAL adjacent pair (the core gap-closure check)
  //   - a straight VERTICAL adjacent pair (same check, the other axis)
  //   - a real 90° turn: (4,1) straight -> (5,1) CORNER -> (5,2)/(5,3)
  //     straight, continuing the run around the corner
  //   - an isolated DIAGONAL piece
  const cellsByRole = {
    horizA: { x: 1, y: 1 },
    horizB: { x: 2, y: 1 },
    vertA: { x: 1, y: 3 },
    vertB: { x: 1, y: 4 },
    turnStraight1: { x: 4, y: 1 },
    turnCorner: { x: 5, y: 1 },
    turnStraight2: { x: 5, y: 2 },
    turnStraight3: { x: 5, y: 3 },
    diagonal: { x: 1, y: 6 },
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
    { role: "diagonal", asset_id: PRESET_WALL_DIAGONAL, rotation: 0, ...cellsByRole.diagonal },
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

  await admin.from("campaigns").update({ live_map: map.id }).eq("id", campaignId);

  const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  try {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="object-measure-state"]', { state: "attached", timeout: 30000 });

    const measured = await waitForMeasureCount(page, objectSeeds.length);
    check(
      `all ${objectSeeds.length} wall-family objects report a real measured maxDim/scale`,
      measured && Object.keys(measured).length === objectSeeds.length,
      JSON.stringify(measured)
    );

    // --- 1. THE core gap-closure proof: for every straight PRESET_WALL
    // instance, maxDim*scale (its own rendered span, in "1 cell = 1.0"
    // units) must be ~1.0 — the model reaches its full cell, so two
    // adjacent instances (spaced exactly 1 cell apart, unrelated to this
    // fix) touch with ~zero gap. Also confirms the measured maxDim itself
    // reads ~2.0 (wall.glb's own authored main-box width), matching this
    // investigation's real, pre-fix geometry inspection exactly — not a
    // coincidence, the SAME model file, unchanged. ---
    for (const role of ["horizA", "horizB", "vertA", "vertB", "turnStraight1", "turnStraight2", "turnStraight3"]) {
      const id = idByRole.get(role);
      const m = measured?.[id];
      check(`[${role}] measured maxDim ≈ 2.0 (wall.glb's own authored width, unchanged)`, m && Math.abs(m.maxDim - 2) < 0.01, JSON.stringify(m));
      check(`[${role}] measured scale ≈ 0.5 (the new fit target 1 / maxDim 2)`, m && Math.abs(m.scale - 0.5) < 0.01, JSON.stringify(m));
      const span = m ? m.maxDim * m.scale : NaN;
      check(
        `[${role}] rendered span ≈ 1.0 full cell-width (was 0.92 before this fix — a real, measured 0.08 cell-width gap)`,
        Math.abs(span - 1) < 0.01,
        JSON.stringify({ ...m, span })
      );
    }

    // --- 2. The corner piece: scale ≈ 1.0 (its fit target was set to its
    // OWN measured maxDim, so it renders exactly as authored — arms already
    // 1 cell-width long, matching the straight run's own fixed span above,
    // connecting flush with either neighbor with no additional shrink). ---
    const corner = measured?.[idByRole.get("turnCorner")];
    check(
      "[turnCorner] a distinct asset from the straight run (PRESET_WALL_CORNER, not PRESET_WALL)",
      insertedObjects.find((o) => o.id === idByRole.get("turnCorner"))?.asset_id === PRESET_WALL_CORNER
    );
    check(
      "[turnCorner] measured maxDim ≈ 1.07 (its own authored merlon-accent height, the real bounding box's largest axis)",
      corner && Math.abs(corner.maxDim - 1.07) < 0.01,
      JSON.stringify(corner)
    );
    check(
      "[turnCorner] measured scale ≈ 1.0 (fit target matches its own measured maxDim exactly — no distortion, its 1-cell-wide arms stay exactly 1 cell wide)",
      corner && Math.abs(corner.scale - 1) < 0.01,
      JSON.stringify(corner)
    );

    // --- 3. The diagonal piece: scale ≈ 1.0 confirms its hardcoded fit
    // target (1.190919) matches the real measured maxDim of the actual
    // shipped .glb — proving the authored Math.SQRT2 beam length (a full
    // cell's own corner-to-corner diagonal) survives to the rendered scene
    // undistorted. ---
    const diagonal = measured?.[idByRole.get("diagonal")];
    check(
      "[diagonal] a distinct 45°-baked asset (PRESET_WALL_DIAGONAL)",
      insertedObjects.find((o) => o.id === idByRole.get("diagonal"))?.asset_id === PRESET_WALL_DIAGONAL
    );
    check(
      "[diagonal] measured maxDim ≈ 1.190919 (its own real bounding box, per generate-wall-variants-presets.mjs's own console measurement)",
      diagonal && Math.abs(diagonal.maxDim - 1.190919) < 0.001,
      JSON.stringify(diagonal)
    );
    check(
      "[diagonal] measured scale ≈ 1.0 (fit target matches its own measured maxDim exactly — the authored Math.SQRT2 beam length, a full cell's diagonal, is preserved undistorted)",
      diagonal && Math.abs(diagonal.scale - 1) < 0.001,
      JSON.stringify(diagonal)
    );

    check("no uncaught page errors rendering the wall-family test map", consoleErrors.length === 0, JSON.stringify(consoleErrors));

    // --- Real screenshots for visual confirmation (the corner/diagonal
    // acceptance criteria explicitly ask for this, not just numbers).
    //
    // Taken from the map EDITOR (not the game room's seated table view):
    // GameTableScene's per-seat OrbitControls targets the physical table's
    // own center ([0, TABLE_SURFACE_Y, 0]), which — once actually zoomed
    // out far enough to fit the whole table — renders this map's small 8x8
    // cells too small to read (confirmed by hand: the game room's own
    // object-measure-state numeric proof above is real and load-bearing,
    // but a same-session screenshot attempt there was illegible). The
    // editor's own OrbitControls (MapEditorScene.tsx) targets [0, 0, 0] —
    // this map's own grid center — and its default camera already frames
    // the whole grid span, so a plain dolly-zoom (toward that fixed
    // target) lands cleanly on this layout's own wall cluster without
    // needing to fight a table-centric camera at all. ---
    await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${map.id}/edit`);
    await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 30000 });
    await page.waitForTimeout(2000);

    // 1. The straight-run -> corner -> straight-run turn (turnStraight1 at
    // (4,1) through turnStraight3 at (5,3)) sits close enough to this
    // layout's own grid center [0,0,0] that a plain zoom-in, no pan, lands
    // squarely on it.
    const cornerFocus = { x: 950, y: 500 };
    await page.mouse.move(cornerFocus.x, cornerFocus.y);
    for (let i = 0; i < 18; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(15);
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "wall-geometry-corner-closeup.png") });

    // 2. The diagonal cell (1,6) is much further from grid center than the
    // corner cluster, so it needs an explicit middle-drag PAN (the
    // editor's own MIDDLE: MOUSE.PAN mapping) to bring it into frame
    // before zooming — a plain dolly-zoom only ever zooms toward whatever
    // OrbitControls' `target` already is, not toward the cursor.
    await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${map.id}/edit`);
    await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 30000 });
    await page.waitForTimeout(2000);
    const diagonalFocus = { x: 950, y: 500 };
    await page.mouse.move(diagonalFocus.x, diagonalFocus.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(diagonalFocus.x + 260, diagonalFocus.y - 200, { steps: 20 });
    await page.mouse.up({ button: "middle" });
    await page.waitForTimeout(300);
    for (let i = 0; i < 16; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(15);
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "wall-geometry-diagonal-closeup.png") });

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
