#!/usr/bin/env node
// Bridges and stairs verification (a post-roadmap addition, not one of the
// numbered prompts) — a crossing structure is an ordinary placed map OBJECT
// (map_objects.crossing_type, migration 0053_crossing_structures.sql), not
// a new terrain_type. See src/data-access/mapObjects.ts's CrossingType doc
// comment for the full design; src/rules-engine/movement.ts's own
// CrossingType comment for the cost-side mechanics.
//
// Real signed-in Playwright browser throughout (a single DM client is
// sufficient: every mechanic under test — handleTokenLanded's fall
// resolution, dragPathCost/commitTokenMove's cost accounting — is gated on
// `currentUserIsDM` and runs entirely on the DM's own client; unlike
// verify-pits-and-falling.mjs this script isn't proving the OTHER-client
// broadcast path, so a second browser buys nothing here), driving the REAL
// map editor and Game Room UIs. Covers:
//   1. The editor's real object palette offers "Bridge" and "Stairs" as
//      placeable presets (the Chest-preset pattern); placing each tags the
//      created map_objects row with the right crossing_type, shown live via
//      a real UI hint — a real screenshot included.
//   2. A token crossing a 10ft+ pit cell WITH a bridge present takes no
//      fall damage and is never made prone (a real move, real HP/condition
//      checks).
//   3. The SAME pit cell WITHOUT a bridge still falls exactly as before
//      (regression against verify-pits-and-falling.mjs's own mechanic,
//      unregressed).
//   4. A token entering a water+difficult cell WITH a bridge is charged
//      exactly the flat 5 ft cost, not the usual double — verified via the
//      REAL move_combat_token RPC's persisted combat_combatants.
//      movement_used_feet, compared against the SAME cell WITHOUT a bridge
//      (which still costs double, unregressed).
//   5. A token entering a raised cell WITH stairs pays no SRD climbing
//      surcharge, compared against the SAME elevation change WITHOUT
//      stairs (which still costs the full surcharge, unregressed) — same
//      movement_used_feet proof as #4.
//   6. Regression: placing a bridge object on an ordinary cell that is
//      neither a pit nor difficult/water nor an elevation change changes
//      NOTHING about that cell's cost or rendering.
//
// Every "move onto a specific cell" step voids out every OTHER cell on that
// small test map first (via the DM's own authenticated client) so a blind
// canvas click can only ever land on void (a harmless miss/deselect) or the
// one real destination — verify-pits-and-falling.mjs's own established
// technique for making a blind WebGL click deterministic.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its dedicated port isn't already serving.
// Usage: node scripts/db/verify-bridges-and-stairs.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { createServer } from "vite";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port — this machine runs several concurrent agent
// worktrees, each potentially squatting on the common ports with their OWN
// checkout's dev server (verify-pits-and-falling.mjs's own reasoning).
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 3913);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

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
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

// Same floating-panel-occlusion fix verify-pits-and-falling.mjs established:
// collapse everything except combat/tokens so the small test map's cells
// stay clickable.
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  map: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `bridges-stairs-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Bridges ${label}`,
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

