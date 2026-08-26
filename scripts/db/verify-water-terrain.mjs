#!/usr/bin/env node
// Water terrain verification (a post-roadmap addition, not one of the
// numbered prompts) — migration 0051_water_terrain.sql widens map_cells'
// ground_type CHECK with a tenth value, 'water' (0047_ground_types.sql's
// own header comment anticipated this by name), and adds a nullable
// water_flow_direction column, meaningful only alongside ground_type =
// 'water', purely decorative (no rules-engine code, here or anywhere else,
// ever reads it).
//
// The confirmed design: water reuses the EXISTING difficult-terrain cost
// mechanic wholesale — a water cell costs double movement if and only if
// the DM ALSO marks it 'difficult' terrain via the ordinary terrain brush,
// exactly like any other difficult cell. src/rules-engine/movement.ts is
// untouched by this addition. This script proves that end to end: the
// schema CHECK, the editor's Water brush + flow-direction picker (live,
// before Save, and persisted after it), ground/terrain independence via a
// real persisted row, the live Game Room table rendering the same values,
// backward compatibility for maps that never touch water, and — the one
// check that can't be faked by inspecting colors — a REAL movement-cost
// test: the app's own `cellMovementCost`/`computeReachableCells` (loaded
// via vite, the verify-token-click-select.mjs/verify-opportunity-
// attacks.mjs precedent for "the exact code the app ships", not a
// hand-rolled lookalike), fed real persisted map_cells rows, proving a
// water+difficult cell costs exactly double and a water-only cell costs
// exactly normal, and that a water+difficult corridor's reachable set is
// IDENTICAL to a plain difficult corridor's — "identical mechanism, not a
// new one" verified structurally, not just asserted in a comment.
//
// Needs the local Supabase stack. Starts (or reuses) its own dev server on
// a dedicated port, the verify-ground-types.mjs convention — this host runs
// several worktrees/agents side by side and :3000 may already be bound to
// an unrelated build.
// Usage: node scripts/db/verify-water-terrain.mjs
//
// Real screenshots are saved to the scratchpad directory below at each
// meaningful rendering checkpoint.

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { createServer } from "vite";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3458;
const APP_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/water-terrain-screenshots";
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
  console.log(`dev server not running on :${PORT} — starting yarn dev -p ${PORT}…`);
  devServer = spawn("yarn", ["dev", "-p", String(PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
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
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `water-terrain-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Water ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

/** The blind-aim workaround for WebGL scenes (verify-void-terrain.mjs's own
 * scanClick): click a centered-outward scan of canvas points until `done()`
 * reports the scene reacted (or the points run out). */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.3, xTo = 0.78, yFrom = 0.24, yTo = 0.7, step = 40, settleMs = 140 } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const [offset, settle] of [
    [0, settleMs],
    [step / 2, settleMs * 2],
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
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) return point;
    }
  }
  return null;
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

/** Switches the Game Room to Free Camera before a screenshot — the
 * verify-ground-types.mjs precedent (see its own doc comment for why this
 * doesn't reliably produce an overhead view; it mainly confirms the right
 * map is live and rendering). */
async function angleCameraOverTable(page) {
  await page.bringToFront();
  await page.click('[data-testid="camera-mode-toggle"]');
  await sleep(300);
}

await ensureDevServer();

// The app's REAL rules-engine module, loaded through vite exactly the way
// verify-token-click-select.mjs/verify-opportunity-attacks.mjs do — every
// movement-cost assertion below runs the SAME code the Game Room ships,
// fed real rows fetched from the database, not a hand-rolled lookalike.
const vite = await createServer({
  root: rootDir,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
});
const movementRules = await vite.ssrLoadModule("/src/rules-engine/movement.ts");

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Water terrain test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Water terrain map",
    grid_width: 6,
    grid_height: 5,
  });

  // ── 1. The CHECK constraints: water is a real ground_type value, an
  //       invalid one is still rejected, and water_flow_direction only
  //       accepts null or the four cardinals. ──
  const { error: lavaError } = await admin
    .from("map_cells")
    .upsert(
      [{ map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "lava" }],
      { onConflict: "map_id,x,y" }
    );
  check(
    "the ground_type CHECK still rejects a value outside the (now ten-value) vocabulary",
    lavaError !== null && /ground_type/.test(lavaError.message ?? ""),
    lavaError?.message ?? "insert unexpectedly succeeded"
  );

  const { error: waterOkError } = await admin
    .from("map_cells")
    .upsert(
      [{ map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "water" }],
      { onConflict: "map_id,x,y" }
    );
  check("'water' is accepted as a real ground_type value", waterOkError === null, waterOkError?.message);

  const { error: badFlowError } = await admin
    .from("map_cells")
    .upsert(
      [
        {
          map_id: mapId,
          x: 0,
          y: 0,
          elevation: 0,
          terrain_type: "normal",
          light_level: "bright",
          ground_type: "water",
          water_flow_direction: "northeast",
        },
      ],
      { onConflict: "map_id,x,y" }
    );
  check(
    "the water_flow_direction CHECK rejects anything outside the four cardinals",
    badFlowError !== null && /water_flow_direction/.test(badFlowError.message ?? ""),
    badFlowError?.message ?? "insert unexpectedly succeeded"
  );

  const { error: nullFlowError } = await admin
    .from("map_cells")
    .upsert(
      [{ map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "water", water_flow_direction: null }],
      { onConflict: "map_id,x,y" }
    );
  check(
    "water_flow_direction accepts null (water with no authored arrow)",
    nullFlowError === null,
    nullFlowError?.message
  );

  const { error: goodFlowError } = await admin
    .from("map_cells")
    .upsert(
      [{ map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "water", water_flow_direction: "east" }],
      { onConflict: "map_id,x,y" }
    );
  check(
    "water_flow_direction accepts each of the four cardinals",
    goodFlowError === null,
    goodFlowError?.message
  );

  // Reset (0,0) back to untouched (sparse storage: deleting the row
  // reconstructs it as the plain DEFAULT_CELL) — the CHECK-constraint
  // probing above left a REAL water+east row there, which would otherwise
  // pre-satisfy the editor UI scan's "find a water cell" predicate below
  // before any actual click happens, making the UI walkthrough think it
  // painted a cell it never actually clicked.
  await admin.from("map_cells").delete().eq("map_id", mapId).eq("x", 0).eq("y", 0);

  // ── 2. Authorization: a player cannot paint water (same RLS as every
  //       other ground type / terrain paint). ──
  const { error: playerPaintError } = await player.client
    .from("map_cells")
    .upsert(
      [{ map_id: mapId, x: 1, y: 1, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "water" }],
      { onConflict: "map_id,x,y" }
    );
  const { data: afterPlayerPaint } = await admin.from("map_cells").select().eq("map_id", mapId).eq("x", 1).eq("y", 1);
  check(
    "a player's client cannot paint water (same can_write_map RLS as terrain/ground)",
    playerPaintError !== null || (afterPlayerPaint ?? []).length === 0,
    playerPaintError?.message ?? `rows: ${(afterPlayerPaint ?? []).length}`
  );

  // ── 3. The editor's real Ground tool: a Water brush, distinct from all
  //       nine other ground types, plus a flow-direction picker that only
  //       appears for water. ──
  // Tall viewport: the editor's toolbar panel is absolute-positioned and
  // bottom-anchored with no scroll container of its own (editor.module.css's
  // .toolbar), so a fully-expanded Ground tool (all ten brushes plus the
  // Flow direction picker's own row) grows tall enough to push earlier
  // buttons above a typical 900px viewport's top edge with nothing able to
  // scroll them back into view. A generously tall headless viewport
  // sidesteps that without touching product layout — real DMs on a shorter
  // window would need to scroll their own OS window or collapse a section,
  // unrelated to this addition's own correctness.
  const dmContext = await browser.newContext({ viewport: { width: 1400, height: 2000 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const editorPage = await dmContext.newPage();
  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });

  await editorPage.click('[data-testid="tool-ground"]');
  await editorPage.waitForSelector('[data-testid="brush-ground-water"]', { timeout: 10000 });
  for (const type of ["default", "grass", "rock", "forest", "dense_forest", "path", "sand", "swamp", "stone", "water"]) {
    check(
      `the Ground tool offers a ${type} brush`,
      await editorPage.locator(`[data-testid="brush-ground-${type}"]`).isVisible(),
      `brush-ground-${type} not found`
    );
  }
  check(
    "the flow-direction picker is ABSENT while a non-water ground brush is selected",
    !(await editorPage.locator('[data-testid="water-flow-north"]').isVisible().catch(() => false))
  );

  await editorPage.click('[data-testid="brush-ground-water"]');
  await editorPage.waitForSelector('[data-testid="water-flow-east"]', { timeout: 10000 });
  check(
    "selecting the Water brush reveals the flow-direction picker (all four cardinals)",
    await editorPage.locator('[data-testid="water-flow-north"]').isVisible() &&
      await editorPage.locator('[data-testid="water-flow-east"]').isVisible() &&
      await editorPage.locator('[data-testid="water-flow-south"]').isVisible() &&
      await editorPage.locator('[data-testid="water-flow-west"]').isVisible()
  );
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "01-water-brush-and-flow-picker.png") });

  // Paint cell A with flow East.
  await editorPage.click('[data-testid="water-flow-east"]');
  const cellAPoint = await scanClick(editorPage, async () => {
    const mirror = await readMirror(editorPage, "editor-surface-state");
    return Object.entries(mirror.waterFlowByCell ?? {}).some(([, dir]) => dir === "east");
  });
  check("painting the Water brush (flow East selected) marks a cell water+east, live in the mirror", cellAPoint !== null);
  const mirrorAfterA = await readMirror(editorPage, "editor-surface-state");
  const cellAKey = Object.entries(mirrorAfterA.waterFlowByCell ?? {}).find(([, dir]) => dir === "east")?.[0];
  check("the painted cell's ground is 'water'", cellAKey !== undefined && mirrorAfterA.groundByCell[cellAKey] === "water", JSON.stringify(mirrorAfterA));
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "02-water-east-painted.png") });

  // Re-pick flow North and re-click the EXACT same screen point — a real
  // "way to set flow direction on a water cell" that changes an ALREADY
  // water cell's direction without touching its ground type.
  await editorPage.click('[data-testid="water-flow-north"]');
  await sleep(200); // lets the brush-selection state (and its ref sync) settle before the repaint click
  await editorPage.mouse.click(cellAPoint.x, cellAPoint.y);
  await sleep(200);
  const mirrorAfterRepaint = await readMirror(editorPage, "editor-surface-state");
  check(
    "re-painting the SAME water cell with a different flow selection updates its arrow, still water",
    mirrorAfterRepaint.groundByCell[cellAKey] === "water" && mirrorAfterRepaint.waterFlowByCell[cellAKey] === "north",
    JSON.stringify(mirrorAfterRepaint)
  );

  // Paint a SECOND, distinct cell (flow East again) — proves per-cell
  // independence: cell A must stay "north" while cell B becomes "east".
  await editorPage.click('[data-testid="water-flow-east"]');
  const cellBPoint = await scanClick(
    editorPage,
    async () => {
      const mirror = await readMirror(editorPage, "editor-surface-state");
      const key = Object.keys(mirror.waterFlowByCell ?? {}).find((k) => k !== cellAKey);
      return key !== undefined && mirror.waterFlowByCell[key] === "east";
    },
    { xFrom: 0.5, xTo: 0.85 }
  );
  check("painting a second, distinct water cell works independently of the first", cellBPoint !== null);
  const mirrorAfterB = await readMirror(editorPage, "editor-surface-state");
  const cellBKey = Object.keys(mirrorAfterB.waterFlowByCell ?? {}).find((k) => k !== cellAKey);
  check(
    "cell A keeps its own flow direction (north) while cell B independently holds east",
    mirrorAfterB.waterFlowByCell[cellAKey] === "north" && mirrorAfterB.waterFlowByCell[cellBKey] === "east",
    JSON.stringify(mirrorAfterB.waterFlowByCell)
  );
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "03-two-independent-water-cells.png") });

  // Switch to a non-water ground brush and re-paint cell A — the flow
  // direction must clear back to null (no longer meaningful) since the
  // cell is no longer water.
  await editorPage.click('[data-testid="brush-ground-grass"]');
  await sleep(200);
  check(
    "the flow-direction picker disappears again once a non-water brush is selected",
    !(await editorPage.locator('[data-testid="water-flow-north"]').isVisible().catch(() => false))
  );
  await editorPage.mouse.click(cellAPoint.x, cellAPoint.y);
  await sleep(200);
  const mirrorAfterClear = await readMirror(editorPage, "editor-surface-state");
  check(
    "painting a different ground type over a water cell clears its flow direction",
    mirrorAfterClear.groundByCell[cellAKey] === "grass" && !(cellAKey in (mirrorAfterClear.waterFlowByCell ?? {})),
    JSON.stringify(mirrorAfterClear)
  );

  // ── 4. Save, and a fresh page load reconstructs the same state from the
  //       database (overlayFromRows round trip), not just in-memory state. ──
  await editorPage.click('[data-testid="save-map"]');
  await editorPage.waitForSelector('[data-testid="save-status"]', { timeout: 15000 });
  const { x: bx, y: by } = { x: Number(cellBKey.split(",")[0]), y: Number(cellBKey.split(",")[1]) };
  const { data: savedCellB } = await admin
    .from("map_cells")
    .select()
    .eq("map_id", mapId)
    .eq("x", bx)
    .eq("y", by)
    .maybeSingle();
  check(
    "Save persisted cell B's ground_type and water_flow_direction exactly",
    savedCellB?.ground_type === "water" && savedCellB?.water_flow_direction === "east",
    JSON.stringify(savedCellB)
  );

  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  const mirrorAfterReload = await readMirror(editorPage, "editor-surface-state");
  check(
    "a fresh editor page load reconstructs the exact same water cells from the database",
    mirrorAfterReload.groundByCell[cellBKey] === "water" &&
      mirrorAfterReload.waterFlowByCell[cellBKey] === "east" &&
      mirrorAfterReload.groundByCell[cellAKey] === "grass" &&
      !(cellAKey in (mirrorAfterReload.waterFlowByCell ?? {})),
    JSON.stringify(mirrorAfterReload)
  );
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "04-editor-after-reload.png") });

  // ── 5. Ground/terrain independence on a REAL persisted row: mark cell B
  //       ALSO difficult terrain — its ground type and flow direction must
  //       survive untouched, and vice versa (this is the exact row the
  //       movement-cost test below reads back). ──
  const cellBDifficult = { ...savedCellB, terrain_type: "difficult" };
  const { error: markDifficultError } = await admin
    .from("map_cells")
    .upsert([cellBDifficult], { onConflict: "map_id,x,y" });
  const { data: cellBAfterDifficult } = await admin
    .from("map_cells")
    .select()
    .eq("map_id", mapId)
    .eq("x", bx)
    .eq("y", by)
    .maybeSingle();
  check(
    "marking a water cell ALSO difficult terrain leaves its ground_type and water_flow_direction untouched",
    markDifficultError === null &&
      cellBAfterDifficult?.terrain_type === "difficult" &&
      cellBAfterDifficult?.ground_type === "water" &&
      cellBAfterDifficult?.water_flow_direction === "east",
    JSON.stringify({ markDifficultError, cellBAfterDifficult })
  );

  // A sibling water cell that stays NOT difficult, persisted (not just
  // asserted) so the "water alone costs normal movement" half of the proof
  // below reads a real row too, not just a hand-built literal.
  const { data: waterOnlyCell } = await admin
    .from("map_cells")
    .upsert(
      [{ map_id: mapId, x: 5, y: 4, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "water", water_flow_direction: "south" }],
      { onConflict: "map_id,x,y" }
    )
    .select()
    .single();

  // ── 6. The REAL movement-cost test: the app's own cellMovementCost,
  //       loaded via vite, fed the exact rows just persisted above. No
  //       hand-rolled cost formula — this is the production function. ──
  check(
    "a water cell NOT marked difficult costs the normal 5 ft to enter — cellMovementCost fed the real persisted row",
    movementRules.cellMovementCost({ terrain: waterOnlyCell.terrain_type, elevationDeltaFeet: 0 }) ===
      movementRules.FEET_PER_CELL,
    `terrain=${waterOnlyCell.terrain_type} ground=${waterOnlyCell.ground_type} cost=${movementRules.cellMovementCost({ terrain: waterOnlyCell.terrain_type, elevationDeltaFeet: 0 })}`
  );
  check(
    "the SAME water cell marked difficult costs exactly double (10 ft) to enter — cellMovementCost fed the real persisted row",
    movementRules.cellMovementCost({ terrain: cellBAfterDifficult.terrain_type, elevationDeltaFeet: 0 }) ===
      movementRules.FEET_PER_CELL * 2,
    `terrain=${cellBAfterDifficult.terrain_type} cost=${movementRules.cellMovementCost({ terrain: cellBAfterDifficult.terrain_type, elevationDeltaFeet: 0 })}`
  );

  // ── 7. computeReachableCells over real corridors: water+difficult reaches
  //       EXACTLY as far as plain difficult (no water at all) — "identical
  //       mechanism, not a new one" proven structurally — and strictly less
  //       far than a water-but-not-difficult corridor at the same budget. ──
  const CORRIDOR_LENGTH = 8;
  const BUDGET_FEET = 30; // 30/5 = 6 cells normal; 30/10 = 3 cells difficult.

  async function makeCorridorMap(name, cellFactory) {
    const corridorMapId = crypto.randomUUID();
    await admin.from("campaign_maps").insert({
      id: corridorMapId,
      campaign_id: campaignId,
      name,
      grid_width: CORRIDOR_LENGTH,
      grid_height: 1,
    });
    const rows = [];
    for (let x = 1; x < CORRIDOR_LENGTH - 1; x++) {
      const cell = cellFactory(x);
      if (cell) rows.push({ map_id: corridorMapId, x, y: 0, elevation: 0, light_level: "bright", ...cell });
    }
    if (rows.length > 0) await admin.from("map_cells").upsert(rows, { onConflict: "map_id,x,y" });
    return corridorMapId;
  }

  const waterOnlyMapId = await makeCorridorMap("Water corridor (not difficult)", () => ({
    terrain_type: "normal",
    ground_type: "water",
    water_flow_direction: "east",
  }));
  const waterDifficultMapId = await makeCorridorMap("Water + difficult corridor", () => ({
    terrain_type: "difficult",
    ground_type: "water",
    water_flow_direction: "east",
  }));
  const plainDifficultMapId = await makeCorridorMap("Plain difficult corridor (no water)", () => ({
    terrain_type: "difficult",
    ground_type: "default",
  }));

  async function reachableMaxX(corridorMapId) {
    const { data: rows } = await admin.from("map_cells").select().eq("map_id", corridorMapId);
    const byKey = new Map((rows ?? []).map((row) => [`${row.x},${row.y}`, row]));
    const cells = [];
    for (let x = 0; x < CORRIDOR_LENGTH; x++) {
      const row = byKey.get(`${x},0`);
      cells.push({
        position: { x, y: 0 },
        terrain: row?.terrain_type ?? "normal",
        elevationSteps: row?.elevation ?? 0,
      });
    }
    const reachable = movementRules.computeReachableCells({
      origin: { x: 0, y: 0 },
      cells,
      budgetFeet: BUDGET_FEET,
    });
    return Math.max(...reachable.map((point) => point.x));
  }

  const waterOnlyMaxX = await reachableMaxX(waterOnlyMapId);
  const waterDifficultMaxX = await reachableMaxX(waterDifficultMapId);
  const plainDifficultMaxX = await reachableMaxX(plainDifficultMapId);

  check(
    "a water-only (non-difficult) corridor reaches the full normal-terrain distance (6 cells at 30 ft budget)",
    waterOnlyMaxX === 6,
    `reached x=${waterOnlyMaxX}`
  );
  check(
    "a water+difficult corridor reaches only the difficult-terrain distance (3 cells at 30 ft budget) — half as far as water alone",
    waterDifficultMaxX === 3,
    `reached x=${waterDifficultMaxX}`
  );
  check(
    "a water+difficult corridor reaches EXACTLY as far as a plain difficult corridor with no water at all — identical mechanism, not a new one",
    waterDifficultMaxX === plainDifficultMaxX,
    `water+difficult=${waterDifficultMaxX} plain difficult=${plainDifficultMaxX}`
  );

  // ── 8. The live Game Room table renders the same water cells (color +
  //       flow direction) the editor saved. ──
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  const roomPage = await dmContext.newPage();
  await roomPage.setViewportSize({ width: 1400, height: 900 });
  await roomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await roomPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  const tableMirror = await readMirror(roomPage, "table-surface-state");
  check(
    "the live Game Room table renders the exact same water ground type and flow direction the editor saved",
    tableMirror.groundByCell[cellBKey] === "water" && tableMirror.waterFlowByCell[cellBKey] === "east",
    JSON.stringify({ groundByCell: tableMirror.groundByCell, waterFlowByCell: tableMirror.waterFlowByCell })
  );
  await sleep(500);
  await angleCameraOverTable(roomPage);
  await roomPage.screenshot({ path: join(SCREENSHOT_DIR, "05-live-table-water-cell.png") });

  // ── 9. Backward compatibility: a map that never touches water (or that
  //       uses pit terrain, MapPlan P7b's own addition) renders identically
  //       to before this change — empty waterFlowByCell, and pit's own
  //       rendering untouched. ──
  const pitMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: pitMapId,
    campaign_id: campaignId,
    name: "Pit-only map (no water)",
    grid_width: 3,
    grid_height: 3,
  });
  await admin.from("map_cells").upsert(
    [{ map_id: pitMapId, x: 1, y: 1, elevation: -2, terrain_type: "pit", light_level: "bright", ground_type: "default" }],
    { onConflict: "map_id,x,y" }
  );
  const pitEditorPage = await dmContext.newPage();
  await pitEditorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${pitMapId}/edit`);
  await pitEditorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  const pitMirror = await readMirror(pitEditorPage, "editor-surface-state");
  check(
    "a pit-only map (no water ever painted) has an EMPTY waterFlowByCell and its pit cell is untouched",
    Object.keys(pitMirror.waterFlowByCell ?? {}).length === 0 &&
      pitMirror.pitCells.some((cell) => cell.key === "1,1" && cell.elevation === -2),
    JSON.stringify(pitMirror)
  );

  await admin.from("campaigns").update({ live_map: pitMapId }).eq("id", campaignId);
  await roomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await roomPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  const pitTableMirror = await readMirror(roomPage, "table-surface-state");
  check(
    "the same pit-only map's live table rendering also has an EMPTY waterFlowByCell",
    Object.keys(pitTableMirror.waterFlowByCell ?? {}).length === 0,
    JSON.stringify(pitTableMirror)
  );
  await angleCameraOverTable(roomPage);
  await roomPage.screenshot({ path: join(SCREENSHOT_DIR, "06-pit-only-map-unaffected.png") });

  // ── 10. A palette swatch: water alongside a few other ground types and a
  //       pit, each with a distinct flow direction where applicable — one
  //       at-a-glance visual confirmation (steps 1-9 already proved
  //       correctness; this is purely for the report's screenshots). ──
  const paletteMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: paletteMapId,
    campaign_id: campaignId,
    name: "Water palette swatch",
    grid_width: 4,
    grid_height: 2,
  });
  await admin.from("map_cells").upsert(
    [
      { map_id: paletteMapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "water", water_flow_direction: "north" },
      { map_id: paletteMapId, x: 1, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "water", water_flow_direction: "east" },
      { map_id: paletteMapId, x: 2, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "water", water_flow_direction: "south" },
      { map_id: paletteMapId, x: 3, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "water", water_flow_direction: "west" },
      { map_id: paletteMapId, x: 0, y: 1, elevation: 0, terrain_type: "difficult", light_level: "bright", ground_type: "water", water_flow_direction: "east" },
      { map_id: paletteMapId, x: 1, y: 1, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "stone" },
      { map_id: paletteMapId, x: 2, y: 1, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "swamp" },
      { map_id: paletteMapId, x: 3, y: 1, elevation: -2, terrain_type: "pit", light_level: "bright", ground_type: "default" },
    ],
    { onConflict: "map_id,x,y" }
  );
  const paletteEditorPage = await dmContext.newPage();
  await paletteEditorPage.setViewportSize({ width: 1400, height: 900 });
  await paletteEditorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${paletteMapId}/edit`);
  await paletteEditorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  const paletteMirror = await readMirror(paletteEditorPage, "editor-surface-state");
  check(
    "the palette swatch map carries all four flow directions on water, plus stone/swamp/pit for visual contrast",
    paletteMirror.waterFlowByCell["0,0"] === "north" &&
      paletteMirror.waterFlowByCell["1,0"] === "east" &&
      paletteMirror.waterFlowByCell["2,0"] === "south" &&
      paletteMirror.waterFlowByCell["3,0"] === "west" &&
      paletteMirror.groundByCell["0,1"] === "water" &&
      paletteMirror.pitCells.some((cell) => cell.key === "3,1"),
    JSON.stringify(paletteMirror)
  );
  await sleep(300);
  await paletteEditorPage.screenshot({ path: join(SCREENSHOT_DIR, "07-water-palette-all-directions.png") });

  await admin.from("campaigns").update({ live_map: paletteMapId }).eq("id", campaignId);
  await roomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await roomPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await angleCameraOverTable(roomPage);
  await roomPage.screenshot({ path: join(SCREENSHOT_DIR, "08-water-palette-live-table.png") });
} finally {
  await vite.close();
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
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
console.log(`\nAll water-terrain checks passed. Screenshots saved to ${SCREENSHOT_DIR}`);
process.exit(0);
