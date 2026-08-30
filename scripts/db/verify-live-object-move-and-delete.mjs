#!/usr/bin/env node
// "It is not easy to move objects or place them mid game, please look into
// this" — the project owner's own bug report. Two gaps this closes, both
// confirmed by inspection before writing this script:
//   1. Arming an asset for live placement (LiveObjectsPanel) had ZERO visual
//      preview — the armed asset id was tracked in state but never rendered
//      anywhere in the 3D scene, so the DM got no on-map feedback of where
//      the object would land until the click already committed.
//   2. Repositioning or deleting a live-placed object required leaving to
//      the separate Map Editor — updateMapObject was only ever called from
//      the room with revealed_to_players/tag patches (never x/y), and
//      deleteMapObject was never reachable from the room's own UI at all.
//
// The fix reuses the chair-drag/DM-tray-drag gestures' own proven shape
// (GameTableScene.tsx: floorPointFromClientXY raycast, a drag-session ref,
// an invisible oversized grab handle) generalized from a continuous (x, z)
// target to a GRID CELL target, plus a new moveMapObject data-access
// function and a plain Delete button on LiveObjectsPanel's existing
// per-object editor.
//
// Covers, all through the real Game Room UI:
//   1. Placement preview: hovering the map while an asset is armed (no
//      press) reports a live target CELL (live-object-drag-state's own
//      previewCell mirror) — and clicking commits EXACTLY at whatever cell
//      was last hovered, proving the preview accurately predicts the
//      outcome, not just that it renders SOMETHING.
//   2. Move-drag: a real grab-move-release gesture on a live-placed object
//      (no trip to the Map Editor) persists its new cell, with a live mid-
//      drag ghost-cell mirror proving continuous tracking, not a single
//      teleport on release.
//   3. The move genuinely reaches a second, already-connected client
//      (alice, who never reloads) once the object is revealed.
//   4. Invalid drops fail safe: dropping onto a void cell, and dropping onto
//      a cell another object already occupies, both leave the dragged
//      object's row byte-for-byte unchanged and surface a visible error —
//      never a silent no-op, never a corrupted position.
//   5. Delete: LiveObjectsPanel's new Delete button removes the row for
//      real (deleteMapObject, previously only reachable from the Map
//      Editor), closes the DM's own editor if it was open for that object,
//      and reaches a second, already-connected client live (an interactive
//      entry alice could already see disappears with no reload).
//   6. DM-only gating regression: a player's client never has a draggable
//      object or an active placement preview, in any state this script
//      puts the DM through.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its own port isn't already serving.
// Usage: node scripts/db/verify-live-object-move-and-delete.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port — this machine runs several concurrent agent
// worktrees, each potentially squatting on common ports with their OWN
// checkout's dev server (verify-live-object-reveal.mjs's own reasoning).
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 51342);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

const CHEST_PRESET_ID = "a55e7002-0000-4000-8000-000000000002";
const ROCK_PRESET_ID = "a55e7006-0000-4000-8000-000000000006";

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
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

// verify-live-object-reveal.mjs's own precedent: collapse every floating
// Game Room panel not needed by name — map/liveObjects stay expanded (this
// script needs the map panel's own interactive-entries list and
// LiveObjectsPanel itself).
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
  combat: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `live-object-move-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Live Object Move ${label}`,
    ui_preferences: { panelLayout: COLLAPSED_PANEL_LAYOUT },
  });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function isCanvasPoint(page, point) {
  return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS", [point.x, point.y]);
}


/** scanClick's own candidate-point generation, adapted from "click and check
 * a DB condition" to "hover (mouse.move only, no press) and check the LIVE
 * placement-preview mirror" — used only to prove the ghost tracks the
 * cursor BEFORE any commit, which scanClick's click-based shape can't
 * observe on its own. */