/** Blind center-out scan over the canvas (verify-pits-and-falling.mjs's own
 * `scanClick`) — no way to compute a WebGL raycast target from camera math,
 * so this discovers a working screen point empirically. `exclude` skips
 * points too close to an already-known point. */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.25, xTo = 0.75, yFrom = 0.3, yTo = 0.75, step = 16, settleMs = 110, exclude = [], onMiss, label = "" } = opts;
  let box = await page.locator("canvas").boundingBox();
  const viewport = page.viewportSize();
  const minSize = viewport ? Math.min(viewport.width, viewport.height) * 0.5 : 400;
  for (let i = 0; i < 20 && (!box || box.width < minSize || box.height < minSize); i++) {
    await sleep(200);
    box = await page.locator("canvas").boundingBox();
  }
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
      if (exclude.some((e) => Math.hypot(e.x - point.x, e.y - point.y) < (e.radius ?? 20))) continue;
      if (!(await isCanvasPoint(page, point))) continue;
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) {
        console.log(`  scanClick${label ? ` (${label})` : ""}: found`);
        return point;
      }
      if (onMiss) await onMiss(point);
    }
  }
  console.log(`  scanClick${label ? ` (${label})` : ""}: exhausted every candidate point — not found`);
  return null;
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function pollUntil(fn, { timeoutMs = 10000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

async function dismissTurnCameraIfShown(page) {
  if (await isVisible(page, "turn-camera-dismiss")) {
    await page.click('[data-testid="turn-camera-dismiss"]');
    await sleep(300);
  }
}

async function characterRow(id) {
  const { data, error } = await admin.from("characters").select().eq("id", id).single();
  if (error) throw error;
  return data;
}

async function tokenRow(id) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

async function combatantRow(encounterId, tokenId) {
  const { data, error } = await admin
    .from("combat_combatants")
    .select()
    .eq("encounter_id", encounterId)
    .eq("token_id", tokenId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Upserts real map_cells rows via the DM's own authenticated client and
 * throws on any RLS/validation error instead of silently swallowing it —
 * every row explicitly carries the SAME full column set (ground_type/
 * water_flow_direction included, defaulted, even on a row that doesn't
 * care about them) so a single batch of otherwise-heterogeneous-shaped
 * objects can never trip up PostgREST's one-statement bulk insert. */
async function upsertCells(dmClient, rows) {
  const { error } = await dmClient.from("map_cells").upsert(
    rows.map((row) => ({
      ground_type: "default",
      water_flow_direction: null,
      ...row,
    })),
    { onConflict: "map_id,x,y" }
  );
  if (error) throw new Error(`upserting map_cells failed: ${error.message}`);
}

/** Voids every cell in a WxH grid except the ones in `keep` — a real
 * RLS-authorized write via the DM's OWN client, verify-pits-and-falling.mjs's
 * own technique for making a blind click deterministic (only void, a
 * harmless miss, or the one real destination are ever clickable). */
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

async function startCombatAndGetCombatant(dmRoom, campaignId, tokenId) {
  await dmRoom.click('[data-testid="start-combat-button"]');
  const encounter = await pollUntil(async () => {
    const { data } = await admin
      .from("combat_encounters")
      .select("id")
      .eq("campaign_id", campaignId)
      .is("ended_at", null)
      .maybeSingle();
    return data;
  });
  check("Start combat creates an active encounter", encounter !== undefined && encounter !== null);
  const combatant = await pollUntil(() => combatantRow(encounter.id, tokenId));
  check("the token joined the encounter as a combatant", combatant !== undefined && combatant !== null);
  await dmRoom.waitForSelector('[data-testid="combat-panel"]', { timeout: 15000 });
  await dismissTurnCameraIfShown(dmRoom);
  return { encounter, combatant };
}

async function endCombat(dmRoom, campaignId) {
  await dmRoom.click('[data-testid="end-combat-button"]');
  await pollUntil(async () => {
    const { data } = await admin
      .from("combat_encounters")
      .select("id")
      .eq("campaign_id", campaignId)
      .is("ended_at", null)
      .maybeSingle();
    return data === null ? true : null;
  });
}

/** The click-select-to-move gesture (verify-token-click-select.mjs's own
 * pattern): click the token's own marker to select it, then click the
 * (voidExcept-guaranteed-unique) destination cell to confirm the tracked
 * move. `onMiss` re-selects the token if a stray click deselected it —
 * the exact `reselectOnMiss` precedent, inlined here since this script only
 * ever needs it for this one gesture. */
async function clickSelectMove(page, tokenId, destX, destY) {
  const selectionState = () => readMirror(page, "token-selection-state");
  const tokenPoint = await scanClick(
    page,
    async () => (await selectionState()).selectedTokenId === tokenId,
    { label: "select token" }
  );
  if (!tokenPoint) return null;
  const destPoint = await scanClick(
    page,
    async () => {
      const row = await tokenRow(tokenId);
      return row.x === destX && row.y === destY;
    },
    {
      label: "confirm destination",
      exclude: [{ ...tokenPoint, radius: 14 }],
      onMiss: async () => {
        const state = await selectionState();
        if (state.selectedTokenId !== tokenId) {
          await page.mouse.click(tokenPoint.x, tokenPoint.y);
          await sleep(200);
        }
      },
    }
  );
  return destPoint;
}

await ensureDevServer();

// The app's REAL rules-engine module, loaded through vite exactly the way
// verify-water-terrain.mjs/verify-token-click-select.mjs do — the
// structural cost check below (phase 6) runs the SAME cellMovementCost the
// Game Room ships, fed real persisted rows, not a hand-rolled lookalike.
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
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({
    id: campaignId,
    name: "Bridges and stairs test",
    creator: dm.id,
    // Freeform: nothing under test is action-economy-gated; Strict mode
    // would otherwise hard-reject an over-budget move instead of just
    // recording it, which is exactly what phase 5's "without stairs" case
    // needs to observe.
    action_economy_strict: false,
  });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const ariaId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: ariaId,
    campaign_id: campaignId,
    owner_id: dm.id,
    name: "Aria Spanwell",
    race: "Human",
    class: "Adventurer",
    level: 1,
    strength: 10,
    dexterity: 14,
    constitution: 14,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 100,
    max_hp: 100,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const ROOM_VIEWPORT = { width: 1920, height: 1080 };
  const dmContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));

  async function loadEditor(page, mapId) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
    await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  }
  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  }
  async function resetHp() {
    await admin.from("characters").update({ current_hp: 100 }).eq("id", ariaId);
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — the real editor object palette offers "Bridge" and "Stairs";
  // placing each tags the created row with the right crossing_type.
  // ════════════════════════════════════════════════════════════════════
  const { data: presetAssets } = await admin
    .from("asset_library")
    .select("id, name")
    .eq("source_type", "preset")
    .in("name", ["Bridge", "Stairs"]);
  const bridgeAssetId = presetAssets?.find((a) => a.name === "Bridge")?.id;
  const stairsAssetId = presetAssets?.find((a) => a.name === "Stairs")?.id;
  check(
    "the Bridge preset asset exists (migration 0053) and the pre-existing Stairs preset is still there",
    Boolean(bridgeAssetId) && Boolean(stairsAssetId),
    JSON.stringify(presetAssets)
  );

  const mapEditorId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapEditorId,
    campaign_id: campaignId,
    name: "Crossing structures editor test",
    grid_width: 4,
    grid_height: 4,
  });

  const editorPage = await dmContext.newPage();
  await loadEditor(editorPage, mapEditorId);
  await editorPage.click('[data-testid="tool-object"]');
  check(
    "the object palette offers a Bridge card",
    await editorPage.locator(`[data-testid="asset-${bridgeAssetId}"]`).isVisible().catch(() => false)
  );
  check(
    "the object palette offers a Stairs card",
    await editorPage.locator(`[data-testid="asset-${stairsAssetId}"]`).isVisible().catch(() => false)
  );

  await editorPage.click(`[data-testid="asset-${bridgeAssetId}"]`);
  const bridgePlacedAt = await scanClick(
    editorPage,
    async () => {
      const { data } = await admin.from("map_objects").select("id").eq("map_id", mapEditorId);
      return (data ?? []).length >= 1;
    },
    EDITOR_SCAN
  );
  check("clicking a cell with Bridge selected places a real object", bridgePlacedAt !== null);
  const bridgeHintText = await editorPage.textContent('[data-testid="object-crossing-hint"]').catch(() => null);
  check(
    "the editor shows the Bridge crossing hint immediately after placement",
    Boolean(bridgeHintText) && /Bridge/i.test(bridgeHintText ?? ""),
    bridgeHintText ?? "not found"
  );
  const { data: objectsAfterBridge } = await admin.from("map_objects").select().eq("map_id", mapEditorId);
  const bridgeObjectRow = (objectsAfterBridge ?? [])[0];
  check(
    "the placed object's row is tagged crossing_type='bridge'",
    bridgeObjectRow?.crossing_type === "bridge" && bridgeObjectRow?.asset_id === bridgeAssetId,
    JSON.stringify(bridgeObjectRow)
  );

  await editorPage.click(`[data-testid="asset-${stairsAssetId}"]`);
  const stairsPlacedAt = await scanClick(
    editorPage,
    async () => {
      const { data } = await admin.from("map_objects").select("id").eq("map_id", mapEditorId);
      return (data ?? []).length >= 2;
    },
    { ...EDITOR_SCAN, exclude: [{ ...bridgePlacedAt, radius: 25 }] }
  );
  check("clicking a different cell with Stairs selected places a second real object", stairsPlacedAt !== null);
  const stairsHintText = await editorPage.textContent('[data-testid="object-crossing-hint"]').catch(() => null);
  check(
    "the editor shows the Stairs crossing hint immediately after placement",
    Boolean(stairsHintText) && /Stairs/i.test(stairsHintText ?? ""),
    stairsHintText ?? "not found"
  );
  const { data: objectsAfterStairs } = await admin.from("map_objects").select().eq("map_id", mapEditorId);
  const stairsObjectRow = (objectsAfterStairs ?? []).find((o) => o.asset_id === stairsAssetId);
  check(
    "the second placed object's row is tagged crossing_type='stairs'",
    stairsObjectRow?.crossing_type === "stairs",
    JSON.stringify(stairsObjectRow)
  );

  await editorPage.screenshot({ path: join(SCRATCH_DIR, "bridges-stairs-editor-placement.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "bridges-stairs-editor-placement.png")}`);

  const dmRoom = await dmContext.newPage();

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — a token crossing a 10ft+ pit cell WITH a bridge present
  // takes no fall damage and is never made prone.
  // ════════════════════════════════════════════════════════════════════
  const mapPitBridgeId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapPitBridgeId,
    campaign_id: campaignId,
    name: "Pit with bridge",
    grid_width: 4,
    grid_height: 4,
  });
  const pitX = 2;
  const pitY = 2;
  await upsertCells(dm.client, [
    { map_id: mapPitBridgeId, x: pitX, y: pitY, elevation: -2, terrain_type: "pit", light_level: "bright" },
  ]);
  await voidExcept(dm.client, mapPitBridgeId, 4, 4, [{ x: 0, y: 0 }, { x: pitX, y: pitY }]);
  await admin.from("map_objects").insert({
    map_id: mapPitBridgeId,
    asset_id: bridgeAssetId,
    x: pitX,
    y: pitY,
    elevation: 0,
    rotation: 0,
    crossing_type: "bridge",
  });

  const tokenPitBridgeId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: tokenPitBridgeId,
    map_id: mapPitBridgeId,
    character_id: ariaId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });
  await admin.from("campaigns").update({ live_map: mapPitBridgeId }).eq("id", campaignId);
  await loadRoom(dmRoom);
  await sleep(1000);

  const { combatant: pitBridgeCombatant } = await startCombatAndGetCombatant(dmRoom, campaignId, tokenPitBridgeId);

  const pitBridgeMirror = await readMirror(dmRoom, "table-surface-state");
  check(
    "the render-state mirror shows the bridge on the pit cell",
    pitBridgeMirror.crossingByCell?.[`${pitX},${pitY}`] === "bridge",
    JSON.stringify(pitBridgeMirror.crossingByCell)
  );

  await dmRoom.click(`[data-testid="move-token-${tokenPitBridgeId}"]`);
  const bridgedFallPoint = await scanClick(
    dmRoom,
    async () => {
      const row = await tokenRow(tokenPitBridgeId);
      return row.x === pitX && row.y === pitY;
    },
    { label: "bridged pit" }
  );
  check("the token can be moved onto the bridged pit cell", bridgedFallPoint !== null);
  await sleep(2000); // give any (unwanted) fall resolution time to happen

  const afterBridgedFall = await characterRow(ariaId);
  check(
    "crossing the pit cell WITH a bridge takes NO fall damage",
    afterBridgedFall.current_hp === 100,
    `hp=${afterBridgedFall.current_hp}`
  );
  const bridgedProne = await admin
    .from("combatant_conditions")
    .select()
    .eq("combatant_id", pitBridgeCombatant.id)
    .eq("condition_key", "prone")
    .maybeSingle();
  check("crossing the pit cell WITH a bridge is never made prone", bridgedProne.data === null);
  const bridgedToken = await tokenRow(tokenPitBridgeId);
  check(
    "the token still lands on the bridged pit cell itself (not rejected, not bounced elsewhere)",
    bridgedToken.x === pitX && bridgedToken.y === pitY,
    JSON.stringify(bridgedToken)
  );

  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "bridges-stairs-pit-bridge-safe.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "bridges-stairs-pit-bridge-safe.png")}`);

  await endCombat(dmRoom, campaignId);

  // ════════════════════════════════════════════════════════════════════
  // Phase 3 — the SAME pit cell WITHOUT a bridge still falls exactly as
  // before (regression against the existing pits-and-falling mechanic).
  // ════════════════════════════════════════════════════════════════════
  const mapPitNoBridgeId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapPitNoBridgeId,
    campaign_id: campaignId,
    name: "Pit without bridge",
    grid_width: 4,
    grid_height: 4,
  });
  await upsertCells(dm.client, [
    { map_id: mapPitNoBridgeId, x: pitX, y: pitY, elevation: -2, terrain_type: "pit", light_level: "bright" },
  ]);
  await voidExcept(dm.client, mapPitNoBridgeId, 4, 4, [{ x: 0, y: 0 }, { x: pitX, y: pitY }]);

  const tokenPitNoBridgeId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: tokenPitNoBridgeId,
    map_id: mapPitNoBridgeId,
    character_id: ariaId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });
  await resetHp();
  await admin.from("campaigns").update({ live_map: mapPitNoBridgeId }).eq("id", campaignId);
  await dmRoom.reload();
  await dmRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  const { combatant: noBridgeCombatant } = await startCombatAndGetCombatant(dmRoom, campaignId, tokenPitNoBridgeId);

  await dmRoom.click(`[data-testid="move-token-${tokenPitNoBridgeId}"]`);
  const unbridgedFallPoint = await scanClick(
    dmRoom,
    async () => {
      const row = await tokenRow(tokenPitNoBridgeId);
      return row.x === pitX && row.y === pitY;
    },
    { label: "unbridged pit" }
  );
  check("the token can be moved onto the unbridged pit cell", unbridgedFallPoint !== null);

  const afterUnbridgedFall = await pollUntil(async () => {
    const row = await characterRow(ariaId);
    return row.current_hp !== 100 ? row : null;
  });
  check(
    "crossing the SAME pit cell WITHOUT a bridge still deals real fall damage (unregressed)",
    afterUnbridgedFall !== null,
    afterUnbridgedFall ? `hp=${afterUnbridgedFall.current_hp}` : "hp never changed"
  );
  const unbridgedProne = await pollUntil(async () => {
    const { data } = await admin
      .from("combatant_conditions")
      .select()
      .eq("combatant_id", noBridgeCombatant.id)
      .eq("condition_key", "prone")
      .maybeSingle();
    return data;
  });
  check(
    "crossing the SAME pit cell WITHOUT a bridge still knocks the mover prone (unregressed)",
    unbridgedProne !== undefined && unbridgedProne !== null
  );

  await endCombat(dmRoom, campaignId);

  // ════════════════════════════════════════════════════════════════════
  // Phase 4 — a water+difficult cell WITH a bridge costs exactly the flat
  // 5 ft, not the usual double; the SAME cell WITHOUT a bridge still costs
  // double (unregressed) — proven via the real move_combat_token RPC's
  // persisted movement_used_feet, a real committed tracked move.
  // ════════════════════════════════════════════════════════════════════
  async function waterBridgeCostPhase(withBridge) {
    const mapId = crypto.randomUUID();
    await admin.from("campaign_maps").insert({
      id: mapId,
      campaign_id: campaignId,
      name: withBridge ? "Water+difficult with bridge" : "Water+difficult without bridge",
      grid_width: 3,
      grid_height: 3,
    });
    await upsertCells(dm.client, [
      { map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
      {
        map_id: mapId,
        x: 1,
        y: 0,
        elevation: 0,
        terrain_type: "difficult",
        light_level: "bright",
        ground_type: "water",
        water_flow_direction: "east",
      },
    ]);
    await voidExcept(dm.client, mapId, 3, 3, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    if (withBridge) {
      await admin.from("map_objects").insert({
        map_id: mapId,
        asset_id: bridgeAssetId,
        x: 1,
        y: 0,
        elevation: 0,
        rotation: 0,
        crossing_type: "bridge",
      });
    }

    const tokenId = crypto.randomUUID();
    await admin.from("map_tokens").insert({
      id: tokenId,
      map_id: mapId,
      character_id: ariaId,
      x: 0,
      y: 0,
      elevation: 0,
      allegiance: "party",
    });
    await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
    await dmRoom.reload();
    await dmRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

    const { combatant } = await startCombatAndGetCombatant(dmRoom, campaignId, tokenId);
    const usedBefore = combatant.movement_used_feet;

    const movedPoint = await clickSelectMove(dmRoom, tokenId, 1, 0);
    check(
      `the click-select-to-move gesture lands the token on the water+difficult cell (${withBridge ? "with" : "without"} bridge)`,
      movedPoint !== null
    );

    const combatantAfter = await pollUntil(async () => {
      const row = await combatantRow(combatant.encounter_id, tokenId);
      return row && row.movement_used_feet !== usedBefore ? row : null;
    });
    const feetCharged = combatantAfter ? combatantAfter.movement_used_feet - usedBefore : null;

    await endCombat(dmRoom, campaignId);
    return feetCharged;
  }

  const feetWithBridge = await waterBridgeCostPhase(true);
  check(
    "entering a water+difficult cell WITH a bridge costs exactly the flat 5 ft, not double",
    feetWithBridge === 5,
    `feetCharged=${feetWithBridge}`
  );
  const feetWithoutBridge = await waterBridgeCostPhase(false);
  check(
    "the SAME water+difficult cell WITHOUT a bridge still costs double, 10 ft (unregressed)",
    feetWithoutBridge === 10,
    `feetCharged=${feetWithoutBridge}`
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 5 — a raised cell WITH stairs pays no climbing surcharge; the
  // SAME elevation change WITHOUT stairs still pays the full surcharge
  // (unregressed) — same real movement_used_feet proof as phase 4.
  // ════════════════════════════════════════════════════════════════════
  async function stairsCostPhase(withStairs) {
    const mapId = crypto.randomUUID();
    await admin.from("campaign_maps").insert({
      id: mapId,
      campaign_id: campaignId,
      name: withStairs ? "Elevation change with stairs" : "Elevation change without stairs",
      grid_width: 3,
      grid_height: 3,
    });
    await upsertCells(dm.client, [
      { map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
      // 2 elevation steps = 10 ft climbed — a real, substantial SRD
      // surcharge (20 ft: 1 extra foot per foot climbed) to make the
      // waiver unmistakable.
      { map_id: mapId, x: 1, y: 0, elevation: 2, terrain_type: "normal", light_level: "bright" },
    ]);
    await voidExcept(dm.client, mapId, 3, 3, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    if (withStairs) {
      await admin.from("map_objects").insert({
        map_id: mapId,
        asset_id: stairsAssetId,
        x: 1,
        y: 0,
        elevation: 2,
        rotation: 0,
        crossing_type: "stairs",
      });
    }

    const tokenId = crypto.randomUUID();
    await admin.from("map_tokens").insert({
      id: tokenId,
      map_id: mapId,
      character_id: ariaId,
      x: 0,
      y: 0,
      elevation: 0,
      allegiance: "party",
    });
    await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
    await dmRoom.reload();
    await dmRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

    const { combatant } = await startCombatAndGetCombatant(dmRoom, campaignId, tokenId);
    const usedBefore = combatant.movement_used_feet;

    const movedPoint = await clickSelectMove(dmRoom, tokenId, 1, 0);
    check(
      `the click-select-to-move gesture lands the token on the raised cell (${withStairs ? "with" : "without"} stairs)`,
      movedPoint !== null
    );

    const combatantAfter = await pollUntil(async () => {
      const row = await combatantRow(combatant.encounter_id, tokenId);
      return row && row.movement_used_feet !== usedBefore ? row : null;
    });
    const feetCharged = combatantAfter ? combatantAfter.movement_used_feet - usedBefore : null;

    await dmRoom.screenshot({
      path: join(SCRATCH_DIR, withStairs ? "bridges-stairs-stairs-no-penalty.png" : "bridges-stairs-no-stairs-penalty.png"),
    });

    await endCombat(dmRoom, campaignId);
    return feetCharged;
  }

  const feetWithStairs = await stairsCostPhase(true);
  check(
    "entering a raised cell WITH stairs costs exactly the flat 5 ft, climbing surcharge waived",
    feetWithStairs === 5,
    `feetCharged=${feetWithStairs}`
  );
  const feetWithoutStairs = await stairsCostPhase(false);
  check(
    "the SAME elevation change WITHOUT stairs still costs the full 25 ft (5 base + 20 climb) — unregressed",
    feetWithoutStairs === 25,
    `feetCharged=${feetWithoutStairs}`
  );
  console.log(`screenshot: ${join(SCRATCH_DIR, "bridges-stairs-stairs-no-penalty.png")}`);
  console.log(`screenshot: ${join(SCRATCH_DIR, "bridges-stairs-no-stairs-penalty.png")}`);

  // ════════════════════════════════════════════════════════════════════
  // Phase 6 — regression: a bridge placed on an ordinary cell that is
  // neither a pit, nor difficult/water, nor an elevation change changes
  // NOTHING about that cell's cost, fall behavior, or terrain rendering.
  // ════════════════════════════════════════════════════════════════════
  const mapNeitherId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapNeitherId,
    campaign_id: campaignId,
    name: "Bridge on plain ground (regression)",
    grid_width: 3,
    grid_height: 3,
  });
  await upsertCells(dm.client, [
    { map_id: mapNeitherId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
    { map_id: mapNeitherId, x: 1, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
  ]);
  await voidExcept(dm.client, mapNeitherId, 3, 3, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  await admin.from("map_objects").insert({
    map_id: mapNeitherId,
    asset_id: bridgeAssetId,
    x: 1,
    y: 0,
    elevation: 0,
    rotation: 0,
    crossing_type: "bridge",
  });

  const tokenNeitherId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: tokenNeitherId,
    map_id: mapNeitherId,
    character_id: ariaId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });
  await resetHp();
  await admin.from("campaigns").update({ live_map: mapNeitherId }).eq("id", campaignId);
  await dmRoom.reload();
  await dmRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  const neitherMirror = await readMirror(dmRoom, "table-surface-state");
  check(
    "the bridged plain cell renders with NO pit/water terrain change — only the object itself is new",
    neitherMirror.crossingByCell?.["1,0"] === "bridge" &&
      (neitherMirror.pitCells ?? []).every((c) => c.key !== "1,0") &&
      !("1,0" in (neitherMirror.groundByCell ?? {})),
    JSON.stringify(neitherMirror)
  );

  const { combatant: neitherCombatant } = await startCombatAndGetCombatant(dmRoom, campaignId, tokenNeitherId);
  const neitherUsedBefore = neitherCombatant.movement_used_feet;
  const neitherMovedPoint = await clickSelectMove(dmRoom, tokenNeitherId, 1, 0);
  check("the click-select-to-move gesture lands the token on the bridged plain cell", neitherMovedPoint !== null);
  const neitherCombatantAfter = await pollUntil(async () => {
    const row = await combatantRow(neitherCombatant.encounter_id, tokenNeitherId);
    return row && row.movement_used_feet !== neitherUsedBefore ? row : null;
  });
  const neitherFeetCharged = neitherCombatantAfter ? neitherCombatantAfter.movement_used_feet - neitherUsedBefore : null;
  check(
    "a bridge on plain, unrelated terrain changes NOTHING about its cost — still the flat 5 ft",
    neitherFeetCharged === 5,
    `feetCharged=${neitherFeetCharged}`
  );
  const neitherHp = await characterRow(ariaId);
  check(
    "a bridge on plain terrain never triggers any fall consequence — HP untouched",
    neitherHp.current_hp === 100,
    `hp=${neitherHp.current_hp}`
  );

  // The same conclusion proven a second way, structurally: the app's OWN
  // cellMovementCost (loaded via vite), fed the real persisted row plus the
  // real crossing_type this phase just wrote, agrees exactly with the
  // real committed cost observed above.
  const { data: neitherCellRow } = await admin
    .from("map_cells")
    .select()
    .eq("map_id", mapNeitherId)
    .eq("x", 1)
    .eq("y", 0)
    .maybeSingle();
  const { data: neitherObjectRow } = await admin
    .from("map_objects")
    .select()
    .eq("map_id", mapNeitherId)
    .eq("x", 1)
    .eq("y", 0)
    .maybeSingle();
  const structuralCost = movementRules.cellMovementCost({
    terrain: neitherCellRow.terrain_type,
    elevationDeltaFeet: 0,
    crossing: neitherObjectRow?.crossing_type ?? null,
  });
  check(
    "the real cellMovementCost function, fed the real persisted row, agrees: still the flat 5 ft",
    structuralCost === movementRules.FEET_PER_CELL,
    `structuralCost=${structuralCost}`
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await vite.close();
  await browser.close();
  if (devServer) devServer.kill();
}
