#!/usr/bin/env node
// Verification for the "enlarge outdoor templates + add foliage; add
// battleground, corridor/cave, and treasure-room categories" content-
// authoring task (a follow-up to MapPlan P11's 18 themed starter templates).
//
// Scope, matching what actually changed in templates.ts:
//  - 12 outdoor templates (forest x3, coast x3, water-only x3, swamp x3)
//    were enlarged and given noticeably more Tree/Rock foliage;
//  - 2 town templates (market-square, crossroads-hamlet) got a LIGHT touch
//    of ornamental trees (no resize) — tradesmans-row and the 3 stone
//    templates were left untouched;
//  - 9 brand-new templates were added: battleground x3 (open-field,
//    broken-ground, sinkhole-arena), cave/corridor x3 (natural-passage,
//    branching-junction, winding-tunnel), and treasure-room x3
//    (vault-plinth, strongroom, sunken-cache).
// That's 23 templates this script actually creates/screenshots for real —
// the other 7 (empty-room, corridor, tavern, and the 3 stone templates plus
// town-tradesmans-row) are untouched by this change and already covered by
// verify-map-templates.mjs (P11's own verification), so they're only
// checked here for "still listed in the picker" (a cheap regression guard),
// not re-created.
//
// Confirms, against the REAL app (never a hand-copied approximation of
// templates.ts):
//  - the live browser's template picker lists all 30 templates (21
//    pre-existing + 9 new) — no regression to what's selectable;
//  - each of the 23 changed templates' REAL data (dumped live from
//    templates.ts itself via a throwaway vitest run) writes cleanly under
//    the DM's own real, signed-in, RLS-gated Supabase client, then renders
//    correctly in the real map editor (every cell's ground type checked
//    against the editor's own render-state mirror, [data-testid=
//    "editor-surface-state"] — the verify-ground-types.mjs/
//    verify-map-templates.mjs precedent, since the WebGL scene has no DOM
//    to locate);
//  - one representative template per NEW category (battleground, cave,
//    treasure-room) also renders correctly on the live Game Room table via
//    [data-testid="table-surface-state"];
//  - no browser console errors during any of it.
//
// Reuses verify-map-templates.mjs's own documented RLS workaround verbatim
// (a bare campaign_maps insert + separate select, instead of one chained
// .insert().select().single()) — see that file's header comment for the
// full root cause (a 0048 per-viewer-visibility regression). Migration
// 0054_campaign_maps_returning_fix.sql exists on this branch as a candidate
// fix; this script doesn't depend on whether it's been applied to the
// shared dev DB, since the workaround succeeds either way.
//
// Needs the local Supabase stack config normal for this repo (.env /
// supabase/.env). Runs its own dev server on a dedicated port — this host
// runs many worktrees side by side and other verify-*.mjs scripts already
// claim :3457/:3458/:3459/etc, so this uses :3460.
//
// Real screenshots are saved to the scratchpad directory below.
//
// Usage: node scripts/db/verify-map-templates-expansion.mjs

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3460;
const APP_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/map-templates-expansion-screenshots";
const DUMP_PATH =
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/map-templates-expansion-dump.json";
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
    "src/app/campaigns/[id]/maps/lib/__verify-dump-templates-expansion.test.ts"
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
      ["vitest", "run", "src/app/campaigns/[id]/maps/lib/__verify-dump-templates-expansion.test.ts"],
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
  const email = `map-templates-expansion-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Templates Expansion ${label}` });
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
 * (src/data-access/maps.ts) — with ONE deliberate deviation, identical to
 * verify-map-templates.mjs's own: the campaign_maps insert is split into a
 * bare insert plus a separate select, instead of one chained
 * `.insert().select().single()`, working around the 0048-era RLS/RETURNING
 * issue documented in that file's header comment (unaffected by whether
 * migration 0054's candidate fix has been applied on this instance). */
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

// The 23 templates this task actually changed — enlarged outdoor (12),
// light-touch town foliage (2), and the 9 brand-new templates.
const CHANGED_TEMPLATE_IDS = [
  "forest-clearing",
  "forest-treeline-ambush",
  "forest-hollow",
  "coast-tidal-shallows",
  "coast-sandbar-crossing",
  "coast-cove-inlet",
  "water-river-bend",
  "water-lake-crossing",
  "water-rapids",
  "swamp-murky-bog",
  "swamp-fetid-mire",
  "swamp-sunken-marsh",
  "town-market-square",
  "town-crossroads-hamlet",
  "battleground-open-field",
  "battleground-broken-ground",
  "battleground-sinkhole-arena",
  "cave-natural-passage",
  "cave-branching-junction",
  "cave-winding-tunnel",
  "treasure-vault-plinth",
  "treasure-strongroom",
  "treasure-sunken-cache",
];

