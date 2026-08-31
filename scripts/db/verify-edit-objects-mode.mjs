#!/usr/bin/env node
// Object click-routing/selectability addition: the project owner's own ask
// after being shown LiveObjectsPanel's coordinate dropdown ("Wall Segment ·
// 10,0") — "the object selector for the DM isn't very useful as its not
// likely they will know the exact map coordinates, please make it so the DM
// clicks an Edit objects button, can then click any object on the map and
// change its details/rotation/delete it".
//
// The fix is a new, DM-only, STICKY "Edit objects" toggle on LiveObjectsPanel
// (GameRoom.tsx's new `editObjectsMode` state). While it's on:
//   - MapSurfaceObject.selectable additionally makes EVERY object on the map
//     a click target, even one with NO configured interactive behavior at
//     all (a plain wall/crate) — today those are never clickable, which is
//     exactly why coordinates were the only way to reach them.
//   - handleSelectMapObject routes a click straight to setEditingLiveObjectId
//     instead of firing the object's trigger/opening its container, so a DM
//     in this mode clicking a chest never accidentally opens it.
// Once selected this way, the editor/drag-to-move/delete are all the SAME
// pre-existing tools the coordinate dropdown and pending-reveal Edit button
// already reach — nothing downstream changed.
//
// Covers, all through the real Game Room UI:
//   1. Entering edit-objects mode (the toggle button + its hint).
//   2. Clicking an object with NO configured behavior at all, in edit mode,
//      opens its editor (not a trigger/no-op) — proves the new selectability
//      clause, since the ordinary trigger-gate could never have let this
//      click land at all.
//   3. Clicking an object that DOES have a triggerable behavior, in edit
//      mode, ALSO opens its editor — and its own `triggered` flag is
//      confirmed UNCHANGED, proving the click was routed to the editor, not
//      the ordinary handleTrigger/handleOpenObjectContainer path.
//   4. The mode stays ON across both of the above selections back-to-back —
//      no re-toggle needed between them (a sticky mode, not an arm-once
//      gesture).
//   5. Turning the mode back off makes that exact same screen point (over
//      the plain object) inert again — a cheap, deterministic proof that
//      ordinary (non-edit-mode) selectability is unaffected.
//   6. The ordinary player-facing click-to-trigger path still works exactly
//      as before when edit mode is off (a separate triggerable object, DB
//      `triggered` flips true off a plain canvas click).
//   7. Both PRE-EXISTING selection methods — the coordinate dropdown and the
//      pending-reveal list's own per-object Edit button — still work
//      unchanged.
//   8. A player never sees the "Edit objects" control at all (LiveObjects-
//      Panel itself never mounts for a non-DM viewer), checked at the start
//      AND after the entire DM session above.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its own port isn't already serving.
// Usage: node scripts/db/verify-edit-objects-mode.mjs

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
// checkout's dev server. Never rely on APP_URL's usual localhost:3000
// default, which is this project's live production server, not a fresh
// build of this worktree's own changes (verify-item-containers.mjs's own
// reasoning, copied verbatim).
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 48959);
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

// verify-live-object-move-and-delete.mjs's own precedent: collapse every
// floating Game Room panel not needed by name — map/liveObjects stay
// expanded (this script needs LiveObjectsPanel itself).
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
  combat: { collapsed: true, x: 0, y: 0 },
  tokens: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `edit-objects-mode-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Edit Objects Mode ${label}`,
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

