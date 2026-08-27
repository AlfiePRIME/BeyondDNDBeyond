#!/usr/bin/env node
// Map Editor Batch A9 verification: curses and blessings on placeable items
// — the structured payload map_object_items.curse_blessing (added,
// unpopulated, by A4's migration 0060) actually holds once this prompt
// populates it, and the Game Room's take-item flow (A4's
// handleTakeContainerItem) resolving it.
//
// Covers, all through the real editor/Game Room UIs:
//   1. A DM configures a chest with two items via the real map editor's
//      Container-items panel's new curse/blessing fields:
//        - "Cursed Dagger": cursed, MECHANICAL, an hp_delta effect (-8),
//          NOT telegraphed.
//        - "Blessing of Renewal": blessed, NARRATIVE, telegraphed=true,
//          tagged "Renewal".
//      Both configurations are verified via a direct DB read of the saved
//      curse_blessing jsonb — the real structured payload, not just a UI
//      message.
//   2. In the Game Room, BEFORE either item is taken: the telegraphed
//      blessing shows its warning hint; the untelegraphed cursed dagger
//      does not.
//   3. Alice takes the narrative blessing: no mechanical effect (her HP is
//      unchanged), the item lands in her inventory, and a
//      "blessing_narrative" interaction_events row is written (tag
//      "Renewal", her as actor) alongside the item_taken row A4 already
//      writes — the DM's activity-feed note this prompt adds.
//   4. Alice takes the mechanical cursed dagger: applyHpDelta genuinely
//      fires — her current_hp actually drops by 8, verified via a direct
//      characters-table read, not just a UI message — and the item still
//      lands in her inventory. No extra narrative-note row is written for
//      a mechanical resolution.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its own port isn't already serving.
// Usage: node scripts/db/verify-curse-blessing.mjs

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
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 48920);
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

// verify-item-containers.mjs's own precedent: collapse every floating Game
// Room panel not needed by name (they dock at fixed pixel positions that
// would otherwise cover the canvas a blind scanClick needs). tokens/combat/
// map stay expanded — this script needs the map panel's own Containers-list
// Open button.
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `curse-blessing-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Curse Blessing ${label}`,
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
 * a working screen point is discovered empirically. */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.25, xTo = 0.75, yFrom = 0.3, yTo = 0.75, step = 16, settleMs = 110, label = "" } = opts;
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

