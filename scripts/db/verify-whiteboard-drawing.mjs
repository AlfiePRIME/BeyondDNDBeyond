#!/usr/bin/env node
// Whiteboard drawing layer verification (docs/design/whiteboard-drawing-layer.md,
// Prompt 2 — rendering, toolset, draw-mode UI, and undo/redo; persistence
// and cross-client sync are explicitly a LATER prompt, so this script never
// reloads a page expecting a drawing to survive it, and never asserts
// anything about map_whiteboard_tiles or any other database table for the
// drawing itself).
//
// Real signed-in Playwright browsers throughout (a DM and a player, Alice),
// against a live room — the WebGL canvas has no DOM to inspect, so every
// whiteboard assertion reads the hidden [data-testid="whiteboard-state"]
// render-state mirror GameRoom exposes (WhiteboardPlane's own onHistoryChange/
// onDebug/onCenterProjectedPosition callbacks, mirrored — the
// onTokenSlideDebug/onOwnChairProjectedPosition precedent), while the actual
// gestures are real mouse drags on the canvas at the REAL projected screen
// point the mirror hands back (onCenterProjectedPosition), not a blind scan.
//
// Covers: draw mode toggles via the new MapPanel glyph and only THEN shows
// the pen/eraser/color/height/undo/redo toolbar; a real freehand drag draws
// with the selected color (real screenshots); switching to the eraser and
// dragging over the same ink genuinely deletes it from the sparse per-cell
// tile store (not a paint-over — tileCount drops to 0 and the touched cell's
// key disappears entirely); Clear wipes everything and is itself undoable;
// Undo/Redo restore and re-remove the cleared ink, with the mirrored
// canUndo/canRedo flags tracking each step exactly; the height slider both
// updates its own reported value AND genuinely moves the plane in 3D space
// (the projected center's own screen Y shifts); and — the single highest-risk
// regression this prompt's own Notes call out — with draw mode toggled back
// OFF, the SAME DM client's ordinary token-move gesture (TokenPanel's arm/
// move flow, a plain map-cell click) still works exactly as before, and a
// totally different player's chair-drag gesture (a different continuous-drag
// pointer system, exercised on a client that never had whiteboard
// interactivity at all) is completely unaffected by the whiteboard's
// always-mounted, non-interactive visual plane having been present in the
// scene the whole time.
//
// Needs the local Supabase stack. Starts (or reuses) its own dev server on a
// dedicated port (this host runs several worktrees/agents side by side and
// :3000 is already bound to an unrelated build) — the verify-ground-types.mjs/
// verify-water-terrain.mjs convention.
// Usage: node scripts/db/verify-whiteboard-drawing.mjs
//
// Real screenshots are saved to the scratchpad directory below at each
// meaningful rendering checkpoint.

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3461;
const APP_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/whiteboard-screenshots";
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
  const email = `whiteboard-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Whiteboard ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

const whiteboardState = (page) => readMirror(page, "whiteboard-state");

/** Polls a mirror until `predicate` is true or `timeoutMs` elapses — drawing
 * a stroke, a broadcast, or a debounced React state update is never
 * instant. Returns the last-read value either way, so a timed-out caller
 * still has a useful detail string. */
async function waitFor(readState, predicate, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let last = await readState();
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await readState();
  }
  return last;
}

/** The blind-aim workaround for WebGL scenes (verify-void-terrain.mjs's own
 * scanClick) — used only for the token-move regression check, where (unlike
 * the whiteboard plane) there's no per-frame projected-point mirror to read
 * a real click target from directly. */
async function scanGridClick(page, done, opts = {}) {
  const { xFrom = 0.2, xTo = 0.85, yFrom = 0.25, yTo = 0.7, step = 34, settleMs = 160 } = opts;
  const box = await page.locator("canvas").boundingBox();
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
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) return point;
    }
  }
  return null;
}

/** Sets a native input's value via its own prototype setter (bypassing
 * React's own onChange-only listening) then dispatches real "input"/"change"
 * events — the standard, reliable way to programmatically drive a
 * React-controlled `<input type="color">`/`<input type="range">` from
 * outside React; Playwright's own `.fill()` is documented for ordinary text
 * inputs, not these two. */
async function setNativeInputValue(page, selector, value) {
  await page.evaluate(
    ({ selector, value }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no element for ${selector}`);
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!setter) throw new Error(`no native value setter for ${selector}`);
      setter.call(el, String(value));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { selector, value }
  );
}

