#!/usr/bin/env node
// Whiteboard drawing layer verification (docs/design/whiteboard-drawing-layer.md).
// Prompt 2 shipped rendering/toolset/draw-mode UI/undo-redo, entirely local-
// state; Prompt 3 added real persistence (map_whiteboard_tiles, 0058) and
// cross-client sync (the live-tier stream + the persisted-tier broadcast,
// §5) on top — this script now covers both, extended rather than replaced
// (every Prompt 2 check below is unmodified; Prompt 3's own checks are new
// sections layered on top of the same DM+Alice session).
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
// Covers (Prompt 2): draw mode toggles via the new MapPanel glyph and only
// THEN shows the pen/eraser/color/height/undo/redo toolbar; a real freehand
// drag draws with the selected color (real screenshots); switching to the
// eraser and dragging over the same ink genuinely deletes it from the
// sparse per-cell tile store (not a paint-over — tileCount drops to 0 and
// the touched cell's key disappears entirely); Clear wipes everything and
// is itself undoable; Undo/Redo restore and re-remove the cleared ink, with
// the mirrored canUndo/canRedo flags tracking each step exactly; the height
// slider both updates its own reported value AND genuinely moves the plane
// in 3D space (the projected center's own screen Y shifts); and — the
// single highest-risk regression this prompt's own Notes call out — with
// draw mode toggled back OFF, the SAME DM client's ordinary token-move
// gesture (TokenPanel's arm/move flow, a plain map-cell click) still works
// exactly as before, and a totally different player's chair-drag gesture (a
// different continuous-drag pointer system, exercised on a client that
// never had whiteboard interactivity at all) is completely unaffected by
// the whiteboard's always-mounted, non-interactive visual plane having been
// present in the scene the whole time.
//
// Covers (Prompt 3, added by this extension): RLS rejects a non-DM's direct
// write against map_whiteboard_tiles, server-side, not just client-gated;
// a connected player sees the DM's ink appear WHILE a stroke is still in
// progress (the live tier), then converges to exactly the DM's own tiles
// once it completes (the persisted tier correcting/confirming it); a
// reload rebuilds the exact same drawing from map_whiteboard_tiles, not
// from any in-session cache; and a second map's own board is completely
// unaffected by the first map's drawing, verified with a real player
// independently viewing that second map (per the per-viewer map system)
// while the DM keeps drawing on the first, confirmed both in the client
// render and directly against the database.
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
// The verify-dm-tray-drag.mjs/verify-whiteboard-height.mjs convention — lets
// this script target an already-running dev server (this project's own
// single-dev-server-per-directory lock means only one `next dev` can ever
// bind here at a time, which matters on a shared checkout with another
// agent's own server already up) instead of always spawning its own on the
// hardcoded PORT.
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;
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

  // ── 1b. RLS (0058, Prompt 3): a non-DM's DIRECT write attempt against
  //    map_whiteboard_tiles is rejected server-side — this project's
  //    established "gate real actions at the RLS layer, not just the UI"
  //    discipline, exercised with Alice's own real signed-in client, not
  //    through any app code that might merely hide the button. ──
  const { error: aliceWhiteboardWriteError } = await alice.client
    .from("map_whiteboard_tiles")
    .insert({ map_id: mapId, x: 5, y: 5, tile_png: "\\x89504e470d0a1a0a" });
  check(
    "a player cannot write a whiteboard tile directly — server-side RLS rejects it, not just client-gated (0058)",
    aliceWhiteboardWriteError !== null,
    String(aliceWhiteboardWriteError)
  );
  const { data: aliceRejectedRow } = await admin
    .from("map_whiteboard_tiles")
    .select()
    .eq("map_id", mapId)
    .eq("x", 5)
    .eq("y", 5)
    .maybeSingle();
  check("the rejected player write left no row behind", aliceRejectedRow === null, JSON.stringify(aliceRejectedRow));

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

  // Live sync (Prompt 3, docs/design/whiteboard-drawing-layer.md §5): Alice
  // — a connected player, on the SAME map, with no reveal step of any kind
  // — must see the DM's strokes appear AS they're drawn, not only once the
  // gesture completes and persists. This drives the SAME stroke the rest of
  // this section already needs (not a separate, extra one this script
  // would then have to clean back up) but pauses mid-gesture — pointer
  // still down, no mouseup yet — specifically to check Alice's own board
  // WHILE the stroke is in progress, which is the only thing that actually
  // exercises the live tier's own stream rather than the persisted tier's
  // eventual stroke-end broadcast (§5.1's two genuinely different wire
  // paths).
  const aliceBeforeStroke = await whiteboardState(alicePage);
  check("before any drawing, Alice's own board has no ink yet", aliceBeforeStroke.tileCount === 0, JSON.stringify(aliceBeforeStroke));
  await dmPage.mouse.move(strokePoints[0].x, strokePoints[0].y);
  await dmPage.mouse.down();
  for (const point of strokePoints.slice(1, -1)) {
    await dmPage.mouse.move(point.x, point.y, { steps: 8 });
  }
  // Still mid-gesture — no mouseup yet. The live-tier's own send interval
  // (WHITEBOARD_STROKE_FLUSH_MS) needs a moment to have actually fired at
  // least once; waitFor's own polling absorbs that.
  const aliceMidStroke = await waitFor(() => whiteboardState(alicePage), (s) => s.tileCount > 0, 6000);
  check(
    "a connected player sees the DM's ink appear WHILE the stroke is still in progress (the live tier), not only after it completes",
    aliceMidStroke.tileCount > 0,
    JSON.stringify(aliceMidStroke)
  );
  await dmPage.mouse.move(strokePoints[strokePoints.length - 1].x, strokePoints[strokePoints.length - 1].y, { steps: 8 });
  await dmPage.mouse.up();

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

  // Once the stroke completes and the persisted tier's own tiles-changed
  // broadcast lands, Alice's board converges to EXACTLY the DM's own —
  // proving the persisted tier corrects/confirms the live tier's own
  // result rather than the two ever silently disagreeing.
  const aliceAfterStroke = await waitFor(
    () => whiteboardState(alicePage),
    (s) => s.tileCount === afterDraw.tileCount
  );
  check(
    "once the stroke completes, the player's board converges to EXACTLY the same tiles as the DM's own",
    aliceAfterStroke.tileCount === afterDraw.tileCount &&
      [...aliceAfterStroke.tileKeys].sort().join(",") === [...afterDraw.tileKeys].sort().join(","),
    JSON.stringify({ dm: afterDraw, alice: aliceAfterStroke })
  );

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

  // ── 5b. Brush size: a small/medium/large selector (the owner's own
  //    report: "I can't pick colours or brush sizes, can this be added")
  //    that must actually change the next stroke's own footprint, and that
  //    change must reach a connected player too — the exact same
  //    color/tool/live-tier wiring §3/§4 above already established, now
  //    carrying brushSize alongside. Board is empty here (Redo just
  //    re-applied the clear above), tool is "pen" (also set just above). ──
  check(
    "brush size starts at the documented default",
    (await whiteboardState(dmPage)).brushSize === "medium",
    JSON.stringify(await whiteboardState(dmPage))
  );

  await dmPage.click('[data-testid="whiteboard-brush-small"]');
  const afterSmallBrush = await waitFor(() => whiteboardState(dmPage), (s) => s.brushSize === "small");
  check("the brush-size control updates the reported size", afterSmallBrush.brushSize === "small", JSON.stringify(afterSmallBrush));

  await dragStroke(dmPage, strokePoints);
  const afterSmallStroke = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount > 0);
  check("a small-brush stroke leaves real ink", afterSmallStroke.tileCount > 0, JSON.stringify(afterSmallStroke));
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "06-small-brush-stroke.png") });

  await dmPage.click('[data-testid="whiteboard-clear"]');
  await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount === 0);

  await dmPage.click('[data-testid="whiteboard-brush-large"]');
  const afterLargeBrush = await waitFor(() => whiteboardState(dmPage), (s) => s.brushSize === "large");
  check("switching to the large brush is reflected in the mirror", afterLargeBrush.brushSize === "large", JSON.stringify(afterLargeBrush));

  // The IDENTICAL gesture (same strokePoints) as the small-brush stroke
  // above — any difference in how much ink lands is attributable ONLY to
  // the brush-size change, nothing else.
  await dragStroke(dmPage, strokePoints);
  const afterLargeStroke = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount > 0);
  check(
    "changing the brush size visibly changes the next stroke drawn — the identical gesture leaves strictly more ink at 'large' than it did at 'small'",
    afterLargeStroke.tileCount > afterSmallStroke.tileCount,
    JSON.stringify({ small: afterSmallStroke.tileCount, large: afterLargeStroke.tileCount })
  );
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "07-large-brush-stroke.png") });

  // Cross-client sync (§5.1's live tier): Alice — still on this same map —
  // must converge to the SAME (larger) footprint too, the exact
  // color-convergence check above, now for brush size.
  const aliceAfterLargeStroke = await waitFor(
    () => whiteboardState(alicePage),
    (s) => s.tileCount === afterLargeStroke.tileCount
  );
  check(
    "a connected player's board converges to the EXACT SAME (larger) footprint — the chosen brush size travels through the same live/persisted sync path as color",
    aliceAfterLargeStroke.tileCount === afterLargeStroke.tileCount &&
      [...aliceAfterLargeStroke.tileKeys].sort().join(",") === [...afterLargeStroke.tileKeys].sort().join(","),
    JSON.stringify({ dm: afterLargeStroke, alice: aliceAfterLargeStroke })
  );

  // Leaves the board empty and brush size back at its default — section 6
  // below (height) draws its own fresh stroke and doesn't care about brush
  // size, but shouldn't inherit an unrelated non-default choice this
  // section made.
  await dmPage.click('[data-testid="whiteboard-clear"]');
  await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount === 0);
  await dmPage.click('[data-testid="whiteboard-brush-medium"]');
  await waitFor(() => whiteboardState(dmPage), (s) => s.brushSize === "medium");

  // ── 6. Height slider: updates its own reported value AND genuinely moves
  //    the plane (its projected screen point shifts), not just a label. ──
  const beforeHeight = await whiteboardState(dmPage);
  // 0104_whiteboard_height.sql: DEFAULT_WHITEBOARD_HEIGHT was lowered from
  // 1.2 to 0.7 ("the white board height is way too high in game") — this
  // fresh map has never had a height explicitly saved, so it renders at the
  // shipped default exactly like before, just a different numeric value.
  check("the height starts at the documented default", beforeHeight.height === 0.7, JSON.stringify(beforeHeight));
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

  // ── 9. Persistence (Prompt 3, docs/design/whiteboard-drawing-layer.md
  //    §5.3): reloading the page rebuilds the composite canvas from exactly
  //    what's in map_whiteboard_tiles — the SAME drawing survives, not just
  //    this session's own in-memory cache (a fresh page load creates a
  //    wholly new WhiteboardPlane instance with an EMPTY per-map cache, so
  //    this genuinely exercises the persisted-tier fetch-and-composite path,
  //    not a cache that merely survived). ──
  const beforeReload = await whiteboardState(dmPage);
  check("there is real ink to persist before reloading", beforeReload.tileCount > 0, JSON.stringify(beforeReload));
  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="whiteboard-state"]', { state: "attached", timeout: 60000 });
  const afterReload = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount === beforeReload.tileCount, 15000);
  check(
    "reloading the page shows the exact same drawing — persisted per-cell, not just cached in this session's memory",
    afterReload.tileCount === beforeReload.tileCount &&
      [...afterReload.tileKeys].sort().join(",") === [...beforeReload.tileKeys].sort().join(","),
    JSON.stringify({ before: beforeReload, after: afterReload })
  );
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "05-persisted-after-reload.png") });

  // ── 10. Per-map independence (Prompt 3): a SEPARATE map's own board is
  //    completely unaffected by the DM's drawing on this one — verified
  //    with a real second map and a player independently viewing it (per
  //    the per-viewer map system, MapPlan P9) while the DM keeps drawing on
  //    the FIRST map. ──
  const mapBId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapBId,
    campaign_id: campaignId,
    name: "A different map entirely",
    grid_width: 6,
    grid_height: 6,
  });

  // Gives Alice her own character with a token placed on Map B — her own
  // "effective current map" (ownTokenMapId in GameRoom.tsx, the per-viewer
  // map system, verify-per-viewer-map.mjs's own technique) now
  // independently resolves to Map B, regardless of the campaign's shared
  // live map (still Map A throughout this whole script — campaigns.live_map
  // is never touched here).
  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice Wayfarer",
    race: "Human",
    class: "Rogue",
    level: 1,
    strength: 10,
    dexterity: 14,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 10,
    max_hp: 10,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });
  await admin.from("map_tokens").insert({
    id: crypto.randomUUID(),
    map_id: mapBId,
    character_id: aliceCharacterId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });

  // A fresh navigation (not a reload) — re-runs the effective-map
  // derivation (ownTokenMapId ?? campaignDefaultMapId), both server- and
  // client-side, from scratch against this now-placed token, the same way
  // any real client picks up a change like this.
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="whiteboard-state"]', { state: "attached", timeout: 60000 });
  const aliceOnMapB = await waitFor(() => whiteboardState(alicePage), (s) => s.mapId === mapBId, 15000);
  check(
    "Alice's own view has independently switched to Map B (per-viewer map system)",
    aliceOnMapB.mapId === mapBId,
    JSON.stringify(aliceOnMapB)
  );
  check(
    "Map B's own board starts completely empty — a brand new map with no drawing of its own",
    aliceOnMapB.tileCount === 0,
    JSON.stringify(aliceOnMapB)
  );

  // The DM (still on Map A the whole script) draws again. Draw mode is
  // local-only UI state (never persisted, per the owner's own §7.2 design
  // decision) — the page reload in section 9 above reset it to off, and
  // reset the height slider to its own default too, so both need
  // re-establishing (and `center` re-deriving from the freshly reported
  // centerScreenPoint) exactly like every other post-reload/post-height-
  // change stroke earlier in this script already does.
  await dmPage.bringToFront();
  const dmStillOnMapA = await whiteboardState(dmPage);
  check("the DM's own view never left Map A", dmStillOnMapA.mapId === mapId, JSON.stringify(dmStillOnMapA));
  await dmPage.click('[data-testid="whiteboard-draw-toggle"]');
  const dmDrawModeBackOn = await waitFor(() => whiteboardState(dmPage), (s) => s.drawMode === true);
  check("draw mode is back on for this second round of drawing", dmDrawModeBackOn.drawMode === true, JSON.stringify(dmDrawModeBackOn));
  const dmCenterAfterReload = await waitFor(() => whiteboardState(dmPage), (s) => s.centerScreenPoint !== null, 5000);
  center = centerAbs(dmCenterAfterReload);
  // Clear first — the reloaded height reverted to its own default (1.2),
  // which happens to reproject to the SAME screen point section 3's very
  // first stroke already used, so redrawing there without clearing first
  // would just re-ink cells already inked and never move tileCount at all,
  // even though a real stroke genuinely happened (a false-negative risk in
  // THIS check, not a real product bug). Clearing first makes "did this
  // stroke land" unambiguous regardless of exactly where on the board it
  // falls, the same simple tileCount > 0 shape sections 3/6 already use.
  await dmPage.click('[data-testid="whiteboard-clear"]');
  await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount === 0);
  const beforeIndependenceDraw = 0;
  await dragStroke(dmPage, strokeAround(center));
  const afterIndependenceDraw = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount > beforeIndependenceDraw);
  check(
    "the DM's new stroke really did land on Map A",
    afterIndependenceDraw.tileCount > beforeIndependenceDraw,
    JSON.stringify(afterIndependenceDraw)
  );

  // Give any stray broadcast a moment to arrive, then confirm it did NOT —
  // Alice, independently viewing Map B, never evaluates a Map-A-scoped
  // event at all (§5.2's own "simply ignores the event" wording is what
  // this is confirming, not just an absence of effort to send it to her).
  await sleep(1200);
  const aliceStillOnMapB = await whiteboardState(alicePage);
  check(
    "a drawing on Map A does not appear on Map B for a player independently viewing it",
    aliceStillOnMapB.mapId === mapBId && aliceStillOnMapB.tileCount === 0,
    JSON.stringify(aliceStillOnMapB)
  );

  // Confirmed directly against the database too, not just the client-side
  // render mirror: Map B's own map_whiteboard_tiles rows stay at zero
  // throughout, while Map A's are genuinely non-empty.
  const { data: mapBTiles } = await admin.from("map_whiteboard_tiles").select().eq("map_id", mapBId);
  const { data: mapATiles } = await admin.from("map_whiteboard_tiles").select().eq("map_id", mapId);
  check(
    "Map B has zero persisted whiteboard tiles; Map A has real ones — independence confirmed at the database, not just the render",
    (mapBTiles ?? []).length === 0 && (mapATiles ?? []).length > 0,
    JSON.stringify({ mapBTiles, mapATilesCount: (mapATiles ?? []).length })
  );

  // ── 11. A final wide screenshot, free camera, for the report. ──
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
