#!/usr/bin/env node
// Map Editor Batch A6 verification: the general step-on trigger system,
// the built-in Pressure Plate preset, and the shared interaction_events
// table both the (pre-existing) click-trigger path and the new step-on
// path write to.
//
// Covers, all through the real editor/Game Room UIs:
//   1. The built-in "Pressure Plate" preset appears in the editor's asset
//      palette and, placed via the real Place-mode flow, comes pre-wired
//      with behavior_config.triggerOnStepOn (and a real configured action)
//      out of the box — no manual BehaviorEditor step required.
//   2. A DM tags the placed plate (map_objects.tag) and configures a
//      second, ordinary object as a ordinary click-triggered switch via
//      the real BehaviorEditor UI.
//   3. In the Game Room, moving a PLAYER-CHARACTER token onto the plate's
//      cell fires it via the exact same trigger_map_object RPC a click
//      uses, flips its live behavior_config.triggered, and writes a
//      correctly-populated interaction_events row (source, action_type,
//      tag, actor, timestamp).
//   4. Moving an NPC token onto the SAME cell fires it again — step-on
//      triggers are not player-only — writing a second event row.
//   5. Clicking the switch's own trigger button (the pre-existing
//      click-trigger path, via the Map panel's interactive list) writes
//      its own interaction_events row with no tag (none was set).
//
// Concealed-pit fall-through is deliberately NOT re-verified here — this
// prompt's own acceptance criteria is satisfied by the existing, otherwise
// untouched verify-pits-and-falling.mjs still passing (run separately).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its own port isn't already serving.
// Usage: node scripts/db/verify-step-on-triggers.mjs

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
// build of this worktree's own changes.
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 48610);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

const PRESSURE_PLATE_PRESET_ID = "a55e7013-0000-4000-8000-000000000013";
const TORCH_PRESET_ID = "a55e7001-0000-4000-8000-000000000001";

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

// The Game Room's floating panels (DraggablePanel: combat/tokens/dice log/
// quick actions/dice tray/map/handouts) dock at fixed pixel positions,
// several of them centered — exactly where this script's blind canvas scan
// (xFrom/xTo/yFrom/yTo centered on the middle of the viewport) also tries
// to click. verify-pits-and-falling.mjs's own precedent: collapse every
// panel not needed by name, via the real persisted preference (profiles.
// ui_preferences.panelLayout), rather than fight drag gestures at runtime.
// tokens/combat stay expanded — their default corners never cover the
// center — since this script needs the tokens panel's own Move buttons;
// map ALSO stays expanded (unlike that script) since this script needs its
// interactive-object trigger button, and map's own bottom-right corner
// anchor is just as safe as tokens'/combat's own corners.
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `step-on-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Step-on ${label}`,
    ui_preferences: { panelLayout: COLLAPSED_PANEL_LAYOUT },
  });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function isCanvasPoint(page, point) {
  return page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS",
    [point.x, point.y]
  );
}

const EDITOR_SCAN = { xFrom: 0.12, xTo: 0.88, yFrom: 0.22, yTo: 0.72, step: 30, settleMs: 150 };

/** Blind center-out scan over the canvas — this project's own scanClick
 * convention (verify-void-terrain.mjs's original): no way to compute a
 * WebGL raycast target from camera math, so a working screen point is
 * discovered empirically. `exclude` skips points too close to a
 * known point (e.g. a token's own current cell). */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.25, xTo = 0.75, yFrom = 0.3, yTo = 0.75, step = 16, settleMs = 110, exclude = [], label = "" } = opts;
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

async function mapObjectRow(objectId) {
  const { data, error } = await admin.from("map_objects").select().eq("id", objectId).maybeSingle();
  if (error) throw error;
  return data;
}

async function tokenRow(tokenId) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", tokenId).maybeSingle();
  if (error) throw error;
  return data;
}

/** Voids every cell in a WxH grid except the ones in `keep` — called once
 * per placement/move step below with EXACTLY the one destination cell that
 * step needs, so a blind canvas click can only ever land on void (a
 * harmless miss) or that one real destination, never on some OTHER
 * already-revealed cell (which would consume the armed placement/move
 * before the scan ever reaches the intended target). A cell dropped from
 * `keep` on a later call reverts to void — safe, since an already-placed
 * token's stored position never depends on its current cell's terrain (see
 * MapSurface's own object/token rendering, which reads off the token/object
 * row, never the cell). A real RLS-authorized write via the DM's own
 * client, exactly what the editor's own Void brush would persist
 * (verify-pits-and-falling.mjs's own voidExcept precedent). */
