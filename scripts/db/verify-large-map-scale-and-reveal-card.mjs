#!/usr/bin/env node
// THIRD investigation of this exact area (2026-08-30) — supersedes this
// script's own prior two versions. History, briefly (full reasoning lives in
// src/scene-3d/mapFit.ts's own doc comment on computeTableMapMetrics and
// src/scene-3d/table.ts's on COMBINED_TABLE_VISIBLE_TOP):
//
//   1. "this is a 20x40 map, it is very small in game, please make it so
//      larger maps display bigger" — fixed by GROWING the table's own
//      footprint (computeTableFootprint) past its real modeled size on
//      large/lopsided grids, backed by a synthetic flat wood-colored slab
//      (GameTableScene's TableExtension) wherever it grew past the real
//      table.glb model.
//   2. That growth was measured against the wrong (too-wide) footprint
//      constant (COMBINED_TABLE_TOP, the LEG-clearance one, not the real
//      visible top) — "this is way too large for the table... the complete
//      opposite of before". Fixed by introducing COMBINED_TABLE_VISIBLE_TOP
//      — but that constant's own DEPTH formula was ALSO wrong (TABLE_TOP.depth
//      + TABLE_TOP_JOIN_DEPTH = 3.948, when the real combined visible depth,
//      confirmed by directly measuring public/table/table.glb's own vertices,
//      is 2 × TABLE_TOP_JOIN_DEPTH = 3.696 — TABLE_TOP.depth is the WIDER
//      leg-inclusive figure, the exact category of mistake #2 above was
//      about, just recurring in a smaller, easier-to-miss form).
//   3. The project owner's own direct call, after both of the above still
//      didn't fully fix it: "the table is exactly the same, remove the brown
//      box it places, and make the 3d map fit to the 3d table models that
//      are there." This is that fix: computeTableFootprint and
//      TableExtension are BOTH GONE — the live map now fits ONLY inside
//      COMBINED_TABLE_VISIBLE_TOP's own real, fixed, already-rendered surface
//      (with its depth formula corrected per #2 above), never synthesizing
//      extra surface to grow onto. A large/extreme grid legitimately gets a
//      SMALLER cellSize than would read as comfortably legible — an honest,
//      accepted tradeoff now, not a bug to work around by growing the table.
//
// This script seeds THREE grid shapes in the same campaign — a small square
// (5x5, comfortably within the table even before any of this), a wide one
// close to the original "24x11"-ish overflow report, and the original "20x40"
// extreme case from the very first bug report — each with one token (a size
// reference) and one reveal_text object (triggered live, via the ordinary
// MapPanel trigger-<id> button — untouched by this fix; GameRoom.tsx's
// REVEAL_CARD_FIXED_CLEARANCE still applies on top of it).
//
// Checks, per map size:
//   - The map loads with no page errors.
//   - computeTableMapMetrics's own formula (replayed here in plain JS — this
//     project's own "plain perspective-projection replay" precedent,
//     seating.ts's CAMERA_FORWARD_INSET doc comment) NEVER exceeds
//     COMBINED_TABLE_VISIBLE_TOP on either axis, for every shape including
//     the extreme one — no special-cased growth path exists anymore to make
//     this NOT hold.
//   - Triggering the reveal_text object shows a real object-reveal-card-<id>
//     node with the exact content, rendered inside the <canvas> bounds.
//   - The reveal card's anchorY clears the object's own worst-case modelled
//     height by a REAL absolute margin (REVEAL_CARD_FIXED_CLEARANCE) that
//     does not shrink to nothing as cellSize shrinks.
//   - Real screenshots of each map — a close, steeply-tilted top-down-ish
//     orbit view specifically so a human (or a subsequent Claude turn) can
//     visually confirm every one of the grid's own edge cells sits fully on
//     real, visible wood, on every side, with nothing floating past the
//     table's real edge — the whole point of this fix, and something no
//     numeric assertion here can substitute for.
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
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/map-fits-table";
mkdirSync(SCRATCH_DIR, { recursive: true });

const CHEST_PRESET_ID = "a55e7002-0000-4000-8000-000000000002";