/** This project's own blind center-out scan over the canvas — there's no way
 * to compute a WebGL raycast target from camera math, so a working screen
 * point is discovered empirically by actually clicking candidates and
 * checking a real effect (`done`). Copied verbatim from verify-item-
 * containers.mjs / verify-live-object-move-and-delete.mjs's shared idiom. */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.2, xTo = 0.8, yFrom = 0.25, yTo = 0.8, step = 18, settleMs = 130, exclude = [], label = "" } = opts;
  let box = await page.locator("canvas").boundingBox();
  const viewport = page.viewportSize();
  const minSize = viewport ? Math.min(viewport.width, viewport.height) * 0.5 : 400;
  for (let i = 0; i < 20 && (!box || box.width < minSize || box.height < minSize); i++) {
    await sleep(200);
    box = await page.locator("canvas").boundingBox();
  }
  if (!box) throw new Error("no canvas on the page");
  const startedAt = Date.now();
  let tried = 0;
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
      tried++;
      if (exclude.some((e) => Math.hypot(e.x - point.x, e.y - point.y) < (e.radius ?? 20))) continue;
      if (!(await isCanvasPoint(page, point))) continue;
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) {
        console.log(`  scanClick${label ? ` (${label})` : ""}: found after ${tried} tries, ${Math.round((Date.now() - startedAt) / 1000)}s`);
        return point;
      }
    }
  }
  console.log(`  scanClick${label ? ` (${label})` : ""}: exhausted ${tried} tries — not found`);
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

async function mapObjectRow(objectId) {
  const { data, error } = await admin.from("map_objects").select().eq("id", objectId).maybeSingle();
  if (error) throw error;
  return data;
}

async function selectValue(page) {
  return page.locator('[data-testid="live-object-select"]').inputValue();
}

