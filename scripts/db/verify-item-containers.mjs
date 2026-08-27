#!/usr/bin/env node
// Map Editor Batch A4 verification: item containers — flavor loot living on
// a chest (a MapObject) or inside a still-concealed pit (a concealed_pits
// row), the shared map_object_items table (migration 0060) and its
// claim_map_object_item RPC.
//
// Covers, all through the real editor/Game Room UIs:
//   1. A DM adds an item to a placed Chest via the real map editor's
//      Container-items panel (selecting the chest, filling the form).
//   2. DM-only authoring is enforced server-side: a non-DM member's direct
//      insert attempt against map_object_items is rejected by RLS, not
//      just hidden in the UI.
//   3. A player opens the chest in the Game Room (a real canvas click on
//      the placed object, no configured click-trigger behavior needed),
//      sees its contents, and takes the item — it lands on their
//      character's inventory (a direct DB check), is gone from the
//      container for every connected client (a SECOND client's already-
//      open panel updates live via the real broadcast, not just a fresh
//      re-fetch), and a matching interaction_events row is written
//      (action_type "item_taken", the chest's own id, the item's tag, the
//      taking player as actor).
//   4. A concealed pit can hold items too: the DM adds one via the editor's
//      Concealed-pits list. When a player's token fails its DC 15 DEX save
//      and falls in, the concealed_pits row is deliberately PRESERVED
//      (not cascade-deleted) because it still holds an item — the falling
//      player's own client is offered the contents automatically (the
//      pit's own "opening" moment, since concealed_pits stays DM-only
//      readable even after this reveal). Taking the item removes it,
//      credits their inventory, and writes its own interaction_events row
//      (concealed_pit_id set, no map_object_id) — the now-empty
//      concealed_pits row itself is deliberately left in place rather than
//      cleaned up (see claim_map_object_item's own comment on why: an ON
//      DELETE CASCADE would destroy the very event row just written, in
//      the same transaction).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its own port isn't already serving.
// Usage: node scripts/db/verify-item-containers.mjs

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
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 48910);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

const CHEST_PRESET_ID = "a55e7002-0000-4000-8000-000000000002";

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

// verify-step-on-triggers.mjs's own precedent: collapse every floating Game
// Room panel not needed by name (they dock at fixed pixel positions that
// would otherwise cover the canvas a blind scanClick needs).
// tokens/combat/map stay expanded — this script needs the tokens panel's
// own Move buttons and the map panel's own Containers-list Open buttons,
// same reasoning as verify-step-on-triggers.mjs's own identical layout.
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `item-container-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Item Container ${label}`,
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
 * convention: no way to compute a WebGL raycast target from camera math, so
 * a working screen point is discovered empirically. `exclude` skips points
 * too close to a known point. */
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

async function dismissTurnCameraIfShown(page) {
  if (await isVisible(page, "turn-camera-dismiss")) {
    await page.click('[data-testid="turn-camera-dismiss"]');
    await sleep(300);
  }
}

async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

async function tokenRow(tokenId) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", tokenId).maybeSingle();
  if (error) throw error;
  return data;
}

async function characterRow(id) {
  const { data, error } = await admin.from("characters").select().eq("id", id).single();
  if (error) throw error;
  return data;
}

async function itemsForMapObject(mapObjectId) {
  const { data, error } = await admin.from("map_object_items").select().eq("map_object_id", mapObjectId);
  if (error) throw error;
  return data ?? [];
}

async function itemsForPit(pitId) {
  const { data, error } = await admin.from("map_object_items").select().eq("concealed_pit_id", pitId);
  if (error) throw error;
  return data ?? [];
}

async function concealedPitRowById(pitId) {
  const { data, error } = await admin.from("concealed_pits").select().eq("id", pitId).maybeSingle();
  if (error) throw error;
  return data;
}

