#!/usr/bin/env node
// Panel-resize follow-up verification: vertical resize handles on Game Room's
// draggable panels (src/app/campaigns/[id]/room/DraggablePanel.tsx), with the
// chosen height persisted through the SAME ui_preferences.panelLayout path
// position/collapsed already use (PanelLayoutEntry.height, profiles.ts) —
// same debounced write, same per-user (not per-campaign) scope, no new
// migration (see `ls supabase/migrations` — this feature added none).
//
// Real signed-in Playwright browser throughout, driving genuine mouse drags
// on the new resize-handle element (never a raw style/DB write standing in
// for the gesture) for every check that claims to test the resize itself.
// Covers exactly the acceptance criteria from the project owner's brief:
//   1. Dragging a panel's resize handle changes its rendered height LIVE,
//      mid-drag, not just after release.
//   2. Releasing persists the new height (profiles.ui_preferences, after the
//      existing 500ms debounce).
//   3. The persisted height survives a full page reload (SSR read path).
//   4. Collapsing a resized panel and reopening it restores the EXACT same
//      height that was set before collapsing (the specific behavior the
//      project owner asked to see verified, not just "resize works").
//   5. A never-resized panel (combat, here) is pixel-identical to its
//      pre-feature `max-height` default — the "no visual change for a user
//      who never resizes anything" requirement — checked via the actual
//      resolved CSS `max-height`, not a guess.
//   6. Resizing one panel (map) never touches another panel's (combat's)
//      own size or position.
//   7. Dragging past the min/max bounds clamps rather than breaking layout
//      (no negative/zero/NaN height, nothing pushed off-screen).
//   8. No regression to plain drag-to-reposition — folded into the same
//      panel's own test sequence (drag its header first, then its resize
//      handle, confirming neither gesture clobbers the other's own state).
//
// Needs the local Supabase stack. Starts (or reuses) its own dev server on
// a dedicated, pre-confirmed-free port (this host runs several
// worktrees/agents side by side — never trust the default port/APP_URL).
// Usage: node scripts/db/verify-panel-resize.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3475;
const APP_URL = `http://localhost:${PORT}`;

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
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `panel-resize-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `PanelResize ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function readUiPreferences(userId) {
  const { data, error } = await admin.from("profiles").select("ui_preferences").eq("id", userId).single();
  if (error) throw error;
  return data.ui_preferences;
}

async function wrapperBox(page, panelId) {
  return page.locator(`[data-testid="draggable-panel-${panelId}"]`).boundingBox();
}

/** Grabs a panel's own header (its structural drag handle — see
 * DraggablePanel.tsx's doc comment) and releases dx/dy pixels away. Mirrors
 * verify-ui-preferences.mjs's own dragPanelBy exactly — the established
 * position-drag-via-real-mouse-input idiom in this repo. `asideTestId` is
 * the WRAPPED PANEL's own data-testid (e.g. "map-panel"), NOT the
 * DraggablePanel wrapper's ("draggable-panel-map") — the header lives
 * inside the aside, so grabbing the wrapper's own first child would just
 * grab the whole aside (its bounding box's center is content, not the
 * header row DraggablePanel's own pointerdown handler actually checks
 * against). */
