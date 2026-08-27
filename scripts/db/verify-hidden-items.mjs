#!/usr/bin/env node
// Map Editor Batch A5 verification: hidden items with passive-Perception
// reveal — an optional hidden_dc on an A4 container item (migration 0061),
// revealed per-VIEWER (matching hiddenFrom's shape, Prompt 60) rather than a
// single global reveal flag like concealed_pits uses, since two characters
// can have very different passive Perception scores.
//
// Covers, all through the real map editor / Game Room UIs:
//   1. A DM adds a hidden item (with a Hidden DC) and a plain item (DC left
//      blank) to a placed chest via the real map editor's Container-items
//      panel, including the new Hidden DC field's own input validation.
//   2. In the Game Room, a highly perceptive character standing near the
//      chest sees BOTH items; a character with poor passive Perception
//      standing equally near sees only the plain one — two different
//      characters, two different views of the very same container, neither
//      one a button press or an active roll.
//   3. The DM's own client always sees every item regardless of DC, for
//      prep purposes.
//   4. The plain (no-DC) item stays visible to everyone regardless of
//      passive Perception or proximity — A4's original behavior, untouched.
//   5. "Near" is simplified to cell-adjacency (the container's own cell plus
//      its 8 surrounding cells) rather than a new distance system: the
//      SAME highly perceptive character loses sight of the hidden item the
//      moment she's moved far from the chest, despite her passive
//      Perception not having changed at all.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its own port isn't already serving.
// Usage: node scripts/db/verify-hidden-items.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port, distinct from every other verify-*.mjs script's
// own pick — this machine runs several concurrent agent worktrees, each
// potentially squatting on common ports with their OWN checkout's dev
// server. Never rely on APP_URL's usual localhost:3000 default, which is
// this project's live production server, not a fresh build of this
// worktree's own changes.
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 48937);
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
// would otherwise cover the canvas), but leave the map panel expanded — this
// script needs its Containers-list Open button.
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `hidden-items-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Hidden Items ${label}`,
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

async function itemsForMapObject(mapObjectId) {
  const { data, error } = await admin.from("map_object_items").select().eq("map_object_id", mapObjectId);
  if (error) throw error;
  return data ?? [];
}