const NEW_CATEGORY_REPRESENTATIVES = {
  battleground: "battleground-sinkhole-arena",
  cave: "cave-winding-tunnel",
  "treasure-room": "treasure-vault-plinth",
};

console.log("dumping the real MAP_TEMPLATES data from templates.ts via vitest…");
const realTemplates = dumpRealTemplates();
check("dumped exactly 30 templates (21 pre-existing + 9 new)", realTemplates.length === 30, String(realTemplates.length));
const newIds = Object.values(NEW_CATEGORY_REPRESENTATIVES);
for (const id of newIds) {
  check(`dump includes new template "${id}"`, realTemplates.some((t) => t.id === id));
}
const changedTemplates = realTemplates.filter((template) => CHANGED_TEMPLATE_IDS.includes(template.id));
check(
  "all 23 changed/new templates are present in the dump",
  changedTemplates.length === CHANGED_TEMPLATE_IDS.length,
  `found ${changedTemplates.length}`
);

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const consoleErrors = [];

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Map templates expansion test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const dmContext = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const page = await dmContext.newPage();
  collectConsoleErrors(page, consoleErrors);

  // ── 1. The template picker lists all 30 templates — no regression to
  //       what's selectable, including the 7 templates this task left
  //       fully untouched. ──
  await page.goto(`${APP_URL}/campaigns/${campaignId}/maps`);
  await page.waitForSelector('[data-testid="template-picker"]', { timeout: 60000 });
  for (const template of realTemplates) {
    check(
      `template picker offers "${template.id}"`,
      await page.locator(`[data-testid="template-${template.id}"]`).isVisible(),
      `template-${template.id} not found in the picker`
    );
  }
  await page.screenshot({ path: join(SCREENSHOT_DIR, "00-template-picker.png"), fullPage: true });

  // ── 2. Each of the 23 changed/new templates' REAL data writes cleanly
  //       under real RLS and renders correctly in the real editor. ──
  const mapIdByTemplateId = {};
  let shotIndex = 1;
  for (const template of changedTemplates) {
    const { mapId, error } = await createTemplateMapForReal(dm.client, campaignId, template);
    check(`"${template.id}" writes cleanly as the DM (real RLS)`, !error, error?.message);
    if (!mapId) continue;
    mapIdByTemplateId[template.id] = mapId;

    await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
    await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 150000 });
    const mirror = await readMirror(page, "editor-surface-state");

    // Full comparison against the REAL template data — every non-'default'
    // ground_type cell (buildDenseCells' own render rule) must match
    // exactly, at the template's real (possibly newly-enlarged) grid size.
    const expectedGround = new Map(
      template.cells
        .filter((cell) => (cell.ground_type ?? "default") !== "default")
        .map((cell) => [`${cell.x},${cell.y}`, cell.ground_type])
    );
    const groundMatches =
      expectedGround.size === Object.keys(mirror.groundByCell).length &&
      [...expectedGround.entries()].every(([key, ground]) => mirror.groundByCell[key] === ground);
    check(
      `"${template.id}" editor mirror's groundByCell matches the real template data exactly (${expectedGround.size} cells, grid ${template.gridWidth}x${template.gridHeight})`,
      groundMatches,
      JSON.stringify({ expected: Object.fromEntries(expectedGround), got: mirror.groundByCell })
    );

    await sleep(250);
    await page.screenshot({
      path: join(SCREENSHOT_DIR, `${String(shotIndex).padStart(2, "0")}-${template.id}.png`),
      fullPage: true,
    });
    shotIndex++;
  }

  // ── 3. One representative template per NEW category also renders
  //       correctly on the live Game Room table (same shared MapSurface
  //       renderer as the editor). ──
  const roomPage = await dmContext.newPage();
  collectConsoleErrors(roomPage, consoleErrors);
  await roomPage.setViewportSize({ width: 1500, height: 1000 });
  let liveShotIndex = 1;
  for (const [category, representativeId] of Object.entries(NEW_CATEGORY_REPRESENTATIVES)) {
    const mapId = mapIdByTemplateId[representativeId];
    if (!mapId) {
      check(`the live Game Room table renders "${representativeId}" (${category})`, false, "no map id — creation failed earlier");
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
      `the live Game Room table renders "${representativeId}" (${category}) with the right ground types`,
      matches,
      JSON.stringify(tableMirror.groundByCell)
    );
    await sleep(400);
    await angleCameraOverTable(roomPage);
    await roomPage.screenshot({
      path: join(SCREENSHOT_DIR, `live-${String(liveShotIndex).padStart(2, "0")}-${representativeId}.png`),
      fullPage: true,
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
console.log(`\nAll map-templates-expansion checks passed. Screenshots saved to ${SCREENSHOT_DIR}`);
process.exit(0);
