#!/usr/bin/env node
// Map Editor Batch A3 verification: object coloring.
//
// Covers:
//   1. Selecting a placed PRESET object (a Chest) in the map editor shows a
//      tint picker with no tint set by default.
//   2. Picking a swatch persists '#rrggbb' to map_objects.tint and the
//      editor's own UI reflects it (the active swatch + "Current: #hex").
//   3. The tint survives a real page reload in the editor.
//   4. Clearing the tint restores the untinted state (DB null, UI clears).
//   5. The identical flow works for a DM-UPLOADED CUSTOM model, not just a
//      preset — a real upload to the map-assets bucket + a real
//      source_type: "custom" asset_library row, exercised the same way.
//   6. The tint change reaches an ALREADY-CONNECTED Game Room client LIVE,
//      with no page reload (subscribeToMapObjectChanges' own postgres_changes
//      subscription — the separate Map Editor route has no broadcast channel
//      of its own at all), and survives a hard reload of that second client
//      too.
//   7. An object with no tint renders through the untinted state both
//      before any tint is ever set and again after Clear.
//
// A WebGL canvas has no DOM of its own to inspect a mesh's actual material
// color, so live client-side state is read from GameRoom's own hidden
// table-surface-state mirror (tintByObjectId) — the same "mirror render
// state into a hidden div for Playwright" precedent every other verify
// script in this project already relies on (voidCells/groundByCell/etc.).
// Screenshots are saved for a human to eyeball the real visual result, not
// asserted against pixel-by-pixel (this project's own verify-ground-
// types.mjs precedent: screenshots confirm the right things are being
// drawn, not exact colors).
//
// Needs the local Supabase stack (with this batch's own 0064 migration —
// map_objects.tint plus map_objects added to the supabase_realtime
// publication — already applied via `node scripts/db/migrate.mjs`); starts
// `yarn dev` itself (and polls /api/health) if its own port isn't already
// serving.
// Usage: node scripts/db/verify-object-tint.mjs

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
// checkout's dev server, and :3000 is this machine's live production
// server, not a fresh build of this worktree's own changes.
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 48931);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
const SCREENSHOT_DIR = join(SCRATCH_DIR, "object-tint-screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

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

// verify-live-object-reveal.mjs's own precedent: collapse every floating
// Game Room panel not needed by name, so Alice's canvas is unobstructed.
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
  combat: { collapsed: true, x: 0, y: 0 },
  map: { collapsed: true, x: 0, y: 0 },
  liveObjects: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label, panelLayout) {
  const email = `object-tint-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Object Tint ${label}`,
    ...(panelLayout ? { ui_preferences: { panelLayout } } : {}),
  });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function textOrNull(page, testid) {
  return (await isVisible(page, testid)) ? page.textContent(`[data-testid="${testid}"]`) : null;
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

/** verify-object-multi-select-delete.mjs's own scanClick, unchanged (same
 * default region/step, tuned for this exact scene — a small dense grid
 * keeps every blind scan point close to a real cell). No way to compute a
 * WebGL raycast target from camera math, so a working screen point is
 * discovered empirically. */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.34, xTo = 0.74, yFrom = 0.26, yTo = 0.68, step = 42, settleMs = 140 } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const [offset, settle] of [
    [0, settleMs],
    [step / 2, settleMs * 2],
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
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) return point;
    }
  }
  return null;
}

async function findObjectPoint(page, x, y) {
  return scanClick(page, async () => {
    const text = await textOrNull(page, "selected-object");
    return text !== null && text.includes(`cell ${x},${y}`);
  });
}

async function mapObjectRow(objectId) {
  const { data, error } = await admin.from("map_objects").select().eq("id", objectId).maybeSingle();
  if (error) throw error;
  return data;
}

