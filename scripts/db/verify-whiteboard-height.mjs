#!/usr/bin/env node
// "the white board height is way too high in game, it needs to be
// lowerable too" — the project owner's own bug report, two bugs in one.
// Root cause (confirmed by inspection before writing this script): GameRoom
// .tsx's whiteboardHeight state has never been anything but pure per-client
// React state — never persisted, never broadcast. MapPanel.tsx's own height
// slider (docs/design/whiteboard-drawing-layer.md §6) has existed since the
// whiteboard drawing layer shipped, but moving it only ever changed the
// DRAGGING DM's own local useState: every OTHER connected client (every
// player, and the DM's own next reload) kept rendering the plane at the
// untouched DEFAULT_WHITEBOARD_HEIGHT (1.2, now lowered to 0.7) forever. The
// slider was also DM-only reachable AFTER first toggling "🖊 Draw" on — an
// unrelated drawing-mode gate in front of a plain height control.
//
// Fix, three parts:
//   1. DEFAULT_WHITEBOARD_HEIGHT lowered 1.2 -> 0.7 (scene-3d/whiteboardMath.ts).
//   2. Persisted per-map (campaign_maps.whiteboard_height, migration
//      0104_whiteboard_height.sql — a plain nullable real, NOT an offset,
//      since (unlike dm_book_offset/dm_tray_offset) there is no reshaping
//      computed default to stay relative to) and broadcast live over the
//      existing campaign channel (WHITEBOARD_HEIGHT_CHANGED_EVENT, the
//      DM_BOOK_MOVED_EVENT/DM_TRAY_MOVED_EVENT persist-then-broadcast
//      shape, but per-map-keyed like every other whiteboard event).
//   3. MapPanel.tsx's height slider moved OUTSIDE the `whiteboardDrawMode ?
//      ... : null` gate — a DM can now reach and move it without first
//      turning drawing on. Only the slider moved; the rest of the toolbar
//      (pen/eraser/brush/color/undo/redo/clear) stays exactly as
//      draw-mode-gated as before.
//
// IMPORTANT — this script was authored and run BEFORE migration
// 0104_whiteboard_height.sql was applied to the real database (the task
// this was built under explicitly forbids an agent from applying it — left
// for a human to review and run via `node scripts/db/migrate.mjs`). Phase 0
// below probes the real schema for the new column and branches accordingly
// — the verify-dm-tray-drag.mjs "probe first, blocked-not-failed" pattern,
// reused verbatim in shape:
//   - If the column is MISSING (expected on first run): every check that
//     doesn't need it still runs for real (the slider is reachable without
//     draw mode, moving it updates this client's own local render
//     instantly — real screenshots either way — and the drawing-toolbar
//     regression checks), and the ones that genuinely need it (DB
//     persistence, cross-client broadcast, reload survival) are reported as
//     "BLOCKED (schema pending)", not FAIL. The write path is proven to
//     fail SAFE: a visible whiteboard-height-error appears, the database is
//     left untouched, and a reload still renders the safe shipped default
//     rather than anything corrupted.
//   - If the column EXISTS (re-run this script after a human applies the
//     migration): every check below runs for real, including the live
//     round-trip DB assertions and the second-client broadcast check.
//
// Covers:
//   1. The height slider is visible and usable for the DM WITHOUT first
//      toggling draw mode on (the actual bug) — while the rest of the
//      drawing toolbar (pen/eraser/etc.) stays exactly as gated as before
//      (regression check: only the slider moved, nothing else did).
//   2. A player never sees the slider at all (DM-only, unaffected).
//   3. A fresh, untouched room already renders at the new, lower shipped
//      default (0.7, not the old 1.2) — real screenshot.
//   4. The DM can lower the height further via the slider; a real
//      before/after screenshot comparing the old default (1.2) against a
//      genuinely lower value.
//   5. Schema permitting: the new height persists to
//      campaign_maps.whiteboard_height, reaches a second, idle,
//      already-connected client (alice, a player who never reloaded) LIVE
//      via WHITEBOARD_HEIGHT_CHANGED_EVENT — confirmed both numerically and
//      by her own plane's projected screen point actually shifting — and
//      survives a real page reload for BOTH the DM and Alice.
//
// Needs the real dev server (starts `yarn dev` itself, polling /api/health,
// if the target port isn't already serving) and the real shared Supabase
// instance this project's .env points at — the same convention every other
// scripts/db/verify-*.mjs already uses; ephemeral test users/campaign are
// created here and torn down in `finally`.
// Usage: node scripts/db/verify-whiteboard-height.mjs
//        APP_URL=http://localhost:6497 node scripts/db/verify-whiteboard-height.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default, not-otherwise-claimed port (see this directory's own
// scripts for the full list already in use) — the verify-dm-tray-drag.mjs
// precedent of always spawning this worktree's own fresh `yarn dev` here
// rather than risking any interaction with an unrelated process already
// bound to a more common port.
const PORT = 6497;
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/whiteboard-height-screenshots";
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
let blocked = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}
function skipBlocked(label, reason) {
  console.log(`BLOCKED  ${label} — ${reason}`);
  blocked++;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on :${PORT} — starting this worktree's own…`);
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
  const email = `whiteboardheight-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `WhiteboardHeight ${label}` });
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

/** Polls a mirror until `predicate` is true or `timeoutMs` elapses — a
 * debounced write/broadcast/React state update is never instant. Returns
 * the last-read value either way, so a timed-out caller still has a useful
 * detail string. */
async function waitFor(readState, predicate, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let last = await readState();
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await readState();
  }
  return last;
}

/** Sets a native input's value via its own prototype setter (bypassing
 * React's own onChange-only listening) then dispatches real "input"/"change"
 * events — verify-whiteboard-drawing.mjs's own precedent for driving a
 * React-controlled `<input type="range">` from outside React. */
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

/** Docked floating 2D panels (DiceLogPanel/CombatPanel/etc.) default to a
 * layout that covers most of the 3D table, including the whiteboard plane
 * itself — the verify-dm-tray-drag.mjs dockAllPanels precedent, closing them
 * so a screenshot actually shows the unobstructed 3D scene. A docked
 * panel's own DOM (confirmed by reading DraggablePanel.tsx directly) is
 * `display: none`, not unmounted — the height slider input stays in the DOM
 * and setNativeInputValue keeps working on it after docking, which is
 * exactly why every visibility/interaction CHECK below happens BEFORE this
 * is ever called, and only the screenshot-quality docking happens after. */
const PANEL_IDS = [
  "combat",
  "opportunityAttack",
  "quickActions",
  "diceLog",
  "handout",
  "diceTray",
  "hp",
  "liveObjects",
  "chatLog",
  "tokens",
  "map",
];
async function dockAllPanels(page) {
  for (const panelId of PANEL_IDS) {
    await page.click(`[data-testid="close-toggle-${panelId}"]`, { timeout: 1000 }).catch(() => undefined);
  }
  await sleep(300);
}

await ensureDevServer();

// ── Phase 0: schema probe — does campaign_maps.whiteboard_height exist? ──
const probe = await admin.from("campaign_maps").select("whiteboard_height").limit(1);
const heightColumnExists = !probe.error;
if (heightColumnExists) {
  console.log("Phase 0: campaign_maps.whiteboard_height EXISTS — migration 0104 has been applied. Running full live checks.\n");
} else {
  console.log(
    `Phase 0: campaign_maps.whiteboard_height does NOT exist yet (${probe.error?.message ?? "unknown error"}).\n` +
      "This is EXPECTED — the task this script was built under explicitly forbade applying\n" +
      "migration 0104_whiteboard_height.sql (left for a human to review/run). Every check below\n" +
      "that genuinely needs the column is reported as BLOCKED, not FAIL — the slider's own\n" +
      "un-gating, its local instant visual update, and every regression check still run for\n" +
      "real. Re-run this exact script after the migration is applied for the full live\n" +
      "verification.\n"
  );
}

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Whiteboard height test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Whiteboard height arena",
    grid_width: 6,
    grid_height: 6,
  });
  // A token for visual reference in every screenshot — a bare empty floor
  // makes it hard to eyeball scale/height by comparison.
  await admin.from("map_tokens").insert({
    id: crypto.randomUUID(),
    map_id: mapId,
    npc_name: "Height Reference Goblin",
    x: 2,
    y: 2,
    elevation: 0,
    allegiance: "hostile",
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  if (heightColumnExists) {
    const { data: mapRowInitial } = await admin
      .from("campaign_maps")
      .select("whiteboard_height")
      .eq("id", mapId)
      .maybeSingle();
    check(
      "a freshly created map has never had a height saved — whiteboard_height starts null",
      mapRowInitial?.whiteboard_height === null,
      JSON.stringify(mapRowInitial)
    );
  }

  const dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();

  // Alice loads once here and is NEVER reloaded again until the explicit
  // reload-survival check at the very end — the "already loaded, never
  // reloaded" second-connected-client requirement for the broadcast check.
  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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

  // -------------------------------------------------------------------
  // 1. THE bug: the height slider must be visible and usable for the DM
  //    WITHOUT first toggling draw mode on — while the rest of the drawing
  //    toolbar stays exactly as gated as before (only the slider moved).
  // -------------------------------------------------------------------
  const initialState = await whiteboardState(dmPage);
  check("draw mode starts off for a fresh DM session", initialState.drawMode === false, JSON.stringify(initialState));
  check(
    "the height slider IS visible with draw mode OFF — the actual bug this fixes (reachable without entering drawing)",
    await dmPage.locator('[data-testid="whiteboard-height-slider"]').isVisible()
  );
  check(
    "REGRESSION: the pen tool button is still NOT visible with draw mode off — only the height slider was un-gated, not the whole toolbar",
    !(await dmPage.locator('[data-testid="whiteboard-tool-pen"]').isVisible().catch(() => false))
  );
  check(
    "REGRESSION: the color picker is still NOT visible with draw mode off",
    !(await dmPage.locator('[data-testid="whiteboard-color-picker"]').isVisible().catch(() => false))
  );
  check(
    "REGRESSION: the undo button is still NOT visible with draw mode off",
    !(await dmPage.locator('[data-testid="whiteboard-undo"]').isVisible().catch(() => false))
  );

  // -------------------------------------------------------------------
  // 2. A player never sees the slider at all — DM-only, unaffected by this
  //    fix (the whole whiteboard-toolbar block stays isDM-gated).
  // -------------------------------------------------------------------
  check(
    "a player never sees the height slider at all (DM-only control, unaffected by un-gating it from draw mode)",
    (await alicePage.$('[data-testid="whiteboard-height-slider"]')) === null
  );
  check(
    "a player never sees the whiteboard toolbar at all",
    (await alicePage.$('[data-testid="whiteboard-toolbar"]')) === null
  );

  // -------------------------------------------------------------------
  // 3. A fresh, untouched room already renders at the new, lower shipped
  //    default (0.7, not the old 1.2) — real screenshot for both clients.
  // -------------------------------------------------------------------
  check(
    "a fresh DM session, nobody having touched the slider, already reports the new lower default (0.7, not the old 1.2)",
    initialState.height === 0.7,
    JSON.stringify(initialState)
  );
  const aliceInitialState = await whiteboardState(alicePage);
  check(
    "a fresh player session ALSO already reports the new lower default — not just the DM's own client",
    aliceInitialState.height === 0.7,
    JSON.stringify(aliceInitialState)
  );

  // A BLANK board is a fully transparent canvas texture with no visible
  // border of its own (confirmed by inspection: WhiteboardPlane draws only
  // the ink itself, nothing else) — so a height CHANGE on an empty board is
  // numerically real (centerScreenPoint moves) but literally invisible to a
  // human looking at a screenshot. Drawing one real, visible mark first (the
  // verify-whiteboard-drawing.mjs strokeAround/dragStroke pattern) — while
  // draw mode is still ON and the panel still visible, since a docked
  // panel's own `display: none` button can't be `.click()`-ed — gives every
  // screenshot below actual content whose on-screen position changing is
  // what "visibly lower" really means. The ink itself rides along with the
  // plane's own group transform, so it stays anchored to the board through
  // every height change that follows.
  await dmPage.click('[data-testid="whiteboard-draw-toggle"]');
  await waitFor(() => whiteboardState(dmPage), (s) => s.drawMode === true);
  const withCenter = await waitFor(() => whiteboardState(dmPage), (s) => s.centerScreenPoint !== null, 5000);
  check(
    "the plane's own world-space center projects to a real on-screen point, so a real mark can be drawn on it",
    withCenter.centerScreenPoint !== null,
    JSON.stringify(withCenter)
  );
  const dmCanvasBox = await dmPage.locator("canvas").boundingBox();
  const centerAbs = (point) => ({ x: dmCanvasBox.x + point[0], y: dmCanvasBox.y + point[1] });
  const markCenter = centerAbs(withCenter.centerScreenPoint);
  const markPoints = [
    { x: markCenter.x - 80, y: markCenter.y - 30 },
    { x: markCenter.x - 20, y: markCenter.y + 40 },
    { x: markCenter.x + 40, y: markCenter.y - 35 },
    { x: markCenter.x + 90, y: markCenter.y + 30 },
  ];
  await dmPage.mouse.move(markPoints[0].x, markPoints[0].y);
  await dmPage.mouse.down();
  for (const point of markPoints.slice(1)) await dmPage.mouse.move(point.x, point.y, { steps: 8 });
  await dmPage.mouse.up();
  const withMark = await waitFor(() => whiteboardState(dmPage), (s) => s.tileCount > 0);
  check("a real, visible mark was drawn on the board for the height screenshots below", withMark.tileCount > 0, JSON.stringify(withMark));
  await dmPage.click('[data-testid="whiteboard-draw-toggle"]');
  await waitFor(() => whiteboardState(dmPage), (s) => s.drawMode === false);

  // Every visibility/un-gating check above needed the real panel layout;
  // from here on this script only ever drives the slider programmatically
  // (setNativeInputValue), so dock every panel now for an unobstructed view
  // of the actual 3D scene in every screenshot below.
  await dockAllPanels(dmPage);
  await dockAllPanels(alicePage);
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "00-fresh-load-new-default-0.7.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "00-fresh-load-new-default-0.7.png")}`);

  // -------------------------------------------------------------------
  // 4. Before/after: dial the slider UP to the OLD default (1.2) for a real
  //    "how it used to look" comparison shot, then DOWN to a genuinely
  //    lower value — proving the board is now lowerable, not just
  //    shipped-lower-by-default.
  // -------------------------------------------------------------------
  await setNativeInputValue(dmPage, '[data-testid="whiteboard-height-slider"]', 1.2);
  const oldDefaultState = await waitFor(() => whiteboardState(dmPage), (s) => s.height === 1.2);
  check("the slider can be moved UP to the old 1.2 default for comparison", oldDefaultState.height === 1.2, JSON.stringify(oldDefaultState));
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "01-old-default-1.2-too-high.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "01-old-default-1.2-too-high.png")}`);

  const LOWERED_HEIGHT = 0.4;
  await setNativeInputValue(dmPage, '[data-testid="whiteboard-height-slider"]', LOWERED_HEIGHT);
  const loweredState = await waitFor(() => whiteboardState(dmPage), (s) => s.height === LOWERED_HEIGHT);
  check(
    "the DM can lower the height well below even the new default — the project owner's own 'needs to be lowerable too' ask",
    loweredState.height === LOWERED_HEIGHT,
    JSON.stringify(loweredState)
  );
  // Direction-agnostic (the verify-whiteboard-drawing.mjs "raising the
  // height" check's own precedent, section 6 there) — a real projected
  // camera can put "down in world space" at either a larger or smaller
  // screen Y depending on the seated view's own angle, so this asserts a
  // confidently-measurable SHIFT, not a specific sign.
  const screenAfterLower = await waitFor(
    () => whiteboardState(dmPage),
    (s) => s.centerScreenPoint !== null && Math.abs(s.centerScreenPoint[1] - oldDefaultState.centerScreenPoint[1]) > 4
  );
  check(
    "lowering the height genuinely moves the plane in 3D space — its own projected screen point shifts, not just a UI label",
    Math.abs(screenAfterLower.centerScreenPoint[1] - oldDefaultState.centerScreenPoint[1]) > 4,
    JSON.stringify({ oldDefault: oldDefaultState.centerScreenPoint, lowered: screenAfterLower.centerScreenPoint })
  );
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "02-lowered-0.4-visibly-lower.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "02-lowered-0.4-visibly-lower.png")}`);

  if (heightColumnExists) {
    // ---------------------------------------------------------------
    // 5a. Persistence — the debounced write lands in the database.
    // ---------------------------------------------------------------
    const deadline1 = Date.now() + 10000;
    let mapRowAfterChange = null;
    while (Date.now() < deadline1) {
      const { data } = await admin.from("campaign_maps").select("whiteboard_height").eq("id", mapId).maybeSingle();
      if (data?.whiteboard_height !== null && data?.whiteboard_height !== undefined) {
        mapRowAfterChange = data;
        break;
      }
      await sleep(250);
    }
    check(
      "the lowered height persisted to campaign_maps.whiteboard_height",
      mapRowAfterChange?.whiteboard_height !== undefined &&
        Math.abs(mapRowAfterChange.whiteboard_height - LOWERED_HEIGHT) < 1e-6,
      JSON.stringify(mapRowAfterChange)
    );
    check(
      "no whiteboard-height-error appeared on a successful save",
      (await dmPage.$('[data-testid="whiteboard-height-error"]')) === null
    );

    // ---------------------------------------------------------------
    // 5b. A second, idle, already-connected client (alice, never reloaded)
    //    sees the DM's lowered height live via the broadcast — both
    //    numerically and by her own plane's projected point actually
    //    shifting, exactly like the DM's own check above.
    // ---------------------------------------------------------------
    const aliceAfterBroadcast = await waitFor(
      () => whiteboardState(alicePage),
      (s) => s.height === LOWERED_HEIGHT,
      15000
    );
    check(
      "a second, idle, already-connected client (alice, a player who never reloaded) sees the DM's lowered height live via the broadcast",
      aliceAfterBroadcast.height === LOWERED_HEIGHT,
      JSON.stringify(aliceAfterBroadcast)
    );
    check(
      "alice's OWN plane visibly moved too — her own projected screen point also shifted down, not just the reported number",
      aliceAfterBroadcast.centerScreenPoint !== null &&
        aliceAfterBroadcast.centerScreenPoint[1] > aliceInitialState.centerScreenPoint[1] + 4,
      JSON.stringify({ before: aliceInitialState.centerScreenPoint, after: aliceAfterBroadcast.centerScreenPoint })
    );
    check(
      "the persisted DB value the DM's client wrote and the value alice's client received via broadcast are the exact same number",
      Math.abs(mapRowAfterChange.whiteboard_height - aliceAfterBroadcast.height) < 1e-6,
      JSON.stringify({ db: mapRowAfterChange.whiteboard_height, alice: aliceAfterBroadcast.height })
    );
    await alicePage.screenshot({ path: join(SCREENSHOT_DIR, "03-alice-live-sync-lowered.png") });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "03-alice-live-sync-lowered.png")}`);

    // ---------------------------------------------------------------
    // 5c. Survives a real page reload — for BOTH the DM and alice.
    // ---------------------------------------------------------------
    await dmPage.reload();
    await dmPage.waitForSelector('[data-testid="whiteboard-state"]', { state: "attached", timeout: 30000 });
    await dmPage.waitForTimeout(1200);
    const dmAfterReload = await whiteboardState(dmPage);
    check(
      "the lowered height survives a real page reload for the DM",
      dmAfterReload.height === LOWERED_HEIGHT,
      JSON.stringify(dmAfterReload)
    );
    await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "04-dm-after-reload-persisted.png") });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "04-dm-after-reload-persisted.png")}`);

    await alicePage.reload();
    await alicePage.waitForSelector('[data-testid="whiteboard-state"]', { state: "attached", timeout: 30000 });
    await alicePage.waitForTimeout(1200);
    const aliceAfterReload = await whiteboardState(alicePage);
    check(
      "the lowered height survives a real page reload for a player too, not just the DM who set it",
      aliceAfterReload.height === LOWERED_HEIGHT,
      JSON.stringify(aliceAfterReload)
    );

    // ---------------------------------------------------------------
    // 5d. RLS: a player cannot write campaign_maps.whiteboard_height (the
    //    same DM-only UPDATE policy that already governs every other
    //    campaign_maps column — no new policy was added for this one).
    // ---------------------------------------------------------------
    const { error: crossWriteError, count: crossWriteCount } = await alice.client
      .from("campaign_maps")
      .update({ whiteboard_height: 2.9 }, { count: "exact" })
      .eq("id", mapId);
    check(
      "a player cannot write this map's whiteboard_height (RLS blocks it: zero rows affected)",
      !crossWriteError && crossWriteCount === 0,
      JSON.stringify({ crossWriteError, crossWriteCount })
    );
  } else {
    // ---------------------------------------------------------------
    // Schema pending: the write path must fail SAFE — a visible error
    // naming the whiteboard, the database untouched, and a reload still
    // rendering the safe shipped default rather than anything corrupted.
    // ---------------------------------------------------------------
    const heightErrorText = await dmPage.textContent('[data-testid="whiteboard-height-error"]').catch(() => "");
    check(
      "adjusting the height with the column missing surfaces a clear, visible error (not a silent no-op, not a crash) naming the whiteboard",
      /whiteboard/i.test(heightErrorText ?? ""),
      `whiteboard-height-error text: ${JSON.stringify(heightErrorText)}`
    );

    const { data: mapRowUntouched } = await admin.from("campaign_maps").select().eq("id", mapId).maybeSingle();
    check(
      "the database itself is completely untouched by the failed write attempt (the map row still exists, unrelated columns unharmed)",
      mapRowUntouched !== null && mapRowUntouched.name === "Whiteboard height arena" && mapRowUntouched.grid_width === 6
    );

    // Alice never received anything — nothing was ever persisted, so
    // nothing was ever broadcast either.
    const aliceStillDefault = await whiteboardState(alicePage);
    check(
      "with the column missing, alice's own client never receives anything (nothing was ever persisted to broadcast) — she still reports the untouched default",
      aliceStillDefault.height === 0.7,
      JSON.stringify(aliceStillDefault)
    );

    await dmPage.reload();
    await dmPage.waitForSelector('[data-testid="whiteboard-state"]', { state: "attached", timeout: 30000 });
    await dmPage.waitForTimeout(1200);
    const dmAfterFailedReload = await whiteboardState(dmPage);
    check(
      "a reload after the failed save still renders the safe shipped default, not a crash or a corrupted value",
      dmAfterFailedReload.height === 0.7,
      JSON.stringify(dmAfterFailedReload)
    );

    skipBlocked(
      "the lowered height persists to campaign_maps.whiteboard_height",
      "campaign_maps.whiteboard_height does not exist yet — apply migration 0104_whiteboard_height.sql, then re-run this script"
    );
    skipBlocked(
      "a second connected client (alice) sees the lowered height live via the broadcast",
      "depends on the same missing column — nothing is ever persisted or broadcast until the write itself can succeed"
    );
    skipBlocked(
      "the lowered height survives a real page reload for the DM and a player",
      "depends on the same missing column — a reload always falls back to the shipped default with nothing saved to recover"
    );
    skipBlocked(
      "a player cannot write this map's whiteboard_height (RLS)",
      "the column does not exist yet, so ANY write to it (by anyone, DM or player) fails on schema grounds alone — RLS itself cannot be meaningfully exercised until the column exists"
    );
  }

  await dmContext.close();
  await aliceContext.close();
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

console.log(`\n${failures} failure(s), ${blocked} blocked (schema pending) check(s).`);
if (failures > 0) {
  console.error("Whiteboard height verification FAILED.");
  process.exit(1);
}
console.log(
  blocked > 0
    ? "Whiteboard height verification PASSED every check runnable today; the rest are BLOCKED pending the (deliberately unapplied) schema migration — see the console notes above."
    : "All whiteboard height checks passed."
);
process.exit(0);