async function upsertCells(mapId, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rows.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "default", water_flow_direction: null });
    }
  }
  const { error } = await admin.from("map_cells").upsert(rows, { onConflict: "map_id,x,y" });
  if (error) throw new Error(`upserting map_cells failed: ${error.message}`);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Edit objects mode test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // A fully open, odd-sized grid (verify-live-object-move-and-delete.mjs's
  // own reasoning: an even grid puts the canvas's own screen-center exactly
  // on a four-way cell corner, the worst case for click precision).
  const mapId = crypto.randomUUID();
  const GRID = 5;
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Edit objects mode — open room",
    grid_width: GRID,
    grid_height: GRID,
  });
  await upsertCells(mapId, GRID, GRID);

  // ── Objects, all inserted BEFORE the DM's first page load — a raw admin
  //    insert has no live-sync path to an already-open client (no realtime
  //    INSERT subscription exists for map_objects, only UPDATE — confirmed
  //    by inspection, same as verify-live-object-move-and-delete.mjs's own
  //    doc comment). ──
  //
  // dropdownObj: revealed, no behavior — used ONLY to prove the pre-existing
  // coordinate dropdown still works, untouched by this feature.
  const { data: dropdownObj } = await admin
    .from("map_objects")
    .insert({ map_id: mapId, asset_id: ROCK_PRESET_ID, x: 0, y: 2, elevation: 0, rotation: 0, revealed_to_players: true })
    .select()
    .single();

  // plainObj: revealed, NO configured behavior at all — the "plain wall or
  // crate" the task calls out: today, with edit mode off, this has no hit
  // box in the 3D scene whatsoever (MapSurfaceObject.selectable is false),
  // so it can ONLY ever be reached via a coordinate/pending-list pick. The
  // whole point of edit-objects mode is making this exact object clickable.
  const { data: plainObj } = await admin
    .from("map_objects")
    .insert({ map_id: mapId, asset_id: ROCK_PRESET_ID, x: 2, y: 0, elevation: 0, rotation: 0, revealed_to_players: true })
    .select()
    .single();

  // triggerBaselineObj: revealed, player-triggerable toggle_state — used
  // ONLY to prove the ORDINARY click-to-trigger path still fires normally
  // while edit mode is OFF (this feature is additive, not a replacement).
  const { data: triggerBaselineObj } = await admin
    .from("map_objects")
    .insert({
      map_id: mapId,
      asset_id: CHEST_PRESET_ID,
      x: 4,
      y: 2,
      elevation: 0,
      rotation: 0,
      revealed_to_players: true,
      behavior_config: { action: "toggle_state", playerTriggerable: true, triggerOnStepOn: false, triggered: false },
    })
    .select()
    .single();

  // pendingObj: NOT revealed — used ONLY to prove the pre-existing
  // pending-reveal per-object Edit button still works, untouched.
  const { data: pendingObj } = await admin
    .from("map_objects")
    .insert({ map_id: mapId, asset_id: ROCK_PRESET_ID, x: 1, y: 1, elevation: 0, rotation: 0, revealed_to_players: false })
    .select()
    .single();

  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

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
  // Phase 0 — DM-only gating baseline, before anything else happens.
  // ════════════════════════════════════════════════════════════════════
  check("the DM sees LiveObjectsPanel", await isVisible(dmPage, "live-object-panel"));
  check("the DM sees the new 'Edit objects' toggle", await isVisible(dmPage, "live-object-edit-mode-toggle"));
  check("edit-objects mode is off by default (no hint shown)", !(await isVisible(dmPage, "live-object-edit-mode-hint")));

  check("a player's client never mounts LiveObjectsPanel at all", !(await isVisible(alicePage, "live-object-panel")));
  const aliceToggleCountBaseline = await alicePage.locator('[data-testid="live-object-edit-mode-toggle"]').count();
  check(
    "a player's client has ZERO 'Edit objects' toggle elements in the DOM — not just hidden, never rendered, so a player has no way to ever enter this mode",
    aliceToggleCountBaseline === 0
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — regression baseline: with edit mode OFF, the ORDINARY
  // click-to-trigger path still fires exactly as before this feature.
  // ════════════════════════════════════════════════════════════════════
  const baselineTriggerPoint = await scanClick(
    dmPage,
    async () => {
      const row = await mapObjectRow(triggerBaselineObj.id);
      return row?.behavior_config?.triggered === true;
    },
    { label: "click triggerable object with edit mode OFF (baseline)" }
  );
  check(
    "with edit-objects mode OFF, clicking a triggerable object still fires its trigger (existing behavior is unaffected)",
    baselineTriggerPoint !== null
  );

  // A SECOND triggerable object, inserted only now (after the baseline scan
  // above) so it can never be an accidental stray hit during that scan —
  // reached via a reload (see the doc comment on the inserts above).
  const { data: triggerEditModeObj } = await admin
    .from("map_objects")
    .insert({
      map_id: mapId,
      asset_id: CHEST_PRESET_ID,
      x: 2,
      y: 4,
      elevation: 0,
      rotation: 0,
      revealed_to_players: true,
      behavior_config: { action: "toggle_state", playerTriggerable: true, triggerOnStepOn: false, triggered: false },
    })
    .select()
    .single();
  await loadRoom(dmPage);

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — enter edit-objects mode; click a NO-behavior object ("a plain
  // wall or crate") and confirm its editor opens — not a trigger, not a
  // no-op. This is the whole point of the feature: this exact click could
  // never have landed at all before (MapSurfaceObject.selectable required a
  // configured behavior).
  // ════════════════════════════════════════════════════════════════════
  await dmPage.click('[data-testid="live-object-edit-mode-toggle"]');
  check(
    "clicking 'Edit objects' turns the mode on and shows its hint",
    await pollUntil(() => isVisible(dmPage, "live-object-edit-mode-hint"))
  );

  const plainObjPoint = await scanClick(
    dmPage,
    async () => (await selectValue(dmPage)) === plainObj.id,
    { label: "click plain (no-behavior) object in edit mode" }
  );
  check(
    "clicking an object with NO configured behavior at all, while in edit mode, selects it for editing (not a no-op)",
    plainObjPoint !== null
  );
  check(
    "the object editor actually opened for it (Delete button present)",
    await isVisible(dmPage, "live-object-delete")
  );
  check(
    "this was routed to the editor, NOT the ordinary open-container path — no container panel appeared",
    !(await isVisible(dmPage, "container-panel"))
  );

  if (plainObjPoint) {
    await dmPage.screenshot({ path: join(SCRATCH_DIR, "edit-objects-mode-plain-object-selected.png") });
    console.log(`screenshot (plain object selected via edit-objects mode): ${join(SCRATCH_DIR, "edit-objects-mode-plain-object-selected.png")}`);
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 3 — WITHOUT re-toggling anything (proving the mode is sticky, not
  // one-shot), click a SECOND object that DOES have a triggerable behavior.
  // It must ALSO open the editor, and its trigger must NOT fire.
  // ════════════════════════════════════════════════════════════════════
  const triggerEditPoint = await scanClick(
    dmPage,
    async () => (await selectValue(dmPage)) === triggerEditModeObj.id,
    { label: "click triggerable object while in edit mode" }
  );
  check(
    "clicking a triggerable object, while in edit mode, ALSO selects it for editing (mode stayed on with no re-toggle needed)",
    triggerEditPoint !== null
  );
  check(
    "the object editor opened for the triggerable object too (Delete button present)",
    await isVisible(dmPage, "live-object-delete")
  );
  const triggerEditRowAfter = await mapObjectRow(triggerEditModeObj.id);
  check(
    "the triggerable object's OWN trigger did NOT fire while in edit mode — it stayed untriggered",
    triggerEditRowAfter?.behavior_config?.triggered === false,
    JSON.stringify(triggerEditRowAfter?.behavior_config)
  );
  check(
    "no container panel opened for it either",
    !(await isVisible(dmPage, "container-panel"))
  );
  check(
    "edit-objects mode is STILL active after two consecutive selections — a sticky mode, not an arm-once gesture",
    await isVisible(dmPage, "live-object-edit-mode-hint")
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 4 — turn the mode back off; the EXACT same screen point that just
  // selected the plain object goes inert again (cheap, deterministic proof
  // that ordinary, non-edit-mode selectability is unaffected — reuses the
  // point found in Phase 2 rather than an expensive "scan and confirm
  // nothing is ever found" sweep).
  // ════════════════════════════════════════════════════════════════════
  await dmPage.selectOption('[data-testid="live-object-select"]', "");
  await dmPage.click('[data-testid="live-object-edit-mode-toggle"]');
  check(
    "clicking 'Edit objects' again turns the mode off and hides its hint",
    await pollUntil(async () => !(await isVisible(dmPage, "live-object-edit-mode-hint")))
  );

  if (plainObjPoint) {
    await dmPage.mouse.click(plainObjPoint.x, plainObjPoint.y);
    await sleep(500);
    const valueAfterOff = await selectValue(dmPage);
    check(
      "with edit mode OFF, clicking that exact same point (over the plain, no-behavior object) does nothing at all",
      valueAfterOff === "",
      `select value was "${valueAfterOff}"`
    );
  } else {
    check("Phase 4's reused-point regression check could run", false, "Phase 2 never found the plain object's screen point");
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 5 — both PRE-EXISTING selection methods still work, unchanged.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.selectOption('[data-testid="live-object-select"]', dropdownObj.id);
  check(
    "the coordinate dropdown still selects an object for editing exactly as before",
    await pollUntil(() => isVisible(dmPage, "live-object-delete"))
  );

  check(
    "the still-unrevealed object appears in the Pending reveal list",
    await isVisible(dmPage, `live-object-pending-${pendingObj.id}`)
  );
  await dmPage.click(`[data-testid="live-object-edit-${pendingObj.id}"]`);
  check(
    "the pending-reveal list's own per-object Edit button still opens that object's editor exactly as before",
    await pollUntil(async () => (await selectValue(dmPage)) === pendingObj.id)
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 6 — final gating regression: alice's client (never reloaded this
  // entire time) still never gained the control, after the whole DM session
  // above.
  // ════════════════════════════════════════════════════════════════════
  const aliceToggleCountFinal = await alicePage.locator('[data-testid="live-object-edit-mode-toggle"]').count();
  check(
    "a player's client still has zero 'Edit objects' toggle elements, throughout the entire DM session above",
    aliceToggleCountFinal === 0
  );
  check(
    "a player's client still never mounts LiveObjectsPanel, throughout the entire DM session above",
    !(await isVisible(alicePage, "live-object-panel"))
  );

  check("no uncaught page errors occurred", pageErrors.length === 0, pageErrors.join("\n"));
} finally {
  // Cleanup — this shared dev Supabase stack runs many concurrent
  // worktrees. Deleting the campaign CASCADEs its maps/objects/tokens
  // (campaign_maps.campaign_id, map_objects.map_id are both ON DELETE
  // CASCADE per their own FKs).
  await admin.from("campaigns").delete().eq("name", "Edit objects mode test").eq("creator", dm.id);
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
