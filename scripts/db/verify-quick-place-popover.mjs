#!/usr/bin/env node
// Ctrl+click quick-place POPOVER verification (Map Editor Batch A1, object
// tool only) — supersedes the old hardcoded-Chest verify-chest-quick-place.mjs
// (renamed: this file used to test "Ctrl+click always places a Chest"; it now
// tests "Ctrl+click opens a popover listing the real asset roster").
//
// Object placement normally requires picking an asset from the sidebar
// palette (setSelectedAssetId) before clicking a cell. Ctrl (or Cmd) + click
// in the object tool now opens a small popover at the clicked cell's own
// screen position, listing the exact same roster the sidebar palette shows
// (AssetPickerGrid, shared by both) — picking a card from it places THAT
// asset at the clicked cell in one motion, without ever touching the
// palette's own selectedAssetId. Escape or a click anywhere outside the
// popover dismisses it with no placement.
//
// Covers, all through the DM's REAL editor UI:
//   1. A plain click in the object tool is unaffected — it places whatever
//      asset is currently selected in the sidebar palette, same as always.
//   2. Ctrl+click opens the popover positioned at the exact screen point
//      clicked, WITHOUT placing anything yet.
//   3. Picking a card from the popover places that asset at the clicked
//      cell — verified by re-clicking that exact same screen point
//      afterward (plain click) and confirming it SELECTS the newly placed
//      object rather than creating a second one, proving the placement
//      landed on the very cell that was clicked, not some other one.
//   4. Escape closes the popover with no placement; a further plain click
//      at the same point places normally afterward (nothing left armed).
//   5. Clicking away (anywhere outside the popover) closes it with no
//      placement, same follow-up check as Escape.
//   6. Throughout all of the above, the sidebar palette's own selection
//      (a non-chest, non-preset asset) is never touched by the shortcut —
//      proving it bypasses setSelectedAssetId entirely, exactly like the
//      hardcoded-Chest shortcut it replaces did.
//   7. Ctrl+click in the terrain tool and the elevation tool do nothing
//      special: no map_objects row is created, and the normal paint/raise
//      behavior still happens (the object tool routes onCellClick at all;
//      every other tool never wires onCellClick to this handler at all).
//
// The scene is WebGL (no DOM to click a specific cell precisely), so this
// reuses the blind-aim scanClick technique from verify-void-terrain.mjs:
// click a centered-outward scan of canvas points until a DB/UI side effect
// confirms the gesture landed. The map is small and entirely normal terrain
// (no void cells), so any landed click is a valid target. Because
// scanClick's page.mouse.click(x, y) uses real page-viewport coordinates —
// exactly what a ThreeEvent's clientX/clientY carry — the popover's
// rendered position can be checked directly against the point scanClick
// actually landed on.
//
// Needs a reachable Supabase instance (via .env / supabase/.env); starts
// `yarn dev` itself (and polls /api/health) on PORT if nothing is already
// serving there. Defaults to a non-3000 port so it doesn't collide with
// another agent's dev server already bound to :3000.
// Usage: node scripts/db/verify-quick-place-popover.mjs
//        PORT=4177 node scripts/db/verify-quick-place-popover.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "4178";
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
  const email = `quick-place-popover-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Quick Place QP ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

/** The blind-aim workaround for WebGL scenes (verify-void-terrain.mjs's
 * scanClick): click a centered-outward scan of canvas points, each with the
 * given modifier keys held, until `done()` reports the scene reacted (or
 * the points run out). Steers clear of the DOM overlays (header top, panels
 * bottom-left). Returns the exact {x, y} PAGE (viewport) coordinates the
 * successful click landed on — the same coordinate space a ThreeEvent's
 * clientX/clientY carry, so callers can check a screen-positioned popover
 * against it directly. */
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

async function waitUntil(condition, timeoutMs = 3000, pollMs = 120) {
  const deadline = Date.now() + timeoutMs;
  let last = false;
  do {
    last = await condition();
    if (last) return true;
    await sleep(pollMs);
  } while (Date.now() < deadline);
  return last;
}

async function objectCount(mapId) {
  const { data } = await admin.from("map_objects").select().eq("map_id", mapId);
  return (data ?? []).length;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Quick-place popover test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // 8x8, entirely default (normal) terrain — no void cells needed since this
  // is about the click-routing/modifier gesture and the popover's own
  // position/dismissal, not the void-placement guard verify-void-terrain.mjs
  // already covers. Bigger than void-terrain's 3x3 deliberately: every
  // placement step below just needs SOME empty cell, not a specific one,
  // and re-landing on an already-occupied cell is a harmless no-op (it
  // selects instead of placing) that the scan simply continues past.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Quick-place popover room",
    grid_width: 8,
    grid_height: 8,
  });

  // A second, non-chest asset for the palette so a plain click's "whatever
  // is selected" behavior is provably distinct from the popover's own
  // picks, rather than coincidentally matching one — Chest sorts first
  // alphabetically among the presets, so the palette's OWN default
  // selection could otherwise mask a broken quick-place popover.
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
  check(
    "a plain click places the PALETTE-SELECTED asset (the crate), not any hardcoded preset — unchanged behavior",
    (await objectCount(mapId)) === 1 &&
      (await admin.from("map_objects").select().eq("map_id", mapId)).data[0].asset_id === crateAssetId
  );

  // ── 2. Ctrl+click opens the popover at the clicked cell's own screen
  //       position, WITHOUT placing anything yet. ──
  const quickPlacePoint = await scanClick(
    editorPage,
    () => isVisible(editorPage, "quick-place-popover"),
    { modifiers: ["Control"] }
  );
  check("Ctrl+click in the object tool opens the quick-place popover", quickPlacePoint !== null);
  check(
    "opening the popover places NOTHING yet — still exactly the one crate from step 1",
    (await objectCount(mapId)) === 1
  );
  const popoverBox = await editorPage.locator('[data-testid="quick-place-popover"]').boundingBox();
  check(
    "the popover is positioned at the clicked cell's exact screen coordinates",
    popoverBox !== null &&
      Math.abs(popoverBox.x - quickPlacePoint.x) <= 2 &&
      Math.abs(popoverBox.y - quickPlacePoint.y) <= 2,
    `popover at (${popoverBox?.x}, ${popoverBox?.y}), clicked at (${quickPlacePoint.x}, ${quickPlacePoint.y})`
  );
  check(
    "the popover lists the same roster the sidebar palette shows — the crate is present",
    await isVisible(editorPage, `quick-place-asset-${crateAssetId}`)
  );
  check(
    "the popover lists the same roster the sidebar palette shows — a built-in preset (Chest) is present",
    await isVisible(editorPage, `quick-place-asset-${CHEST_PRESET_ID}`)
  );
  check(
    "the palette's OWN selection is untouched merely by OPENING the popover — the crate is still pressed",
    (await editorPage.getAttribute(`[data-testid="asset-${crateAssetId}"]`, "aria-pressed")) === "true"
  );

  // ── 3. Picking a card from the popover places that asset AT THE CLICKED
  //       CELL — proven by re-clicking that exact same screen point
  //       afterward (plain click) and confirming it SELECTS the new object
  //       (an occupant) rather than creating a second one. ──
  await editorPage.click(`[data-testid="quick-place-asset-${CHEST_PRESET_ID}"]`);
  check(
    "picking a popover card closes it",
    await waitUntil(async () => !(await isVisible(editorPage, "quick-place-popover")))
  );
  check(
    "picking a popover card places exactly one new object",
    await waitUntil(async () => (await objectCount(mapId)) === 2)
  );
  const rowsAfterPick = (await admin.from("map_objects").select().eq("map_id", mapId).order("created_at")).data;
  check(
    "the newly placed object is the asset picked from the popover (Chest), not the palette's own crate",
    rowsAfterPick[1].asset_id === CHEST_PRESET_ID,
    JSON.stringify(rowsAfterPick)
  );
  check(
    "the newly placed object becomes selected, and its name reads 'Chest' in the editor",
    await waitForTextIncludes(editorPage, "selected-object", "Chest")
  );
  check(
    "the palette's OWN selection is still untouched — the crate is still the pressed card",
    (await editorPage.getAttribute(`[data-testid="asset-${crateAssetId}"]`, "aria-pressed")) === "true"
  );
  check(
    "the Chest preset card in the SIDEBAR palette was never pressed by the popover pick (setSelectedAssetId was bypassed)",
    (await editorPage.getAttribute(`[data-testid="asset-${CHEST_PRESET_ID}"]`, "aria-pressed")) === "false"
  );
  // Re-click the EXACT same point the popover was opened at (plain click,
  // no modifier). If the Chest really landed on that cell, this SELECTS it
  // (an occupant click) instead of creating a second object there.
  await editorPage.mouse.click(quickPlacePoint.x, quickPlacePoint.y);
  await sleep(300);
  check(
    "re-clicking the exact same screen point selects the just-placed object rather than creating a new one — proving it landed on that exact cell",
    (await objectCount(mapId)) === 2
  );
  check(
    "the re-click's selection is still the Chest that was placed there",
    await waitForTextIncludes(editorPage, "selected-object", "Chest")
  );

  // ── 4. A further plain click after the popover pick still uses the
  //       crate again — the popover never left the palette selection
  //       pointed at whatever it last placed. ──
  const secondPlainClickAt = await scanClick(
    editorPage,
    async () => (await objectCount(mapId)) >= 3
  );
  check("a further plain click after the popover pick still places something", secondPlainClickAt !== null);
  const rowsAfterSecondPlain = (
    await admin.from("map_objects").select().eq("map_id", mapId).order("created_at")
  ).data;
  const newestAfterSecondPlain = rowsAfterSecondPlain[rowsAfterSecondPlain.length - 1];
  check(
    "the very next plain click still places the crate, proving the popover never called setSelectedAssetId",
    newestAfterSecondPlain?.asset_id === crateAssetId,
    JSON.stringify(newestAfterSecondPlain)
  );

  // ── 5. Escape closes the popover with no placement; a further plain
  //       click at the same point places normally afterward. ──
  const escapePoint = await scanClick(
    editorPage,
    () => isVisible(editorPage, "quick-place-popover"),
    { modifiers: ["Control"] }
  );
  check("Ctrl+click opens the popover again for the Escape check", escapePoint !== null);
  const countBeforeEscape = await objectCount(mapId);
  await editorPage.keyboard.press("Escape");
  check(
    "Escape closes the popover",
    await waitUntil(async () => !(await isVisible(editorPage, "quick-place-popover")))
  );
  check("Escape places nothing", (await objectCount(mapId)) === countBeforeEscape);
  await editorPage.mouse.click(escapePoint.x, escapePoint.y);
  check(
    "a plain click at the same point after Escape still places normally (nothing left armed)",
    await waitUntil(async () => (await objectCount(mapId)) === countBeforeEscape + 1)
  );

  // ── 6. Clicking away (anywhere outside the popover) closes it with no
  //       placement; a further plain click at the same point places
  //       normally afterward. ──
  const clickAwayPoint = await scanClick(
    editorPage,
    () => isVisible(editorPage, "quick-place-popover"),
    { modifiers: ["Control"] }
  );
  check("Ctrl+click opens the popover again for the click-away check", clickAwayPoint !== null);
  const countBeforeClickAway = await objectCount(mapId);
  // A fixed point well outside both the scanned grid band and any
  // popover the scan could have opened near it (§ scanClick's own xFrom/
  // yFrom bounds keep every popover roughly centered on the canvas) —
  // the full-viewport overlay behind the popover intercepts this
  // regardless of what's visually underneath it.
  await editorPage.mouse.click(20, 20);
  check(
    "clicking away closes the popover",
    await waitUntil(async () => !(await isVisible(editorPage, "quick-place-popover")))
  );
  check("clicking away places nothing", (await objectCount(mapId)) === countBeforeClickAway);
  await editorPage.mouse.click(clickAwayPoint.x, clickAwayPoint.y);
  check(
    "a plain click at the same point after clicking away still places normally (nothing left armed)",
    await waitUntil(async () => (await objectCount(mapId)) === countBeforeClickAway + 1)
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

  // ── 7. Ctrl+click in the terrain tool does nothing special: no object
  //       gets created, and the normal terrain paint still happens. ──
  const objectCountBeforeTerrain = await objectCount(mapId);
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
  check(
    "Ctrl+click in the terrain tool creates NO object and opens no popover — the shortcut is object-tool-only",
    (await objectCount(mapId)) === objectCountBeforeTerrain && !(await isVisible(editorPage, "quick-place-popover"))
  );

  // ── 8. Ctrl+click in the raise tool: same — no object, no popover,
  //       normal raise. ──
  // Pre-existing stale testid fixed incidentally (flagged by the toolbar
  // redesign's own verify-script audit, unrelated to this batch): the
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
  check(
    "Ctrl+click in the raise tool creates NO object and opens no popover — the shortcut is object-tool-only",
    (await objectCount(mapId)) === objectCountBeforeTerrain && !(await isVisible(editorPage, "quick-place-popover"))
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
console.log("\nAll quick-place popover checks passed.");
process.exit(0);