async function scanHover(page, done, opts = {}) {
  const { xFrom = 0.25, xTo = 0.75, yFrom = 0.3, yTo = 0.75, step = 24, settleMs = 90, label = "" } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  const points = [];
  for (let y = box.y + box.height * yFrom; y <= box.y + box.height * yTo; y += step) {
    for (let x = box.x + box.width * xFrom; x <= box.x + box.width * xTo; x += step) {
      points.push({ x, y });
    }
  }
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.5;
  points.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
  for (const point of points) {
    if (!(await isCanvasPoint(page, point))) continue;
    await page.mouse.move(point.x, point.y);
    await sleep(settleMs);
    const result = await done(point);
    if (result) {
      console.log(`  scanHover${label ? ` (${label})` : ""}: found`);
      return { point, result };
    }
  }
  console.log(`  scanHover${label ? ` (${label})` : ""}: exhausted every candidate — not found`);
  return null;
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function dismissTurnCameraIfShown(page) {
  if (await isVisible(page, "turn-camera-dismiss")) {
    await page.click('[data-testid="turn-camera-dismiss"]');
    await sleep(300);
  }
}

async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

const dragState = (page) => readMirror(page, "live-object-drag-state");

async function mapObjectRow(objectId) {
  const { data, error } = await admin.from("map_objects").select().eq("id", objectId).maybeSingle();
  if (error) throw error;
  return data;
}

async function mapObjectsFor(mapId) {
  const { data, error } = await admin.from("map_objects").select().eq("map_id", mapId);
  if (error) throw error;
  return data ?? [];
}

async function upsertCells(rows) {
  const { error } = await admin
    .from("map_cells")
    .upsert(rows.map((row) => ({ ground_type: "default", water_flow_direction: null, ...row })), {
      onConflict: "map_id,x,y",
    });
  if (error) throw new Error(`upserting map_cells failed: ${error.message}`);
}

/** Drags from `start` (canvas-relative CSS pixels, already found via the
 * dragHandleScreen mirror — GameTableScene.tsx's onObjectDragHandleProjectedPosition)
 * by a fixed pixel delta, using the SAME multi-step page.mouse precedent
 * verify-dm-tray-drag.mjs already established for a WebGL drag gesture
 * (never a plain .click()). Returns the drag-state mirror read mid-gesture
 * (mouse still down) so a caller can assert on the LIVE preview cell before
 * releasing. */
async function dragBy(page, start, dx, dy, { steps = 8, stepDelayMs = 40 } = {}) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await sleep(80);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(start.x + dx * t, start.y + dy * t, { steps: 2 });
    await sleep(stepDelayMs);
  }
  await sleep(150);
  const midDrag = await dragState(page);
  return midDrag;
}

async function release(page) {
  await page.mouse.up();
  await sleep(300);
}

/** Searches a small grid of nearby start points for the real grab handle —
 * verify-dm-tray-drag.mjs's own "a press has to land inside the object's
 * comparatively small WebGL hit box" precedent, in case the projected
 * center point is a few pixels off the actual raycast-hit region. */
async function grabAndDrag(page, canvasBox, screen, dx, dy, opts) {
  const searchOffsets = [
    [0, 0],
    [10, 0], [-10, 0], [0, 10], [0, -10],
    [20, 0], [-20, 0], [0, 20], [0, -20],
  ];
  for (const [ox, oy] of searchOffsets) {
    const start = { x: canvasBox.x + screen[0] + ox, y: canvasBox.y + screen[1] + oy };
    const before = await dragState(page);
    const mid = await dragBy(page, start, dx, dy, opts);
    const moved = mid.previewCell && (!before.previewCell || mid.previewCell.x !== before.previewCell.x || mid.previewCell.y !== before.previewCell.y);
    if (!moved) {
      await release(page);
      continue;
    }
    return { start, mid };
  }
  await page.mouse.up().catch(() => {});
  return null;
}

/** For the invalid-drop rejection tests (a minimal 2-cell map with exactly
 * ONE other real cell to aim at): screen-drag direction doesn't reliably
 * map to a specific grid axis (depends on the current camera framing), so
 * this tries several directions, using the LIVE previewCell mirror mid-drag
 * (never a guess) to confirm the ghost is actually over `targetCell` — then
 * RELEASES there (a real committed drop attempt, not just a hover), so the
 * caller's next read of the database/error mirror reflects GameRoom.tsx's
 * real rejection path. Returns whether the target was ever actually
 * reached; a caller should treat `false` as "this attempt proves nothing"
 * rather than a passing rejection check. */
