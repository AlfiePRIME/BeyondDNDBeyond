#!/usr/bin/env node
// Ctrl+click chest quick-place verification (object tool only).
//
// Object placement normally requires picking an asset from the palette
// (setSelectedAssetId) before clicking a cell. This adds a shortcut scoped
// to the object tool: holding Ctrl (or Cmd — this file's undo/redo shortcut
// already treats the two as the same "platform modifier", matched here for
// consistency) while clicking a cell places the built-in Chest preset
// (a55e7002-0000-4000-8000-000000000002, seeded by
// 0016_asset_library_presets.sql) immediately, without touching the
// palette's own selection state.
//
// Covers, all through the DM's REAL editor UI:
//   1. Ctrl+click while the object tool is active places a Chest at the
//      clicked cell, even though a DIFFERENT asset is the palette's current
//      selection — and that selection is untouched afterward (the palette
//      still highlights the asset the DM actually picked, proving the
//      shortcut bypasses setSelectedAssetId rather than calling it with the
//      chest's id).
//   2. A plain click (no modifier) in the object tool is completely
//      unaffected — it places whatever asset is currently selected, same as
//      before this change.
//   3. Ctrl+click in the terrain tool and the raise tool do nothing special:
//      no map_objects row is created, and the normal paint/raise behavior
//      still happens (the object tool routes onCellClick at all; every
//      other tool never wires onCellClick to a chest-aware handler in the
//      first place, so this also exercises that routing).
//
// The scene is WebGL (no DOM to click a specific cell precisely), so this
// reuses the blind-aim scanClick technique from verify-void-terrain.mjs:
// click a centered-outward scan of canvas points until a DB/UI side effect
// confirms the gesture landed. The map is small and entirely normal terrain
// (no void cells), so any landed click is a valid target.
//
// Needs a reachable Supabase instance (via .env / supabase/.env); starts
// `yarn dev` itself (and polls /api/health) on PORT if nothing is already
// serving there. Defaults to a non-3000 port so it doesn't collide with
// another agent's dev server already bound to :3000.
// Usage: node scripts/db/verify-chest-quick-place.mjs
//        PORT=4177 node scripts/db/verify-chest-quick-place.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "4177";
const APP_URL = `http://localhost:${PORT}`;

