#!/usr/bin/env node
// Map grid growth verification (Prompt 10, Map Editor Extensions plan —
// migration 0046, column-drift/concealed_pits fix — migration 0057).
//
// Confirms a DM can grow an existing map's grid in any of the four
// directions from the real editor, mid-session, on a map that already has
// cells/objects/tokens AND an in-progress combat encounter:
//   - East/south growth is a pure grid_width/grid_height bump — every
//     existing cell/object/token keeps its stored x/y exactly as it was.
//   - West/north growth (the risky case — see the migration's own doc
//     comment) shifts EVERY existing cell/object/token's x (west) or y
//     (north) by the growth amount, so real position relative to the rest
//     of the map is preserved even though every stored coordinate changed.
//   - The whole thing is atomic (grow_map_grid, one plpgsql function): a
//     rejected call (bad edge, non-positive amount, wrong caller) leaves
//     the map completely untouched — dimensions AND every row.
//   - A non-DM (even a campaign member who can read the live map) cannot
//     grow it — RLS-driven authorization, not a blanket allow.
//   - Newly-added cells are immediately usable normal ground, not void —
//     the sparse-storage convention (no stored row = normal terrain)
//     structurally guarantees this, checked directly against map_cells.
//   - A live combat encounter (round/turn state, per-combatant initiative,
//     token_id references) survives every resize completely untouched —
//     combat is keyed by token id, never by coordinate.
//   - 0057 regression: a west/north-shifted cell's ground_type and
//     water_flow_direction (0047/0051, added well after grow_map_grid
//     originally shipped) survive the shift intact instead of silently
//     resetting to their defaults — the map_cells delete-then-reinsert used
//     to name an explicit, stale column list that predated both columns.
//   - 0057 regression: a concealed_pits row (0050 — a DM-only hidden-pit
//     shadow table keyed exactly like map_cells, added after grow_map_grid
//     shipped) shifts by the same dx/dy as every other per-cell table on a
//     west/north grow, so a hidden trap stays pinned to the same visible
//     cell instead of drifting onto the wrong one relative to the
//     now-larger grid.
//   - 0058 addition (docs/design/whiteboard-drawing-layer.md §8.1): a
//     map_whiteboard_tiles row (a fourth (map_id, x, y)-keyed table, added
//     to shift_map_coordinate_table's own allowlist alongside map_cells/
//     concealed_pits) shifts by the same dx/dy on a west/north grow, its
//     tile_png bytes byte-for-byte unchanged — proving the whiteboard
//     drawing layer's own per-cell persistence rides the ALREADY-FIXED
//     generic shift mechanism (0057) rather than needing a new one. Every
//     PRE-EXISTING assertion in this script (seed data, atomicity/
//     authorization, east/south no-op, the four real grows' own cell/
//     object/token/pit/combat checks) is left completely unchanged — the
//     whiteboard checks are additive, new checks alongside them, exactly
//     per this feature's own Notes on how conservatively to extend this
//     already-shipped, already-relied-upon RPC.
//
// Hybrid shape per verify-void-terrain.mjs: service-role client for setup
// and admin-side assertions, real signed-in clients for the RLS/RPC checks,
// and a real Playwright browser driving the actual editor UI (the Grid
// size controls in MapEditor.tsx) for the four real grows.
//
// Runs its OWN dev server on a dedicated port (not the shared :3000) so it
// doesn't collide with any other agent's dev server against this same
// shared local Supabase stack.
//
// Needs the local Supabase stack. Usage: node scripts/db/verify-map-grid-growth.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3101;
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
  console.log(`dev server not running on :${PORT} — starting yarn dev…`);
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
  const email = `map-grid-growth-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Grid Growth ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

/** Full snapshot of every row this feature touches, keyed for exact
 * before/after comparison — the atomicity and shift-correctness checks are
 * all "does this snapshot match the expected one", not spot checks. Reads
 * the map row FIRST (not inside the same Promise.all as the rest) because
 * the combat_encounters query needs its campaign_id, and combat_combatants
 * is scoped down to just this campaign's own encounter ids — the shared
 * local Supabase stack can have other agents' verify runs' combatants in it
 * concurrently, so an unfiltered read would risk cross-contaminating this
 * script's exact-match comparisons. */
async function snapshotMap(mapId) {
  const { data: map } = await admin.from("campaign_maps").select().eq("id", mapId).single();
  const [{ data: cells }, { data: objects }, { data: tokens }, { data: encounters }, { data: pits }, { data: whiteboardTiles }] =
    await Promise.all([
      admin.from("map_cells").select().eq("map_id", mapId).order("x").order("y"),
      admin.from("map_objects").select().eq("map_id", mapId).order("x").order("y"),
      admin.from("map_tokens").select().eq("map_id", mapId).order("x").order("y"),
      admin.from("combat_encounters").select().eq("campaign_id", map.campaign_id),
      // concealed_pits (0050) — DM-only, but the service-role admin client
      // bypasses RLS the same way it already does for every other table here.
      // Included in the snapshot (not a separate ad-hoc query) so it rides
      // along for free in the existing "every rejected call left everything
      // untouched" whole-snapshot equality check below, exactly like cells/
      // objects/tokens already do.
      admin.from("concealed_pits").select().eq("map_id", mapId).order("x").order("y"),
      // map_whiteboard_tiles (0058) — the whiteboard drawing layer's own
      // per-cell persistence, a fourth (map_id, x, y)-keyed table added to
      // shift_map_coordinate_table's allowlist. Same reasoning as pits
      // above: included here so it rides along for free in the existing
      // "every rejected call left everything untouched" equality check.
      admin.from("map_whiteboard_tiles").select().eq("map_id", mapId).order("x").order("y"),
    ]);
  const encounterIds = (encounters ?? []).map((e) => e.id);
  const { data: combatants } =
    encounterIds.length > 0
      ? await admin.from("combat_combatants").select().in("encounter_id", encounterIds).order("npc_name")
      : { data: [] };
  return {
    map,
    cells: cells ?? [],
    objects: objects ?? [],
    tokens: tokens ?? [],
    encounters: encounters ?? [],
    combatants: combatants ?? [],
    pits: pits ?? [],
    whiteboardTiles: whiteboardTiles ?? [],
  };
}

function cellPoint(cells, elevation, terrain) {
  return cells.find((c) => c.elevation === elevation && c.terrain_type === terrain) ?? null;
}

// Map editor toolbar redesign: Grid size now lives in the "Map" utility
// drawer (closed by default) instead of the old always-mounted flat
// toolbar. `handleGrowGrid`'s own full `window.location.reload()` means the
// drawer is closed again after every grow — opens it (a no-op if it's
// already open, checked first so this never just TOGGLES it shut on a
// later poll of the same wait) before each attempt to read the label.
async function openMapDrawer(page) {
  const alreadyOpen = await page
    .locator('[data-testid="grid-size-label"]')
    .isVisible()
    .catch(() => false);
  if (!alreadyOpen) {
    await page.click('[data-testid="map-drawer-toggle"]', { timeout: 2000 }).catch(() => {});
  }
}

async function waitForGridLabel(page, expected, timeoutMs = 30000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      await openMapDrawer(page);
      last = await page.locator('[data-testid="grid-size-label"]').textContent({ timeout: 2000 });
      if (last && last.trim() === expected) return last.trim();
    } catch {
      // Mid-reload — the old document is gone and the new one hasn't
      // attached yet; just retry.
    }
    await sleep(300);
  }
  return last;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Grid growth test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  // 5x5 starting grid — small enough to reason about exactly, big enough
  // that a shift by more than 1 in either direction is unambiguous.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Growth Test Map",
    grid_width: 5,
    grid_height: 5,
  });

  // Cell A carries ground_type AND water_flow_direction (0047/0051 — both
  // added well after grow_map_grid (0046) originally shipped, and the
  // exact two columns 0057 confirmed the old hardcoded shift column list
  // was silently dropping on every west/north grow). Cell B carries only
  // ground_type, no flow direction (a water cell with no authored arrow is
  // itself a legitimate, common state per 0051's own comment) — between
  // the two, every non-key map_cells column gets a non-default value
  // exercised through the shift.
  await admin.from("map_cells").insert([
    {
      map_id: mapId,
      x: 1,
      y: 1,
      elevation: 1,
      terrain_type: "difficult",
      light_level: "dim",
      ground_type: "water",
      water_flow_direction: "north",
    },
    { map_id: mapId, x: 3, y: 3, elevation: 2, terrain_type: "difficult", light_level: "bright", ground_type: "swamp" },
  ]);

  const assetId = crypto.randomUUID();
  await admin.from("asset_library").insert({
    id: assetId,
    name: "Growth Test Crate",
    source_type: "custom",
    model_ref: `${campaignId}/growth-test-crate.glb`,
    campaign_id: campaignId,
  });
  const objectId = crypto.randomUUID();
  await admin.from("map_objects").insert({
    id: objectId,
    map_id: mapId,
    asset_id: assetId,
    x: 2,
    y: 2,
    elevation: 0,
    rotation: 90,
  });

  const tokenAId = crypto.randomUUID();
  const tokenBId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: tokenAId, map_id: mapId, npc_name: "Goblin A", x: 0, y: 0, elevation: 0, allegiance: "hostile" },
    { id: tokenBId, map_id: mapId, npc_name: "Goblin B", x: 4, y: 4, elevation: 0, allegiance: "hostile" },
  ]);

  // A hidden pit trap (0050) at (4,0) — the grid's one remaining unused
  // corner, so it can never collide with a cell/object/token coordinate
  // above. Keyed exactly like map_cells (map_id, x, y) and, per 0057,
  // shifted the same way on a west/north grow. save_dc deliberately NOT
  // the 15 default, so a passthrough of every non-key column (not just
  // bottom_elevation_steps) is actually exercised end to end.
  await admin.from("concealed_pits").insert({ map_id: mapId, x: 4, y: 0, bottom_elevation_steps: 3, save_dc: 12 });

  // A whiteboard drawing-layer tile (0058) at (0,4) — the grid's OWN LAST
  // remaining unused corner ((0,0)/(4,4) are goblin tokens, (4,0) is the
  // concealed pit, (1,1)/(3,3) are painted cells, (2,2) is the placed
  // object), so it can never collide with anything else seeded above. A
  // tiny, valid PNG-header byte sequence, hex-encoded in the exact `\x`-
  // prefixed wire format bytea/PostgREST actually use (confirmed directly
  // against this project's own local stack — see src/data-access/
  // whiteboardTiles.ts's own doc comment) — this script only needs to prove
  // the raw BYTES survive a coordinate shift unchanged, not exercise the
  // drawing UI itself (that's scripts/db/verify-whiteboard-drawing.mjs's
  // job).
  const WHITEBOARD_TILE_PNG_HEX = "\\x89504e470d0a1a0a0000000d49484452";
  await admin
    .from("map_whiteboard_tiles")
    .insert({ map_id: mapId, x: 0, y: 4, tile_png: WHITEBOARD_TILE_PNG_HEX });

  // A live game in progress, mid-combat: a real encounter with non-default
  // round/turn state and two combatants, keyed by token_id (never by
  // coordinate) — this is what should come through every resize completely
  // untouched.
  const encounterId = crypto.randomUUID();
  await admin
    .from("combat_encounters")
    .insert({ id: encounterId, campaign_id: campaignId, round_number: 2, current_turn_index: 1 });
  await admin.from("combat_combatants").insert([
    { encounter_id: encounterId, token_id: tokenAId, npc_name: "Goblin A", initiative: 15 },
    { encounter_id: encounterId, token_id: tokenBId, npc_name: "Goblin B", initiative: 5 },
  ]);

  await admin.from("campaigns").update({ live_map: mapId, session_active: true }).eq("id", campaignId);

  const seedSnapshot = await snapshotMap(mapId);
  check(
    "seed data landed as expected (5x5, 2 cells, 1 object, 2 tokens, 1 encounter, 2 combatants)",
    seedSnapshot.map.grid_width === 5 &&
      seedSnapshot.map.grid_height === 5 &&
      seedSnapshot.cells.length === 2 &&
      seedSnapshot.objects.length === 1 &&
      seedSnapshot.tokens.length === 2 &&
      seedSnapshot.encounters.length === 1 &&
      seedSnapshot.combatants.length === 2,
    JSON.stringify(seedSnapshot.map)
  );
  check(
    "seed data also landed the ground_type/water_flow_direction paint and the one concealed pit (0057 fixtures)",
    cellPoint(seedSnapshot.cells, 1, "difficult")?.ground_type === "water" &&
      cellPoint(seedSnapshot.cells, 1, "difficult")?.water_flow_direction === "north" &&
      cellPoint(seedSnapshot.cells, 2, "difficult")?.ground_type === "swamp" &&
      seedSnapshot.pits.length === 1 &&
      seedSnapshot.pits[0].x === 4 &&
      seedSnapshot.pits[0].y === 0 &&
      seedSnapshot.pits[0].bottom_elevation_steps === 3 &&
      seedSnapshot.pits[0].save_dc === 12,
    JSON.stringify({ cells: seedSnapshot.cells, pits: seedSnapshot.pits })
  );
  check(
    "seed data also landed the one whiteboard tile (0058 fixture)",
    seedSnapshot.whiteboardTiles.length === 1 &&
      seedSnapshot.whiteboardTiles[0].x === 0 &&
      seedSnapshot.whiteboardTiles[0].y === 4 &&
      seedSnapshot.whiteboardTiles[0].tile_png === WHITEBOARD_TILE_PNG_HEX,
    JSON.stringify(seedSnapshot.whiteboardTiles)
  );

  // A non-DM member cannot write a whiteboard tile directly (0058 RLS) —
  // this project's established "gate real actions at the RLS layer, not
  // just the UI" discipline, checked the exact same way the very next
  // section checks it for grow_map_grid itself: a real signed-in player
  // client attempting the write directly against the table, not through
  // any app code that might client-side-gate it first.
  const { error: playerWhiteboardWriteError } = await player.client
    .from("map_whiteboard_tiles")
    .insert({ map_id: mapId, x: 9, y: 9, tile_png: WHITEBOARD_TILE_PNG_HEX });
  check(
    "a non-DM member cannot write a whiteboard tile directly — server-side RLS, not just client-gated (0058)",
    playerWhiteboardWriteError !== null,
    String(playerWhiteboardWriteError)
  );
  const { data: rejectedWhiteboardRow } = await admin
    .from("map_whiteboard_tiles")
    .select()
    .eq("map_id", mapId)
    .eq("x", 9)
    .eq("y", 9)
    .maybeSingle();
  check(
    "the rejected non-DM whiteboard write left no row behind",
    rejectedWhiteboardRow === null,
    JSON.stringify(rejectedWhiteboardRow)
  );

  // ── 1. Atomicity/authorization: every rejected call leaves EVERYTHING
  //       untouched — dimensions, cells, objects, tokens, combat. ──
  const { error: playerGrowError } = await player.client.rpc("grow_map_grid", {
    p_map_id: mapId,
    p_edge: "east",
    p_amount: 1,
  });
  check("a non-DM member (even one who can read the live map) cannot grow it", playerGrowError !== null, String(playerGrowError));

  const { error: badEdgeError } = await dm.client.rpc("grow_map_grid", {
    p_map_id: mapId,
    p_edge: "diagonal",
    p_amount: 1,
  });
  check("an invalid edge is rejected", badEdgeError !== null, String(badEdgeError));

  const { error: zeroAmountError } = await dm.client.rpc("grow_map_grid", {
    p_map_id: mapId,
    p_edge: "east",
    p_amount: 0,
  });
  check("a zero growth amount is rejected", zeroAmountError !== null, String(zeroAmountError));

  const { error: negativeAmountError } = await dm.client.rpc("grow_map_grid", {
    p_map_id: mapId,
    p_edge: "east",
    p_amount: -3,
  });
  check("a negative growth amount is rejected", negativeAmountError !== null, String(negativeAmountError));

  const { error: missingMapError } = await dm.client.rpc("grow_map_grid", {
    p_map_id: crypto.randomUUID(),
    p_edge: "east",
    p_amount: 1,
  });
  check("a nonexistent map is rejected", missingMapError !== null, String(missingMapError));

  const afterRejections = await snapshotMap(mapId);
  check(
    "every rejected call left the map completely untouched (dims, cells, objects, tokens, combat)",
    JSON.stringify(afterRejections) === JSON.stringify(seedSnapshot),
    `before: ${JSON.stringify(seedSnapshot.map)} after: ${JSON.stringify(afterRejections.map)}`
  );

  // ── 2. The real editor UI, DM session. ──
  // Explicit taller viewport (Playwright's own default is 1280×720):
  // editor.module.css's `.toolbar` is bottom-anchored (`position: absolute;
  // bottom: 24px`) with no max-height/scroll of its own, so it grows
  // upward as the editor accumulates more controls across features (asset
  // palette, terrain/ground-type painting, generate-area, grow-grid, wall
  // presets, …) — confirmed directly (not guessed) that at the 720px
  // default this panel is now tall enough to push `grow-grid-button`
  // entirely above the top of the viewport (a negative bounding-box y),
  // which Playwright's own auto-scroll can't fix since nothing here is a
  // scrolling container — `.editor` fills the viewport with `position:
  // fixed; inset: 0` and never scrolls. 1600 gives the current toolbar
  // comfortable headroom; bumping this is the right fix if a future
  // feature adds enough toolbar height to need more, rather than this
  // script's real editor-driving checks silently timing out again.
  const dmContext = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const page = await dmContext.newPage();
  await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  // Map editor toolbar redesign: Grid size now lives behind the "Map"
  // utility drawer button, closed by default.
  await openMapDrawer(page);
  check("the editor shows the starting 5×5 grid size", (await page.textContent('[data-testid="grid-size-label"]'))?.trim() === "5×5");

  // ── 3. Grow EAST by 2 — pure width bump, nothing moves. ──
  await page.fill('[data-testid="grow-amount"]', "2");
  // growEdge's own default is "east" — no select change needed for this one.
  await page.click('[data-testid="grow-grid-button"]');
  const afterEastLabel = await waitForGridLabel(page, "7×5");
  check("growing east updates the visible grid size to 7×5 after the reload", afterEastLabel === "7×5", afterEastLabel);
  await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 30000 });

  const afterEast = await snapshotMap(mapId);
  check("growing east only changed grid_width (5→7), grid_height untouched", afterEast.map.grid_width === 7 && afterEast.map.grid_height === 5, JSON.stringify(afterEast.map));
  check(
    "growing east left both cells at their exact original coordinates",
    cellPoint(afterEast.cells, 1, "difficult")?.x === 1 &&
      cellPoint(afterEast.cells, 1, "difficult")?.y === 1 &&
      afterEast.cells.find((c) => c.x === 3 && c.y === 3)?.elevation === 2,
    JSON.stringify(afterEast.cells)
  );
  const eastObject = afterEast.objects.find((o) => o.id === objectId);
  check("growing east left the placed object at its exact original coordinates", eastObject?.x === 2 && eastObject?.y === 2 && eastObject?.rotation === 90, JSON.stringify(eastObject));
  const eastTokenA = afterEast.tokens.find((t) => t.id === tokenAId);
  const eastTokenB = afterEast.tokens.find((t) => t.id === tokenBId);
  check(
    "growing east left both tokens at their exact original coordinates",
    eastTokenA?.x === 0 && eastTokenA?.y === 0 && eastTokenB?.x === 4 && eastTokenB?.y === 4,
    JSON.stringify({ eastTokenA, eastTokenB })
  );
  const { data: newEastColumnRows } = await admin.from("map_cells").select().eq("map_id", mapId).gte("x", 5);
  check("the two new east columns have no stored rows — they're sparse-default normal ground, not void", (newEastColumnRows ?? []).length === 0, JSON.stringify(newEastColumnRows));
  check(
    "growing east left ground_type/water_flow_direction untouched on both painted cells (0057 no-regression)",
    cellPoint(afterEast.cells, 1, "difficult")?.ground_type === "water" &&
      cellPoint(afterEast.cells, 1, "difficult")?.water_flow_direction === "north" &&
      afterEast.cells.find((c) => c.x === 3 && c.y === 3)?.ground_type === "swamp",
    JSON.stringify(afterEast.cells)
  );
  check(
    "growing east left the concealed pit at its exact original coordinates (0057 no-regression)",
    afterEast.pits.length === 1 && afterEast.pits[0].x === 4 && afterEast.pits[0].y === 0 && afterEast.pits[0].bottom_elevation_steps === 3,
    JSON.stringify(afterEast.pits)
  );
  check(
    "growing east left the whiteboard tile at its exact original coordinates (0058)",
    afterEast.whiteboardTiles.length === 1 &&
      afterEast.whiteboardTiles[0].x === 0 &&
      afterEast.whiteboardTiles[0].y === 4 &&
      afterEast.whiteboardTiles[0].tile_png === WHITEBOARD_TILE_PNG_HEX,
    JSON.stringify(afterEast.whiteboardTiles)
  );

  // ── 4. Grow SOUTH by 3 — pure height bump, nothing moves. ──
  await page.selectOption('[data-testid="grow-edge"]', "south");
  await page.fill('[data-testid="grow-amount"]', "3");
  await page.click('[data-testid="grow-grid-button"]');
  const afterSouthLabel = await waitForGridLabel(page, "7×8");
  check("growing south updates the visible grid size to 7×8 after the reload", afterSouthLabel === "7×8", afterSouthLabel);
  await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 30000 });

  const afterSouth = await snapshotMap(mapId);
  check("growing south only changed grid_height (5→8), grid_width untouched", afterSouth.map.grid_width === 7 && afterSouth.map.grid_height === 8, JSON.stringify(afterSouth.map));
  check(
    "growing south left every cell/object/token exactly where east already left them",
    JSON.stringify(afterSouth.cells) === JSON.stringify(afterEast.cells) &&
      JSON.stringify(afterSouth.objects) === JSON.stringify(afterEast.objects) &&
      JSON.stringify(afterSouth.tokens) === JSON.stringify(afterEast.tokens),
    "coordinates changed when they should not have"
  );
  check(
    "growing south left the concealed pit exactly where east already left it (0057 no-regression)",
    JSON.stringify(afterSouth.pits) === JSON.stringify(afterEast.pits),
    JSON.stringify({ afterEast: afterEast.pits, afterSouth: afterSouth.pits })
  );
  check(
    "growing south left the whiteboard tile exactly where east already left it (0058)",
    JSON.stringify(afterSouth.whiteboardTiles) === JSON.stringify(afterEast.whiteboardTiles),
    JSON.stringify({ afterEast: afterEast.whiteboardTiles, afterSouth: afterSouth.whiteboardTiles })
  );

  // ── 5. Grow WEST by 4 — THE risky case: every x shifts by +4. ──
  await page.selectOption('[data-testid="grow-edge"]', "west");
  await page.fill('[data-testid="grow-amount"]', "4");
  await page.click('[data-testid="grow-grid-button"]');
  const afterWestLabel = await waitForGridLabel(page, "11×8");
  check("growing west updates the visible grid size to 11×8 after the reload", afterWestLabel === "11×8", afterWestLabel);
  await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 30000 });

  const afterWest = await snapshotMap(mapId);
  check("growing west only changed grid_width (7→11), grid_height untouched", afterWest.map.grid_width === 11 && afterWest.map.grid_height === 8, JSON.stringify(afterWest.map));
  const westCellA = afterWest.cells.find((c) => c.elevation === 1 && c.terrain_type === "difficult");
  const westCellB = afterWest.cells.find((c) => c.elevation === 2 && c.terrain_type === "difficult");
  check(
    "growing west shifted cell A's x by exactly +4 (1→5), y untouched, elevation/terrain/light preserved",
    westCellA?.x === 5 && westCellA?.y === 1 && westCellA?.light_level === "dim",
    JSON.stringify(westCellA)
  );
  check("growing west shifted cell B's x by exactly +4 (3→7), y untouched", westCellB?.x === 7 && westCellB?.y === 3, JSON.stringify(westCellB));
  const westObject = afterWest.objects.find((o) => o.id === objectId);
  check(
    "growing west shifted the placed object's x by exactly +4 (2→6), y and rotation untouched",
    westObject?.x === 6 && westObject?.y === 2 && westObject?.rotation === 90,
    JSON.stringify(westObject)
  );
  const westTokenA = afterWest.tokens.find((t) => t.id === tokenAId);
  const westTokenB = afterWest.tokens.find((t) => t.id === tokenBId);
  check(
    "growing west shifted token A's x by exactly +4 (0→4), y untouched (was at the grid's own west edge)",
    westTokenA?.x === 4 && westTokenA?.y === 0,
    JSON.stringify(westTokenA)
  );
  check(
    "growing west shifted token B's x by exactly +4 (4→8), y untouched (was at the OPPOSITE, east edge)",
    westTokenB?.x === 8 && westTokenB?.y === 4,
    JSON.stringify(westTokenB)
  );
  const { data: newWestColumnRows } = await admin.from("map_cells").select().eq("map_id", mapId).lt("x", 4);
  check("the four new west columns have no stored rows — normal ground, not void", (newWestColumnRows ?? []).length === 0, JSON.stringify(newWestColumnRows));
  check(
    "the live combat encounter (round/turn state) survived the west grow completely untouched",
    afterWest.encounters[0]?.round_number === 2 && afterWest.encounters[0]?.current_turn_index === 1 && afterWest.encounters[0]?.id === encounterId,
    JSON.stringify(afterWest.encounters)
  );
  check(
    "both combatants' token_id references and initiative survived the west grow untouched",
    afterWest.combatants.find((c) => c.token_id === tokenAId)?.initiative === 15 &&
      afterWest.combatants.find((c) => c.token_id === tokenBId)?.initiative === 5,
    JSON.stringify(afterWest.combatants)
  );
  // 0057 regression checks: this is the exact case that used to silently
  // corrupt/desync — a west grow shifting a cell whose ground_type/
  // water_flow_direction predate grow_map_grid's original column list, and
  // a concealed pit that predates grow_map_grid ever knowing about it.
  check(
    "growing west preserved cell A's ground_type/water_flow_direction through the shift (0057 fix — previously silently reset to defaults)",
    westCellA?.ground_type === "water" && westCellA?.water_flow_direction === "north",
    JSON.stringify(westCellA)
  );
  check(
    "growing west preserved cell B's ground_type through the shift (0057 fix)",
    westCellB?.ground_type === "swamp",
    JSON.stringify(westCellB)
  );
  const westPit = afterWest.pits.find((p) => p.map_id === mapId);
  check(
    "growing west shifted the concealed pit's x by exactly +4 (4→8), y untouched, bottom_elevation_steps/save_dc preserved (0057 fix — previously never shifted at all)",
    westPit?.x === 8 && westPit?.y === 0 && westPit?.bottom_elevation_steps === 3 && westPit?.save_dc === 12,
    JSON.stringify(westPit)
  );
  check("growing west left exactly one concealed pit row (no duplicate left behind by the delete-then-reinsert)", afterWest.pits.length === 1, JSON.stringify(afterWest.pits));
  // 0058: the whiteboard drawing layer's own per-cell persistence, riding
  // the ALREADY-FIXED shift_map_coordinate_table mechanism (0057) via its
  // extended allowlist — the single highest-risk part of this whole
  // feature, per this feature's own Notes. Seeded at (0,4); a west grow by
  // 4 shifts x by +4 only, exactly like every other per-cell table above.
  const westWhiteboardTile = afterWest.whiteboardTiles.find((t) => t.map_id === mapId);
  check(
    "growing west shifted the whiteboard tile's x by exactly +4 (0→4), y untouched, tile_png bytes preserved byte-for-byte (0058)",
    westWhiteboardTile?.x === 4 && westWhiteboardTile?.y === 4 && westWhiteboardTile?.tile_png === WHITEBOARD_TILE_PNG_HEX,
    JSON.stringify(westWhiteboardTile)
  );
  check(
    "growing west left exactly one whiteboard tile row (no duplicate left behind by the delete-then-reinsert)",
    afterWest.whiteboardTiles.length === 1,
    JSON.stringify(afterWest.whiteboardTiles)
  );

  // ── 6. Grow NORTH by 2 — every y shifts by +2, on top of the west shift. ──
  await page.selectOption('[data-testid="grow-edge"]', "north");
  await page.fill('[data-testid="grow-amount"]', "2");
  await page.click('[data-testid="grow-grid-button"]');
  const afterNorthLabel = await waitForGridLabel(page, "11×10");
  check("growing north updates the visible grid size to 11×10 after the reload", afterNorthLabel === "11×10", afterNorthLabel);
  await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 30000 });

  const afterNorth = await snapshotMap(mapId);
  check("growing north only changed grid_height (8→10), grid_width untouched", afterNorth.map.grid_width === 11 && afterNorth.map.grid_height === 10, JSON.stringify(afterNorth.map));
  const northCellA = afterNorth.cells.find((c) => c.elevation === 1 && c.terrain_type === "difficult");
  const northCellB = afterNorth.cells.find((c) => c.elevation === 2 && c.terrain_type === "difficult");
  check(
    "growing north shifted cell A's y by exactly +2 (1→3), x stays at west's own 5",
    northCellA?.x === 5 && northCellA?.y === 3,
    JSON.stringify(northCellA)
  );
  check("growing north shifted cell B's y by exactly +2 (3→5), x stays at west's own 7", northCellB?.x === 7 && northCellB?.y === 5, JSON.stringify(northCellB));
  const northObject = afterNorth.objects.find((o) => o.id === objectId);
  check("growing north shifted the object's y by exactly +2 (2→4), x stays at 6", northObject?.x === 6 && northObject?.y === 4, JSON.stringify(northObject));
  const northTokenA = afterNorth.tokens.find((t) => t.id === tokenAId);
  const northTokenB = afterNorth.tokens.find((t) => t.id === tokenBId);
  check(
    "growing north shifted BOTH tokens' y by exactly +2, x untouched from the west grow — final real position for a token seeded at the grid's own corner",
    northTokenA?.x === 4 && northTokenA?.y === 2 && northTokenB?.x === 8 && northTokenB?.y === 6,
    JSON.stringify({ northTokenA, northTokenB })
  );
  const { data: newNorthRowRows } = await admin.from("map_cells").select().eq("map_id", mapId).lt("y", 2);
  check("the two new north rows have no stored rows — normal ground, not void", (newNorthRowRows ?? []).length === 0, JSON.stringify(newNorthRowRows));
  check(
    "the live combat encounter survived ALL FOUR resizes (round 2, turn index 1, same encounter id)",
    afterNorth.encounters.length === 1 && afterNorth.encounters[0].id === encounterId && afterNorth.encounters[0].round_number === 2 && afterNorth.encounters[0].current_turn_index === 1,
    JSON.stringify(afterNorth.encounters)
  );
  check(
    "both combatants survived all four resizes with their token_id/initiative intact — the mid-combat, tokens-present acceptance criterion",
    afterNorth.combatants.length === 2 &&
      afterNorth.combatants.find((c) => c.token_id === tokenAId)?.initiative === 15 &&
      afterNorth.combatants.find((c) => c.token_id === tokenBId)?.initiative === 5,
    JSON.stringify(afterNorth.combatants)
  );
  // 0057 regression checks, compounded across BOTH risky shifts (west then
  // north) — the acceptance bar this bug report actually sets: painted
  // ground_type/water_flow_direction and a hidden pit's coordinates must
  // both still be correct after two consecutive west/north grows, not just
  // one.
  check(
    "growing north (on top of west) still preserved cell A's ground_type/water_flow_direction (0057 fix)",
    northCellA?.ground_type === "water" && northCellA?.water_flow_direction === "north",
    JSON.stringify(northCellA)
  );
  check(
    "growing north (on top of west) still preserved cell B's ground_type (0057 fix)",
    northCellB?.ground_type === "swamp",
    JSON.stringify(northCellB)
  );
  const northPit = afterNorth.pits.find((p) => p.map_id === mapId);
  check(
    "growing north shifted the concealed pit's y by exactly +2 (0→2) on top of west's x shift (4→8), bottom_elevation_steps/save_dc still preserved (0057 fix)",
    northPit?.x === 8 && northPit?.y === 2 && northPit?.bottom_elevation_steps === 3 && northPit?.save_dc === 12,
    JSON.stringify(northPit)
  );
  check("growing north left exactly one concealed pit row", afterNorth.pits.length === 1, JSON.stringify(afterNorth.pits));
  // 0058, compounded across BOTH risky shifts — the same "still correct
  // after two consecutive west/north grows, not just one" bar 0057's own
  // checks above hold cells/pits to, now covering the whiteboard drawing
  // layer's own per-cell tiles too: draw something, grow west, grow north,
  // confirm the drawing is still aligned with the same terrain it was
  // drawn on (this script proves the coordinate math; the pixel-alignment
  // half of that same acceptance criterion is confirmed by a real drawn
  // stroke in scripts/db/verify-whiteboard-drawing.mjs).
  const northWhiteboardTile = afterNorth.whiteboardTiles.find((t) => t.map_id === mapId);
  check(
    "growing north shifted the whiteboard tile's y by exactly +2 (4→6) on top of west's x shift (0→4), tile_png bytes still preserved byte-for-byte (0058)",
    northWhiteboardTile?.x === 4 && northWhiteboardTile?.y === 6 && northWhiteboardTile?.tile_png === WHITEBOARD_TILE_PNG_HEX,
    JSON.stringify(northWhiteboardTile)
  );
  check(
    "growing north left exactly one whiteboard tile row",
    afterNorth.whiteboardTiles.length === 1,
    JSON.stringify(afterNorth.whiteboardTiles)
  );

  // ── 7. The live Game Room table still renders this map cleanly post-resize
  //       (no void cells introduced, no crash) — the "live game in progress"
  //       surface a DM's players are actually looking at. ──
  const roomPage = await dmContext.newPage();
  await roomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await roomPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  const tableMirrorText = await roomPage.textContent('[data-testid="table-surface-state"]');
  const tableMirror = JSON.parse(tableMirrorText);
  check(
    "the Game Room table loads the resized live map cleanly, with no void cells introduced by any of the four grows",
    tableMirror.mapId === mapId && tableMirror.voidCells.length === 0,
    tableMirrorText
  );
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
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
console.log("\nAll map grid growth checks passed.");
process.exit(0);