async function dragUntilPreviewCellIs(page, canvasBox, screen, targetCell) {
  // The grab handle's own projected point can legitimately land underneath
  // a real DOM toolbar button (a 2-cell map's own object can project very
  // close to a screen edge, depending on camera framing) — confirmed by
  // direct inspection while authoring this script (a real `ruler-toggle`
  // button, not a WebGL element, was sitting exactly on the projected
  // point for one of these tiny maps). The grab handle's own hit box is
  // deliberately oversized (OBJECT_DRAG_HANDLE_OVERSIZE) for exactly this
  // kind of imprecision, so search a small neighborhood — the
  // grabAndDrag/verify-dm-tray-drag.mjs searchOffsets precedent — for a
  // point that's actually over the canvas before starting the drag.
  const searchOffsets = [
    [0, 0],
    [0, 60], [0, 100], [0, -60],
    [15, 0], [-15, 0], [30, 0], [-30, 0],
  ];
  let start = null;
  for (const [ox, oy] of searchOffsets) {
    const candidate = { x: canvasBox.x + screen[0] + ox, y: canvasBox.y + screen[1] + oy };
    if (await isCanvasPoint(page, candidate)) {
      start = candidate;
      break;
    }
  }
  if (!start) return false;

  // A 2-cell map fits the SAME fixed physical table surface as any other
  // grid (mapFit.ts's computeTableMapMetrics) — fewer columns means a
  // LARGER cellSize, so crossing from one cell to the other can require far
  // more screen pixels than a denser grid would. Escalating magnitudes
  // (rather than one fixed distance) covers both cases without needing to
  // know the real cellSize/camera distance up front.
  for (const magnitude of [220, 500, 900]) {
    const directions = [
      [magnitude, 0], [-magnitude, 0], [0, magnitude], [0, -magnitude],
      [magnitude, magnitude], [-magnitude, -magnitude], [magnitude, -magnitude], [-magnitude, magnitude],
    ];
    for (const [dx, dy] of directions) {
      const mid = await dragBy(page, start, dx, dy, { steps: 12 });
      if (mid.previewCell && mid.previewCell.x === targetCell.x && mid.previewCell.y === targetCell.y) {
        await release(page);
        return true;
      }
      await release(page);
    }
  }
  return false;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Live object move/delete test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // ════════════════════════════════════════════════════════════════════
  // Map A — a fully open 5x5 grid (an ODD size, deliberately — an even grid
  // puts the canvas's own geometric screen-center exactly on a four-way
  // cell corner, the worst case for hover/click boundary precision; found
  // by direct inspection while authoring this script, not theoretical: the
  // scanHover-then-click sequence below intentionally favors near-center
  // candidates, the same way scanClick's own candidate ordering does).
  // Used for placement preview, move-drag, cross-client broadcast, and
  // delete.
  // ════════════════════════════════════════════════════════════════════
  const mapAId = crypto.randomUUID();
  const GRID = 5;
  await admin.from("campaign_maps").insert({
    id: mapAId,
    campaign_id: campaignId,
    name: "Live object move — open room",
    grid_width: GRID,
    grid_height: GRID,
  });
  const cellsA = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      cellsA.push({ map_id: mapAId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright" });
    }
  }
  await upsertCells(cellsA);

  // ════════════════════════════════════════════════════════════════════
  // Map B — a minimal 2x1 grid, cell (0,0) real, cell (1,0) VOID, with one
  // object already sitting at (0,0) — the verify-standable-objects.mjs
  // "exactly one other real cell" precedent, so a drag toward the void
  // side has nowhere else to land, no scanning/matching needed.
  // ════════════════════════════════════════════════════════════════════
  const mapBId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapBId,
    campaign_id: campaignId,
    name: "Live object move — void reject",
    grid_width: 2,
    grid_height: 1,
  });
  await upsertCells([{ map_id: mapBId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" }]);
  await admin.from("map_cells").upsert(
    { map_id: mapBId, x: 1, y: 0, elevation: 0, terrain_type: "void", light_level: "bright", ground_type: "default", water_flow_direction: null },
    { onConflict: "map_id,x,y" }
  );
  const { data: voidTestObj } = await admin
    .from("map_objects")
    .insert({ map_id: mapBId, asset_id: ROCK_PRESET_ID, x: 0, y: 0, elevation: 0, rotation: 0, revealed_to_players: true })
    .select()
    .single();

  // ════════════════════════════════════════════════════════════════════
  // Map C — a minimal 2x1 grid, BOTH cells real, one object at each — the
  // occupied-cell rejection: dragging the (0,0) object toward (1,0) has
  // nowhere else to land but the other object's own cell.
  // ════════════════════════════════════════════════════════════════════
  const mapCId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapCId,
    campaign_id: campaignId,
    name: "Live object move — occupied reject",
    grid_width: 2,
    grid_height: 1,
  });
  await upsertCells([
    { map_id: mapCId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
    { map_id: mapCId, x: 1, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
  ]);
  const { data: occupiedMoverObj } = await admin
    .from("map_objects")
    .insert({ map_id: mapCId, asset_id: ROCK_PRESET_ID, x: 0, y: 0, elevation: 0, rotation: 0, revealed_to_players: true })
    .select()
    .single();
  const { data: occupiedBlockerObj } = await admin
    .from("map_objects")
    .insert({ map_id: mapCId, asset_id: CHEST_PRESET_ID, x: 1, y: 0, elevation: 0, rotation: 0, revealed_to_players: true })
    .select()
    .single();

  await admin.from("campaigns").update({ live_map: mapAId }).eq("id", campaignId);

  const pageErrors = [];
  const ROOM_VIEWPORT = { width: 1920, height: 1080 };

  const dmContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  dmPage.on("pageerror", (err) => pageErrors.push(String(err)));

  const aliceContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  alicePage.on("pageerror", (err) => pageErrors.push(String(err)));

  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
    await dismissTurnCameraIfShown(page);
    await sleep(800);
  }

  await loadRoom(dmPage);
  await loadRoom(alicePage);

  // ════════════════════════════════════════════════════════════════════
  // Phase 0 — DM-only gating baseline: a player's client never has a
  // draggable object or an active placement preview before the DM does
  // anything at all.
  // ════════════════════════════════════════════════════════════════════
  const aliceBaseline = await dragState(alicePage);
  check(
    "a player's client starts with no draggable-object grab handle and no placement preview",
    aliceBaseline.dragHandleScreen === null && aliceBaseline.previewCell === null,
    JSON.stringify(aliceBaseline)
  );
  check("the DM sees LiveObjectsPanel", await isVisible(dmPage, "live-object-panel"));
  check("a player's client never mounts LiveObjectsPanel at all", !(await isVisible(alicePage, "live-object-panel")));

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — Placement preview: arm a Chest, hover (no press) until the
  // ghost reports a target cell, screenshot it, then commit by clicking
  // that EXACT point — proving the preview accurately predicts where the
  // click will actually place the object, not just that something renders.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.click('[data-testid="live-object-add-toggle"]');
  await pollUntil(() => isVisible(dmPage, `live-object-asset-${CHEST_PRESET_ID}`));
  await dmPage.click(`[data-testid="live-object-asset-${CHEST_PRESET_ID}"]`);
  check(
    "picking an asset arms placement and shows the placement hint",
    await pollUntil(() => isVisible(dmPage, "live-object-placement-hint"))
  );

  let placedObjectId = null;
  const hoverResult = await scanHover(
    dmPage,
    async () => {
      const state = await dragState(dmPage);
      return state.previewCell ? state.previewCell : null;
    },
    { label: "placement preview hover" }
  );
  check("hovering the map while an asset is armed reports a live placement-preview target cell", hoverResult !== null);

  if (hoverResult) {
    await dmPage.screenshot({ path: join(SCRATCH_DIR, "live-object-placement-preview.png") });
    console.log(`screenshot (placement preview ghost): ${join(SCRATCH_DIR, "live-object-placement-preview.png")}`);

    const expectedCell = hoverResult.result;
    await dmPage.mouse.click(hoverResult.point.x, hoverResult.point.y);
    const placed = await pollUntil(async () => {
      const rows = await mapObjectsFor(mapAId);
      const fresh = rows.find((row) => row.asset_id === CHEST_PRESET_ID);
      return fresh ?? null;
    });
    check(
      "clicking the exact hovered point places the object AT the previewed cell — the ghost accurately predicted the outcome",
      placed !== null && placed.x === expectedCell.x && placed.y === expectedCell.y,
      JSON.stringify({ expectedCell, placed })
    );
    check(
      "the placement-preview target clears once placement is committed",
      await pollUntil(async () => {
        const state = await dragState(dmPage);
        return state.previewCell === null ? true : null;
      })
    );

    placedObjectId = placed?.id ?? null;
  }

  check("no invalid object landed anywhere unexpected — exactly one Chest exists on the open map", (await mapObjectsFor(mapAId)).filter((r) => r.asset_id === CHEST_PRESET_ID).length === 1);

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — Move-drag: handlePlaceLiveObject auto-selected the freshly-
  // placed object for editing, so it should already be draggable with no
  // extra click.
  // ════════════════════════════════════════════════════════════════════
  let objectId = placedObjectId;
  if (!objectId) {
    // Placement preview's own scan didn't land (should not happen on a
    // fully open 4x4 grid, but fail forward rather than cascade every
    // remaining check into false negatives): fall back to a direct DB
    // placement so Phase 2+ can still run for real.
    const { data: fallback } = await admin
      .from("map_objects")
      .insert({ map_id: mapAId, asset_id: CHEST_PRESET_ID, x: 1, y: 1, elevation: 0, rotation: 0, revealed_to_players: false })
      .select()
      .single();
    objectId = fallback.id;
    await dmPage.selectOption('[data-testid="live-object-select"]', objectId);
  }

  const handleState = await pollUntil(async () => {
    const state = await dragState(dmPage);
    return state.dragHandleScreen ? state : null;
  });
  check(
    "the selected-for-editing object has a live grab-handle screen projection (a Playwright drag has a real pixel to press on)",
    handleState !== null,
    JSON.stringify(handleState)
  );

  check(
    "LiveObjectsPanel surfaces a hint that the selected object can be dragged on the map",
    await isVisible(dmPage, "live-object-move-hint")
  );

  const objectBeforeMove = await mapObjectRow(objectId);
  const canvasBox = await dmPage.locator("canvas").boundingBox();

  let moveResult = null;
  if (handleState) {
    moveResult = await grabAndDrag(dmPage, canvasBox, handleState.dragHandleScreen, 90, 60);
    check("the DM can grab and drag a live-placed object (a real gesture visibly moved the preview cell mid-drag)", moveResult !== null);
    if (moveResult) {
      await dmPage.screenshot({ path: join(SCRATCH_DIR, "live-object-move-mid-drag.png") });
      console.log(`screenshot (move-drag ghost mid-gesture): ${join(SCRATCH_DIR, "live-object-move-mid-drag.png")}`);
      const targetCell = moveResult.mid.previewCell;
      await release(dmPage);
      const moved = await pollUntil(async () => {
        const row = await mapObjectRow(objectId);
        return row.x === targetCell.x && row.y === targetCell.y ? row : null;
      });
      check(
        "releasing the drag persists the object at exactly the last-previewed cell",
        moved !== null,
        JSON.stringify({ targetCell, before: objectBeforeMove, after: await mapObjectRow(objectId) })
      );
      check(
        "the drag genuinely moved the object off its starting cell (not a rounding-error no-op)",
        moved && (moved.x !== objectBeforeMove.x || moved.y !== objectBeforeMove.y)
      );
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 3 — cross-client broadcast: reveal the object, then move it
  // again; alice's ALREADY-OPEN client (never reloaded) must see the new
  // position live.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.click(`[data-testid="live-object-reveal-${objectId}"]`);
  const revealed = await pollUntil(async () => {
    const row = await mapObjectRow(objectId);
    return row.revealed_to_players ? row : null;
  });
  check("the moved object can still be revealed to players", revealed !== null);

  const aliceReadBeforeSecondMove = await alice.client.from("map_objects").select().eq("id", objectId);
  check("alice's own client can read the revealed object directly", (aliceReadBeforeSecondMove.data ?? []).length === 1);

  const handleState2 = await pollUntil(async () => {
    const state = await dragState(dmPage);
    return state.dragHandleScreen ? state : null;
  });
  if (handleState2) {
    const secondMove = await grabAndDrag(dmPage, canvasBox, handleState2.dragHandleScreen, -70, 40);
    if (secondMove) {
      const targetCell2 = secondMove.mid.previewCell;
      await release(dmPage);
      const movedAgain = await pollUntil(async () => {
        const row = await mapObjectRow(objectId);
        return row.x === targetCell2.x && row.y === targetCell2.y ? row : null;
      });
      check("a second move-drag also persists correctly", movedAgain !== null, JSON.stringify({ targetCell2 }));

      const aliceSeesMove = await pollUntil(async () => {
        const { data } = await alice.client.from("map_objects").select().eq("id", objectId).maybeSingle();
        return data && data.x === targetCell2.x && data.y === targetCell2.y ? data : null;
      });
      check(
        "the move reaches a SECOND, already-connected client live (alice, who never reloaded) with no page reload",
        aliceSeesMove !== null,
        JSON.stringify(aliceSeesMove)
      );
    } else {
      check("a second move-drag could be performed", false, "grabAndDrag exhausted every search offset");
    }
  } else {
    check("the grab handle is still available after revealing", false);
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 4 — invalid drops fail safe: void cell (Map B) and an already-
  // occupied cell (Map C), each on its own minimal, fully-isolated map so
  // the drag direction alone determines the destination (no scanning).
  // ════════════════════════════════════════════════════════════════════
  await admin.from("campaigns").update({ live_map: mapBId }).eq("id", campaignId);
  await loadRoom(dmPage);
  await dmPage.selectOption('[data-testid="live-object-select"]', voidTestObj.id);
  const voidHandleState = await pollUntil(async () => {
    const state = await dragState(dmPage);
    return state.dragHandleScreen ? state : null;
  });
  check("the void-reject test object has a live grab handle", voidHandleState !== null, JSON.stringify(voidHandleState));

  if (voidHandleState) {
    const voidCanvasBox = await dmPage.locator("canvas").boundingBox();
    // A 2-cell map — the ONLY other real cell candidate is (1, 0), which is
    // void. dragUntilPreviewCellIs tries several directions (screen-drag
    // direction doesn't reliably map to a specific grid axis) and only
    // releases once the LIVE ghost mirror confirms it's actually over (1,0).
    const reachedVoidCell = await dragUntilPreviewCellIs(dmPage, voidCanvasBox, voidHandleState.dragHandleScreen, { x: 1, y: 0 });
    check("the drag can actually reach the void cell before releasing (a real attempt, not skipped)", reachedVoidCell);
    const afterVoidAttempt = await mapObjectRow(voidTestObj.id);
    check(
      "dropping onto a VOID cell leaves the object's row byte-for-byte unchanged",
      afterVoidAttempt.x === voidTestObj.x && afterVoidAttempt.y === voidTestObj.y,
      JSON.stringify({ before: voidTestObj, after: afterVoidAttempt })
    );
    const voidErrorState = await pollUntil(async () => {
      const state = await dragState(dmPage);
      return state.moveError ? state : null;
    });
    check(
      "a visible error surfaces for the rejected void-cell drop — never a silent no-op",
      voidErrorState !== null,
      JSON.stringify(voidErrorState)
    );
  }

  await admin.from("campaigns").update({ live_map: mapCId }).eq("id", campaignId);
  await loadRoom(dmPage);
  await dmPage.selectOption('[data-testid="live-object-select"]', occupiedMoverObj.id);
  const occupiedHandleState = await pollUntil(async () => {
    const state = await dragState(dmPage);
    return state.dragHandleScreen ? state : null;
  });
  check("the occupied-reject test object has a live grab handle", occupiedHandleState !== null, JSON.stringify(occupiedHandleState));

  if (occupiedHandleState) {
    const occCanvasBox = await dmPage.locator("canvas").boundingBox();
    // A 2-cell map — the ONLY other real cell candidate is (1, 0), already
    // occupied by occupiedBlockerObj.
    const reachedOccupiedCell = await dragUntilPreviewCellIs(dmPage, occCanvasBox, occupiedHandleState.dragHandleScreen, { x: 1, y: 0 });
    check("the drag can actually reach the occupied cell before releasing (a real attempt, not skipped)", reachedOccupiedCell);
    const afterOccupiedAttempt = await mapObjectRow(occupiedMoverObj.id);
    check(
      "dropping onto an ALREADY-OCCUPIED cell leaves the dragged object's row byte-for-byte unchanged",
      afterOccupiedAttempt.x === occupiedMoverObj.x && afterOccupiedAttempt.y === occupiedMoverObj.y,
      JSON.stringify({ before: occupiedMoverObj, after: afterOccupiedAttempt })
    );
    const blockerUnchanged = await mapObjectRow(occupiedBlockerObj.id);
    check(
      "the object already occupying that cell is completely undisturbed",
      blockerUnchanged.x === occupiedBlockerObj.x && blockerUnchanged.y === occupiedBlockerObj.y
    );
    const occupiedErrorState = await pollUntil(async () => {
      const state = await dragState(dmPage);
      return state.moveError ? state : null;
    });
    check(
      "a visible error surfaces for the rejected occupied-cell drop",
      occupiedErrorState !== null,
      JSON.stringify(occupiedErrorState)
    );
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 5 — Delete: give the object a trigger behavior + reveal it so
  // alice can already see it as an interactive entry, then delete it and
  // confirm it disappears for real (DB) and live (alice's own client, no
  // reload).
  // ════════════════════════════════════════════════════════════════════
  await admin.from("campaigns").update({ live_map: mapAId }).eq("id", campaignId);

  // Inserted BEFORE the reloads below, deliberately — a raw admin insert
  // has no live-sync path to an already-open client (no realtime INSERT
  // subscription exists for map_objects, only UPDATE — confirmed by
  // inspection while authoring this script), so it must already be in the
  // database by the time each page's own fresh initial fetch runs, exactly
  // like every other object this whole script places through the real UI.
  const { data: deleteTargetObj } = await admin
    .from("map_objects")
    .insert({
      map_id: mapAId,
      asset_id: ROCK_PRESET_ID,
      x: 3,
      y: 3,
      elevation: 0,
      rotation: 0,
      revealed_to_players: true,
      behavior_config: { action: "toggle_state", playerTriggerable: true, triggerOnStepOn: false, triggered: false },
    })
    .select()
    .single();

  await loadRoom(dmPage);
  await loadRoom(alicePage);

  check(
    "alice already sees the object as an interactive entry before it's deleted",
    await pollUntil(() => isVisible(alicePage, `interactive-${deleteTargetObj.id}`))
  );

  await dmPage.selectOption('[data-testid="live-object-select"]', deleteTargetObj.id);
  check("the editor opens for the object about to be deleted", await pollUntil(() => isVisible(dmPage, "behavior-action")));
  check("the Delete button is present in the per-object editor", await isVisible(dmPage, "live-object-delete"));

  await dmPage.click('[data-testid="live-object-delete"]');

  const deletedRow = await pollUntil(async () => ((await mapObjectRow(deleteTargetObj.id)) === null ? true : null));
  check("deleting the object actually removes the row from the database", deletedRow !== null);

  check(
    "the DM's own editor closes once its object is deleted (editingObjectId cleared)",
    await pollUntil(async () => !(await isVisible(dmPage, "behavior-action")))
  );

  check(
    "alice's ALREADY-OPEN client loses the interactive entry live, with no page reload",
    await pollUntil(async () => !(await isVisible(alicePage, `interactive-${deleteTargetObj.id}`)))
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 6 — DM-only gating, final regression sweep: after everything
  // above, a player's client STILL never has a draggable object or an
  // active placement preview.
  // ════════════════════════════════════════════════════════════════════
  const aliceFinal = await dragState(alicePage);
  check(
    "a player's client never gains a draggable-object grab handle or placement preview, throughout the entire DM session above",
    aliceFinal.dragHandleScreen === null && aliceFinal.previewCell === null,
    JSON.stringify(aliceFinal)
  );

  check("no uncaught page errors occurred", pageErrors.length === 0, pageErrors.join("\n"));
} finally {
  // Cleanup — this shared dev Supabase stack runs many concurrent
  // worktrees. Deleting the campaign CASCADEs its maps/objects/tokens
  // (campaign_maps.campaign_id, map_objects.map_id are both ON DELETE
  // CASCADE per their own FKs).
  await admin.from("campaigns").delete().eq("name", "Live object move/delete test").eq("creator", dm.id);
  await admin.auth.admin.deleteUser(dm.id).catch(() => {});
  await admin.auth.admin.deleteUser(alice.id).catch(() => {});
  await browser.close();
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
