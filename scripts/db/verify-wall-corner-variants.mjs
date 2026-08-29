#!/usr/bin/env node
// Wall-family corner variants verification (project owner's own request:
// "a T-junction, a genuine right-angle corner, and a curved corner" — see
// scripts/assets/generate-wall-corner-variants.mjs's own top comment for
// full context on why the EXISTING "Wall Corner" preset isn't actually a
// right angle).
//
// Covers:
//   1. All 3 new built-in preset rows (Wall T-Junction, Wall Corner (Right
//      Angle), Wall Corner (Curved)) exist in asset_library with the right
//      name/source_type/model_ref, and each model_ref points at a real
//      generated .glb on disk — the same DB-level shape
//      verify-tavern-presets.mjs/verify-building-presets.mjs already check,
//      scoped to this batch's own 3 new rows.
//   2. Through the DM's REAL map editor UI (Place mode, object tool): each
//      of the 3 new presets appears as a real card in the sidebar asset
//      palette (data-testid="asset-<uuid>").
//   3. Each of the 3 can actually be placed via the normal Place-mode
//      click-to-place flow: select the card, click an empty cell, confirm
//      a real map_objects row appears with that exact asset_id.
//   4. The T-junction and the right-angle corner are both orientation-
//      dependent (which side(s) their arm(s) point toward) — clicking the
//      map editor's ordinary rotate control (data-testid="object-rotate")
//      4 times cycles the newly placed object's own `rotation` column in
//      the database through all 4 values (90, 180, 270, 0), confirming
//      MapEditor.tsx's handleRotate needed no changes to work with these
//      two new shapes (it already generalizes to any preset). The curved
//      corner is NOT checked here — this task's own brief scopes the
//      rotation check to "the two orientation-dependent ones" (T-junction
//      and right-angle corner) specifically.
//   5. No uncaught page errors while loading/rendering any of these new
//      models.
//
// Needs a reachable Supabase instance (via .env / supabase/.env) with this
// batch's own 0092 migration already applied (`node scripts/db/migrate.mjs`)
// and the presets themselves generated
// (`node scripts/assets/generate-wall-corner-variants.mjs`); starts
// `yarn dev` itself (and polls /api/health) on PORT if nothing is already
// serving there.
// Usage: node scripts/db/verify-wall-corner-variants.mjs
//        PORT=4899 node scripts/db/verify-wall-corner-variants.mjs