// Fixed UUID from 0016_asset_library_presets.sql — see
// scripts/db/verify-asset-presets.mjs's EXPECTED table for the full set.
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
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `chest-quick-place-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Chest QP ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

/** The blind-aim workaround for WebGL scenes (verify-void-terrain.mjs's
 * scanClick): click a centered-outward scan of canvas points, each with the
 * given modifier keys held, until `done()` reports the scene reacted (or
 * the points run out). Steers clear of the DOM overlays (header top, panels
 * bottom-left). */
async function scanClick(page, done, opts = {}) {
  const {
    xFrom = 0.34,
    xTo = 0.74,
    yFrom = 0.26,
    yTo = 0.68,
    step = 42,
    modifiers = [],
    // Object placement is NOT the synchronous local-state update terrain
    // painting is — handleCellClick's create path awaits a real network
    // round trip to Supabase before the effect done() looks for becomes
    // observable. A short fixed settle (fine for terrain) would move on to
    // a SECOND point before the first click's placement lands, firing a
    // second, unwanted placement — polling per point until done() is true
    // (or this budget elapses) waits out exactly as long as each click
    // actually needs, however long that turns out to be.
    maxWaitMs = 3000,
    pollMs = 120,
  } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const key of modifiers) await page.keyboard.down(key);
  try {
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
  } finally {
    for (const key of modifiers) await page.keyboard.up(key);
  }
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

// scanClick's done() already confirmed the DB row exists (queried via a
// SEPARATE admin connection) by the time these text checks run, but the
// BROWSER's own createMapObject request and its React commit are an
// independent round trip that can lag the admin client's view by a beat —
// polls briefly instead of reading textContent exactly once.
async function waitForTextIncludes(page, testid, substring, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await page.textContent(`[data-testid="${testid}"]`).catch(() => null);
    if (last?.includes(substring)) return true;
    await sleep(120);
  } while (Date.now() < deadline);
  console.error(`  (waitForTextIncludes timed out — last saw: ${JSON.stringify(last)})`);
  return false;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Chest quick-place test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // 8x8, entirely default (normal) terrain — no void cells needed since this
  // is about the click-routing/modifier gesture, not the void-placement
  // guard verify-void-terrain.mjs already covers. Bigger than void-terrain's
  // 3x3 deliberately: every placement step below just needs SOME empty
  // cell, not a specific one, and re-landing on an already-occupied cell is
  // a harmless no-op (it selects instead of placing) that the scan simply
  // continues past — more cells means that's over almost immediately.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Chest quick-place room",
    grid_width: 8,
    grid_height: 8,
  });

  // A second, non-chest asset for the palette so a plain click's "whatever
  // is selected" behavior is provably distinct from the chest shortcut,
  // rather than coincidentally matching it (Chest sorts first alphabetically
  // among the presets, so the palette's OWN default selection could
  // otherwise mask a broken quick-place).
  const crateAssetId = crypto.randomUUID();
  await admin.from("asset_library").insert({
    id: crateAssetId,
    name: "Quick Place Test Crate",
    source_type: "custom",
    model_ref: `${campaignId}/quick-place-test-crate.glb`,
    campaign_id: campaignId,
  });

  // Tall viewport: a selected placed object expands the (position: absolute,
  // un-scrollable) toolbar panel with Rotate/Move/Remove/LOS-toggle/Behavior-
  // editor controls, which can push the tool switcher buttons above it
  // outside a default-sized viewport with no way to scroll them into view.
  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const editorPage = await dmContext.newPage();
  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });

  // ── 1. Object tool, explicitly select the non-chest crate (not the
  //       default palette selection), plain click places THAT asset. ──
  // Map editor toolbar redesign: Object now lives in Place mode's context
  // panel, not the old always-mounted flat toolbar.
  await editorPage.click('[data-testid="mode-place"]');
  await editorPage.click('[data-testid="tool-object"]');
  await editorPage.waitForSelector('[data-testid="asset-palette"]', { timeout: 10000 });
  await editorPage.click(`[data-testid="asset-${crateAssetId}"]`);
  check(
    "the crate asset is selected in the palette before any placement",
    (await editorPage.getAttribute(`[data-testid="asset-${crateAssetId}"]`, "aria-pressed")) === "true"
  );

  const plainClickAt = await scanClick(editorPage, () => isVisible(editorPage, "selected-object"));
  check("a plain click in the object tool places something", plainClickAt !== null);
  const { data: objectsAfterPlain } = await admin.from("map_objects").select().eq("map_id", mapId);
  check(
    "a plain click places the PALETTE-SELECTED asset (the crate), not the chest — unchanged behavior",
    (objectsAfterPlain ?? []).length === 1 && objectsAfterPlain[0].asset_id === crateAssetId,
    JSON.stringify(objectsAfterPlain)
  );

  // ── 2. Same tool, same crate still selected: Ctrl+click a DIFFERENT cell
  //       places a Chest instead, and the palette selection is untouched.
  //       Re-landing on the crate's own cell just selects it (unaffected by
  //       Ctrl) rather than placing on top of it, so the scan harmlessly
  //       continues past it to an empty cell instead of ever failing here. ──
  const ctrlClickAt = await scanClick(
    editorPage,
    async () => (await admin.from("map_objects").select().eq("map_id", mapId)).data?.length >= 2,
    { modifiers: ["Control"] }
  );
  check("Ctrl+click in the object tool places something", ctrlClickAt !== null);
  const { data: objectsAfterCtrl } = await admin.from("map_objects").select().eq("map_id", mapId).order("created_at");
  const chestRow = (objectsAfterCtrl ?? []).find((row) => row.asset_id === CHEST_PRESET_ID);
  check(
    "Ctrl+click quick-places the built-in Chest — no palette selection needed",
    (objectsAfterCtrl ?? []).length === 2 && chestRow !== undefined,
    JSON.stringify(objectsAfterCtrl)
  );
  check(
    "the newly placed Chest becomes selected, and its name reads 'Chest' in the editor",
    await waitForTextIncludes(editorPage, "selected-object", "Chest")
  );
  check(
    "the palette's OWN selection is untouched by the shortcut — the crate is still the pressed card",
    (await editorPage.getAttribute(`[data-testid="asset-${crateAssetId}"]`, "aria-pressed")) === "true"
  );
  check(
    "the Chest preset card itself was never pressed by the shortcut (setSelectedAssetId was bypassed)",
    (await editorPage.getAttribute(`[data-testid="asset-${CHEST_PRESET_ID}"]`, "aria-pressed")) === "false"
  );

  // ── 3. A plain click right after still uses the crate again — the
  //       shortcut didn't leave the palette selection pointed at the chest. ──
  const secondPlainClickAt = await scanClick(
    editorPage,
    async () => (await admin.from("map_objects").select().eq("map_id", mapId)).data?.length >= 3
  );
  check("a further plain click after the shortcut still places something", secondPlainClickAt !== null);
  const { data: objectsAfterSecondPlain } = await admin
    .from("map_objects")
    .select()
    .eq("map_id", mapId)
    .order("created_at");
  const newestRow = (objectsAfterSecondPlain ?? [])[objectsAfterSecondPlain.length - 1];
  check(
    "the very next plain click still places the crate, proving Ctrl+click never called setSelectedAssetId",
    newestRow?.asset_id === crateAssetId,
    JSON.stringify(newestRow)
  );

  // Numeric reading of the dirty-cell counter (format "N unsaved cell(s)"),
  // 0 when the badge isn't rendered at all (nothing dirty yet) — used below
  // to prove a NEW cell got painted, not just that some earlier one still
  // shows dirty from a previous step.
  async function dirtyCount(page) {
    if (!(await isVisible(page, "dirty-count"))) return 0;
    const text = await page.textContent('[data-testid="dirty-count"]');
    return Number(text?.match(/\d+/)?.[0] ?? 0);
  }

  // ── 4. Ctrl+click in the terrain tool does nothing special: no object
  //       gets created, and the normal terrain paint still happens. ──
  const objectCountBeforeTerrain = (objectsAfterSecondPlain ?? []).length;
  // Terrain lives in Sculpt mode — back out of Place mode first.
  await editorPage.click('[data-testid="mode-sculpt"]');
  await editorPage.click('[data-testid="tool-terrain"]');
  await editorPage.waitForSelector('[data-testid="brush-difficult"]', { timeout: 10000 });
  const dirtyBeforeTerrain = await dirtyCount(editorPage);
  const terrainCtrlClickAt = await scanClick(
    editorPage,
    async () => (await dirtyCount(editorPage)) > dirtyBeforeTerrain,
    { modifiers: ["Control"] }
  );
  check("Ctrl+click in the terrain tool still paints (the tool itself is unaffected)", terrainCtrlClickAt !== null);
  const { data: objectsAfterTerrainCtrl } = await admin.from("map_objects").select().eq("map_id", mapId);
  check(
    "Ctrl+click in the terrain tool creates NO object — the shortcut is object-tool-only",
    (objectsAfterTerrainCtrl ?? []).length === objectCountBeforeTerrain,
    `before: ${objectCountBeforeTerrain}, after: ${(objectsAfterTerrainCtrl ?? []).length}`
  );

  // ── 5. Ctrl+click in the raise tool: same — no object, normal raise. ──
  // Pre-existing stale testid fixed incidentally (flagged by the toolbar
  // redesign's own verify-script audit, unrelated to this redesign): the
  // separate "raise"/"lower" tools were folded into one "elevation" tool
  // (direction read from the mouse button) well before this redesign —
  // `tool-raise` hasn't existed since then. Already in Sculpt mode from
  // the terrain step above, so no mode-rail click is needed here.
  await editorPage.click('[data-testid="tool-elevation"]');
  const dirtyBeforeRaise = await dirtyCount(editorPage);
  const raiseCtrlClickAt = await scanClick(
    editorPage,
    async () => (await dirtyCount(editorPage)) > dirtyBeforeRaise,
    { modifiers: ["Control"] }
  );
  check("Ctrl+click in the raise tool still raises (the tool itself is unaffected)", raiseCtrlClickAt !== null);
  const { data: objectsAfterRaiseCtrl } = await admin.from("map_objects").select().eq("map_id", mapId);
  check(
    "Ctrl+click in the raise tool creates NO object — the shortcut is object-tool-only",
    (objectsAfterRaiseCtrl ?? []).length === objectCountBeforeTerrain,
    `before: ${objectCountBeforeTerrain}, after: ${(objectsAfterRaiseCtrl ?? []).length}`
  );
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
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
console.log("\nAll chest quick-place checks passed.");
process.exit(0);
