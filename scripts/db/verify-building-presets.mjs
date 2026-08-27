#!/usr/bin/env node
// Medieval building presets (Map Editor Batch A8a) verification.
//
// Covers:
//   1. All 8 new built-in preset rows (Cottage, Timber House, Roundhouse,
//      Town Hall, Tavern, Shop, Food Cart, Farm Cart) exist in
//      asset_library with the right name/source_type/model_ref, and each
//      model_ref points at a real generated .glb on disk — the same
//      DB-level shape verify-asset-presets.mjs already checks for the
//      original 8, scoped to this batch's own 8 new rows.
//   2. Through the DM's REAL map editor UI (Place mode, object tool): each
//      of the 8 new presets appears as a real card in the sidebar asset
//      palette (data-testid="asset-<uuid>") — no code change was needed in
//      MapEditor.tsx/AssetPickerGrid.tsx for this to be true (the palette
//      already renders whatever asset_library returns), so this is really
//      confirming the migration seeded correctly end to end, not a new UI
//      path.
//   3. Each of the 8 can actually be placed via the normal Place-mode
//      click-to-place flow: select the card, click an empty cell, confirm
//      a real map_objects row appears with that exact asset_id.
//   4. No overlap/clipping concern for a multi-cell footprint: per this
//      prompt's own judgment call (documented in
//      generate-building-presets.mjs and 0066_building_presets.sql), none
//      of these 8 presets use a multi-cell footprint — every one is
//      auto-normalized to a SINGLE cell by PlacedObject.tsx's existing
//      maxDim-based scaling, the same convention every other built-in
//      preset already uses. Two of the eight are placed on cells directly
//      ADJACENT to each other and to the map's own edge (top-left corner)
//      to confirm that ordinary single-cell placement there is exactly as
//      unremarkable as anywhere else on the grid — no crash, no page
//      error, no rendering exception.
//   5. No uncaught page errors while loading/rendering any of these new,
//      more complex (multi-material, up to 12-mesh) models.
//
// Needs a reachable Supabase instance (via .env / supabase/.env) with this
// batch's own 0066 migration already applied (`node scripts/db/migrate.mjs`)
// and the presets themselves generated
// (`node scripts/assets/generate-building-presets.mjs`); starts `yarn dev`
// itself (and polls /api/health) on PORT if nothing is already serving
// there. Defaults to a non-3000 port — :3000 on this machine is a live
// production server, not this worktree's own build.
// Usage: node scripts/db/verify-building-presets.mjs
//        PORT=4899 node scripts/db/verify-building-presets.mjs

import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "4899";
const APP_URL = `http://localhost:${PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
const SCREENSHOT_DIR = join(SCRATCH_DIR, "building-presets-screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Mirrors scripts/assets/generate-building-presets.mjs's own PRESETS — the
// fixed UUIDs seeded by 0066_building_presets.sql, continuing the a55e7NNN
// sequence one past 0059's Pressure Plate (…013).
const EXPECTED = [
  { uuid: "a55e7014-0000-4000-8000-000000000014", name: "Cottage", file: "cottage.glb" },
  { uuid: "a55e7015-0000-4000-8000-000000000015", name: "Timber House", file: "timber-house.glb" },
  { uuid: "a55e7016-0000-4000-8000-000000000016", name: "Roundhouse", file: "roundhouse.glb" },
  { uuid: "a55e7017-0000-4000-8000-000000000017", name: "Town Hall", file: "town-hall.glb" },
  { uuid: "a55e7018-0000-4000-8000-000000000018", name: "Tavern", file: "tavern.glb" },
  { uuid: "a55e7019-0000-4000-8000-000000000019", name: "Shop", file: "shop.glb" },
  { uuid: "a55e7020-0000-4000-8000-000000000020", name: "Food Cart", file: "food-cart.glb" },
  { uuid: "a55e7021-0000-4000-8000-000000000021", name: "Farm Cart", file: "farm-cart.glb" },
];

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
  devServer = spawn("yarn", ["dev"], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PORT },
  });
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
  const email = `building-presets-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Building Presets ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

function hasExpectedRow(rows, expected) {
  const row = (rows ?? []).find((r) => r.id === expected.uuid);
  return (
    row !== undefined &&
    row.name === expected.name &&
    row.source_type === "preset" &&
    row.campaign_id === null &&
    row.model_ref === `/assets/presets/${expected.file}`
  );
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

/** verify-quick-place-popover.mjs's own scanClick: click a centered-outward
 * scan of canvas points until `done()` reports the scene reacted. Object
 * placement is a real network round trip, so each point is polled briefly
 * rather than clicked-and-moved-on immediately. */
async function scanClick(page, done, opts = {}) {
  const {
    xFrom = 0.3,
    xTo = 0.78,
    yFrom = 0.22,
    yTo = 0.72,
    step = 40,
    maxWaitMs = 3000,
    pollMs = 120,
  } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const offset of [0, step / 2]) {
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
      await page.mouse.click(point.x, point.y);
      const deadline = Date.now() + maxWaitMs;
      do {
        if (await done(point)) return point;
        await sleep(pollMs);
      } while (Date.now() < deadline);
    }
  }
  return null;
}

async function objectRows(mapId) {
  const { data, error } = await admin.from("map_objects").select().eq("map_id", mapId).order("created_at");
  if (error) throw error;
  return data ?? [];
}

// ═══════════════════════════════════════════════════════════════════════
// 1. DB-level: every new row exists with the right shape, every model_ref
//    file is real, on disk.
// ═══════════════════════════════════════════════════════════════════════
const { data: presetRows, error: presetError } = await admin
  .from("asset_library")
  .select()
  .eq("source_type", "preset");