import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "4931";
const APP_URL = `http://localhost:${PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
const SCREENSHOT_DIR = join(SCRATCH_DIR, "wall-corner-variants-screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Mirrors scripts/assets/generate-wall-corner-variants.mjs's own PRESETS —
// the fixed UUIDs seeded by 0092_wall_corner_variants.sql, continuing the
// a55e7NNN sequence with a deliberate gap (…040-…042) past 0083's last row
// (…035) to reduce collision risk against other in-flight parallel
// migrations seeding their own new preset rows concurrently.
const EXPECTED = [
  { uuid: "a55e7040-0000-4000-8000-000000000040", name: "Wall T-Junction", file: "wall-t.glb", checkRotation: true },
  {
    uuid: "a55e7041-0000-4000-8000-000000000041",
    name: "Wall Corner (Right Angle)",
    file: "wall-corner-l.glb",
    checkRotation: true,
  },
  {
    uuid: "a55e7042-0000-4000-8000-000000000042",
    name: "Wall Corner (Curved)",
    file: "wall-corner-curved.glb",
    checkRotation: false,
  },
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
  const email = `wall-corner-variants-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Wall Corner Variants ${label}` });
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

async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

/** verify-tavern-presets.mjs's/verify-quick-place-popover.mjs's own
 * scanClick: click a centered-outward scan of canvas points until `done()`
 * reports the scene reacted. */
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

async function objectRotation(objectId) {
  const { data, error } = await admin.from("map_objects").select("rotation").eq("id", objectId).single();
  if (error) throw error;
  return data.rotation;
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
// 2, 3 & 4. Through the real editor UI: each preset appears in the palette,
//    can actually be placed, and (for the two orientation-dependent
//    shapes) rotates through all 4 orientations via the real rotate
//    control.
// ═══════════════════════════════════════════════════════════════════════
await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Wall corner variants test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Wall corner variants room",
    grid_width: 10,
    grid_height: 10,
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

  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "00-palette-with-all-3-wall-corner-variants.png") });

  for (const expected of EXPECTED) {
    const before = await objectRows(mapId);
    await editorPage.click(`[data-testid="asset-${expected.uuid}"]`);
    check(
      `"${expected.name}" becomes the active palette selection`,
      (await editorPage.getAttribute(`[data-testid="asset-${expected.uuid}"]`, "aria-pressed")) === "true"
    );
    const point = await scanClick(editorPage, async () => (await objectRows(mapId)).length > before.length);
    check(`"${expected.name}" is placeable on the map via a real canvas click`, point !== null);
    const after = await objectRows(mapId);
    const placed = after.find((row) => !before.some((b) => b.id === row.id));
    check(
      `the newly created map_objects row for "${expected.name}" has the correct asset_id`,
      placed?.asset_id === expected.uuid,
      JSON.stringify(placed)
    );

    if (expected.checkRotation && placed) {
      // Placing an object auto-selects it (MapEditor.tsx's placeAssetAtCell
      // calls setSelectedObjectIds right after creating the row), so the
      // rotate control should already be live for this exact object with no
      // further selection step needed.
      check(
        `"${expected.name}" is auto-selected right after placement (rotate control is visible)`,
        await isVisible(editorPage, "object-rotate")
      );
      const expectedSequence = [90, 180, 270, 0];
      for (const expectedRotation of expectedSequence) {
        await editorPage.click('[data-testid="object-rotate"]');
        const rotation = await pollUntil(async () => {
          const value = await objectRotation(placed.id);
          return value === expectedRotation ? value : null;
        });
        check(
          `"${expected.name}"'s rotation reaches ${expectedRotation}° in the database after clicking rotate`,
          rotation === expectedRotation,
          `got ${rotation}`
        );
      }
    }
  }

  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "01-all-3-wall-corner-variants-placed.png") });

  const allPlaced = await objectRows(mapId);
  check("all 3 new wall corner variants were placed as 3 distinct objects", allPlaced.length === EXPECTED.length);
  const coordKeys = allPlaced.map((row) => `${row.x},${row.y}`);
  check(
    "every placement landed on its own distinct cell — no accidental double-placement/overlap",
    new Set(coordKeys).size === coordKeys.length,
    JSON.stringify(coordKeys)
  );

  // ═════════════════════════════════════════════════════════════════════
  // Curved corner close-up: confirm the curved geometry renders cleanly
  // (no visible faceting) at real render distance — seeded directly at a
  // known cell for a tight, reproducible crop (exact-cell targeting isn't
  // reliably scriptable through a WebGL canvas — verify-tavern-presets.mjs's
  // identical precedent for Bar Corner).
  // ═════════════════════════════════════════════════════════════════════
  const closeupMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: closeupMapId,
    campaign_id: campaignId,
    name: "Wall corner variants closeup",
    grid_width: 6,
    grid_height: 6,
  });
  await admin
    .from("map_objects")
    .insert({ id: crypto.randomUUID(), map_id: closeupMapId, asset_id: EXPECTED[2].uuid, x: 3, y: 3 });
  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${closeupMapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await sleep(1500);
  await editorPage.screenshot({ path: join(SCREENSHOT_DIR, "02-curved-corner-closeup.png") });

  check("no uncaught page errors occurred while loading/rendering any of the 3 new models", pageErrors.length === 0, pageErrors.join("\n"));
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
console.log(`\nAll wall corner variant checks passed. Screenshots: ${SCREENSHOT_DIR}`);
process.exit(0);
