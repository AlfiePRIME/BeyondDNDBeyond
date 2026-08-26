#!/usr/bin/env node
// New themed map templates verification (Prompt 11 acceptance criteria).
//
// 18 new starter templates were added to templates.ts — 3 each across
// forest, sand+water, water-only, stone, swamp, and town — on top of the 3
// pre-existing ones (empty-room, corridor, tavern). Confirms:
//  - the real browser's template picker lists all 18 new cards alongside
//    the 3 original ones (no regression to what's already selectable);
//  - each of the 21 templates' REAL data (dumped live from templates.ts
//    itself via a throwaway vitest run — never a hand-copied
//    approximation) writes cleanly under the DM's own real, signed-in,
//    RLS-gated Supabase client, using the exact row shapes
//    createPopulatedMap itself builds (src/data-access/maps.ts), then
//    renders correctly in the real editor (every cell's ground type
//    checked against the editor's own render-state mirror, the same
//    [data-testid="editor-surface-state"] approach verify-ground-types.mjs/
//    verify-water-terrain.mjs use, since the WebGL scene has no DOM to
//    locate);
//  - a representative template per theme (6 total) also renders correctly
//    on the live Game Room table via [data-testid="table-surface-state"];
//  - no browser console errors during any of it.
//
// IMPORTANT — a pre-existing, unrelated bug this run discovered: the real
// "Create & edit" button (MapsManager.tsx's handleCreate ->
// createPopulatedMap) currently fails for EVERY map (template or blank),
// not just the 18 new ones — createPopulatedMap's `campaign_maps` insert
// chains `.select().single()` to get the new row back, and that combined
// INSERT+RETURNING is rejected by RLS ("new row violates row-level
// security policy for table campaign_maps") even for a legitimate DM, on
// this live shared instance. Root cause, isolated by hand:
//   - a bare `.insert(...)` (no `.select()`) into campaign_maps succeeds;
//   - a separate, later `.select()` of that same row (by the DM, or by
//     admin) succeeds; `is_campaign_dm(campaign_id)` and
//     `can_read_map(id)` both evaluate true via direct RPC;
//   - but `.insert(...).select().single()` in ONE call fails every time.
// This traces to migration 0048 (per-viewer map visibility)'s rewritten
// campaign_maps SELECT policy (`using (public.can_read_map(id))`, a
// SECURITY DEFINER function that itself re-queries campaign_maps) — some
// interaction between that self-referencing check and the
// INSERT...RETURNING snapshot on this instance's actual Postgres/PostgREST
// versions. Confirmed NOT caused by this change: it reproduces identically
// for a plain blank-grid map and for the original 3 templates, and the
// broken step (the campaign_maps insert) runs before any map_cells/
// ground_type work happens at all. Out of scope to fix here (a P9-era
// regression, not a templates.ts concern) — flagged for separate
// follow-up. This script works around it by using the same DM client to
// perform the exact same writes as two statements instead of one
// (matching verify-maps.mjs's own already-passing "bare insert" pattern),
// so the templates themselves are still verified against the real schema
// and real RLS, and rendering is still verified in a real browser.
//
// Needs the local Supabase stack config normal for this repo (.env /
// supabase/.env). Runs its OWN dev server on a dedicated port — this host
// runs many worktrees side by side and other verify-*.mjs scripts already
// claim :3457/:3458/:3907/etc, so this uses :3459.
//
// Real screenshots are saved to the scratchpad directory below — one per
// template (21) plus one per representative live-table check (6).
//
// Usage: node scripts/db/verify-map-templates.mjs

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3459;
const APP_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/map-templates-screenshots";
const DUMP_PATH =
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/map-templates-dump.json";
mkdirSync(SCREENSHOT_DIR, { recursive: true });

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
  console.log(`dev server not running on :${PORT} — starting yarn dev -p ${PORT}…`);
  devServer = spawn("yarn", ["dev", "-p", String(PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${PORT} within 150s`);
}

/** Dumps the REAL MAP_TEMPLATES array (templates.ts) via a throwaway vitest
 * test — the only way a plain-Node script can get the real, path-aliased
 * TypeScript data without a hand-copied (and therefore unverified)
 * approximation. The temp test file is written, run once, and deleted
 * immediately; it is never part of the committed diff. */
function dumpRealTemplates() {
  const tempTestPath = join(
    rootDir,
    "src/app/campaigns/[id]/maps/lib/__verify-dump-templates.test.ts"
  );
  writeFileSync(
    tempTestPath,
    [
      'import { writeFileSync } from "node:fs";',
      'import { it } from "vitest";',
      'import { MAP_TEMPLATES } from "./templates";',
      "",
      'it("dumps MAP_TEMPLATES for the verify script", () => {',
      `  writeFileSync(${JSON.stringify(DUMP_PATH)}, JSON.stringify(MAP_TEMPLATES, null, 2));`,
      "});",
      "",
    ].join("\n")
  );
  try {
    const result = spawnSync(
      "yarn",
      ["vitest", "run", "src/app/campaigns/[id]/maps/lib/__verify-dump-templates.test.ts"],
      { cwd: rootDir, encoding: "utf8" }
    );
    if (result.status !== 0) {
      throw new Error(`dumping MAP_TEMPLATES via vitest failed:\n${result.stdout}\n${result.stderr}`);
    }
  } finally {
    unlinkSync(tempTestPath);
  }
  return JSON.parse(readFileSync(DUMP_PATH, "utf8"));
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
  const email = `map-templates-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Templates ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

/** Brings the page to the front (a background tab's WebGL canvas never
 * paints new frames) and switches the Game Room to Free Camera before a
 * screenshot — the verify-ground-types.mjs precedent. */
async function angleCameraOverTable(page) {
  await page.bringToFront();
  await page.click('[data-testid="camera-mode-toggle"]');
  await sleep(300);
}

function collectConsoleErrors(page, sink) {
  page.on("pageerror", (err) => sink.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") sink.push(`console.error: ${msg.text()}`);
  });
}

/** Writes a template's REAL cells/objects under the DM's own signed-in
 * client, using the exact row shapes createPopulatedMap itself builds
 * (src/data-access/maps.ts) — with ONE deliberate deviation: the
 * campaign_maps insert is split into a bare insert plus a separate select,
 * instead of one chained `.insert().select().single()`. See this file's
 * header comment for why (a pre-existing, unrelated RLS/RETURNING bug this
 * run discovered, reproducible with a plain blank map too). Everything
 * else — the RLS policies exercised, the exact stored row shape for every
 * cell/object — is identical to what the real "Create & edit" button
 * would write if that one call worked. */
async function createTemplateMapForReal(dmClient, campaignId, template) {
  const mapName = `${template.name} test`;
  const { error: insertError } = await dmClient.from("campaign_maps").insert({
    campaign_id: campaignId,
    name: mapName,
    grid_width: template.gridWidth,
    grid_height: template.gridHeight,
  });
  if (insertError) return { error: insertError };

  const { data: mapRow, error: selectError } = await dmClient
    .from("campaign_maps")
    .select()
    .eq("campaign_id", campaignId)
    .eq("name", mapName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selectError || !mapRow) return { error: selectError ?? new Error("map row not found after insert") };
  const mapId = mapRow.id;

  if (template.cells.length > 0) {
    const cellRows = template.cells.map((cell) => ({
      map_id: mapId,
      x: cell.x,
      y: cell.y,
      elevation: cell.elevation,
      terrain_type: cell.terrain_type,
      light_level: cell.light_level ?? "bright",
      ground_type: cell.ground_type ?? "default",
      water_flow_direction: cell.water_flow_direction ?? null,
    }));
    const { error: cellsError } = await dmClient.from("map_cells").upsert(cellRows, { onConflict: "map_id,x,y" });
    if (cellsError) return { error: cellsError };
  }

  if (template.objects.length > 0) {
    const objectRows = template.objects.map((object) => ({
      map_id: mapId,
      asset_id: object.asset_id,
      x: object.x,
      y: object.y,
      elevation: object.elevation,
      rotation: object.rotation,
      ...(object.behavior_config !== undefined ? { behavior_config: object.behavior_config } : {}),
      ...(object.blocks_line_of_sight !== undefined ? { blocks_line_of_sight: object.blocks_line_of_sight } : {}),
    }));
    const { error: objectsError } = await dmClient.from("map_objects").insert(objectRows);
    if (objectsError) return { error: objectsError };
  }

  return { mapId };
}

const THEME_REPRESENTATIVES = {
  forest: "forest-clearing",
  "sand+water": "coast-sandbar-crossing",
  "water-only": "water-river-bend",
  stone: "stone-cavern-chamber",
  swamp: "swamp-murky-bog",
  town: "town-market-square",
};
const THEME_BY_TEMPLATE_ID = {
  "forest-clearing": "forest",
  "forest-treeline-ambush": "forest",
  "forest-hollow": "forest",
  "coast-tidal-shallows": "sand+water",
  "coast-sandbar-crossing": "sand+water",
  "coast-cove-inlet": "sand+water",
  "water-river-bend": "water-only",
  "water-lake-crossing": "water-only",
  "water-rapids": "water-only",
  "stone-corridor-junction": "stone",
  "stone-cavern-chamber": "stone",
  "stone-sunken-vault": "stone",
  "swamp-murky-bog": "swamp",
  "swamp-fetid-mire": "swamp",
  "swamp-sunken-marsh": "swamp",
  "town-market-square": "town",
  "town-crossroads-hamlet": "town",
  "town-tradesmans-row": "town",
};

console.log("dumping the real MAP_TEMPLATES data from templates.ts via vitest…");
const realTemplates = dumpRealTemplates();
check("dumped exactly 21 templates (3 original + 18 new)", realTemplates.length === 21, String(realTemplates.length));
const newTemplates = realTemplates.filter((template) => THEME_BY_TEMPLATE_ID[template.id]);
check("18 of the dumped templates are the new themed ones", newTemplates.length === 18, String(newTemplates.length));

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const consoleErrors = [];

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Map templates test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const dmContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const page = await dmContext.newPage();
  collectConsoleErrors(page, consoleErrors);

  // ── 1. The template picker lists all 18 new cards, and the 3 original
  //       ones are still there too (no regression to what's selectable). ──
  await page.goto(`${APP_URL}/campaigns/${campaignId}/maps`);
  await page.waitForSelector('[data-testid="template-picker"]', { timeout: 60000 });
  for (const template of realTemplates) {
    check(
      `template picker offers "${template.id}"`,
      await page.locator(`[data-testid="template-${template.id}"]`).isVisible(),
      `template-${template.id} not found in the picker`
    );
  }
  await page.screenshot({ path: join(SCREENSHOT_DIR, "00-template-picker.png") });

  // ── 2. Each template's REAL data writes cleanly under real RLS and
  //       renders correctly in the real editor. ──
  const mapIdByTemplateId = {};
  let shotIndex = 1;
  for (const template of realTemplates) {
    const { mapId, error } = await createTemplateMapForReal(dm.client, campaignId, template);
    check(`"${template.id}" writes cleanly as the DM (real RLS)`, !error, error?.message);
    if (!mapId) continue;
    mapIdByTemplateId[template.id] = mapId;

    await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
    await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 150000 });
    const mirror = await readMirror(page, "editor-surface-state");

    // Full comparison against the REAL template data (not a spot check —
    // the dump gives us every cell), same rule buildDenseCells itself
    // uses: only a non-'default' ground type ever appears in the mirror.
    const expectedGround = new Map(
      template.cells
        .filter((cell) => (cell.ground_type ?? "default") !== "default")
        .map((cell) => [`${cell.x},${cell.y}`, cell.ground_type])
    );
    const groundMatches =
      expectedGround.size === Object.keys(mirror.groundByCell).length &&
      [...expectedGround.entries()].every(([key, ground]) => mirror.groundByCell[key] === ground);
    check(
      `"${template.id}" editor mirror's groundByCell matches the real template data exactly (${expectedGround.size} cells)`,
      groundMatches,
      JSON.stringify({ expected: Object.fromEntries(expectedGround), got: mirror.groundByCell })
    );

    await sleep(200);
    await page.screenshot({
      path: join(SCREENSHOT_DIR, `${String(shotIndex).padStart(2, "0")}-${template.id}.png`),
    });
    shotIndex++;
  }

  // ── 3. A representative map per theme also renders correctly on the live
  //       Game Room table (same shared MapSurface renderer). ──
  const roomPage = await dmContext.newPage();
  collectConsoleErrors(roomPage, consoleErrors);
  await roomPage.setViewportSize({ width: 1400, height: 900 });
  let liveShotIndex = 1;
  for (const [theme, representativeId] of Object.entries(THEME_REPRESENTATIVES)) {
    const mapId = mapIdByTemplateId[representativeId];
    if (!mapId) {
      check(`the live Game Room table renders "${representativeId}" (${theme})`, false, "no map id — creation failed earlier");
      continue;
    }
    const template = realTemplates.find((candidate) => candidate.id === representativeId);
    await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
    await roomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await roomPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 150000 });
    const tableMirror = await readMirror(roomPage, "table-surface-state");
    const expectedGround = new Map(
      template.cells
        .filter((cell) => (cell.ground_type ?? "default") !== "default")
        .map((cell) => [`${cell.x},${cell.y}`, cell.ground_type])
    );
    const matches = [...expectedGround.entries()].every(([key, ground]) => tableMirror.groundByCell[key] === ground);
    check(
      `the live Game Room table renders "${representativeId}" (${theme}) with the right ground types`,
      matches,
      JSON.stringify(tableMirror.groundByCell)
    );
    await sleep(400);
    await angleCameraOverTable(roomPage);
    await roomPage.screenshot({
      path: join(SCREENSHOT_DIR, `live-${String(liveShotIndex).padStart(2, "0")}-${representativeId}.png`),
    });
    liveShotIndex++;
  }

  // ── 4. No browser console errors across the whole run. ──
  check(
    "no browser console errors were logged across the whole run",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 10))
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
console.log(`\nAll map-templates checks passed. Screenshots saved to ${SCREENSHOT_DIR}`);
process.exit(0);