async function interactionEventsFor(column, value) {
  const { data, error } = await admin.from("interaction_events").select().eq(column, value).order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Voids every cell in a WxH grid except the ones in `keep` — see
 * verify-step-on-triggers.mjs's own identical helper for why: a blind
 * canvas click can only ever land on void (a harmless miss) or one of the
 * real cells this test actually needs. */
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
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Item containers test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Loot Finder Alice",
    race: "Human",
    class: "Adventurer",
    level: 1,
    strength: 10,
    dexterity: 14,
    constitution: 14,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 50,
    max_hp: 50,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const mapId = crypto.randomUUID();
  const GRID = 4;
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Item containers room",
    grid_width: GRID,
    grid_height: GRID,
  });

  const chestXY = { x: 3, y: 0 };
  const aliceStart = { x: 0, y: 0 };
  const pitXY = { x: 2, y: 2 };

  // The chest — a real object on the map, seeded directly via the DM's own
  // authenticated client (a real RLS-authorized write, exactly what the
  // editor's own Place-mode flow would persist). Placement itself already
  // has its own verify coverage elsewhere; the behavior THIS script tests
  // is authoring/taking its CONTENTS.
  const { data: chestRow, error: chestError } = await dm.client
    .from("map_objects")
    .insert({
      map_id: mapId,
      asset_id: CHEST_PRESET_ID,
      x: chestXY.x,
      y: chestXY.y,
      elevation: 0,
      rotation: 0,
    })
    .select()
    .single();
  if (chestError) throw chestError;
  const chestId = chestRow.id;

  // A concealed pit — same "seed the setup directly, drive only the real
  // behavior under test via the UI" reasoning. Its own creation flow is
  // covered by verify-pits-and-falling.mjs.
  const { data: pitRow, error: pitError } = await dm.client
    .from("concealed_pits")
    .insert({ map_id: mapId, x: pitXY.x, y: pitXY.y, bottom_elevation_steps: -3, save_dc: 15 })
    .select()
    .single();
  if (pitError) throw pitError;
  const pitId = pitRow.id;

  const aliceTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: aliceTokenId,
    map_id: mapId,
    character_id: aliceCharacterId,
    x: aliceStart.x,
    y: aliceStart.y,
    elevation: 0,
    allegiance: "party",
  });

  // Only the chest's own cell stays open for now — the map editor's
  // Place-mode object tool always has SOME asset armed for placement
  // (selectedAssetId defaults to the first palette entry and there is no
  // "deselect" gesture), so any OTHER non-void, object-free cell reachable
  // by the chest-selection scan below would risk a stray accidental
  // placement rather than a harmless miss. aliceStart/pitXY open up further
  // down, once the editor phases are done and only Game Room clicks (which
  // never place anything without an armed token) remain.
  await voidExcept(dm.client, mapId, GRID, GRID, [chestXY]);
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

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — map editor: the DM adds an item to the chest via the real
  // Container-items panel.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await dmPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await dmPage.click('[data-testid="mode-place"]');
  await dmPage.click('[data-testid="tool-object"]');

  const chestSelected = await scanClick(dmPage, () => isVisible(dmPage, "container-items-editor"), {
    ...EDITOR_SCAN,
    label: "select the chest",
  });
  check("the DM can select the placed chest in the map editor", chestSelected !== null);

  check(
    "the chest's Container-items panel starts empty",
    await pollUntil(() => isVisible(dmPage, "container-items-empty"), { timeoutMs: 5000 })
  );

  await dmPage.fill('[data-testid="container-item-name-input"]', "Ring of Protection");
  await dmPage.fill('[data-testid="container-item-description-input"]', "A tarnished silver band.");
  await dmPage.fill('[data-testid="container-item-tag-input"]', "Quest item");
  await dmPage.click('[data-testid="add-container-item-button"]');

  const chestItemsAfterAdd = await pollUntil(async () => {
    const rows = await itemsForMapObject(chestId);
    return rows.length === 1 ? rows : null;
  });
  check(
    "the item was persisted on the chest with the right name/description/tag",
    chestItemsAfterAdd?.[0]?.name === "Ring of Protection" &&
      chestItemsAfterAdd[0].description === "A tarnished silver band." &&
      chestItemsAfterAdd[0].tag === "Quest item" &&
      chestItemsAfterAdd[0].concealed_pit_id === null &&
      chestItemsAfterAdd[0].campaign_id === campaignId,
    JSON.stringify(chestItemsAfterAdd)
  );
  const ringItemId = chestItemsAfterAdd[0].id;

  check(
    "the editor UI reflects the saved item in its list",
    await pollUntil(() => isVisible(dmPage, `container-item-${ringItemId}`), { timeoutMs: 5000 })
  );

  // ── DM-only authoring, enforced server-side (not just UI-hidden): a
  //    non-DM member's direct insert attempt against map_object_items is
  //    rejected by RLS. ──
  const { data: rlsInsertData, error: rlsInsertError } = await alice.client.from("map_object_items").insert({
    campaign_id: campaignId,
    map_object_id: chestId,
    name: "Sneaky Extra Loot",
  });
  check(
    "a non-DM member cannot insert a container item directly — rejected by RLS",
    rlsInsertError !== null && !rlsInsertData,
    JSON.stringify({ rlsInsertError, rlsInsertData })
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — map editor: the DM adds an item to the still-concealed pit
  // via the Concealed-pits list's own Items toggle.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.click('[data-testid="mode-link"]');
  await dmPage.click('[data-testid="tool-concealed-pit"]');
  check(
    "the seeded concealed pit appears in the editor's Concealed-pits list",
    await isVisible(dmPage, `concealed-pit-${pitXY.x}-${pitXY.y}`)
  );
  await dmPage.click(`[data-testid="toggle-concealed-pit-items-${pitXY.x}-${pitXY.y}"]`);
  check(
    "the pit's own Container-items panel opens",
    await isVisible(dmPage, "container-items-editor")
  );
  await dmPage.fill('[data-testid="container-item-name-input"]', "Potion of Healing");
  await dmPage.click('[data-testid="add-container-item-button"]');

  const pitItemsAfterAdd = await pollUntil(async () => {
    const rows = await itemsForPit(pitId);
    return rows.length === 1 ? rows : null;
  });
  check(
    "the item was persisted on the concealed pit (map_object_id null, concealed_pit_id set)",
    pitItemsAfterAdd?.[0]?.name === "Potion of Healing" &&
      pitItemsAfterAdd[0].map_object_id === null &&
      pitItemsAfterAdd[0].concealed_pit_id === pitId,
    JSON.stringify(pitItemsAfterAdd)
  );
  const potionItemId = pitItemsAfterAdd[0].id;

  // The editor phases are done — open the two remaining cells (Alice's
  // token start and the pit) for the Game Room phases below. Safe now:
  // plain cell clicks in the Game Room never place anything without an
  // armed token/placement (unlike the editor's Place-mode object tool).
  await dm.client
    .from("map_cells")
    .upsert(
      [
        { map_id: mapId, x: aliceStart.x, y: aliceStart.y, elevation: 0, terrain_type: "normal", light_level: "bright" },
        { map_id: mapId, x: pitXY.x, y: pitXY.y, elevation: 0, terrain_type: "normal", light_level: "bright" },
      ],
      { onConflict: "map_id,x,y" }
    );

  // ════════════════════════════════════════════════════════════════════
  // Phase 3 — Game Room: the DM and Alice both open the chest; Alice takes
  // the item; the DM's still-open panel (a SECOND connected client) sees
  // it disappear live.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(dmPage);

  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(alicePage);

  // The Map panel's own "Containers" list (Map Editor Batch A4) — a
  // reliable, click-agnostic way to open a chest that has no configured
  // click-trigger action of its own, alongside the raw 3D click on the
  // object itself (GameTableScene's onSelectObject / handleSelectMapObject
  // — real product code, but a placed prop is a small, fiddly target to
  // aim a blind scan at from the Room's default seated camera; this list
  // is the deterministic path this script drives).
  check(
    "the chest appears in the Map panel's Containers list for the DM",
    await pollUntil(() => isVisible(dmPage, `open-container-${chestId}`))
  );
  await dmPage.click(`[data-testid="open-container-${chestId}"]`);
  check("the DM can open the chest in the Game Room", await pollUntil(() => isVisible(dmPage, "container-panel")));
  check(
    "the DM's chest panel shows the Ring of Protection",
    await isVisible(dmPage, `container-panel-item-${ringItemId}`)
  );

  check(
    "the chest appears in the Map panel's Containers list for Alice too",
    await pollUntil(() => isVisible(alicePage, `open-container-${chestId}`))
  );
  await alicePage.click(`[data-testid="open-container-${chestId}"]`);
  check(
    "Alice can open the chest in the Game Room",
    await pollUntil(() => isVisible(alicePage, "container-panel"))
  );
  check(
    "Alice's chest panel shows the Ring of Protection",
    await isVisible(alicePage, `container-panel-item-${ringItemId}`)
  );

  await alicePage.click(`[data-testid="take-container-item-${ringItemId}"]`);

  const ringGoneFromDb = await pollUntil(async () => {
    const rows = await itemsForMapObject(chestId);
    return rows.length === 0;
  });
  check("taking the item removes it from map_object_items", ringGoneFromDb === true);

  const aliceAfterTake = await pollUntil(async () => {
    const row = await characterRow(aliceCharacterId);
    return row.inventory?.some((item) => item.name === "Ring of Protection") ? row : null;
  });
  check(
    "the item appears on Alice's character sheet inventory",
    aliceAfterTake?.inventory?.some((item) => item.name === "Ring of Protection" && item.quantity === 1),
    JSON.stringify(aliceAfterTake?.inventory)
  );

  const ringEvents = await pollUntil(async () => {
    const rows = await interactionEventsFor("map_object_id", chestId);
    return rows.length === 1 ? rows : null;
  });
  check(
    "a correctly-populated item_taken interaction_events row was written for the chest",
    ringEvents?.[0]?.action_type === "item_taken" &&
      ringEvents[0].tag === "Quest item" &&
      ringEvents[0].actor_user_id === alice.id &&
      ringEvents[0].concealed_pit_id === null &&
      typeof ringEvents[0].created_at === "string",
    JSON.stringify(ringEvents)
  );

  // The DM's panel was opened BEFORE Alice took the item and has stayed
  // open this whole time — its live update (not a fresh re-fetch) is the
  // real cross-client proof.
  const dmSawItGoLive = await pollUntil(async () => !(await isVisible(dmPage, `container-panel-item-${ringItemId}`)));
  check(
    "a second connected client (the DM, panel already open) sees the chest go empty LIVE, via the broadcast",
    dmSawItGoLive === true
  );
  check(
    "the DM's panel now shows the empty state",
    await isVisible(dmPage, "container-panel-empty")
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 4 — Game Room: Alice's token falls into the concealed pit (DC 15
  // DEX save, terrible dexterity to force a near-certain failure); the
  // preserved pit's items are offered to her automatically, she takes one.
  // ════════════════════════════════════════════════════════════════════
  // The chest is already empty and no longer needed — voiding its cell
  // back out leaves the pit as the ONLY non-void destination other than
  // Alice's own start, so the blind move-scan below can't mistake a stray
  // click on the (otherwise harmless) chest cell for landing on the pit.
  await dm.client
    .from("map_cells")
    .upsert(
      [{ map_id: mapId, x: chestXY.x, y: chestXY.y, elevation: 0, terrain_type: "void", light_level: "bright" }],
      { onConflict: "map_id,x,y" }
    );
  await admin.from("characters").update({ dexterity: 1 }).eq("id", aliceCharacterId);

  async function resetAliceToken() {
    await admin
      .from("map_tokens")
      .update({ x: aliceStart.x, y: aliceStart.y, elevation: 0 })
      .eq("id", aliceTokenId);
    await alicePage.reload();
    await alicePage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
    await dismissTurnCameraIfShown(alicePage);
  }

  await resetAliceToken();
  let fellIn = false;
  for (let attempt = 0; attempt < 5 && !fellIn; attempt++) {
    if (attempt > 0) await resetAliceToken();
    await alicePage.click(`[data-testid="move-token-${aliceTokenId}"]`);
    const hit = await scanClick(
      alicePage,
      async () => {
        const row = await tokenRow(aliceTokenId);
        return row?.x !== aliceStart.x || row?.y !== aliceStart.y;
      },
      { label: `move onto the pit (attempt ${attempt + 1})` }
    );
    if (!hit) continue;
    await sleep(2000); // let the save roll + reveal settle
    const row = await tokenRow(aliceTokenId);
    if (row?.x === pitXY.x && row?.y === pitXY.y) fellIn = true;
  }
  check("Alice's token fell into the concealed pit within 5 attempts (terrible DEX)", fellIn);

  const pitPreserved = await pollUntil(() => concealedPitRowById(pitId));
  check(
    "the concealed_pits row is PRESERVED (not cascade-deleted) because it still held an item",
    pitPreserved !== null && pitPreserved !== undefined,
    JSON.stringify(pitPreserved)
  );

  const alicePitPanelShown = await pollUntil(() => isVisible(alicePage, "container-panel"));
  check(
    "the falling character's own client is offered the pit's contents automatically",
    alicePitPanelShown === true
  );
  check(
    "the pit panel shows the Potion of Healing",
    await isVisible(alicePage, `container-panel-item-${potionItemId}`)
  );

  await alicePage.click(`[data-testid="take-container-item-${potionItemId}"]`);

  const potionGoneFromDb = await pollUntil(async () => (await itemsForPit(pitId)).length === 0);
  check("taking the pit's item removes it from map_object_items", potionGoneFromDb === true);

  const aliceAfterPotion = await pollUntil(async () => {
    const row = await characterRow(aliceCharacterId);
    return row.inventory?.some((item) => item.name === "Potion of Healing") ? row : null;
  });
  check(
    "the potion appears on Alice's character sheet inventory",
    aliceAfterPotion?.inventory?.some((item) => item.name === "Potion of Healing" && item.quantity === 1),
    JSON.stringify(aliceAfterPotion?.inventory)
  );

  const potionEvents = await pollUntil(async () => {
    const rows = await interactionEventsFor("concealed_pit_id", pitId);
    return rows.length === 1 ? rows : null;
  });
  check(
    "a correctly-populated item_taken interaction_events row was written for the pit",
    potionEvents?.[0]?.action_type === "item_taken" &&
      potionEvents[0].map_object_id === null &&
      potionEvents[0].actor_user_id === alice.id &&
      typeof potionEvents[0].created_at === "string",
    JSON.stringify(potionEvents)
  );

  // The concealed_pits row is deliberately left as an inert, item-less
  // husk rather than auto-deleted once empty — deleting it here would
  // cascade away (interaction_events.concealed_pit_id is ON DELETE
  // CASCADE) the very item_taken row just verified above, in the same
  // transaction that wrote it. See claim_map_object_item's own comment.
  const pitStillExists = await concealedPitRowById(pitId);
  check(
    "the now-empty concealed_pits row is left in place (deleting it would cascade away its own just-written interaction_events row)",
    pitStillExists !== null && pitStillExists !== undefined,
    JSON.stringify(pitStillExists)
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