async function interactionEventsFor(column, value) {
  const { data, error } = await admin.from("interaction_events").select().eq(column, value).order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Voids every cell in a WxH grid except the ones in `keep` — see
 * verify-item-containers.mjs's own identical helper. */
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
  await admin.from("campaigns").insert({ id: campaignId, name: "Curse blessing test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const START_HP = 50;
  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Curse Test Alice",
    race: "Human",
    class: "Adventurer",
    level: 1,
    strength: 10,
    dexterity: 14,
    constitution: 14,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: START_HP,
    max_hp: START_HP,
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
    name: "Curse blessing room",
    grid_width: GRID,
    grid_height: GRID,
  });

  const chestXY = { x: 3, y: 0 };
  const aliceStart = { x: 0, y: 0 };

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

  // Only the chest's own cell stays open for the editor phase's chest
  // selection scan — see verify-item-containers.mjs's identical reasoning.
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
  // Phase 1 — map editor: the DM configures a cursed (mechanical) item and
  // a blessed (narrative, telegraphed) item on the chest.
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

  // ── "Cursed Dagger": cursed, MECHANICAL, hp_delta -8, NOT telegraphed. ──
  await dmPage.fill('[data-testid="container-item-name-input"]', "Cursed Dagger");
  await dmPage.click('[data-testid="container-item-new-curse-blessing-toggle"]');
  check(
    "the curse/blessing fields appear once toggled on",
    await isVisible(dmPage, "container-item-new-curse-blessing-kind")
  );
  // "cursed" and "hp_delta" are both already the draft's own defaults —
  // only the resolution (defaults to narrative) needs changing.
  await dmPage.selectOption('[data-testid="container-item-new-curse-blessing-resolution"]', "mechanical");
  await dmPage.fill('[data-testid="container-item-new-curse-blessing-hp-delta"]', "-8");
  await dmPage.click('[data-testid="add-container-item-button"]');

  const daggerRow = await pollUntil(async () => {
    const rows = await itemsForMapObject(chestId);
    return rows.find((row) => row.name === "Cursed Dagger") ?? null;
  });
  check(
    "the cursed dagger was persisted with a mechanical hp_delta -8 curse, not telegraphed",
    daggerRow?.curse_blessing?.kind === "cursed" &&
      daggerRow.curse_blessing.resolution === "mechanical" &&
      daggerRow.curse_blessing.effect?.kind === "hp_delta" &&
      daggerRow.curse_blessing.effect.delta === -8 &&
      daggerRow.curse_blessing.telegraphed === false,
    JSON.stringify(daggerRow?.curse_blessing)
  );
  const daggerId = daggerRow.id;

  // ── "Blessing of Renewal": blessed, NARRATIVE, telegraphed=true, tagged. ──
  await dmPage.fill('[data-testid="container-item-name-input"]', "Blessing of Renewal");
  await dmPage.fill('[data-testid="container-item-tag-input"]', "Renewal");
  await dmPage.click('[data-testid="container-item-new-curse-blessing-toggle"]');
  await dmPage.selectOption('[data-testid="container-item-new-curse-blessing-kind"]', "blessed");
  // Resolution stays at its own default (narrative) — no select needed.
  await dmPage.click('[data-testid="container-item-new-curse-blessing-telegraphed"]');
  await dmPage.click('[data-testid="add-container-item-button"]');

  const blessingRow = await pollUntil(async () => {
    const rows = await itemsForMapObject(chestId);
    return rows.find((row) => row.name === "Blessing of Renewal") ?? null;
  });
  check(
    "the blessing was persisted as blessed/narrative/telegraphed with no mechanical effect",
    blessingRow?.curse_blessing?.kind === "blessed" &&
      blessingRow.curse_blessing.resolution === "narrative" &&
      blessingRow.curse_blessing.effect === null &&
      blessingRow.curse_blessing.telegraphed === true &&
      blessingRow.tag === "Renewal",
    JSON.stringify(blessingRow?.curse_blessing)
  );
  const blessingId = blessingRow.id;

  // Open the remaining cell (Alice's token start) for the Game Room phase —
  // safe now: plain cell clicks in the Game Room never place anything
  // without an armed token/placement.
  await dm.client
    .from("map_cells")
    .upsert(
      [{ map_id: mapId, x: aliceStart.x, y: aliceStart.y, elevation: 0, terrain_type: "normal", light_level: "bright" }],
      { onConflict: "map_id,x,y" }
    );

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — Game Room: BEFORE either item is taken, the telegraphed
  // blessing shows its hint; the untelegraphed dagger does not.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(dmPage);

  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(alicePage);

  check(
    "the chest appears in Alice's Map panel Containers list",
    await pollUntil(() => isVisible(alicePage, `open-container-${chestId}`))
  );
  await alicePage.click(`[data-testid="open-container-${chestId}"]`);
  check("Alice can open the chest in the Game Room", await pollUntil(() => isVisible(alicePage, "container-panel")));
  check(
    "Alice's panel shows both items before either is taken",
    (await isVisible(alicePage, `container-panel-item-${daggerId}`)) &&
      (await isVisible(alicePage, `container-panel-item-${blessingId}`))
  );

  check(
    "the telegraphed blessing shows its pre-pickup warning hint",
    await pollUntil(() => isVisible(alicePage, `container-panel-item-hint-${blessingId}`))
  );
  check(
    "the untelegraphed cursed dagger shows NO pre-pickup hint",
    !(await isVisible(alicePage, `container-panel-item-hint-${daggerId}`))
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 3 — Alice takes the narrative blessing: no mechanical change, a
  // blessing_narrative note lands on the shared interaction_events table.
  // ════════════════════════════════════════════════════════════════════
  await alicePage.click(`[data-testid="take-container-item-${blessingId}"]`);

  const blessingGone = await pollUntil(async () => (await itemsForMapObject(chestId)).length === 1);
  check("taking the blessing removes it from map_object_items", blessingGone === true);

  const aliceAfterBlessing = await pollUntil(async () => {
    const row = await characterRow(aliceCharacterId);
    return row.inventory?.some((item) => item.name === "Blessing of Renewal") ? row : null;
  });
  check(
    "the blessing appears on Alice's character sheet inventory",
    aliceAfterBlessing?.inventory?.some((item) => item.name === "Blessing of Renewal" && item.quantity === 1),
    JSON.stringify(aliceAfterBlessing?.inventory)
  );
  check(
    "taking the NARRATIVE blessing applied NO mechanical effect — Alice's HP is unchanged",
    aliceAfterBlessing?.current_hp === START_HP,
    `current_hp=${aliceAfterBlessing?.current_hp}`
  );

  const blessingNarrativeEvents = await pollUntil(async () => {
    const rows = await interactionEventsFor("map_object_id", chestId);
    const narrative = rows.filter((row) => row.action_type === "blessing_narrative");
    return narrative.length === 1 ? narrative : null;
  });
  check(
    "a correctly-populated blessing_narrative interaction_events row was written for the DM's activity feed",
    blessingNarrativeEvents?.[0]?.action_type === "blessing_narrative" &&
      blessingNarrativeEvents[0].tag === "Renewal" &&
      blessingNarrativeEvents[0].actor_user_id === alice.id &&
      blessingNarrativeEvents[0].concealed_pit_id === null &&
      typeof blessingNarrativeEvents[0].created_at === "string",
    JSON.stringify(blessingNarrativeEvents)
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 4 — Alice takes the mechanical cursed dagger: applyHpDelta
  // genuinely fires, dropping her HP by 8; no extra narrative note is
  // written for a mechanical resolution.
  // ════════════════════════════════════════════════════════════════════
  await alicePage.click(`[data-testid="take-container-item-${daggerId}"]`);

  const daggerGone = await pollUntil(async () => (await itemsForMapObject(chestId)).length === 0);
  check("taking the dagger removes it from map_object_items", daggerGone === true);

  const aliceAfterDagger = await pollUntil(async () => {
    const row = await characterRow(aliceCharacterId);
    return row.current_hp === START_HP - 8 ? row : null;
  });
  check(
    "taking the MECHANICAL cursed dagger actually applied its hp_delta effect — Alice's HP genuinely dropped by 8",
    aliceAfterDagger?.current_hp === START_HP - 8,
    `current_hp=${aliceAfterDagger?.current_hp}, expected ${START_HP - 8}`
  );
  check(
    "the dagger appears on Alice's character sheet inventory",
    aliceAfterDagger?.inventory?.some((item) => item.name === "Cursed Dagger" && item.quantity === 1),
    JSON.stringify(aliceAfterDagger?.inventory)
  );

  const allChestEvents = await interactionEventsFor("map_object_id", chestId);
  check(
    "no extra narrative-note row was written for the mechanical dagger (only its own item_taken row)",
    allChestEvents.filter((row) => row.action_type === "curse_narrative" || row.action_type === "blessing_narrative").length === 1,
    JSON.stringify(allChestEvents.map((row) => row.action_type))
  );
  check(
    "exactly two item_taken rows exist (one per item claimed)",
    allChestEvents.filter((row) => row.action_type === "item_taken").length === 2,
    JSON.stringify(allChestEvents.map((row) => row.action_type))
  );

  // The DM's own client (unaffected observer throughout) never errored.
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