if (presetError) throw presetError;

for (const expected of EXPECTED) {
  check(`asset_library has a correct row for "${expected.name}"`, hasExpectedRow(presetRows, expected));
  check(
    `"${expected.name}"'s model_ref points at a real file (public/assets/presets/${expected.file})`,
    existsSync(join(rootDir, "public", "assets", "presets", expected.file))
  );
}
check(
  "every new preset is visually distinct from every OTHER new preset (no two share a model_ref)",
  new Set(EXPECTED.map((e) => e.file)).size === EXPECTED.length
);
check(
  "no new preset's model_ref collides with any PRE-EXISTING preset's file",
  EXPECTED.every((e) => !presetRows.some((r) => !EXPECTED.some((x) => x.uuid === r.id) && r.model_ref.endsWith(`/${e.file}`)))
);

// ═══════════════════════════════════════════════════════════════════════
// 2 & 3. Through the real editor UI: each preset appears in the palette
//    and can actually be placed.
// ═══════════════════════════════════════════════════════════════════════
await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Building presets test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // 8x8 — comfortably more empty cells than the 8 sequential placements
  // below need, matching verify-quick-place-popover.mjs's own precedent for
  // a script that places several objects in a row via scanClick.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Building presets room",
    grid_width: 8,
    grid_height: 8,
  });

  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const editorPage = await dmContext.newPage();
  editorPage.on("pageerror", (err) => pageErrors.push(String(err)));

  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await editorPage.click('[data-testid="mode-place"]');
  await editorPage.click('[data-testid="tool-object"]');
  await editorPage.waitForSelector('[data-testid="asset-palette"]', { timeout: 10000 });

  for (const expected of EXPECTED) {
    check(
      `"${expected.name}" appears as a real card in the sidebar asset palette`,
      await isVisible(editorPage, `asset-${expected.uuid}`)
    );
  }

  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "00-palette-with-all-8-buildings.png") });

  for (const expected of EXPECTED) {
    const before = await objectRows(mapId);
    await editorPage.click(`[data-testid="asset-${expected.uuid}"]`);
    check(
      `"${expected.name}" becomes the active palette selection`,
      (await editorPage.getAttribute(`[data-testid="asset-${expected.uuid}"]`, "aria-pressed")) === "true"
    );
    // Same shared scan region every time (verify-quick-place-popover.mjs's
    // own precedent for placing several objects in a row): clicking a cell
    // an EARLIER preset already occupies just selects it (no new row), so
    // done() stays false and the scan naturally continues past it to a
    // still-empty cell — no need to pre-partition the canvas into per-index
    // bands.
    const point = await scanClick(editorPage, async () => (await objectRows(mapId)).length > before.length);
    check(`"${expected.name}" is placeable on the map via a real canvas click`, point !== null);
    const after = await objectRows(mapId);
    const placed = after.find((row) => !before.some((b) => b.id === row.id));
    check(
      `the newly created map_objects row for "${expected.name}" has the correct asset_id`,
      placed?.asset_id === expected.uuid,
      JSON.stringify(placed)
    );
  }

  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "01-all-8-buildings-placed.png") });

  const allPlaced = await objectRows(mapId);
  check("all 8 new building presets were placed as 8 distinct objects", allPlaced.length === EXPECTED.length);
  const coordKeys = allPlaced.map((row) => `${row.x},${row.y}`);
  check(
    "every placement landed on its own distinct cell — no accidental double-placement/overlap",
    new Set(coordKeys).size === coordKeys.length,
    JSON.stringify(coordKeys)
  );

  // ═════════════════════════════════════════════════════════════════════
  // 4. No multi-cell footprint was built (this prompt's own judgment
  //    call — see generate-building-presets.mjs/0066's own doc comments):
  //    confirm two buildings sitting on cells directly ADJACENT to each
  //    other, right at the map's own top-left corner, is exactly as
  //    unremarkable as any other placement — seeded directly (this batch's
  //    own lesson: seed setup state via the admin client, not a blind UI
  //    scan, since exact-cell targeting isn't reliably scriptable through a
  //    WebGL canvas) — then reload and confirm both render with no page
  //    error and no overlap/crash.
  // ═════════════════════════════════════════════════════════════════════
  const cornerA = { id: crypto.randomUUID(), map_id: mapId, asset_id: EXPECTED[0].uuid, x: 0, y: 0 };
  const cornerB = { id: crypto.randomUUID(), map_id: mapId, asset_id: EXPECTED[1].uuid, x: 1, y: 0 };
  const { error: cornerError } = await dm.client.from("map_objects").insert([cornerA, cornerB]);
  check("seeded two buildings on adjacent cells at the map's own edge", !cornerError, cornerError?.message);

  await editorPage.reload();
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await sleep(1500);
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "02-adjacent-edge-buildings-after-reload.png") });

  const afterReload = await objectRows(mapId);
  check(
    "both edge-adjacent buildings still exist, at their own distinct cells, after a real reload",
    afterReload.some((r) => r.id === cornerA.id && r.x === 0 && r.y === 0) &&
      afterReload.some((r) => r.id === cornerB.id && r.x === 1 && r.y === 0)
  );

  check("no uncaught page errors occurred while loading/rendering any of the 8 new models", pageErrors.length === 0, pageErrors.join("\n"));
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll building preset checks passed. Screenshots: ${SCREENSHOT_DIR}`);
process.exit(0);