async function aliceTintDebug(page) {
  const text = await textOrNull(page, "table-surface-state");
  if (!text) return null;
  try {
    return JSON.parse(text).tintByObjectId ?? null;
  } catch {
    return null;
  }
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice", COLLAPSED_PANEL_LAYOUT);
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

let campaignId;

try {
  campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Object tint test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // 3x3, deliberately tiny (verify-object-multi-select-delete.mjs's own
  // precedent) — canvas gestures that must land on a specific cell can't be
  // aimed blindly, so a small dense grid keeps every blind scan point close
  // to a real cell.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Object tint room",
    grid_width: 3,
    grid_height: 3,
  });
  const cells = [];
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      cells.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright" });
    }
  }
  await dm.client.from("map_cells").upsert(cells, { onConflict: "map_id,x,y" });

  // A real DM-uploaded custom model — verify-map-assets-storage.mjs's own
  // precedent: reuse chest.glb's own bytes uploaded fresh under this
  // campaign's own map-assets prefix, so this is indistinguishable from a
  // genuine upload to everything this feature touches (only source_type
  // and model_ref differ from the preset).
  const glb = readFileSync(join(rootDir, "public", "assets", "presets", "chest.glb"));
  const customPath = `${campaignId}/object-tint-custom.glb`;
  const { error: uploadError } = await dm.client.storage
    .from("map-assets")
    .upload(customPath, glb, { contentType: "model/gltf-binary" });
  check("uploaded a real custom model to the map-assets bucket", !uploadError, uploadError?.message);

  const customAssetId = crypto.randomUUID();
  const { error: assetError } = await admin.from("asset_library").insert({
    id: customAssetId,
    name: "Object Tint Custom Crate",
    source_type: "custom",
    model_ref: customPath,
    campaign_id: campaignId,
  });
  check("registered the upload as a real custom asset_library row", !assetError, assetError?.message);

  // Seeded directly at known, distinct cells (this batch's own lesson: seed
  // test-setup state via the admin/service-role client, not a blind UI
  // click-scan) — each object's identity and (x,y) are known up front, with
  // zero scanning involved in PLACEMENT; only SELECTING them (the actual
  // behavior under test) uses a real scanned click.
  const presetObj = { id: crypto.randomUUID(), map_id: mapId, asset_id: CHEST_PRESET_ID, x: 0, y: 0 };
  const customObj = { id: crypto.randomUUID(), map_id: mapId, asset_id: customAssetId, x: 1, y: 0 };
  const { error: seedError } = await dm.client.from("map_objects").insert([presetObj, customObj]);
  check("seeded a preset object and a custom-model object at known cells", !seedError, seedError?.message);

  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const pageErrors = [];
  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const editorPage = await dmContext.newPage();
  editorPage.on("pageerror", (err) => pageErrors.push(String(err)));

  const aliceContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  alicePage.on("pageerror", (err) => pageErrors.push(String(err)));

  // ════════════════════════════════════════════════════════════════════
  // Alice's Game Room is ALREADY OPEN before any tint is ever applied — the
  // ONLY way to genuinely test "syncs live, no reload" later.
  // ════════════════════════════════════════════════════════════════════
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  const initialTints = await pollUntil(async () => {
    const debug = await aliceTintDebug(alicePage);
    return debug && presetObj.id in debug && customObj.id in debug ? debug : null;
  });
  check(
    "both seeded objects reach Alice's already-open client with no tint (default, untinted rendering)",
    initialTints?.[presetObj.id] === null && initialTints?.[customObj.id] === null,
    JSON.stringify(initialTints)
  );

  // ════════════════════════════════════════════════════════════════════
  // The DM opens the separate Map Editor route (not the Game Room) and
  // selects the PRESET object.
  // ════════════════════════════════════════════════════════════════════
  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await editorPage.click('[data-testid="mode-place"]');
  await editorPage.click('[data-testid="tool-object"]');
  await editorPage.waitForSelector('[data-testid="asset-palette"]', { timeout: 10000 });
  await editorPage.click(`[data-testid="asset-${CHEST_PRESET_ID}"]`);

  const presetPoint = await findObjectPoint(editorPage, presetObj.x, presetObj.y);
  check("found the preset (Chest) object's screen point via a real canvas click", presetPoint !== null);

  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "01-preset-selected-untinted.png") });
  check("the tint picker is shown once an object is selected", await isVisible(editorPage, "object-tint-swatches"));
  check("no tint is set by default", !(await isVisible(editorPage, "object-tint-current")));
  check("Clear tint starts disabled (nothing to clear)", await editorPage.isDisabled('[data-testid="object-tint-clear"]'));

  // ── Apply a tint to the preset object. ──
  await editorPage.click('[data-testid="object-tint-swatch-ff5c5c"]');
  const presetTinted = await pollUntil(async () => {
    const row = await mapObjectRow(presetObj.id);
    return row?.tint === "#ff5c5c" ? row : null;
  });
  check("picking a swatch persists the hex tint to map_objects.tint", presetTinted !== null, JSON.stringify(presetTinted));
  check(
    "the editor's own UI reflects the applied tint",
    await pollUntil(async () => (await textOrNull(editorPage, "object-tint-current")) === "Current: #ff5c5c")
  );
  check(
    "the applied swatch shows as pressed/active",
    (await editorPage.getAttribute('[data-testid="object-tint-swatch-ff5c5c"]', "aria-pressed")) === "true"
  );
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "02-preset-tinted-red.png") });

  // ════════════════════════════════════════════════════════════════════
  // Alice's ALREADY-OPEN Game Room client sees the tint LIVE — no reload —
  // via subscribeToMapObjectChanges (postgres_changes), since the Map
  // Editor route has no broadcast channel of its own.
  // ════════════════════════════════════════════════════════════════════
  const aliceSeesPresetTint = await pollUntil(async () => {
    const debug = await aliceTintDebug(alicePage);
    return debug?.[presetObj.id] === "#ff5c5c" ? debug : null;
  });
  check(
    "Alice's ALREADY-OPEN Game Room client sees the preset object's tint live, with no page reload",
    aliceSeesPresetTint !== null,
    JSON.stringify(aliceSeesPresetTint)
  );
  await alicePage.screenshot({ path: join(SCREENSHOT_DIR, "03-alice-sees-preset-tint-live.png") });

  // ── Reload the editor — the tint survives. ──
  await editorPage.reload();
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await editorPage.click('[data-testid="mode-place"]');
  await editorPage.click('[data-testid="tool-object"]');
  await editorPage.waitForSelector('[data-testid="asset-palette"]', { timeout: 10000 });
  await editorPage.click(`[data-testid="asset-${CHEST_PRESET_ID}"]`);
  const presetPointAfterReload = await findObjectPoint(editorPage, presetObj.x, presetObj.y);
  check("re-found the preset object after a real page reload", presetPointAfterReload !== null);
  check(
    "the tint survived the reload, shown in the editor's own UI",
    await pollUntil(async () => (await textOrNull(editorPage, "object-tint-current")) === "Current: #ff5c5c")
  );

  // ── Clear the tint — restores the untinted state everywhere. ──
  await editorPage.click('[data-testid="object-tint-clear"]');
  const presetCleared = await pollUntil(async () => {
    const row = await mapObjectRow(presetObj.id);
    return row?.tint === null ? row : null;
  });
  check("Clear tint persists tint = null", presetCleared !== null, JSON.stringify(presetCleared));
  check(
    "the editor's own UI drops back to untinted",
    await pollUntil(async () => !(await isVisible(editorPage, "object-tint-current")))
  );
  check(
    "Alice's already-open client sees the clear live too — no reload",
    await pollUntil(async () => (await aliceTintDebug(alicePage))?.[presetObj.id] === null)
  );

  // ════════════════════════════════════════════════════════════════════
  // The identical flow on the DM-UPLOADED CUSTOM model — not just presets.
  // ════════════════════════════════════════════════════════════════════
  const customPoint = await findObjectPoint(editorPage, customObj.x, customObj.y);
  check("found the custom-model object's screen point via a real canvas click", customPoint !== null);
  check("the custom object also starts with no tint", !(await isVisible(editorPage, "object-tint-current")));

  await editorPage.click('[data-testid="object-tint-swatch-5b8dff"]');
  const customTinted = await pollUntil(async () => {
    const row = await mapObjectRow(customObj.id);
    return row?.tint === "#5b8dff" ? row : null;
  });
  check(
    "picking a swatch persists the hex tint on the CUSTOM model exactly like the preset",
    customTinted !== null,
    JSON.stringify(customTinted)
  );
  check(
    "the editor's own UI reflects the custom object's applied tint",
    await pollUntil(async () => (await textOrNull(editorPage, "object-tint-current")) === "Current: #5b8dff")
  );
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "04-custom-tinted-blue.png") });

  const aliceSeesCustomTint = await pollUntil(async () => {
    const debug = await aliceTintDebug(alicePage);
    return debug?.[customObj.id] === "#5b8dff" ? debug : null;
  });
  check(
    "Alice's already-open client sees the CUSTOM model's tint live too",
    aliceSeesCustomTint !== null,
    JSON.stringify(aliceSeesCustomTint)
  );

  // ── A hard reload of the SECOND client too — both tints (preset cleared,
  //    custom applied) are exactly what the DB now says, not stale state. ──
  await alicePage.reload();
  await alicePage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  const aliceAfterReload = await pollUntil(async () => {
    const debug = await aliceTintDebug(alicePage);
    return debug && customObj.id in debug ? debug : null;
  });
  check(
    "after a hard reload, the second connected client's state matches the DB exactly (preset untinted, custom tinted)",
    aliceAfterReload?.[presetObj.id] === null && aliceAfterReload?.[customObj.id] === "#5b8dff",
    JSON.stringify(aliceAfterReload)
  );
  await alicePage.screenshot({ path: join(SCREENSHOT_DIR, "05-alice-after-reload.png") });

  check("no uncaught page errors occurred on either client", pageErrors.length === 0, pageErrors.join("\n"));
} finally {
  await browser.close();
  if (campaignId) {
    await admin.storage.from("map-assets").remove([`${campaignId}/object-tint-custom.glb`]).catch(() => undefined);
  }
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

console.log(failures === 0 ? `\nAll checks passed. Screenshots: ${SCREENSHOT_DIR}` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
