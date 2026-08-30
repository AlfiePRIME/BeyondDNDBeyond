#!/usr/bin/env node
// Bug report (2026-08-26, both filed together in the same conversation, both
// coupled through the same cellSize-derived geometry — mapFit.ts's
// computeTableMapMetrics/computeTableFootprint):
//
//   1. "this is a 20x40 map, it is very small in game, please make it so
//      larger maps display bigger so they can be played easier." — the
//      table's own fixed physical footprint (table.ts's TABLE_TOP) used to
//      be the ONLY thing a live map's cellSize was fit against, so a large
//      grid got crammed into the same footprint a tiny one did, shrinking
//      cellSize (and everything scaled to it — tokens, terrain, objects,
//      reveal cards) toward unreadable. mapFit.ts's computeTableFootprint
//      now grows the table's own footprint (COMBINED_TABLE_TOP first — the
//      head square's own already-rendered, already-doubled surface,
//      previously left unused by the live map — then a further, seat-
//      clearance-capped extension slab, GameTableScene.tsx's TableExtension)
//      to keep cellSize legible on large/lopsided grids instead.
//   2. "when the text, image is revealed it reveals too low, it should show
//      above the object like the DM's book does to the DM." —
//      ObjectRevealCard's own anchorY used to be a PURE cellSize multiple
//      (cellSize * 1.15), which read fine on a typically-sized map but
//      shrank toward the object's own top on exactly the small-cellSize
//      maps bug #1 is about — GameRoom.tsx's REVEAL_CARD_FIXED_CLEARANCE
//      adds a flat, non-scaling clearance on top of that term (the same
//      "fixed absolute number" idea as DmBookProp.tsx's own HTML_ANCHOR_Y),
//      so the card keeps real, visible separation regardless of map size.
//
// This script proves both fixes on the SAME live campaign: a small (8x8)
// reference map and a large (20x40) map, each with one token (a size
// reference) and one reveal_text object (triggered live, via the ordinary
// MapPanel trigger-<id> button — unchanged by either fix).
//
// Checks, per map size (small AND large):
//   - The map loads with no page errors.
//   - computeTableFootprint/computeTableMapMetrics's own formula (replayed
//     here in plain JS — this project's own "plain perspective-projection
//     replay" precedent, seating.ts's CAMERA_FORWARD_INSET doc comment)
//     yields a cellSize that's never smaller than the OLD single-table fit
//     ever produced, and — for the large map specifically — at least 1.5x
//     bigger, a real, substantial improvement, not a rounding-error one.
//   - Triggering the reveal_text object shows a real object-reveal-card-<id>
//     node with the exact content, rendered inside the <canvas> bounds.
//   - The reveal card's anchorY clears the object's own worst-case modelled
//     height by a REAL absolute margin (REVEAL_CARD_FIXED_CLEARANCE) that
//     does not shrink to nothing as cellSize shrinks — replayed numerically
//     here, since a card floating "a fraction of a shrinking cellSize" above
//     an object is exactly the bug being fixed.
//   - A real screenshot of each map (before AND after triggering the reveal)
//     for a human to visually confirm "looks bigger" / "card floats above,
//     not on top of, the object" — saved under this repo's scratchpad.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its own port isn't already serving.
// Usage: node scripts/db/verify-large-map-scale-and-reveal-card.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.LARGE_MAP_SCALE_APP_PORT ?? 49481);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

const CHEST_PRESET_ID = "a55e7002-0000-4000-8000-000000000002";

// ═══════════════════════════════════════════════════════════════════════
// mapFit.ts's real formulas, replayed here in plain JS — this script can't
// `import` the TS module directly (a plain Node .mjs script, no TS loader),
// so every constant/formula below is copied verbatim from the real source
// (src/scene-3d/mapFit.ts / table.ts / seating.ts) rather than re-derived.
// If any of these ever drift from the real implementation, mapFit.test.ts
// (which DOES import the real module) is the source of truth — this is a
// live, end-to-end sanity check on top of that, not a replacement for it.
// ═══════════════════════════════════════════════════════════════════════
const TABLE_TOP = { width: 4.36, thickness: 0.35, depth: 2.1 };
const TABLE_UNITS_LONG_EDGE = 2;
const COMBINED_TABLE_TOP = { width: TABLE_TOP.width, depth: TABLE_TOP.depth * TABLE_UNITS_LONG_EDGE };
const TABLE_MAP_MARGIN = 0.3;
const MIN_LEGIBLE_CELL_SIZE = 0.22;
const TABLE_GROWTH_SEAT_CLEARANCE = 0.5;
const SEAT_MARGIN = 0.4;