/** A proven-reliable freehand path, relative to a center point — spanning
 * enough screen distance (up to ~70/±30px) to reliably land real drawn ink
 * regardless of exactly how large the whiteboard plane's own on-screen
 * footprint happens to render at (discovered empirically: a much smaller,
 * ~20-40px-radius zigzag intermittently missed the plane's own hit-mesh
 * entirely at this map's real on-screen size/camera angle, while this
 * larger pattern consistently lands). Reused verbatim for every drawn
 * stroke in this script — including the eraser's own pass, which needs the
 * EXACT same centerline the pen drew (not just "roughly the same area") to
 * guarantee full coverage, since ERASER_WIDTH_CELLS > PEN_WIDTH_CELLS makes
 * retracing it a strict superset of every touched pixel. */
function strokeAround(center) {
  return [
    { x: center.x - 60, y: center.y - 20 },
    { x: center.x - 20, y: center.y + 30 },
    { x: center.x + 30, y: center.y - 25 },
    { x: center.x + 70, y: center.y + 25 },
  ];
}

async function dragStroke(page, points) {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 8 });
  }
  await page.mouse.up();
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Whiteboard test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Whiteboard arena",
    grid_width: 6,
    grid_height: 6,
  });

  const tokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: tokenId,
    map_id: mapId,
    npc_name: "Whiteboard Goblin",
    x: 1,
    y: 1,
    elevation: 0,
    allegiance: "hostile",
  });

  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const dmContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();

  const aliceContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();

  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="whiteboard-state"]', { state: "attached", timeout: 60000 });
    await page.waitForSelector('[data-testid="token-panel"]', { timeout: 30000 });
  }
  await Promise.all([loadRoom(dmPage), loadRoom(alicePage)]);
  // Let both rooms' realtime subscriptions and first WebGL frames settle.
  await sleep(1500);

  // ── 1. Draw mode starts off, and the toolbar (beyond the toggle itself)
  //    is entirely absent until it's turned on. ──
  const initial = await whiteboardState(dmPage);
  check("draw mode starts off for the DM", initial.drawMode === false, JSON.stringify(initial));
  check(
    "the pen/eraser toolbar isn't rendered at all while draw mode is off",
    !(await dmPage.locator('[data-testid="whiteboard-tool-pen"]').isVisible().catch(() => false))
  );
  check(
    "a player never sees the draw-mode toggle at all (DM-only control)",
    !(await alicePage.locator('[data-testid="whiteboard-draw-toggle"]').isVisible().catch(() => false))
  );

  // ── 2. Toggle draw mode on — the toolbar appears, and the plane's own
  //    projected center becomes available as a real click target. ──
  await dmPage.click('[data-testid="whiteboard-draw-toggle"]');
  const afterToggleOn = await waitFor(() => whiteboardState(dmPage), (s) => s.drawMode === true);
  check("clicking the glyph turns draw mode on", afterToggleOn.drawMode === true, JSON.stringify(afterToggleOn));
  check(
    "the toolbar (pen/eraser/color/height/undo/redo/clear) appears once draw mode is on",
    await dmPage.locator('[data-testid="whiteboard-tool-pen"]').isVisible()
  );

  const withCenter = await waitFor(() => whiteboardState(dmPage), (s) => s.centerScreenPoint !== null, 5000);
  check(
    "the plane's own world-space center projects to a real on-screen point (sized correctly enough to be on-screen at all)",
    withCenter.centerScreenPoint !== null,
    JSON.stringify(withCenter)
  );

  const dmCanvasBox = await dmPage.locator("canvas").boundingBox();
  const centerAbs = (state) => ({
    x: dmCanvasBox.x + state.centerScreenPoint[0],
    y: dmCanvasBox.y + state.centerScreenPoint[1],
  });
  let center = centerAbs(withCenter);

  // ── 3. Pick a vivid, distinctive ink color, then draw a real freehand
  //    line — a multi-point drag, not a single click. This exact point
  //    path is reused verbatim for the eraser drag below: the actual
  //    on-screen size of a small map at a normal seated camera distance is
  //    only a few dozen pixels wide (a real, discovered constraint, not
  //    assumed), so "roughly the same area" in screen-pixel offsets isn't
  //    reliable at that scale — retracing the IDENTICAL centerline with a
  //    wider brush (ERASER_WIDTH_CELLS > PEN_WIDTH_CELLS) is, by
  //    construction, a strict superset of every pixel the pen touched,
  //    regardless of how large the map happens to render on screen. ──
  const INK_COLOR = "#39ff14";
  await setNativeInputValue(dmPage, '[data-testid="whiteboard-color-picker"]', INK_COLOR);
  const afterColor = await waitFor(() => whiteboardState(dmPage), (s) => s.color === INK_COLOR);
  check("the color picker updates the reported ink color", afterColor.color === INK_COLOR, JSON.stringify(afterColor));

  const strokePoints = strokeAround(center);
  await dragStroke(dmPage, strokePoints);
  const afterDraw = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount > 0);
  check(
    "a real freehand drag leaves ink behind — the per-cell tile store is non-empty",
    afterDraw.tileCount > 0,
    JSON.stringify(afterDraw)
  );
  check(
    "drawing pushes a real undo entry",
    afterDraw.canUndo === true && afterDraw.canRedo === false,
    JSON.stringify(afterDraw)
  );
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "01-drawn-stroke.png") });

  // ── 4. The eraser is a REAL destination-out compositing operation: the
  //    touched cell's own tile disappears from the sparse store entirely,
  //    not just repainted a different color. ──
  const drawnTileKeys = afterDraw.tileKeys;
  await dmPage.click('[data-testid="whiteboard-tool-eraser"]');
  const afterEraserTool = await whiteboardState(dmPage);
  check("switching to the eraser is reflected in the mirror", afterEraserTool.tool === "eraser");
  await dragStroke(dmPage, strokePoints);
  const afterErase = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount === 0);
  check(
    "erasing over the same ink genuinely removes it — the tile store is empty again, not just recolored",
    afterErase.tileCount === 0 && !drawnTileKeys.some((key) => afterErase.tileKeys.includes(key)),
    JSON.stringify({ before: drawnTileKeys, after: afterErase.tileKeys })
  );
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "02-erased.png") });

  // ── 5. Clear, then Undo/Redo — kept as this feature's OWN separate
  //    stack (never the map editor's). ──
  await dmPage.click('[data-testid="whiteboard-tool-pen"]');
  await dragStroke(dmPage, strokePoints);
  const beforeClear = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount > 0);
  check("a fresh stroke before the clear test leaves real ink", beforeClear.tileCount > 0, JSON.stringify(beforeClear));

  await dmPage.click('[data-testid="whiteboard-clear"]');
  const afterClear = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount === 0);
  check("Clear wipes every tile", afterClear.tileCount === 0, JSON.stringify(afterClear));
  check("Clear itself is undoable", afterClear.canUndo === true, JSON.stringify(afterClear));

  await dmPage.click('[data-testid="whiteboard-undo"]');
  const afterUndo = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount > 0);
  check(
    "Undo restores exactly what Clear wiped",
    afterUndo.tileCount === beforeClear.tileCount &&
      beforeClear.tileKeys.every((key) => afterUndo.tileKeys.includes(key)),
    JSON.stringify({ before: beforeClear, afterUndo })
  );
  check("Undo enables Redo", afterUndo.canRedo === true, JSON.stringify(afterUndo));

  await dmPage.click('[data-testid="whiteboard-redo"]');
  const afterRedo = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount === 0);
  check("Redo re-applies the clear", afterRedo.tileCount === 0, JSON.stringify(afterRedo));
  check(
    "Redo exhausts the redo stack but leaves one more undo step available",
    afterRedo.canRedo === false && afterRedo.canUndo === true,
    JSON.stringify(afterRedo)
  );

  // ── 6. Height slider: updates its own reported value AND genuinely moves
  //    the plane (its projected screen point shifts), not just a label. ──
  const beforeHeight = await whiteboardState(dmPage);
  check("the height starts at the documented default", beforeHeight.height === 1.2, JSON.stringify(beforeHeight));
  const screenBeforeHeightChange = beforeHeight.centerScreenPoint;
  // A modest raise (not the max) — large enough to shift the projected
  // point by a confidently-measurable amount, small enough to keep that
  // point safely on screen (a real, discovered constraint: MAX_WHITEBOARD_HEIGHT
  // pushes the plane's center off the TOP of the canvas entirely at this
  // map's real camera distance, which would make the "draw at the new
  // height" check below meaningless — nothing to click on).
  await setNativeInputValue(dmPage, '[data-testid="whiteboard-height-slider"]', 1.8);
  const afterHeight = await waitFor(() => whiteboardState(dmPage), (s) => s.height === 1.8);
  check("the height slider updates the reported height", afterHeight.height === 1.8, JSON.stringify(afterHeight));
  const screenAfterHeightChange = await waitFor(
    () => whiteboardState(dmPage),
    (s) => s.centerScreenPoint !== null && Math.abs(s.centerScreenPoint[1] - screenBeforeHeightChange[1]) > 4
  );
  check(
    "raising the height genuinely moves the plane in 3D space — its own projected screen point shifts, not just a UI label",
    Math.abs(screenAfterHeightChange.centerScreenPoint[1] - screenBeforeHeightChange[1]) > 4,
    JSON.stringify({ before: screenBeforeHeightChange, after: screenAfterHeightChange.centerScreenPoint })
  );

  // One more stroke at the NEW height, for the final "annotation on a real
  // map" screenshot — proves drawing still works correctly after adjusting
  // height, not just before.
  center = centerAbs(screenAfterHeightChange);
  await dragStroke(dmPage, strokeAround(center));
  const afterHeightDraw = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount > 0);
  check(
    "drawing still works correctly after adjusting the height, at the new position",
    afterHeightDraw.tileCount > 0,
    JSON.stringify(afterHeightDraw)
  );
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "03-drawn-at-adjusted-height.png") });

  // ── 7. THE key regression check: toggle draw mode back OFF on the SAME
  //    DM client that was just drawing, and confirm ordinary map-cell
  //    interaction (TokenPanel's arm/move flow) still works exactly as
  //    before — not just in principle (the hit-plane unmounts), but for
  //    real, on the exact client that just had it mounted. ──
  await dmPage.click('[data-testid="whiteboard-draw-toggle"]');
  const afterToggleOff = await waitFor(() => whiteboardState(dmPage), (s) => s.drawMode === false);
  check("draw mode turns back off", afterToggleOff.drawMode === false, JSON.stringify(afterToggleOff));
  check(
    "the toolbar disappears again once draw mode is off",
    !(await dmPage.locator('[data-testid="whiteboard-tool-pen"]').isVisible().catch(() => false))
  );

  const tokenBefore = await admin.from("map_tokens").select().eq("id", tokenId).single();
  await dmPage.click(`[data-testid="move-token-${tokenId}"]`);
  const moved = await scanGridClick(dmPage, async () => {
    const { data } = await admin.from("map_tokens").select().eq("id", tokenId).single();
    return data.x !== tokenBefore.data.x || data.y !== tokenBefore.data.y;
  });
  const tokenAfter = await admin.from("map_tokens").select().eq("id", tokenId).single();
  check(
    "with draw mode off, the DM's own ordinary token-move gesture (a plain map-cell click) still works exactly as before",
    moved !== null && (tokenAfter.data.x !== tokenBefore.data.x || tokenAfter.data.y !== tokenBefore.data.y),
    JSON.stringify({ before: tokenBefore.data, after: tokenAfter.data })
  );

  // ── 8. Broad regression, a SEPARATE client and a SEPARATE continuous-drag
  //    pointer system: Alice's chair-drag, which was never gated by draw
  //    mode at all — proving the whiteboard's always-mounted, non-
  //    interactive visual plane (present in Alice's scene the entire time
  //    since before her page ever loaded) has no effect on a totally
  //    different gesture. ──
  const aliceChairBefore = await readMirror(alicePage, "chair-drag-state");
  check(
    "Alice's own draggable chair has a real projected screen point",
    aliceChairBefore.ownChairScreen !== null,
    JSON.stringify(aliceChairBefore)
  );
  const aliceSeatsBefore = (await readMirror(alicePage, "seat-layout-state")).seats;
  const aliceSeatBefore = aliceSeatsBefore.find((seat) => seat.userId === alice.id);
  const aliceCanvasBox = await alicePage.locator("canvas").boundingBox();
  const aliceChairScreen = {
    x: aliceCanvasBox.x + aliceChairBefore.ownChairScreen[0],
    y: aliceCanvasBox.y + aliceChairBefore.ownChairScreen[1],
  };
  await alicePage.mouse.move(aliceChairScreen.x, aliceChairScreen.y);
  await alicePage.mouse.down();
  await alicePage.mouse.move(aliceChairScreen.x + 70, aliceChairScreen.y + 40, { steps: 10 });
  await alicePage.mouse.move(aliceChairScreen.x + 110, aliceChairScreen.y + 10, { steps: 10 });
  await alicePage.mouse.up();
  await sleep(500);
  const aliceSeatsAfter = (await readMirror(alicePage, "seat-layout-state")).seats;
  const aliceSeatAfter = aliceSeatsAfter.find((seat) => seat.userId === alice.id);
  const seatMoved =
    Math.abs(aliceSeatAfter.position[0] - aliceSeatBefore.position[0]) > 0.05 ||
    Math.abs(aliceSeatAfter.position[2] - aliceSeatBefore.position[2]) > 0.05;
  check(
    "a completely different player's chair-drag gesture is unaffected by the whiteboard's ever-present visual plane",
    seatMoved,
    JSON.stringify({ before: aliceSeatBefore, after: aliceSeatAfter })
  );

  // ── 9. A final wide screenshot, free camera, for the report. ──
  await dmPage.bringToFront();
  await dmPage.click('[data-testid="camera-mode-toggle"]');
  await sleep(400);
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "04-wide-overview-free-camera.png") });
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
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
console.log("\nAll whiteboard drawing checks passed.");
process.exit(0);