async function voidExcept(dmClient, mapId, width, height, keep) {
  const keepKeys = new Set(keep.map(({ x, y }) => `${x},${y}`));
  const rows = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (keepKeys.has(`${x},${y}`)) continue;
      rows.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "void", light_level: "bright" });
    }
  }
  const { error } = await dmClient.from("map_cells").upsert(rows, { onConflict: "map_id,x,y" });
  if (error) throw error;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Step-on triggers test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const characterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: characterId,
    campaign_id: campaignId,
    owner_id: dm.id,
    name: "Trapfinder Tam",
    race: "Human",
    class: "Adventurer",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 10,
    max_hp: 10,
    armor_class: 10,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const mapId = crypto.randomUUID();
  const GRID = 8;
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Step-on trigger room",
    grid_width: GRID,
    grid_height: GRID,
  });

  const ROOM_VIEWPORT = { width: 1920, height: 1080 };
  const dmContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const pageErrors = [];
  const dmPage = await dmContext.newPage();
  dmPage.on("pageerror", (err) => pageErrors.push(String(err)));

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — editor: place a Pressure Plate (from the real asset
  // palette) and confirm it works out of the box, then tag it. Place a
  // second ordinary preset and wire it up as a plain click-triggered
  // switch via the real BehaviorEditor.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await dmPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await dmPage.click('[data-testid="mode-place"]');
  await dmPage.click('[data-testid="tool-object"]');
  await dmPage.waitForSelector('[data-testid="asset-palette"]', { timeout: 10000 });

  check(
    "the Pressure Plate preset appears in the asset palette",
    await isVisible(dmPage, `asset-${PRESSURE_PLATE_PRESET_ID}`)
  );
  await dmPage.click(`[data-testid="asset-${PRESSURE_PLATE_PRESET_ID}"]`);

  const platePoint = await scanClick(dmPage, () => isVisible(dmPage, "selected-object"), {
    ...EDITOR_SCAN,
    label: "place pressure plate",
  });
  check("placing the Pressure Plate via Place mode succeeds", platePoint !== null);

  const { data: plateObjects } = await admin.from("map_objects").select().eq("map_id", mapId);
  check(
    "exactly one Pressure Plate object exists after placement",
    (plateObjects ?? []).length === 1 && plateObjects[0].asset_id === PRESSURE_PLATE_PRESET_ID,
    JSON.stringify(plateObjects)
  );
  const plateId = plateObjects[0].id;
  check(
    "the placed Pressure Plate works out of the box: triggerOnStepOn is already on",
    plateObjects[0].behavior_config?.triggerOnStepOn === true,
    JSON.stringify(plateObjects[0].behavior_config)
  );
  check(
    "the placed Pressure Plate already has a configured action (toggle_state)",
    plateObjects[0].behavior_config?.action === "toggle_state",
    JSON.stringify(plateObjects[0].behavior_config)
  );
  check(
    "the placed Pressure Plate starts un-triggered",
    plateObjects[0].behavior_config?.triggered === false
  );

  // Tag the plate — the human-readable label this batch's shared
  // interaction_events table copies into every event row it produces.
  await dmPage.fill('[data-testid="object-tag-input"]', "Vault Trap");
  await dmPage.click('[data-testid="object-tag-save"]');
  await sleep(400);
  check("the Pressure Plate's tag persisted", (await mapObjectRow(plateId))?.tag === "Vault Trap");

  // A second, ordinary preset (Torch) wired up as a ordinary click-only
  // switch — the pre-existing behavior system, untouched by this batch.
  await dmPage.click(`[data-testid="asset-${TORCH_PRESET_ID}"]`);
  const switchPoint = await scanClick(
    dmPage,
    async () => (await admin.from("map_objects").select().eq("map_id", mapId)).data?.length >= 2,
    { ...EDITOR_SCAN, exclude: [{ ...platePoint, radius: 40 }], label: "place switch" }
  );
  check("placing the second (switch) object succeeds", switchPoint !== null);
  const { data: allObjects } = await admin.from("map_objects").select().eq("map_id", mapId);
  const switchRow = (allObjects ?? []).find((row) => row.id !== plateId);
  check("a second object exists distinct from the plate", switchRow !== undefined, JSON.stringify(allObjects));
  const switchId = switchRow.id;

  await dmPage.selectOption('[data-testid="behavior-action"]', "toggle_state");
  await dmPage.click('[data-testid="behavior-save"]');
  await sleep(400);
  const switchAfterSave = await mapObjectRow(switchId);
  check(
    "the switch's behavior (toggle_state, click-only) saved",
    switchAfterSave?.behavior_config?.action === "toggle_state" &&
      switchAfterSave?.behavior_config?.triggerOnStepOn !== true,
    JSON.stringify(switchAfterSave?.behavior_config)
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — Game Room: a fresh, SMALL dedicated map (verify-pits-and-
  // falling.mjs's own 3x3 precedent — a small grid keeps every cell
  // comfortably inside the Room's table camera, unlike the editor's own
  // wider view). Objects are inserted directly via the DM's own
  // authenticated client (a real RLS-authorized write, exactly what the
  // editor's own placement would persist — Phase 1 above already proved
  // the real Place-mode/BehaviorEditor UI produces this exact shape).
  // Tokens' STARTING positions are seeded directly too (pits-and-falling's
  // own precedent: only the MOVE onto the plate is the real UI gesture
  // under test — a blind scan has no way to land reliably on a specific
  // cell during PLACEMENT, since placement consumes the armed state on
  // whichever valid cell it lands on first).
  // ════════════════════════════════════════════════════════════════════
  const roomMapId = crypto.randomUUID();
  const ROOM_GRID = 3;
  await admin.from("campaign_maps").insert({
    id: roomMapId,
    campaign_id: campaignId,
    name: "Step-on trigger room (small)",
    grid_width: ROOM_GRID,
    grid_height: ROOM_GRID,
  });

  const roomPlateXY = { x: 1, y: 1 };
  const characterStart = { x: 0, y: 0 };
  const npcStart = { x: 2, y: 0 };
  const roomSwitchXY = { x: 2, y: 2 };

  const { data: roomPlateRow, error: roomPlateError } = await dm.client
    .from("map_objects")
    .insert({
      map_id: roomMapId,
      asset_id: PRESSURE_PLATE_PRESET_ID,
      x: roomPlateXY.x,
      y: roomPlateXY.y,
      elevation: 0,
      rotation: 0,
      // The exact shape Phase 1 already proved the real editor UI produces
      // out of the box for this preset.
      behavior_config: { action: "toggle_state", playerTriggerable: false, triggerOnStepOn: true, triggered: false },
      tag: "Vault Trap",
    })
    .select()
    .single();
  if (roomPlateError) throw roomPlateError;
  const roomPlateId = roomPlateRow.id;

  const { data: roomSwitchRow, error: roomSwitchError } = await dm.client
    .from("map_objects")
    .insert({
      map_id: roomMapId,
      asset_id: TORCH_PRESET_ID,
      x: roomSwitchXY.x,
      y: roomSwitchXY.y,
      elevation: 0,
      rotation: 0,
      behavior_config: { action: "toggle_state", playerTriggerable: false, triggerOnStepOn: false, triggered: false },
    })
    .select()
    .single();
  if (roomSwitchError) throw roomSwitchError;
  const roomSwitchId = roomSwitchRow.id;

  const characterTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: characterTokenId,
    map_id: roomMapId,
    character_id: characterId,
    x: characterStart.x,
    y: characterStart.y,
    elevation: 0,
    allegiance: "party",
  });

  // Only the plate's own cell needs to be non-void — the character's
  // starting cell was seeded directly, never clicked into existence.
  await voidExcept(dm.client, roomMapId, ROOM_GRID, ROOM_GRID, [roomPlateXY]);
  await admin.from("campaigns").update({ live_map: roomMapId }).eq("id", campaignId);

  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  // ── Player-character token: MOVE onto the plate. ──
  const beforeEventCount = (
    await admin.from("interaction_events").select("id").eq("map_object_id", roomPlateId)
  ).data?.length ?? 0;

  await dmPage.click(`[data-testid="move-token-${characterTokenId}"]`);
  const movedToPlate = await scanClick(dmPage, async () => {
    const row = await tokenRow(characterTokenId);
    return row?.x === roomPlateXY.x && row?.y === roomPlateXY.y;
  }, { label: "move character onto plate" });
  check("the player-character token can be moved onto the plate's cell", movedToPlate !== null);

  await sleep(500);
  const plateAfterPlayer = await mapObjectRow(roomPlateId);
  check(
    "the plate fired via trigger_map_object when the player-character token landed on it",
    plateAfterPlayer?.behavior_config?.triggered === true,
    JSON.stringify(plateAfterPlayer?.behavior_config)
  );
  const { data: eventsAfterPlayer } = await admin
    .from("interaction_events")
    .select()
    .eq("map_object_id", roomPlateId)
    .order("created_at", { ascending: true });
  check(
    "a step_on_trigger interaction_events row was written for the player-character token",
    (eventsAfterPlayer?.length ?? 0) === beforeEventCount + 1 &&
      eventsAfterPlayer[eventsAfterPlayer.length - 1].action_type === "step_on_trigger" &&
      eventsAfterPlayer[eventsAfterPlayer.length - 1].tag === "Vault Trap" &&
      eventsAfterPlayer[eventsAfterPlayer.length - 1].actor_user_id === dm.id &&
      eventsAfterPlayer[eventsAfterPlayer.length - 1].concealed_pit_id === null &&
      typeof eventsAfterPlayer[eventsAfterPlayer.length - 1].created_at === "string",
    JSON.stringify(eventsAfterPlayer)
  );

  // Move the character back OFF the plate before bringing the NPC in —
  // discovered the hard way: clicking an already-occupied cell always
  // selects/deselects whatever token is already standing there
  // (handleTokenSelect's own "a new selection supersedes any armed
  // move/placement" rule) rather than ever reaching the cell click a
  // second token's move needs, so two tokens can never both be driven onto
  // the SAME cell via blind clicks without vacating it first — and a blind
  // scan trying to click PAST the character to reach some other cell has
  // the identical problem in reverse (it keeps hitting the character
  // itself). This relocation is test-fixture cleanup, not the behavior
  // under test (both real moves ONTO the plate already ran through the
  // genuine UI above/below) — a direct write is the pragmatic way to
  // vacate the cell, picked up by the same reload the NPC's own seeding
  // already needs.
  await admin.from("map_tokens").update({ x: characterStart.x, y: characterStart.y }).eq("id", characterTokenId);

  // ── NPC token: seeded off the plate, then MOVE onto the SAME plate cell
  //    — step-on triggers are not player-only. Seeded directly (not
  //    through the Room's own place-npc UI), then the page reloads to pick
  //    up state it didn't itself write. ──
  await voidExcept(dm.client, roomMapId, ROOM_GRID, ROOM_GRID, [roomPlateXY]);
  const npcTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: npcTokenId,
    map_id: roomMapId,
    npc_name: "Wandering Rat",
    x: npcStart.x,
    y: npcStart.y,
    elevation: 0,
    allegiance: "hostile",
  });
  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  await dmPage.click(`[data-testid="move-token-${npcTokenId}"]`);
  const npcMovedToPlate = await scanClick(dmPage, async () => {
    const row = await tokenRow(npcTokenId);
    return row?.x === roomPlateXY.x && row?.y === roomPlateXY.y;
  }, { label: "move NPC onto plate" });
  check("the NPC token can be moved onto the plate's cell", npcMovedToPlate !== null);

  await sleep(500);
  const plateAfterNpc = await mapObjectRow(roomPlateId);
  check(
    "the plate fired AGAIN (toggled back off) when the NPC token landed on it — step-on triggers are not player-only",
    plateAfterNpc?.behavior_config?.triggered === false,
    JSON.stringify(plateAfterNpc?.behavior_config)
  );
  const { data: eventsAfterNpc } = await admin
    .from("interaction_events")
    .select()
    .eq("map_object_id", roomPlateId)
    .order("created_at", { ascending: true });
  check(
    "a second step_on_trigger interaction_events row was written for the NPC token",
    (eventsAfterNpc?.length ?? 0) === beforeEventCount + 2 &&
      eventsAfterNpc[eventsAfterNpc.length - 1].action_type === "step_on_trigger",
    JSON.stringify(eventsAfterNpc)
  );

  // ── Click-trigger: the pre-existing path, via the Map panel's
  //    interactive list — its own interaction_events row too, with no tag
  //    (none was ever set on the switch). ──
  check(
    "the switch appears in the Map panel's interactive list",
    await isVisible(dmPage, `trigger-${roomSwitchId}`)
  );
  await dmPage.click(`[data-testid="trigger-${roomSwitchId}"]`);
  await sleep(500);
  const switchAfterTrigger = await mapObjectRow(roomSwitchId);
  check(
    "clicking the switch fires it via trigger_map_object",
    switchAfterTrigger?.behavior_config?.triggered === true,
    JSON.stringify(switchAfterTrigger?.behavior_config)
  );
  const { data: switchEvents } = await admin
    .from("interaction_events")
    .select()
    .eq("map_object_id", roomSwitchId);
  check(
    "a click_trigger interaction_events row was written for the switch, with no tag",
    (switchEvents?.length ?? 0) === 1 &&
      switchEvents[0].action_type === "click_trigger" &&
      switchEvents[0].tag === null &&
      switchEvents[0].actor_user_id === dm.id,
    JSON.stringify(switchEvents)
  );

  check("no uncaught page errors occurred", pageErrors.length === 0, pageErrors.join("\n"));
} finally {
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
