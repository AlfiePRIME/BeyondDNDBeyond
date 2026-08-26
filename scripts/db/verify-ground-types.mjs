#!/usr/bin/env node
// Ground types verification (the flat-color-terrain-dressing addition —
// migration 0046, not one of the numbered prompts).
//
// Hybrid shape per verify-void-terrain.mjs: service-role client for setup,
// real signed-in clients for the RLS/independence checks, and a real
// Playwright browser for the editor brush / persistence / live-table
// rendering checks. Covers: the schema CHECK rejects any ground_type
// outside the nine-value vocabulary; a player's client cannot paint ground
// type (same can_write_map RLS as terrain) while the DM's can, and it
// persists; painting terrain never touches ground_type and painting ground
// type never touches terrain_type (both via direct rows AND via the real
// editor's own brushes); the editor exposes a Ground tool with a brush per
// GROUND_TYPES value; a painted-but-unsaved ground type shows immediately
// in the editor's hidden render-state mirror; Save persists it and a fresh
// page load reconstructs it identically; the live Game Room table renders
// the same ground type once the map goes live; and a map nobody ever
// touched with the ground brush renders with an EMPTY groundByCell on both
// surfaces — the "every existing cell renders identically" acceptance
// criterion, structurally.
//
// The scenes are WebGL (no DOM to locate), so rendering assertions read the
// hidden render-state mirrors — [data-testid="editor-surface-state"] in the
// editor and [data-testid="table-surface-state"] in the room (the
// vision-state/void-terrain precedent), both of which now carry a
// `groundByCell` map (cell key -> ground type) alongside `voidCells`.
//
// Needs the local Supabase stack. Unlike verify-void-terrain.mjs this does
// NOT default to :3000 — this host runs several worktrees/agents side by
// side and :3000 is already bound to an unrelated standalone build outside
// this worktree, so this script starts (or reuses) its OWN dev server on a
// dedicated port instead of colliding with whatever else is already up.
// Usage: node scripts/db/verify-ground-types.mjs
//
// Real screenshots are saved to the scratchpad directory below as the
// script runs, at each meaningful rendering checkpoint, for visual
// confirmation alongside the pass/fail checks.

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Dedicated port for THIS worktree's dev server — :3000 on this shared host
// is a foreign standalone build unrelated to this checkout (see header).
const PORT = 3457;
const APP_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/ground-types-screenshots";
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
  const email = `ground-types-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Ground ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

/** The blind-aim workaround for WebGL scenes: click a centered-outward scan
 * of canvas points until `done()` reports the scene reacted (or the points
 * run out). Steers clear of the DOM overlays (header top, panels bottom-left). */
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

/** Switches the Game Room to Free Camera before a screenshot. Also brings
 * the page to the front first: a background Playwright tab's WebGL canvas
 * doesn't paint new frames at all (page-visibility throttling), which would
 * otherwise make every screenshot after the first open page come out
 * blank. NOTE: this does NOT reliably re-angle the camera to an overhead
 * view — an attempted pitch-drag+zoom-out was tried and dropped: the
 * Game Room's `PerspectiveCamera` position appears to be re-pinned to the
 * seat's fixed `cameraPosition` on ordinary re-renders (a pre-existing Free
 * Camera characteristic unrelated to ground types, out of this addition's
 * scope to fix), so a simulated drag has no lasting visual effect. The
 * table screenshots this produces therefore mainly confirm the right map
 * is live and the room loads correctly; the actual color-parity proof
 * between the editor and the live table is the `table-surface-state`
 * mirror assertions above (same `groundByCell` values, read from the exact
 * cells the shared `MapSurface` renderer draws), not pixel inspection. */
async function angleCameraOverTable(page) {
  await page.bringToFront();
  await page.click('[data-testid="camera-mode-toggle"]');
  await sleep(300);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Ground types test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Ground types map",
    grid_width: 4,
    grid_height: 4,
  });

  // ── 1. The CHECK constraint: only the nine-value vocabulary. ──
  const { error: lavaError } = await admin
    .from("map_cells")
    .upsert(
      [{ map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "lava" }],
      { onConflict: "map_id,x,y" }
    );
  check(
    "the schema CHECK rejects a ground_type outside the nine-value vocabulary (even service-role)",
    lavaError !== null && /ground_type/.test(lavaError.message ?? ""),
    lavaError?.message ?? "insert unexpectedly succeeded"
  );

  // ── 2. Painting authorization: ground_type writes exactly like terrain. ──
  const { error: playerPaintError } = await player.client
    .from("map_cells")
    .upsert(
      [{ map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "grass" }],
      { onConflict: "map_id,x,y" }
    );
  const { data: afterPlayerPaint } = await admin.from("map_cells").select().eq("map_id", mapId);
  check(
    "a player's client cannot paint ground type (same RLS write rule as terrain)",
    playerPaintError !== null || (afterPlayerPaint ?? []).length === 0,
    playerPaintError?.message ?? `rows: ${(afterPlayerPaint ?? []).length}`
  );

  const { error: dmPaintError } = await dm.client
    .from("map_cells")
    .upsert(
      [{ map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "difficult", light_level: "bright", ground_type: "forest" }],
      { onConflict: "map_id,x,y" }
    );
  const { data: dmPainted } = await admin
    .from("map_cells")
    .select()
    .eq("map_id", mapId)
    .eq("x", 0)
    .eq("y", 0)
    .maybeSingle();
  check(
    "the DM's own client paints a cell's ground type and it persists (the exact terrain-paint authorization)",
    dmPaintError === null && dmPainted?.ground_type === "forest",
    dmPaintError?.message ?? JSON.stringify(dmPainted)
  );

  // ── 3. Independence via direct rows: this same cell is ALSO difficult
  //       terrain, set in the very same upsert above — proving the two
  //       columns don't fight or overwrite each other. ──
  check(
    "painting ground type on a cell that is ALSO difficult terrain leaves terrain_type untouched",
    dmPainted?.terrain_type === "difficult" && dmPainted?.ground_type === "forest",
    JSON.stringify(dmPainted)
  );

  // ── 4. The editor's real Ground tool: tool button, brush-per-type, and
  //       the live (pre-Save) render mirror. ──
  const dmContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const editorPage = await dmContext.newPage();
  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });

  // Map editor toolbar redesign: Ground now lives in Paint mode's context
  // panel, not the old always-mounted flat toolbar — one mode-rail click
  // before this test's first tool interaction, per the redesign's own
  // documented verify-script impact table.
  await editorPage.click('[data-testid="mode-paint"]');
  await editorPage.click('[data-testid="tool-ground"]');
  await editorPage.waitForSelector('[data-testid="brush-ground-grass"]', { timeout: 10000 });
  check("the editor offers a Ground tool with a brush per GROUND_TYPES value", true);
  for (const type of ["default", "grass", "rock", "forest", "dense_forest", "path", "sand", "swamp", "stone"]) {
    check(
      `the Ground tool offers a ${type} brush`,
      await editorPage.locator(`[data-testid="brush-ground-${type}"]`).isVisible(),
      `brush-ground-${type} not found`
    );
  }
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "01-ground-tool-open.png") });

  // Paint (1,1) grass — a cell whose terrain_type will stay "normal", never
  // touched by this brush.
  await editorPage.click('[data-testid="brush-ground-grass"]');
  const grassPainted = await scanClick(editorPage, async () => {
    const mirror = await readMirror(editorPage, "editor-surface-state");
    return mirror.groundByCell["1,1"] === "grass";
  });
  check("painting the Grass brush marks a cell 'grass' live in the editor mirror, before Save", grassPainted !== null);
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "02-grass-painted.png") });

  // Switch brush to Forest, paint a second, distinct cell.
  await editorPage.click('[data-testid="brush-ground-forest"]');
  const forestPainted = await scanClick(
    editorPage,
    async () => {
      const mirror = await readMirror(editorPage, "editor-surface-state");
      return mirror.groundByCell["2,2"] === "forest";
    },
    { xFrom: 0.5, xTo: 0.85 }
  );
  check("switching brushes and painting a second cell marks it 'forest', independently of the first", forestPainted !== null);
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "03-forest-painted.png") });

  const mirrorBeforeSave = await readMirror(editorPage, "editor-surface-state");
  check(
    "the mirror carries BOTH painted cells at once, plus the earlier direct-DB (0,0) forest cell",
    mirrorBeforeSave.groundByCell["1,1"] === "grass" &&
      mirrorBeforeSave.groundByCell["2,2"] === "forest" &&
      mirrorBeforeSave.groundByCell["0,0"] === "forest",
    JSON.stringify(mirrorBeforeSave.groundByCell)
  );

  // ── 5. Independence via the real UI: paint (3,3) Difficult terrain and
  //       confirm it does NOT appear in groundByCell (still "default"). ──
  // Terrain lives in Sculpt mode — back out of Paint mode first.
  await editorPage.click('[data-testid="mode-sculpt"]');
  await editorPage.click('[data-testid="tool-terrain"]');
  await editorPage.click('[data-testid="brush-difficult"]');
  const difficultPainted = await scanClick(
    editorPage,
    () => editorPage.locator('[data-testid="dirty-count"]').isVisible(),
    { xFrom: 0.62, xTo: 0.9, yFrom: 0.45, yTo: 0.75 }
  );
  check("painting Difficult terrain through the real terrain brush works", difficultPainted !== null);
  await editorPage.click('[data-testid="save-map"]');
  await editorPage.waitForSelector('[data-testid="save-status"]', { timeout: 15000 });

  const { data: rowsAfterSave } = await admin.from("map_cells").select().eq("map_id", mapId);
  const byKey = Object.fromEntries((rowsAfterSave ?? []).map((row) => [`${row.x},${row.y}`, row]));
  check(
    "Save persisted every painted cell's ground_type exactly, and terrain-only edits carry ground_type='default'",
    byKey["1,1"]?.ground_type === "grass" &&
      byKey["1,1"]?.terrain_type === "normal" &&
      byKey["2,2"]?.ground_type === "forest" &&
      byKey["2,2"]?.terrain_type === "normal",
    JSON.stringify(byKey)
  );
  // The Difficult-terrain-ONLY cell painted in step 5 through the real UI
  // brush: wherever the scan landed, it must NOT be (0,0) — the cell step 3
  // deliberately made both difficult AND forest via a direct row, which is
  // exactly the "a difficult cell CAN carry a real ground type" half of
  // independence, proven by check "painting ground type on a cell that is
  // ALSO difficult terrain..." above. This check proves the OTHER half:
  // painting Difficult through the real terrain brush never ALSO sets a
  // ground type — it stays at 'default'.
  const newDifficultRows = (rowsAfterSave ?? []).filter(
    (row) => row.terrain_type === "difficult" && !(row.x === 0 && row.y === 0)
  );
  check(
    "painting Difficult terrain through the real brush leaves ground_type at its 'default' — independence holds both ways",
    newDifficultRows.length > 0 && newDifficultRows.every((row) => row.ground_type === "default"),
    JSON.stringify(newDifficultRows)
  );

  // ── 6. A fresh page load reconstructs the same ground types from the DB
  //       (overlayFromRows round trip), not just from in-memory state. ──
  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  const mirrorAfterReload = await readMirror(editorPage, "editor-surface-state");
  check(
    "a fresh editor page load reconstructs the exact same ground types from the database",
    mirrorAfterReload.groundByCell["0,0"] === "forest" &&
      mirrorAfterReload.groundByCell["1,1"] === "grass" &&
      mirrorAfterReload.groundByCell["2,2"] === "forest",
    JSON.stringify(mirrorAfterReload.groundByCell)
  );
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "04-editor-after-reload.png") });

  // ── 7. The live Game Room table renders the same ground types. ──
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  const roomPage = await dmContext.newPage();
  await roomPage.setViewportSize({ width: 1400, height: 900 });
  await roomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await roomPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  const tableMirror = await readMirror(roomPage, "table-surface-state");
  check(
    "the live Game Room table renders the exact same ground types the editor saved",
    tableMirror.groundByCell["0,0"] === "forest" &&
      tableMirror.groundByCell["1,1"] === "grass" &&
      tableMirror.groundByCell["2,2"] === "forest",
    JSON.stringify(tableMirror.groundByCell)
  );
  await sleep(500);
  await angleCameraOverTable(roomPage);
  await roomPage.screenshot({ path: join(SCREENSHOT_DIR, "05-live-table-ground-types.png") });

  // ── 8. Backward compatibility: a SECOND, never-touched map's rendering
  //       carries an EMPTY groundByCell on both surfaces — nothing about a
  //       plain map's appearance changes structurally, not just visually. ──
  const untouchedMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: untouchedMapId,
    campaign_id: campaignId,
    name: "Untouched map",
    grid_width: 3,
    grid_height: 3,
  });
  const untouchedEditorPage = await dmContext.newPage();
  await untouchedEditorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${untouchedMapId}/edit`);
  await untouchedEditorPage.waitForSelector('[data-testid="editor-surface-state"]', {
    state: "attached",
    timeout: 60000,
  });
  const untouchedEditorMirror = await readMirror(untouchedEditorPage, "editor-surface-state");
  check(
    "a map with no ground type ever painted has an EMPTY groundByCell in the editor — renders identically to before this feature",
    Object.keys(untouchedEditorMirror.groundByCell).length === 0,
    JSON.stringify(untouchedEditorMirror.groundByCell)
  );

  await admin.from("campaigns").update({ live_map: untouchedMapId }).eq("id", campaignId);
  await roomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await roomPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  const untouchedTableMirror = await readMirror(roomPage, "table-surface-state");
  check(
    "the same untouched map's live table rendering also has an EMPTY groundByCell",
    Object.keys(untouchedTableMirror.groundByCell).length === 0,
    JSON.stringify(untouchedTableMirror.groundByCell)
  );
  await angleCameraOverTable(roomPage);
  await roomPage.screenshot({ path: join(SCREENSHOT_DIR, "06-untouched-map-live-table.png") });

  // ── 9. A full palette swatch: all eight real ground types side by side,
  //       one map, for a single at-a-glance visual confirmation of every
  //       chosen color (not a correctness check — steps 1-8 already proved
  //       correctness; this is purely for the report's screenshots). ──
  const REAL_GROUND_TYPES = ["grass", "rock", "forest", "dense_forest", "path", "sand", "swamp", "stone"];
  const PALETTE_COLS = 4;
  const paletteMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: paletteMapId,
    campaign_id: campaignId,
    name: "Ground palette swatch",
    grid_width: PALETTE_COLS,
    grid_height: Math.ceil(REAL_GROUND_TYPES.length / PALETTE_COLS),
  });
  await admin.from("map_cells").upsert(
    REAL_GROUND_TYPES.map((groundType, i) => ({
      map_id: paletteMapId,
      x: i % PALETTE_COLS,
      y: Math.floor(i / PALETTE_COLS),
      elevation: 0,
      terrain_type: "normal",
      light_level: "bright",
      ground_type: groundType,
    })),
    { onConflict: "map_id,x,y" }
  );
  const paletteEditorPage = await dmContext.newPage();
  await paletteEditorPage.setViewportSize({ width: 1400, height: 900 });
  await paletteEditorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${paletteMapId}/edit`);
  await paletteEditorPage.waitForSelector('[data-testid="editor-surface-state"]', {
    state: "attached",
    timeout: 60000,
  });
  const paletteMirror = await readMirror(paletteEditorPage, "editor-surface-state");
  check(
    "the palette swatch map carries all eight real ground types",
    REAL_GROUND_TYPES.every(
      (type, i) => paletteMirror.groundByCell[`${i % PALETTE_COLS},${Math.floor(i / PALETTE_COLS)}`] === type
    ),
    JSON.stringify(paletteMirror.groundByCell)
  );
  await sleep(300);
  await paletteEditorPage.screenshot({ path: join(SCREENSHOT_DIR, "07-full-palette-editor.png") });

  await admin.from("campaigns").update({ live_map: paletteMapId }).eq("id", campaignId);
  await roomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await roomPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await angleCameraOverTable(roomPage);
  await roomPage.screenshot({ path: join(SCREENSHOT_DIR, "08-full-palette-live-table.png") });
} finally {
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
console.log(`\nAll ground-types checks passed. Screenshots saved to ${SCREENSHOT_DIR}`);
process.exit(0);
