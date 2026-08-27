#!/usr/bin/env node
// Map Editor Batch A8b verification: building-to-map-transition linking UX.
//
// Covers:
//   1. The EXISTING Link-mode transition-authoring flow works naturally when
//      the anchor cell has one of A8a's building presets sitting on it — a
//      real click on that cell (through the editor's own canvas, not a
//      seeded/synthetic transitionCell) picks it as the transition origin,
//      and a real transition gets created there, with no special-casing
//      needed (map_transitions is purely cell-anchored — see
//      mapTransitions.ts's own doc comment).
//   2. A building with no transition authored on its own cell renders as
//      "unlinked" in MapEditor's buildingLinkStatusByObjectId (mirrored into
//      editor-surface-state — a WebGL canvas has no DOM of its own to
//      inspect a 3D badge, the same mirror precedent verify-object-tint.mjs
//      and others already rely on).
//   3. Once a transition is authored on a building's cell, THAT building
//      flips to "linked" while an UNRELATED building elsewhere on the same
//      map stays "unlinked" — confirms the badge is scoped per-object/cell,
//      not a single map-wide flag.
//   4. A non-building placed object (a Chest) never appears in
//      buildingLinkStatusByObjectId at all, in either direction — the badge
//      is building-preset-only, not a generic "any object has a transition
//      on its cell" affordance.
//   5. Removing the transition flips the building straight back to
//      "unlinked" — the badge tracks live state, not a one-way "ever
//      linked" flag.
//   6. The badge state is visible regardless of which editor mode/tool is
//      currently active (Place mode, not just Link mode) — objects always
//      render, only click-routing differs per tool.
//   7. No uncaught page errors throughout.
//
// Needs a reachable Supabase instance (via .env / supabase/.env) with this
// batch's own migrations already applied (`node scripts/db/migrate.mjs`,
// including 0066_building_presets.sql) and the building presets themselves
// generated (`node scripts/assets/generate-building-presets.mjs`); starts
// `yarn dev` itself (and polls /api/health) on PORT if nothing is already
// serving there. Defaults to a non-3000 port — :3000 on this machine is a
// live production server, not this worktree's own build.
// Usage: node scripts/db/verify-building-transition-link.mjs
//        PORT=4917 node scripts/db/verify-building-transition-link.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "49123";
const APP_URL = `http://localhost:${PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
const SCREENSHOT_DIR = join(SCRATCH_DIR, "building-transition-link-screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// 0066_building_presets.sql's fixed UUIDs.
const COTTAGE_ID = "a55e7014-0000-4000-8000-000000000014";
const TAVERN_ID = "a55e7018-0000-4000-8000-000000000018";
// 0016_asset_library_presets.sql's Chest — a non-building control object.
const CHEST_ID = "a55e7002-0000-4000-8000-000000000002";

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
  console.log(`dev server not running on :${PORT} — starting this worktree's own…`);
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
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `building-link-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Building Link ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

/** verify-building-presets.mjs's own scanClick: click a centered-outward
 * scan of canvas points until `done()` reports the scene reacted. */
async function scanClick(page, done, opts = {}) {
  const {
    xFrom = 0.28,
    xTo = 0.8,
    yFrom = 0.2,
    yTo = 0.74,
    step = 36,
    maxWaitMs = 2000,
    pollMs = 100,
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

/** This batch's own lesson (see MapEditor.tsx's editorSurfaceDebug doc
 * comment): read the hidden render-state mirror via textContent directly,
 * never gate it behind isVisible() — a `hidden` element always reports
 * isVisible() === false regardless of content. */
async function editorDebug(page) {
  const text = await page.textContent('[data-testid="editor-surface-state"]').catch(() => null);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

async function transitionRows(mapId) {
  const { data, error } = await admin.from("map_transitions").select().eq("from_map_id", mapId);
  if (error) throw error;
  return data ?? [];
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];

let campaignId;
try {
  campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Building link test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // Town: a 6x6 map with two building presets and one non-building control
  // object, seeded directly (this batch's own lesson: seed setup state via
  // the admin/service-role client, not a blind UI click-scan — only the
  // actual Link-mode authoring below is driven through real UI clicks).
  const townMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: townMapId,
    campaign_id: campaignId,
    name: "Town",
    grid_width: 6,
    grid_height: 6,
  });
  const cells = [];
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      cells.push({ map_id: townMapId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright" });
    }
  }
  await dm.client.from("map_cells").upsert(cells, { onConflict: "map_id,x,y" });

  // Interior: the destination map a transition can point at.
  const interiorMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: interiorMapId,
    campaign_id: campaignId,
    name: "Cottage Interior",
    grid_width: 4,
    grid_height: 4,
  });

  const cottageObj = { id: crypto.randomUUID(), map_id: townMapId, asset_id: COTTAGE_ID, x: 2, y: 2 };
  const tavernObj = { id: crypto.randomUUID(), map_id: townMapId, asset_id: TAVERN_ID, x: 1, y: 4 };
  const chestObj = { id: crypto.randomUUID(), map_id: townMapId, asset_id: CHEST_ID, x: 4, y: 1 };
  const { error: seedError } = await dm.client
    .from("map_objects")
    .insert([cottageObj, tavernObj, chestObj]);
  check("seeded a Cottage, a Tavern, and a control Chest at known cells", !seedError, seedError?.message);

  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const editorPage = await dmContext.newPage();
  editorPage.on("pageerror", (err) => pageErrors.push(String(err)));

  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${townMapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });

  // ═══════════════════════════════════════════════════════════════════
  // 2 & 4. Before any transition exists: both buildings read "unlinked",
  // the Chest doesn't appear in the map at all.
  // ═══════════════════════════════════════════════════════════════════
  const initialDebug = await pollUntil(async () => {
    const debug = await editorDebug(editorPage);
    return debug?.buildingLinkStatusByObjectId &&
      cottageObj.id in debug.buildingLinkStatusByObjectId &&
      tavernObj.id in debug.buildingLinkStatusByObjectId
      ? debug
      : null;
  });
  check(
    "the Cottage starts unlinked (no transition authored yet)",
    initialDebug?.buildingLinkStatusByObjectId?.[cottageObj.id] === "unlinked",
    JSON.stringify(initialDebug?.buildingLinkStatusByObjectId)
  );
  check(
    "the Tavern starts unlinked too",
    initialDebug?.buildingLinkStatusByObjectId?.[tavernObj.id] === "unlinked"
  );
  check(
    "the non-building Chest never appears in buildingLinkStatusByObjectId at all",
    !(chestObj.id in (initialDebug?.buildingLinkStatusByObjectId ?? {}))
  );

  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "00-both-buildings-unlinked.png") });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Real Link-mode authoring: switch to Link mode, click the COTTAGE'S
  // OWN CELL (a building is genuinely sitting there) as the transition
  // origin, through the real canvas — not a seeded transitionCell.
  // ═══════════════════════════════════════════════════════════════════
  await editorPage.click('[data-testid="mode-link"]');
  await editorPage.click('[data-testid="tool-transition"]');

  const originPoint = await scanClick(editorPage, async () => {
    const text = await editorPage.textContent('[data-testid="transition-origin-label"]').catch(() => null);
    return text === `Origin cell (${cottageObj.x},${cottageObj.y})`;
  });
  check(
    "clicking the Cottage's own cell in Link mode picks it as the transition origin (the click fell through the building to the cell beneath, exactly like any other placed object)",
    originPoint !== null
  );

  await editorPage.waitForSelector('[data-testid="transition-destination-map"]', { timeout: 10000 });
  await editorPage.selectOption('[data-testid="transition-destination-map"]', interiorMapId);
  await editorPage.fill('[data-testid="transition-entry-x"]', "0");
  await editorPage.fill('[data-testid="transition-entry-y"]', "0");
  check("Create link is enabled with a valid destination", await editorPage.isEnabled('[data-testid="create-transition"]'));
  await editorPage.click('[data-testid="create-transition"]');

  const createdRows = await pollUntil(async () => {
    const rows = await transitionRows(townMapId);
    const match = rows.find((r) => r.from_x === cottageObj.x && r.from_y === cottageObj.y && r.to_map_id === interiorMapId);
    return match ? rows : null;
  });
  const createdTransition = createdRows?.find(
    (r) => r.from_x === cottageObj.x && r.from_y === cottageObj.y && r.to_map_id === interiorMapId
  );
  check(
    "a real map_transitions row was created anchored at the Cottage's own cell, with no new mechanism required",
    createdTransition !== undefined,
    JSON.stringify(createdRows)
  );

  // ═══════════════════════════════════════════════════════════════════
  // 3. The Cottage flips to "linked"; the unrelated Tavern stays
  // "unlinked" — the badge is scoped per building, not map-wide.
  // ═══════════════════════════════════════════════════════════════════
  const linkedDebug = await pollUntil(async () => {
    const debug = await editorDebug(editorPage);
    return debug?.buildingLinkStatusByObjectId?.[cottageObj.id] === "linked" ? debug : null;
  });
  check(
    "the Cottage now reads 'linked' in buildingLinkStatusByObjectId",
    linkedDebug?.buildingLinkStatusByObjectId?.[cottageObj.id] === "linked"
  );
  check(
    "the unrelated Tavern is STILL 'unlinked' — the badge didn't flip map-wide",
    linkedDebug?.buildingLinkStatusByObjectId?.[tavernObj.id] === "unlinked"
  );
  check(
    "the Chest still never appears in buildingLinkStatusByObjectId",
    !(chestObj.id in (linkedDebug?.buildingLinkStatusByObjectId ?? {}))
  );

  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "01-cottage-linked-tavern-unlinked.png") });

  // ═══════════════════════════════════════════════════════════════════
  // 6. The badge state holds regardless of which mode/tool is active —
  // objects always render, only click-routing changes per tool.
  // ═══════════════════════════════════════════════════════════════════
  await editorPage.click('[data-testid="mode-place"]');
  await editorPage.click('[data-testid="tool-object"]');
  const linkedInPlaceMode = await pollUntil(async () => {
    const debug = await editorDebug(editorPage);
    return debug?.buildingLinkStatusByObjectId?.[cottageObj.id] === "linked" ? debug : null;
  });
  check(
    "the Cottage still reads 'linked' after switching to Place mode (the badge isn't Link-mode-scoped state)",
    linkedInPlaceMode?.buildingLinkStatusByObjectId?.[cottageObj.id] === "linked"
  );
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "02-place-mode-badge-still-shows.png") });

  // ═══════════════════════════════════════════════════════════════════
  // 5. Removing the transition flips the Cottage straight back to
  // "unlinked" — live state, not a one-way "ever linked" flag.
  // ═══════════════════════════════════════════════════════════════════
  await editorPage.click('[data-testid="mode-link"]');
  await editorPage.click('[data-testid="tool-transition"]');
  await editorPage.click(`[data-testid="remove-transition-${createdTransition.id}"]`);

  const afterRemoveRows = await pollUntil(async () => {
    const rows = await transitionRows(townMapId);
    return rows.some((r) => r.id === createdTransition.id) ? null : rows;
  });
  check("the transition row is genuinely gone after Remove", afterRemoveRows !== null, JSON.stringify(afterRemoveRows));

  const unlinkedAgainDebug = await pollUntil(async () => {
    const debug = await editorDebug(editorPage);
    return debug?.buildingLinkStatusByObjectId?.[cottageObj.id] === "unlinked" ? debug : null;
  });
  check(
    "the Cottage flips back to 'unlinked' once its transition is removed",
    unlinkedAgainDebug?.buildingLinkStatusByObjectId?.[cottageObj.id] === "unlinked"
  );

  check("no uncaught page errors occurred throughout", pageErrors.length === 0, pageErrors.join("\n"));
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
console.log(`\nAll building-transition-link checks passed. Screenshots: ${SCREENSHOT_DIR}`);
process.exit(0);