/** Voids every cell in a WxH grid except the ones in `keep` — see
 * verify-item-containers.mjs's own identical helper for why: a blind canvas
 * click can only ever land on void (a harmless miss) or one of the real
 * cells this test actually needs. */
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
// wisdom 20 (+5 mod), proficient, level 5 (+3 proficiency bonus): passive
// Perception = 10 + 5 + 3 = 18 — comfortably clears a DC 15 hidden item.
const vex = await makeTestUser("vex");
// wisdom 8 (-1 mod), not proficient, level 1: passive Perception = 10 - 1 =
// 9 — comfortably fails the same DC 15.
const bram = await makeTestUser("bram");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Hidden items test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: vex.id, role: "player" },
    { campaign_id: campaignId, user_id: bram.id, role: "player" },
  ]);

  const vexCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: vexCharacterId,
    campaign_id: campaignId,
    owner_id: vex.id,
    name: "Vex Sharpeye",
    race: "Elf",
    class: "Ranger",
    level: 5,
    strength: 10,
    dexterity: 14,
    constitution: 12,
    intelligence: 10,
    wisdom: 20,
    charisma: 10,
    current_hp: 40,
    max_hp: 40,
    armor_class: 14,
    speed: 30,
    proficiencies: ["Perception"],
    inventory: [],
    spells: [],
  });

  const bramCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: bramCharacterId,
    campaign_id: campaignId,
    owner_id: bram.id,
    name: "Bram Dimwick",
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 14,
    dexterity: 10,
    constitution: 14,
    intelligence: 10,
    wisdom: 8,
    charisma: 10,
    current_hp: 12,
    max_hp: 12,
    armor_class: 15,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const mapId = crypto.randomUUID();
  const GRID = 6;
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Hidden items room",
    grid_width: GRID,
    grid_height: GRID,
  });

  const chestXY = { x: 3, y: 3 };
  // Both within cell-adjacency (Chebyshev distance 1) of the chest at once —
  // this is what lets a single container show two different characters two
  // different results.
  const vexStart = { x: 3, y: 2 };
  const bramStart = { x: 4, y: 3 };
  // Chebyshev distance from the chest is 3 — well outside the 3x3
  // adjacency zone.
  const farXY = { x: 0, y: 0 };

  const { data: chestRow, error: chestError } = await dm.client
    .from("map_objects")
    .insert({ map_id: mapId, asset_id: CHEST_PRESET_ID, x: chestXY.x, y: chestXY.y, elevation: 0, rotation: 0 })
    .select()
    .single();
  if (chestError) throw chestError;
  const chestId = chestRow.id;

  // Only the chest's own cell stays open for the editor phase below — see
  // voidExcept's own doc comment for why (a stray Place-mode click must
  // never land on a non-void, object-free cell).
  await voidExcept(dm.client, mapId, GRID, GRID, [chestXY]);

  const pageErrors = [];
  const ROOM_VIEWPORT = { width: 1920, height: 1080 };

  const dmContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  dmPage.on("pageerror", (err) => pageErrors.push(String(err)));

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — map editor: the DM adds a plain item and a HIDDEN item (via
  // the new Hidden DC field) to the chest, through the real Container-items
  // panel.
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

  // The plain item — Hidden DC left blank, A4's original always-visible
  // shape.
  await dmPage.fill('[data-testid="container-item-name-input"]', "Common Coin");
  await dmPage.click('[data-testid="add-container-item-button"]');
  const afterCoin = await pollUntil(async () => {
    const rows = await itemsForMapObject(chestId);
    return rows.length === 1 ? rows : null;
  });
  check(
    "the plain item was persisted with hidden_dc null",
    afterCoin?.[0]?.name === "Common Coin" && afterCoin[0].hidden_dc === null,
    JSON.stringify(afterCoin)
  );
  const coinItemId = afterCoin[0].id;

  // Hidden DC field validation: a non-positive DC disables Add and shows an
  // error, before the real (valid) hidden item is added below. (A plain
  // HTML number input already refuses non-numeric characters at the DOM
  // level — "0" is the smallest value the browser will actually let through
  // that this field's own >0 rule still needs to reject.)
  await dmPage.fill('[data-testid="container-item-name-input"]', "Bad DC Attempt");
  await dmPage.fill('[data-testid="container-item-hidden-dc-input"]', "0");
  check(
    "a non-positive Hidden DC disables the Add button",
    await dmPage.locator('[data-testid="add-container-item-button"]').isDisabled()
  );

  // Now the real hidden item — DC 15.
  await dmPage.fill('[data-testid="container-item-name-input"]', "Hidden Gem");
  await dmPage.fill('[data-testid="container-item-hidden-dc-input"]', "15");
  await dmPage.click('[data-testid="add-container-item-button"]');
  const afterGem = await pollUntil(async () => {
    const rows = await itemsForMapObject(chestId);
    return rows.length === 2 ? rows : null;
  });
  const gemRow = afterGem?.find((row) => row.name === "Hidden Gem");
  check(
    "the hidden item was persisted with hidden_dc 15",
    gemRow?.hidden_dc === 15,
    JSON.stringify(afterGem)
  );
  const gemItemId = gemRow.id;

  check(
    "the editor's item summary shows the hidden DC",
    await pollUntil(async () => {
      const text = await dmPage.locator(`[data-testid="container-item-${gemItemId}"]`).innerText().catch(() => "");
      return text.includes("DC 15");
    })
  );

  // The pre-fill on Edit round-trips the stored DC.
  await dmPage.click(`[data-testid="edit-container-item-${gemItemId}"]`);
  check(
    "editing the hidden item pre-fills its stored Hidden DC",
    await dmPage.inputValue('[data-testid="container-item-edit-hidden-dc-input"]') === "15"
  );
  await dmPage.locator(`[data-testid="container-item-editing-${gemItemId}"] button:has-text("Cancel")`).click();

  // The editor phase is done — open the remaining cells this test needs for
  // the Game Room phases below. Safe now: plain cell clicks in the Game Room
  // never place anything without an armed token/placement.
  await dm.client.from("map_cells").upsert(
    [
      { map_id: mapId, x: vexStart.x, y: vexStart.y, elevation: 0, terrain_type: "normal", light_level: "bright" },
      { map_id: mapId, x: bramStart.x, y: bramStart.y, elevation: 0, terrain_type: "normal", light_level: "bright" },
      { map_id: mapId, x: farXY.x, y: farXY.y, elevation: 0, terrain_type: "normal", light_level: "bright" },
    ],
    { onConflict: "map_id,x,y" }
  );

  // Seed both characters' tokens directly, adjacent to the chest at once
  // (rule of thumb for this batch: seed starting state via the admin
  // client, reserve real UI-driven actions for the actual behavior under
  // test — which here is what each viewer's OWN client renders, not how a
  // token got onto the board).
  const vexTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: vexTokenId,
    map_id: mapId,
    character_id: vexCharacterId,
    x: vexStart.x,
    y: vexStart.y,
    elevation: 0,
    allegiance: "party",
  });
  const bramTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: bramTokenId,
    map_id: mapId,
    character_id: bramCharacterId,
    x: bramStart.x,
    y: bramStart.y,
    elevation: 0,
    allegiance: "party",
  });

  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — Game Room: three connected clients (DM, Vex, Bram) open the
  // SAME chest and see three different results.
  // ════════════════════════════════════════════════════════════════════
  const vexContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await vexContext.addCookies(sessionCookies(vex.session));
  const vexPage = await vexContext.newPage();
  vexPage.on("pageerror", (err) => pageErrors.push(String(err)));

  const bramContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await bramContext.addCookies(sessionCookies(bram.session));
  const bramPage = await bramContext.newPage();
  bramPage.on("pageerror", (err) => pageErrors.push(String(err)));

  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(dmPage);

  await vexPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await vexPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(vexPage);

  await bramPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await bramPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(bramPage);

  check(
    "the chest appears in the Map panel's Containers list for the DM",
    await pollUntil(() => isVisible(dmPage, `open-container-${chestId}`))
  );
  await dmPage.click(`[data-testid="open-container-${chestId}"]`);
  check("the DM can open the chest", await pollUntil(() => isVisible(dmPage, "container-panel")));
  check(
    "the DM sees the plain item",
    await isVisible(dmPage, `container-panel-item-${coinItemId}`)
  );
  check(
    "the DM sees the HIDDEN item too, regardless of its DC — prep visibility",
    await isVisible(dmPage, `container-panel-item-${gemItemId}`)
  );

  check(
    "the chest appears in the Map panel's Containers list for Vex",
    await pollUntil(() => isVisible(vexPage, `open-container-${chestId}`))
  );
  await vexPage.click(`[data-testid="open-container-${chestId}"]`);
  check("Vex can open the chest", await pollUntil(() => isVisible(vexPage, "container-panel")));
  check(
    "Vex (passive Perception 18, near, DC 15) sees the plain item",
    await isVisible(vexPage, `container-panel-item-${coinItemId}`)
  );
  check(
    "Vex (passive Perception 18, near, DC 15) sees the HIDDEN item — meets/beats the DC",
    await pollUntil(() => isVisible(vexPage, `container-panel-item-${gemItemId}`))
  );

  check(
    "the chest appears in the Map panel's Containers list for Bram",
    await pollUntil(() => isVisible(bramPage, `open-container-${chestId}`))
  );
  await bramPage.click(`[data-testid="open-container-${chestId}"]`);
  check("Bram can open the chest", await pollUntil(() => isVisible(bramPage, "container-panel")));
  check(
    "Bram (passive Perception 9, near, DC 15) still sees the plain item — A4's original behavior, untouched",
    await isVisible(bramPage, `container-panel-item-${coinItemId}`)
  );
  await sleep(1000); // give any (wrongly) live-revealing state a moment to appear before asserting absence
  check(
    "Bram (passive Perception 9, near, DC 15) does NOT see the HIDDEN item — below the DC",
    !(await isVisible(bramPage, `container-panel-item-${gemItemId}`))
  );

  // The two "sees/does not see the HIDDEN item" checks immediately above,
  // taken together, ARE the "two characters near the same container can
  // have different visibility of the same item" acceptance criterion.

  // ════════════════════════════════════════════════════════════════════
  // Phase 3 — proximity: move Vex far from the chest. Her passive
  // Perception hasn't changed, but she's no longer "near" (cell-adjacency,
  // the container's own cell plus its 8 surrounding cells) — the hidden
  // item disappears from her view even though the plain item does not.
  // ════════════════════════════════════════════════════════════════════
  await admin.from("map_tokens").update({ x: farXY.x, y: farXY.y }).eq("id", vexTokenId);
  await vexPage.reload();
  await vexPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(vexPage);

  check(
    "the chest still appears in Vex's Map panel Containers list after moving away",
    await pollUntil(() => isVisible(vexPage, `open-container-${chestId}`))
  );
  await vexPage.click(`[data-testid="open-container-${chestId}"]`);
  check("Vex can still open the chest from afar", await pollUntil(() => isVisible(vexPage, "container-panel")));
  check(
    "far-away Vex still sees the plain item",
    await isVisible(vexPage, `container-panel-item-${coinItemId}`)
  );
  await sleep(1000);
  check(
    "far-away Vex (same passive Perception 18, but no longer near) no longer sees the HIDDEN item",
    !(await isVisible(vexPage, `container-panel-item-${gemItemId}`))
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