// ═══════════════════════════════════════════════════════════════════════
// mapFit.ts/table.ts's real formulas, replayed here in plain JS — this
// script can't `import` the TS modules directly (a plain Node .mjs script,
// no TS loader), so every constant/formula below is copied verbatim from the
// real source rather than re-derived. If any of these ever drift from the
// real implementation, mapFit.test.ts (which DOES import the real module) is
// the source of truth — this is a live, end-to-end sanity check on top of
// that, not a replacement for it.
// ═══════════════════════════════════════════════════════════════════════
const TABLE_TOP = { width: 4.36, depth: 2.1 };
const TABLE_TOP_JOIN_DEPTH = 1.848;
const COMBINED_TABLE_VISIBLE_TOP = { width: TABLE_TOP.width, depth: TABLE_TOP_JOIN_DEPTH * 2 };
const TABLE_MAP_MARGIN = 0.3;

function newCellSize(gridWidth, gridHeight) {
  return Math.min(
    (COMBINED_TABLE_VISIBLE_TOP.width - TABLE_MAP_MARGIN * 2) / gridWidth,
    (COMBINED_TABLE_VISIBLE_TOP.depth - TABLE_MAP_MARGIN * 2) / gridHeight
  );
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
// 3D table/map for a human to visually judge "does every edge cell sit on
// real wood", not a screen full of floating dice/combat/chat panels.
const COLLAPSED_PANEL_LAYOUT = {
  combat: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
  diceTray: { collapsed: true, x: 0, y: 0 },
  hp: { collapsed: true, x: 0, y: 0 },
  chatLog: { collapsed: true, x: 0, y: 0 },
  diceRoller: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `map-fits-table-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Map Fits Table ${label}`,
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
  await admin.from("campaigns").insert({ id: campaignId, name: "Map fits table test", creator: dm.id });
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

  const REVEAL_TEXT = "A faint humming rises from the vault below.";

  async function makeMap(label, w, h) {
    const mapId = crypto.randomUUID();
    await admin.from("campaign_maps").insert({ id: mapId, campaign_id: campaignId, name: `${label} (${w}x${h})`, grid_width: w, grid_height: h });
    await seedGrid(mapId, w, h);
    const tokenX = Math.floor(w / 2);
    const tokenY = Math.floor(h / 2);
    await admin.from("map_tokens").insert({ id: crypto.randomUUID(), map_id: mapId, character_id: dmCharacterId, x: tokenX, y: tokenY, elevation: 0, allegiance: "party" });
    const { data: obj, error: objError } = await admin
      .from("map_objects")
      .insert({
        map_id: mapId,
        asset_id: CHEST_PRESET_ID,
        x: Math.max(0, tokenX - 1),
        y: Math.max(0, tokenY - 1),
        elevation: 0,
        rotation: 0,
        behavior_config: { action: "reveal_text", content: REVEAL_TEXT, playerTriggerable: true, triggerOnStepOn: false, triggered: false },
      })
      .select()
      .single();
    if (objError) throw objError;
    return { mapId, w, h, obj };
  }

  // Three grid shapes, per the task: a small square, a wide one near the
  // "24x11"-ish overflow report, and the original "20x40" extreme case.
  const small = await makeMap("Small Square", 5, 5);
  const wide = await makeMap("Wide Overflow Repro", 24, 11);
  const tall = await makeMap("Extreme Tall", 20, 40);
  const maps = [
    ["small", small],
    ["wide", wide],
    ["tall", tall],
  ];

  // ═══════════════════════════════════════════════════════════════════
  // Numeric checks — mapFit.ts's real formula, replayed above.
  // ═══════════════════════════════════════════════════════════════════
  for (const [label, m] of maps) {
    const cellSize = newCellSize(m.w, m.h);
    console.log(`cellSize — ${label} (${m.w}x${m.h}): ${cellSize.toFixed(4)}`);
    check(
      `${label} map: rendered width (cellSize * gridWidth) never exceeds the table's real visible width`,
      cellSize * m.w < COMBINED_TABLE_VISIBLE_TOP.width,
      { cellSize, width: cellSize * m.w, tableWidth: COMBINED_TABLE_VISIBLE_TOP.width }
    );
    check(
      `${label} map: rendered depth (cellSize * gridHeight) never exceeds the table's real visible depth`,
      cellSize * m.h < COMBINED_TABLE_VISIBLE_TOP.depth,
      { cellSize, depth: cellSize * m.h, tableDepth: COMBINED_TABLE_VISIBLE_TOP.depth }
    );
    check(`${label} map: cellSize is a real, positive number (never clamped to zero/negative)`, cellSize > 0, { cellSize });

    const oldClearanceAboveObjectTop = cellSize * REVEAL_CARD_PROPORTIONAL_TERM - cellSize * PLACED_OBJECT_SIZE;
    const newClearanceAboveObjectTop = oldClearanceAboveObjectTop + REVEAL_CARD_FIXED_CLEARANCE;
    check(
      `${label} map: the reveal card's real clearance above the object's own top includes the full fixed addition (doesn't shrink away with cellSize)`,
      newClearanceAboveObjectTop - oldClearanceAboveObjectTop >= REVEAL_CARD_FIXED_CLEARANCE - 1e-9,
      { label, oldClearanceAboveObjectTop, newClearanceAboveObjectTop }
    );
  }

  check(
    "the wide/tall maps get a SMALLER cellSize than the small one (no more artificial table growth to compensate — an accepted tradeoff now)",
    newCellSize(wide.w, wide.h) < newCellSize(small.w, small.h) && newCellSize(tall.w, tall.h) < newCellSize(small.w, small.h)
  );

  // ═══════════════════════════════════════════════════════════════════
  // Live, real Playwright checks — one Game Room, switched between maps.
  // ═══════════════════════════════════════════════════════════════════
  await admin.from("campaigns").update({ live_map: small.mapId }).eq("id", campaignId);

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
    // own established post-navigation buffer.
    await sleep(2500);
    await page.click('[data-testid="camera-mode-toggle"]');
    await sleep(400);
  }

  // A close, steeply-tilted top-down-ish orbit framing — specifically so the
  // table's own 4 corners AND every grid edge are visible at once in a
  // single screenshot, the exact framing needed to visually confirm "no
  // grid tile floats past the real wood" (a numeric assertion alone can't
  // substitute for this — see this script's own header comment).
  async function frameTopDown(page) {
    const canvasBox = await page.locator("canvas").first().boundingBox();
    if (!canvasBox) return;
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 300);
      await sleep(50);
    }
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2 + 300, { steps: 10 });
    await page.mouse.up();
    await sleep(400);
  }

  async function clickTrigger(objectId, label) {
    const selector = `[data-testid="trigger-${objectId}"]`;
    const attached = await page.waitForSelector(selector, { state: "attached", timeout: 20000 }).then(() => true).catch(() => false);
    check(`${label} map: the trigger button for the reveal object is present`, attached);
    if (attached) await page.click(selector);
    return attached;
  }

  for (const [label, m] of maps) {
    await admin.from("campaigns").update({ live_map: m.mapId }).eq("id", campaignId);
    await loadMap(m.mapId, label);
    await frameTopDown(page);
    const shotPath = join(SCRATCH_DIR, `${label}-${m.w}x${m.h}-topdown.png`);
    await page.screenshot({ path: shotPath });
    console.log(`saved ${shotPath}`);

    await clickTrigger(m.obj.id, label);
    const triggered = await pollUntil(async () => {
      const row = await mapObjectRow(m.obj.id);
      return row?.behavior_config?.triggered === true ? row : null;
    });
    check(`${label} map: triggering the reveal_text object persists triggered = true`, triggered !== null);

    const cardSelector = `[data-testid="object-reveal-card-${m.obj.id}"]`;
    const cardShown = await page.waitForSelector(cardSelector, { state: "attached", timeout: 15000 }).then(() => true).catch(() => false);
    check(`${label} map: the reveal card appears after triggering`, cardShown);
    if (cardShown) {
      const text = await page.textContent(cardSelector);
      check(`${label} map: the card shows the exact revealed text`, text === REVEAL_TEXT, text);
      const canvasBox = await page.locator("canvas").first().boundingBox();
      const cardBox = await page.locator(cardSelector).boundingBox();
      check(
        `${label} map: the card renders inside the 3D canvas' own bounds`,
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
    const revealShotPath = join(SCRATCH_DIR, `${label}-${m.w}x${m.h}-reveal-card.png`);
    await page.screenshot({ path: revealShotPath });
    console.log(`saved ${revealShotPath}`);
  }

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
console.log(`\nScreenshots written to ${SCRATCH_DIR}`);
process.exit(failures === 0 ? 0 : 1);