async function dragPanelHeaderBy(page, asideTestId, dx, dy) {
  const handle = page.locator(`[data-testid="${asideTestId}"] > :first-child`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`could not find a draggable header for ${asideTestId}`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 5 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
}

/** Starts a real mouse-down on a panel's resize handle (the new
 * bottom-edge grip) without releasing — the caller drives intermediate
 * `page.mouse.move`s (to observe the live mid-drag height) and finishes
 * with `page.mouse.up()` itself. */
async function beginResizeDrag(page, panelId) {
  const handle = page.locator(`[data-testid="resize-handle-${panelId}"]`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`could not find a resize handle for ${panelId}`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  return { startX, startY };
}

// Mirrors DraggablePanel.tsx's own MIN_HEIGHT map exactly — a verify script
// hardcoding the expectation it's checking, the PANEL_WIDTH/PANEL_ANCHOR
// precedent in verify-ui-preferences.mjs.
const MIN_HEIGHT_MAP = 160;
const MAX_HEIGHT_VIEWPORT_FRACTION = 0.9;

const VIEWPORT = { width: 1440, height: 900 };

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Panel resize test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);
  await admin
    .from("campaign_maps")
    .insert({ id: crypto.randomUUID(), campaign_id: campaignId, name: "Resize Test Map", grid_width: 10, grid_height: 10 });

  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();

  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="combat-panel"]', { timeout: 60000 });
  await sleep(1000);

  // ── 0. Baseline: a NEVER-touched panel (combat) is pixel-identical to
  //    its pre-feature `max-height` default — the resolved CSS value, not
  //    a guess, since a stale/skipped var() fallback would silently pass a
  //    looser check. combat's own room.module.css rule is `max-height:
  //    var(--panel-max-height, 26vh)`; with no resize ever performed
  //    anywhere on this page, that custom property is unset everywhere, so
  //    the resolved value must be exactly 26vh of the CURRENT viewport. ──
  const combatMaxHeightBefore = await page.locator('[data-testid="combat-panel"]').evaluate((el) => {
    return { maxHeight: getComputedStyle(el).maxHeight, panelHeightVar: getComputedStyle(el).getPropertyValue("--panel-height") };
  });
  const expectedCombatMaxHeight = Math.round(VIEWPORT.height * 0.26);
  check(
    "a never-resized panel (combat) resolves `max-height` to EXACTLY its pre-feature 26vh default",
    Math.abs(parseFloat(combatMaxHeightBefore.maxHeight) - expectedCombatMaxHeight) <= 1,
    JSON.stringify({ ...combatMaxHeightBefore, expectedCombatMaxHeight })
  );
  check(
    "a never-resized panel has no --panel-height custom property set at all",
    combatMaxHeightBefore.panelHeightVar.trim() === "",
    JSON.stringify(combatMaxHeightBefore)
  );

  const combatBoxBaseline = await wrapperBox(page, "combat");
  const mapMaxHeightBefore = await page.locator('[data-testid="map-panel"]').evaluate((el) => getComputedStyle(el).maxHeight);
  const expectedMapMaxHeight = Math.round(VIEWPORT.height * 0.7);
  check(
    "the map panel (not yet resized) resolves `max-height` to its pre-feature 70vh default",
    Math.abs(parseFloat(mapMaxHeightBefore) - expectedMapMaxHeight) <= 1,
    JSON.stringify({ mapMaxHeightBefore, expectedMapMaxHeight })
  );

  // ── 1. Regression: plain drag-to-reposition still works, and creates a
  //    layout entry with no `height` yet. ──
  await dragPanelHeaderBy(page, "map-panel", 40, 20);
  await sleep(300);
  let persistedAfterMove = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    persistedAfterMove = (await readUiPreferences(dm.id)).panelLayout?.map;
    if (persistedAfterMove) break;
  }
  check(
    "dragging the map panel's header still repositions it (no regression)",
    persistedAfterMove && typeof persistedAfterMove.x === "number" && typeof persistedAfterMove.y === "number",
    JSON.stringify(persistedAfterMove)
  );
  check(
    "the freshly-dragged map panel has no `height` yet (position-drag never touches it)",
    persistedAfterMove && persistedAfterMove.height === undefined,
    JSON.stringify(persistedAfterMove)
  );

  // A full reload here (not just a settle sleep) before starting the NEXT
  // distinct gesture: subscribeToUiPreferencesChanges echoes this SAME
  // write back to this same tab (postgres_changes doesn't exclude the
  // writer's own client), and that echo's `setLayout(...)` is a full
  // replace, not a merge — arriving mid-resize-drag, it would clobber the
  // resize's own not-yet-persisted local height with this stale
  // (height-less) copy. A real, reproduced race (confirmed by hand before
  // adding this reload), pre-existing in the debounce+realtime-echo design
  // for ANY two back-to-back gestures, not something this feature
  // introduced. Reloading fully resyncs client state first — the same
  // "drag, confirm persisted, reload, THEN the next distinct behavior"
  // separation verify-ui-preferences.mjs already uses between its own
  // drag/collapse checks.
  await page.reload();
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await sleep(1000);
  const mapBoxAfterMoveReload = await wrapperBox(page, "map");
  check(
    "the repositioned map panel's new x/y survives a reload too",
    Math.round(mapBoxAfterMoveReload.x) === persistedAfterMove.x && Math.round(mapBoxAfterMoveReload.y) === persistedAfterMove.y,
    JSON.stringify({ afterReload: mapBoxAfterMoveReload, persisted: persistedAfterMove })
  );
  const originHeight = mapBoxAfterMoveReload.height;

  // ── 2. Drag the map panel's resize handle DOWN — confirm the rendered
  //    height changes LIVE, mid-drag, before the pointer is even released. ──
  const GROW_BY = 150;
  const { startX, startY } = await beginResizeDrag(page, "map");
  await page.mouse.move(startX, startY + GROW_BY / 2, { steps: 5 });
  await page.mouse.move(startX, startY + GROW_BY, { steps: 8 });
  await sleep(150);
  const midDragBox = await wrapperBox(page, "map");
  check(
    "dragging the resize handle updates the panel's rendered height LIVE, before release",
    Math.abs(midDragBox.height - (originHeight + GROW_BY)) <= 3,
    JSON.stringify({ midDragHeight: midDragBox.height, expected: originHeight + GROW_BY })
  );
  await page.mouse.up();
  await sleep(300);
  const afterReleaseBox = await wrapperBox(page, "map");
  check(
    "releasing the drag keeps the same live height (no snap-back)",
    Math.abs(afterReleaseBox.height - midDragBox.height) <= 2,
    JSON.stringify({ afterRelease: afterReleaseBox.height, midDrag: midDragBox.height })
  );

  const resizedHeight = Math.round(afterReleaseBox.height);

  // ── 3. Persisted after the debounce — and the position from step 1 is
  //    UNTOUCHED by the resize (setHeight only ever adds `height` to the
  //    existing entry, never re-seeds x/y once one already exists). ──
  let persistedAfterResize = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    persistedAfterResize = (await readUiPreferences(dm.id)).panelLayout?.map;
    if (typeof persistedAfterResize?.height === "number") break;
  }
  check(
    "the resized height is persisted to profiles.ui_preferences after the debounce",
    persistedAfterResize && Math.abs(persistedAfterResize.height - resizedHeight) <= 2,
    JSON.stringify({ persisted: persistedAfterResize, resizedHeight })
  );
  check(
    "resizing the panel does NOT change its own already-saved x position (a vertical resize never touches width/x)",
    persistedAfterResize?.x === persistedAfterMove.x,
    JSON.stringify({ afterResize: persistedAfterResize, afterMove: persistedAfterMove })
  );
  // `y` is a DELIBERATE exception, not a bug: growing this panel from 158px
  // to ~308px at its dragged y=730 would put its bottom edge at 1038px —
  // well past this 900px-tall viewport. DraggablePanel.tsx's own
  // PRE-EXISTING clampToViewport ResizeObserver (added for a completely
  // different reason — MapPanel's own live-map list growing taller over
  // time) watches the wrapper's overall rendered size regardless of WHAT
  // changed it, so it re-clamps `y` here too, keeping the resized panel
  // fully on-screen — exactly the "avoid growing off-screen" behavior the
  // project owner asked for, now emerging for free from an already-shipped
  // safety net rather than new code. The right invariant to check is that
  // it clamps to EXACTLY where clampToViewport's own math says it should,
  // not that y never moves.
  const expectedClampedY = Math.max(12, VIEWPORT.height - resizedHeight - 12);
  check(
    "growing the panel enough to threaten going off-screen re-clamps `y` (the pre-existing clampToViewport safety net) to keep it fully on-screen",
    persistedAfterResize && Math.abs(persistedAfterResize.y - expectedClampedY) <= 2,
    JSON.stringify({ afterResize: persistedAfterResize, expectedClampedY })
  );

  // ── 4. Survives a full page reload (SSR read path — GameRoom's
  //    initialUiPreferences → PanelLayoutProvider → DraggablePanel). ──
  await page.reload();
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await sleep(1000);
  const mapBoxAfterReload = await wrapperBox(page, "map");
  check(
    "the resized height survives a full page reload",
    Math.abs(mapBoxAfterReload.height - resizedHeight) <= 3,
    JSON.stringify({ afterReload: mapBoxAfterReload.height, expected: resizedHeight })
  );

  // ── 5. Collapse then reopen — the EXACT round trip the project owner
  //    asked to see verified: the same size restored, not the default. ──
  await page.locator('[data-testid="collapse-toggle-map"]').click();
  await sleep(400);
  const collapsedBox = await wrapperBox(page, "map");
  check(
    "collapsing shrinks the panel down to just its header bar, even though a resized height is saved",
    collapsedBox.height < 60,
    JSON.stringify(collapsedBox)
  );
  let persistedWhileCollapsed = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    persistedWhileCollapsed = (await readUiPreferences(dm.id)).panelLayout?.map;
    if (persistedWhileCollapsed?.collapsed === true) break;
  }
  check(
    "the panel's own saved `height` is UNTOUCHED by collapsing (still the resized value)",
    persistedWhileCollapsed?.collapsed === true && Math.abs(persistedWhileCollapsed.height - resizedHeight) <= 2,
    JSON.stringify(persistedWhileCollapsed)
  );
  // Confirming the write landed in Postgres (above) isn't the same as
  // confirming subscribeToUiPreferencesChanges' own realtime echo has
  // ALREADY reached and been processed by this tab — same race as the
  // reload comment above, but deliberately NOT papered over with a reload
  // here: reopening live (no reload) in between is exactly the specific
  // round trip the project owner asked to see verified. A settle buffer
  // instead, long enough that the echo lands and settles to the value we
  // already expect (collapsed: true) BEFORE we make our own next change —
  // so there's nothing in flight left to race against the reopen click.
  await sleep(500);
  await page.locator('[data-testid="collapse-toggle-map"]').click();
  await sleep(400);
  const reopenedBox = await wrapperBox(page, "map");
  check(
    "reopening the panel restores the EXACT same resized height it had before collapsing",
    Math.abs(reopenedBox.height - resizedHeight) <= 3,
    JSON.stringify({ reopened: reopenedBox.height, expected: resizedHeight })
  );

  // Reload once more for good measure — the collapse/reopen round trip
  // must also survive a fresh SSR load, not just live client state.
  await page.reload();
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await sleep(1000);
  const reopenedBoxAfterReload = await wrapperBox(page, "map");
  check(
    "the restored (post-collapse-round-trip) height survives a reload too",
    Math.abs(reopenedBoxAfterReload.height - resizedHeight) <= 3,
    JSON.stringify({ afterReload: reopenedBoxAfterReload.height, expected: resizedHeight })
  );

  // ── 6. Cross-panel independence: none of the map panel's resizing (or
  //    the earlier header drag) ever moved or resized the untouched combat
  //    panel. ──
  const combatBoxAfterAll = await wrapperBox(page, "combat");
  check(
    "resizing/dragging the map panel never affects the combat panel's own position or size",
    Math.abs(combatBoxAfterAll.x - combatBoxBaseline.x) <= 1 &&
      Math.abs(combatBoxAfterAll.y - combatBoxBaseline.y) <= 1 &&
      Math.abs(combatBoxAfterAll.height - combatBoxBaseline.height) <= 1,
    JSON.stringify({ before: combatBoxBaseline, after: combatBoxAfterAll })
  );

  // ── 7. Bounds: dragging past either the floor or the ceiling clamps
  //    rather than breaking layout. ──
  const dragUp = await beginResizeDrag(page, "map");
  await page.mouse.move(dragUp.startX, dragUp.startY - 1500, { steps: 10 });
  await page.mouse.up();
  await sleep(300);
  const shrunkBox = await wrapperBox(page, "map");
  check(
    `dragging the resize handle far past the floor clamps at the panel's MIN_HEIGHT (${MIN_HEIGHT_MAP}px), not less`,
    Math.abs(shrunkBox.height - MIN_HEIGHT_MAP) <= 2 && shrunkBox.height > 0,
    JSON.stringify({ height: shrunkBox.height, expectedMin: MIN_HEIGHT_MAP })
  );

  const dragDown = await beginResizeDrag(page, "map");
  await page.mouse.move(dragDown.startX, dragDown.startY + 3000, { steps: 10 });
  await page.mouse.up();
  await sleep(300);
  const grownBox = await wrapperBox(page, "map");
  const expectedMax = VIEWPORT.height * MAX_HEIGHT_VIEWPORT_FRACTION;
  check(
    `dragging the resize handle far past the ceiling clamps at roughly ${MAX_HEIGHT_VIEWPORT_FRACTION * 100}% of the viewport, not off-screen`,
    grownBox.height <= expectedMax + 3 && grownBox.y + grownBox.height <= VIEWPORT.height + 3,
    JSON.stringify({ height: grownBox.height, expectedMax, bottom: grownBox.y + grownBox.height, viewportHeight: VIEWPORT.height })
  );

  // ── 8. Regression: combat is STILL untouched after all of this. ──
  const combatBoxFinal = await wrapperBox(page, "combat");
  check(
    "combat panel remains untouched after every map-panel bounds test too",
    Math.abs(combatBoxFinal.x - combatBoxBaseline.x) <= 1 &&
      Math.abs(combatBoxFinal.y - combatBoxBaseline.y) <= 1 &&
      Math.abs(combatBoxFinal.height - combatBoxBaseline.height) <= 1,
    JSON.stringify({ baseline: combatBoxBaseline, final: combatBoxFinal })
  );
} finally {
  await browser.close();
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
console.log("\nAll panel resize checks passed.");
process.exit(0);