function seatEllipseSemiAxes(table) {
  return {
    semiX: (table.width / 2) * Math.SQRT2 + SEAT_MARGIN,
    semiZ: (table.depth / 2) * Math.SQRT2 + SEAT_MARGIN,
  };
}

function computeTableFootprint(gridWidth, gridHeight) {
  const naturalCellSize = Math.min(
    (COMBINED_TABLE_TOP.width - TABLE_MAP_MARGIN * 2) / gridWidth,
    (COMBINED_TABLE_TOP.depth - TABLE_MAP_MARGIN * 2) / gridHeight
  );
  if (naturalCellSize >= MIN_LEGIBLE_CELL_SIZE) {
    return { width: COMBINED_TABLE_TOP.width, depth: COMBINED_TABLE_TOP.depth };
  }
  const { semiX, semiZ } = seatEllipseSemiAxes(COMBINED_TABLE_TOP);
  const maxWidth = (semiX - TABLE_GROWTH_SEAT_CLEARANCE) * 2;
  const maxDepth = (semiZ - TABLE_GROWTH_SEAT_CLEARANCE) * 2;
  const wantedWidth = gridWidth * MIN_LEGIBLE_CELL_SIZE + TABLE_MAP_MARGIN * 2;
  const wantedDepth = gridHeight * MIN_LEGIBLE_CELL_SIZE + TABLE_MAP_MARGIN * 2;
  return {
    width: Math.min(Math.max(COMBINED_TABLE_TOP.width, wantedWidth), maxWidth),
    depth: Math.min(Math.max(COMBINED_TABLE_TOP.depth, wantedDepth), maxDepth),
  };
}

function newCellSize(gridWidth, gridHeight) {
  const footprint = computeTableFootprint(gridWidth, gridHeight);
  return Math.min((footprint.width - TABLE_MAP_MARGIN * 2) / gridWidth, (footprint.depth - TABLE_MAP_MARGIN * 2) / gridHeight);
}

// The OLD formula (before this fix) — fit directly against the single,
// un-doubled TABLE_TOP, with no footprint growth at all. This no longer
// exists in src/ (mapFit.test.ts's own regression test keeps the same
// baseline) — kept here purely as this script's own "before" comparison.
function oldCellSize(gridWidth, gridHeight) {
  return Math.min((TABLE_TOP.width - TABLE_MAP_MARGIN * 2) / gridWidth, (TABLE_TOP.depth - TABLE_MAP_MARGIN * 2) / gridHeight);
}

// PlacedObject.tsx's own fit target — a model's tallest dimension (any
// axis) never exceeds this fraction of cellSize.
const PLACED_OBJECT_SIZE = 0.92;
// The reveal card's own proportional term (GameRoom.tsx's anchorY) and flat
// addition (REVEAL_CARD_FIXED_CLEARANCE) — copied verbatim.
const REVEAL_CARD_PROPORTIONAL_TERM = 1.15;
const REVEAL_CARD_FIXED_CLEARANCE = 0.35;

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
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
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

// Collapses every panel except map/tokens (verify-live-object-reveal.mjs's
// own COLLAPSED_PANEL_LAYOUT precedent, extended a bit further) — this
// script's screenshots need a clean, mostly-unobstructed view of the actual
// 3D table/map for a human to visually judge "does this look bigger", not a
// screen full of floating dice/combat/chat panels.
const COLLAPSED_PANEL_LAYOUT = {
  combat: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
  diceTray: { collapsed: true, x: 0, y: 0 },
  hp: { collapsed: true, x: 0, y: 0 },
  chatLog: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `large-map-scale-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Large Map Scale ${label}`,
    ui_preferences: { panelLayout: COLLAPSED_PANEL_LAYOUT },
  });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function mapObjectRow(objectId) {
  const { data, error } = await admin.from("map_objects").select().eq("id", objectId).maybeSingle();
  if (error) throw error;
  return data;
}

async function pollUntil(fn, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

async function seedGrid(mapId, gridWidth, gridHeight) {
  const cells = [];
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      cells.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright" });
    }
  }
  const { error } = await admin.from("map_cells").upsert(cells, { onConflict: "map_id,x,y" });
  if (error) throw error;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Large map scale test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const dmCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: dmCharacterId,
    campaign_id: campaignId,
    owner_id: dm.id,
    name: "Size Reference",
    race: "Human",
    class: "Adventurer",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 20,
    max_hp: 20,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  // ── The small reference map: comfortably within the OLD single-table
  //    footprint already — this fix must NOT change how it looks. ──
  const SMALL_W = 8;
  const SMALL_H = 8;
  const smallMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: smallMapId, campaign_id: campaignId, name: "Small Reference Room", grid_width: SMALL_W, grid_height: SMALL_H });
  await seedGrid(smallMapId, SMALL_W, SMALL_H);
  await admin.from("map_tokens").insert({ id: crypto.randomUUID(), map_id: smallMapId, character_id: dmCharacterId, x: 4, y: 4, elevation: 0, allegiance: "party" });
  const REVEAL_TEXT = "A faint humming rises from the vault below.";
  const { data: smallObj, error: smallObjError } = await admin
    .from("map_objects")
    .insert({
      map_id: smallMapId,
      asset_id: CHEST_PRESET_ID,
      x: 3,
      y: 3,
      elevation: 0,
      rotation: 0,
      behavior_config: { action: "reveal_text", content: REVEAL_TEXT, playerTriggerable: true, triggerOnStepOn: false, triggered: false },
    })
    .select()
    .single();
  if (smallObjError) throw smallObjError;

  // ── The large (literal "20x40") map from the bug report — the whole
  //    reason this fix exists. ──
  const LARGE_W = 20;
  const LARGE_H = 40;
  const largeMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: largeMapId, campaign_id: campaignId, name: "Sprawling Dungeon (20x40)", grid_width: LARGE_W, grid_height: LARGE_H });
  await seedGrid(largeMapId, LARGE_W, LARGE_H);
  await admin.from("map_tokens").insert({ id: crypto.randomUUID(), map_id: largeMapId, character_id: dmCharacterId, x: 10, y: 20, elevation: 0, allegiance: "party" });
  const { data: largeObj, error: largeObjError } = await admin
    .from("map_objects")
    .insert({
      map_id: largeMapId,
      asset_id: CHEST_PRESET_ID,
      x: 9,
      y: 19,
      elevation: 0,
      rotation: 0,
      behavior_config: { action: "reveal_text", content: REVEAL_TEXT, playerTriggerable: true, triggerOnStepOn: false, triggered: false },
    })
    .select()
    .single();
  if (largeObjError) throw largeObjError;

  // ═══════════════════════════════════════════════════════════════════
  // Numeric checks — mapFit.ts's real formula, replayed above.
  // ═══════════════════════════════════════════════════════════════════
  const smallOld = oldCellSize(SMALL_W, SMALL_H);
  const smallNew = newCellSize(SMALL_W, SMALL_H);
  const largeOld = oldCellSize(LARGE_W, LARGE_H);
  const largeNew = newCellSize(LARGE_W, LARGE_H);
  console.log(`\ncellSize — small (${SMALL_W}x${SMALL_H}): old=${smallOld.toFixed(4)} new=${smallNew.toFixed(4)}`);
  console.log(`cellSize — large (${LARGE_W}x${LARGE_H}): old=${largeOld.toFixed(4)} new=${largeNew.toFixed(4)} (${(largeNew / largeOld).toFixed(2)}x)\n`);

  check("the small map's cellSize never regresses (new >= old)", smallNew >= smallOld - 1e-9, { smallOld, smallNew });
  check(
    "the large map's cellSize is at least 1.5x bigger than the old single-table fit ever produced",
    largeNew > largeOld * 1.5,
    { largeOld, largeNew, ratio: largeNew / largeOld }
  );
  check(
    "the large map's computed footprint actually grew past COMBINED_TABLE_TOP (TableExtension should render)",
    (() => {
      const footprint = computeTableFootprint(LARGE_W, LARGE_H);
      return footprint.width > COMBINED_TABLE_TOP.width + 1e-6 || footprint.depth > COMBINED_TABLE_TOP.depth + 1e-6;
    })()
  );

  for (const [label, w, h] of [
    ["small", SMALL_W, SMALL_H],
    ["large", LARGE_W, LARGE_H],
  ]) {
    const cellSize = newCellSize(w, h);
    const oldClearanceAboveObjectTop = cellSize * REVEAL_CARD_PROPORTIONAL_TERM - cellSize * PLACED_OBJECT_SIZE;
    const newClearanceAboveObjectTop = oldClearanceAboveObjectTop + REVEAL_CARD_FIXED_CLEARANCE;
    console.log(
      `reveal card clearance above worst-case object top — ${label} map: old=${oldClearanceAboveObjectTop.toFixed(4)} new=${newClearanceAboveObjectTop.toFixed(4)}`
    );
    check(
      `${label} map: the reveal card's real clearance above the object's own top includes the full fixed addition (doesn't shrink away with cellSize)`,
      newClearanceAboveObjectTop - oldClearanceAboveObjectTop >= REVEAL_CARD_FIXED_CLEARANCE - 1e-9,
      { label, oldClearanceAboveObjectTop, newClearanceAboveObjectTop }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Live, real Playwright checks — one Game Room, switched between maps.
  // ═══════════════════════════════════════════════════════════════════
  await admin.from("campaigns").update({ live_map: smallMapId }).eq("id", campaignId);

  const pageErrors = [];
  const ROOM_VIEWPORT = { width: 1920, height: 1080 };
  const context = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  async function loadMap(mapId, label) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
    const onMap = await pollUntil(
      async () => {
        const text = await page.locator('[data-testid="table-surface-state"]').textContent();
        return text && text.includes(`"mapId":"${mapId}"`) ? text : null;
      },
      { timeoutMs: 40000 }
    );
    if (onMap === null) {
      const current = await page.locator('[data-testid="table-surface-state"]').textContent().catch(() => "<no element>");
      console.error(`  debug: table-surface-state = ${current}`);
      console.error(`  debug: pageErrors so far = ${JSON.stringify(pageErrors)}`);
    }
    check(`${label} map: table-surface-state reflects the right live map`, onMap !== null);
    // Real asset/GLTF loads (table, chest, avatar) settling — this project's
    // own established post-navigation buffer (verify-object-reveal-card.mjs,
    // verify-live-object-reveal.mjs et al. all sleep after the first
    // attached-selector wait rather than assuming DOM-attached means
    // visually settled).
    await sleep(2500);

    // The default seated camera deliberately leans in close (seating.ts's
    // CAMERA_FORWARD_INSET doc comment: "leaning in at your own seat,
    // looking across the board") — great for actual play, but too tight a
    // crop for a screenshot meant to show the WHOLE table at once. Switch to
    // Free Camera (orbit) and scroll out toward its own maxDistance (26 —
    // GameTableScene.tsx's own OrbitControls prop) for a consistent, wide,
    // comparable framing across both map sizes.
    await page.click('[data-testid="camera-mode-toggle"]');
    await sleep(400);
    const canvasBox = await page.locator("canvas").first().boundingBox();
    if (canvasBox) {
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 400);
        await sleep(80);
      }
    }
    await sleep(500);
  }

  async function clickTrigger(objectId, label) {
    const selector = `[data-testid="trigger-${objectId}"]`;
    const attached = await page.waitForSelector(selector, { state: "attached", timeout: 20000 }).then(() => true).catch(() => false);
    check(`${label} map: the trigger button for the reveal object is present`, attached);
    if (attached) await page.click(selector);
    return attached;
  }

  await loadMap(smallMapId, "small");
  await page.screenshot({ path: join(SCRATCH_DIR, "small-map-scale.png") });
  console.log(`saved ${join(SCRATCH_DIR, "small-map-scale.png")}`);

  await clickTrigger(smallObj.id, "small");
  const smallTriggered = await pollUntil(async () => {
    const row = await mapObjectRow(smallObj.id);
    return row?.behavior_config?.triggered === true ? row : null;
  });
  check("small map: triggering the reveal_text object persists triggered = true", smallTriggered !== null);

  const smallCardSelector = `[data-testid="object-reveal-card-${smallObj.id}"]`;
  const smallCardShown = await page.waitForSelector(smallCardSelector, { state: "attached", timeout: 15000 }).then(() => true).catch(() => false);
  check("small map: the reveal card appears after triggering", smallCardShown);
  if (smallCardShown) {
    const text = await page.textContent(smallCardSelector);
    check("small map: the card shows the exact revealed text", text === REVEAL_TEXT, text);
    const canvasBox = await page.locator("canvas").first().boundingBox();
    const cardBox = await page.locator(smallCardSelector).boundingBox();
    check(
      "small map: the card renders inside the 3D canvas' own bounds",
      canvasBox !== null &&
        cardBox !== null &&
        cardBox.x >= canvasBox.x - 5 &&
        cardBox.y >= canvasBox.y - 5 &&
        cardBox.x + cardBox.width <= canvasBox.x + canvasBox.width + 5 &&
        cardBox.y + cardBox.height <= canvasBox.y + canvasBox.height + 5,
      { canvasBox, cardBox }
    );
  }
  await sleep(500);
  await page.screenshot({ path: join(SCRATCH_DIR, "small-map-reveal-card.png") });
  console.log(`saved ${join(SCRATCH_DIR, "small-map-reveal-card.png")}`);

  await admin.from("campaigns").update({ live_map: largeMapId }).eq("id", campaignId);
  await loadMap(largeMapId, "large");
  await page.screenshot({ path: join(SCRATCH_DIR, "large-map-scale.png") });
  console.log(`saved ${join(SCRATCH_DIR, "large-map-scale.png")}`);

  await clickTrigger(largeObj.id, "large");
  const largeTriggered = await pollUntil(async () => {
    const row = await mapObjectRow(largeObj.id);
    return row?.behavior_config?.triggered === true ? row : null;
  });
  check("large map: triggering the reveal_text object persists triggered = true", largeTriggered !== null);

  const largeCardSelector = `[data-testid="object-reveal-card-${largeObj.id}"]`;
  const largeCardShown = await page.waitForSelector(largeCardSelector, { state: "attached", timeout: 15000 }).then(() => true).catch(() => false);
  check("large map: the reveal card appears after triggering", largeCardShown);
  if (largeCardShown) {
    const text = await page.textContent(largeCardSelector);
    check("large map: the card shows the exact revealed text", text === REVEAL_TEXT, text);
    const canvasBox = await page.locator("canvas").first().boundingBox();
    const cardBox = await page.locator(largeCardSelector).boundingBox();
    check(
      "large map: the card renders inside the 3D canvas' own bounds",
      canvasBox !== null &&
        cardBox !== null &&
        cardBox.x >= canvasBox.x - 5 &&
        cardBox.y >= canvasBox.y - 5 &&
        cardBox.x + cardBox.width <= canvasBox.x + canvasBox.width + 5 &&
        cardBox.y + cardBox.height <= canvasBox.y + canvasBox.height + 5,
      { canvasBox, cardBox }
    );
  }
  await sleep(500);
  await page.screenshot({ path: join(SCRATCH_DIR, "large-map-reveal-card.png") });
  console.log(`saved ${join(SCRATCH_DIR, "large-map-reveal-card.png")}`);

  check("no uncaught page errors occurred", pageErrors.length === 0, pageErrors.join("\n"));
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
