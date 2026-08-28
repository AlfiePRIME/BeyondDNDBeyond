#!/usr/bin/env node
// Map Art Generation E5 verification: the LIVE Game Room's own generated-art
// image plane (GameTableScene's MapArtPlane), the transparent-floor/
// faint-grid treatment it drives on MapSurface's CellBlock/GridOverlay, and
// the explicit judgment calls this prompt asked for — elevation keeps its
// real 3D geometry, water/pits/vision-masking stay exactly as they render
// today, unaffected by the new mode.
//
// Seeds everything directly via the service-role client (never a blind UI
// click-scan) — a real accepted map_art row pointing at a real PNG
// (docs/map-art-poc-output/final-small-room.png, one of E1's own generated
// example images), no live ComfyUI call needed for this prompt's own
// testing. Drives a REAL running Next.js dev server (this worktree's own,
// on a dedicated port) and REAL Playwright browsers.
//
// Checks:
//   1. A map with accepted art shows the art plane, correctly fitted to the
//      grid (contain-fit, centered — mapArtFit.ts's computeMapArtFit).
//   2. Ordinary floor cells go near-transparent and the grid overlay
//      switches to its faint map-art variant — verified by the real
//      onMapArtDebug/table-surface-state mirrors AND by a real screenshot a
//      human/agent can review (WebGL fill opacity isn't otherwise
//      DOM-observable).
//   3. Elevation keeps its real 3D geometry (a genuinely raised block, not
//      just a flat color swatch) — screenshot-verified.
//   4. Water ground and a real (revealed) pit stay fully opaque/dark under
//      map-art mode — state-verified via table-surface-state's
//      groundByCell/pitCells (unchanged shape/values) AND screenshot-
//      verified for the actual rendered color.
//   5. A concealed pit (not yet revealed) still renders as ordinary floor —
//      absent from pitCells — even with map art active elsewhere on the
//      same map: concealment itself leaks nothing new under the transparent
//      floor treatment.
//   6. Vision masking (dim + fully-hidden "none" tiers) still applies
//      correctly for a real player viewer on a map with art active —
//      verified via vision-state and a screenshot from the PLAYER's own
//      browser context.
//   7. A second map with NO accepted art renders with map-art mode fully
//      INACTIVE (onMapArtDebug reports active:false) — the zero-regression
//      case.
//
// Standing lesson: never trust the default port — PORT below is fixed,
// distinct from every other verify-*.mjs script's own port, and confirmed
// free at runtime.
// Usage: node scripts/db/verify-map-art-rendering.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Cross-checked against every `PORT = <n>` / `PORT ?? <n>` literal under
// scripts/db/*.mjs at the time this was written — distinct from all of
// them — and independently confirmed free at runtime below anyway.
const PORT = Number(process.env.MAP_ART_RENDERING_PORT ?? 4325);
const APP_URL = `http://localhost:${PORT}`;

const SCRATCH_SCREENSHOT_DIR = join(
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad",
  "map-art-rendering-screenshots"
);
mkdirSync(SCRATCH_SCREENSHOT_DIR, { recursive: true });
// Final "looks right" screenshots, per this prompt's own explicit ask —
// alongside E1's existing example images so they're reviewable with no
// re-run required.
const FINAL_SCREENSHOT_DIR = join(rootDir, "docs", "map-art-poc-output");
mkdirSync(FINAL_SCREENSHOT_DIR, { recursive: true });

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

const fileEnv = { ...loadEnv(join(rootDir, ".env")), ...loadEnv(join(rootDir, "supabase", ".env")) };
const baseEnv = { ...fileEnv, ...process.env };
const supabaseUrl = baseEnv.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = baseEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = baseEnv.SUPABASE_SERVICE_ROLE_KEY ?? baseEnv.SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

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

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const tester = createServer()
      .once("error", (err) => reject(new Error(`port ${port} is not free: ${err.message}`)))
      .once("listening", () => tester.close(() => resolve()))
      .listen(port, "127.0.0.1");
  });
}

async function healthOk() {
  return fetch(`${APP_URL}/api/health`, { cache: "no-store" }).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function startServer() {
  console.log(`\n--- starting this worktree's own dev server on :${PORT} ---`);
  devServer = spawn(join(rootDir, "node_modules", ".bin", "next"), ["dev", "-p", String(PORT)], {
    cwd: rootDir,
    env: baseEnv,
    stdio: "ignore",
    detached: true,
  });
  devServer.unref();
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${PORT} within 120s`);
}

async function stopServer() {
  if (!devServer) return;
  const pid = devServer.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  devServer = null;
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

async function makeTestUser(label, displayName) {
  const email = `map-art-render-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: displayName });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, email, client, session: signIn.session };
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

/** Polls a mirror until `predicate` is true or the budget runs out — the
 * table's own texture-load effect (MapArtPlane) resolves asynchronously
 * (a real signed-URL fetch + image decode), so `map-art-state`'s
 * `active: true` doesn't necessarily appear on the very first read. */
async function pollMirror(page, testid, predicate, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readMirror(page, testid);
    if (predicate(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

// Every DraggablePanel this page can mount (GameRoom.tsx's own panelId
// list) — collapsed before a "looks right" screenshot so the floating UI
// doesn't cover the 3D table (and doesn't intercept the orbit-drag mouse
// gesture below, which a panel sitting on top of the canvas would
// otherwise swallow instead of passing through to OrbitControls).
const ALL_PANEL_IDS = [
  "map",
  "liveObjects",
  "tokens",
  "combat",
  "hp",
  "opportunityAttack",
  "quickActions",
  "chatLog",
  "diceLog",
  "diceTray",
  "handout",
];

async function collapseAllPanels(page) {
  for (const panelId of ALL_PANEL_IDS) {
    const panel = page.locator(`[data-testid="draggable-panel-${panelId}"]`);
    if ((await panel.count()) === 0) continue;
    const toggle = page.locator(`[data-testid="collapse-toggle-${panelId}"]`);
    const label = await toggle.getAttribute("aria-label").catch(() => null);
    if (label === "Collapse panel") await toggle.click().catch(() => {});
  }
  await sleep(200);
}

/** Free camera, then a real mouse-wheel zoom — unlike the verify-water-
 * terrain.mjs/verify-ground-types.mjs "click free camera and screenshot"
 * precedent (which explicitly doesn't try for an overhead angle), this
 * script needs an actually-legible view to visually judge "faint but
 * visible" against, so it zooms in from the default orbit vantage.
 *
 * Deliberately does NOT also drag/rotate the camera (an earlier version of
 * this helper did): a calibration pass (scripts/db/calibrate-map-art-
 * opacity.mjs, not part of this deliverable) found that ANY left-drag
 * rotation here, even a small one, swings the orbit camera past the DM's
 * own throne and into an unusable close-up of its (opaque) seat back —
 * OrbitControls' default orbit target/distance combination on THIS scene
 * apparently has very little rotate headroom before the camera clips
 * through nearby seat geometry. The default (un-rotated) orbit vantage,
 * zoomed in, turned out to already be a legible, reasonably top-down-ish
 * view with no rotation risk at all. */
async function angleCameraOverTable(page, { zoomTicks = 9 } = {}) {
  await page.bringToFront();
  await page.click('[data-testid="camera-mode-toggle"]');
  await sleep(300);
  const box = await page.locator("canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < zoomTicks; i++) {
    await page.mouse.wheel(0, -120);
    await sleep(15);
  }
  await sleep(300);
}

let browser = null;
const cleanupUserIds = [];
let cleanupCampaignId = null;

try {
  await assertPortFree(PORT);
  await startServer();
  browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

  const dm = await makeTestUser("dm", "DM Tester");
  cleanupUserIds.push(dm.id);
  const player = await makeTestUser("player", "Player Tester");
  cleanupUserIds.push(player.id);

  const { data: campaign, error: campaignError } = await admin
    .from("campaigns")
    .insert({ name: "Map Art Rendering Test Campaign", creator: dm.id })
    .select("id")
    .single();
  if (campaignError) throw new Error(`creating test campaign: ${campaignError.message}`);
  cleanupCampaignId = campaign.id;

  const { error: memberError } = await admin.from("campaign_members").insert([
    { campaign_id: campaign.id, user_id: dm.id, role: "dm" },
    { campaign_id: campaign.id, user_id: player.id, role: "player" },
  ]);
  if (memberError) throw new Error(`seeding campaign membership: ${memberError.message}`);

  // ═══════════════════════════════════════════════════════════════════
  // Map A ("Map With Art") — 10x10, matching final-small-room.png's own
  // 1024x1024 (1:1) aspect exactly, so the demo screenshot shows a clean,
  // full-bleed fit with no letterboxing to explain away. Every feature this
  // prompt's own "use your own judgment" section calls out lives on this
  // one map: a raised plateau, a water patch, a real (already-revealed)
  // pit, a concealed (not-yet-revealed) pit, and a dim/dark vision-masking
  // corner — all alongside the new transparent floor.
  // ═══════════════════════════════════════════════════════════════════
  const { data: mapWithArt, error: mapWithArtError } = await admin
    .from("campaign_maps")
    .insert({ campaign_id: campaign.id, name: "Map With Art", grid_width: 10, grid_height: 10 })
    .select("id")
    .single();
  if (mapWithArtError) throw new Error(`creating Map With Art: ${mapWithArtError.message}`);
  const mapWithArtId = mapWithArt.id;

  const cellRows = [];
  // Raised plateau (elevation 3, ordinary terrain) — center-ish.
  for (const [x, y] of [[4, 4], [4, 5], [5, 4], [5, 5]]) {
    cellRows.push({ map_id: mapWithArtId, x, y, elevation: 3, terrain_type: "normal", light_level: "bright", ground_type: "default" });
  }
  // Water patch — bottom-left corner.
  for (const [x, y] of [[0, 8], [0, 9], [1, 8], [1, 9]]) {
    cellRows.push({ map_id: mapWithArtId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "water" });
  }
  // A real, already-revealed pit — bottom-right corner.
  for (const [x, y] of [[8, 8], [8, 9], [9, 8], [9, 9]]) {
    cellRows.push({ map_id: mapWithArtId, x, y, elevation: -3, terrain_type: "pit", light_level: "bright", ground_type: "default" });
  }
  // Vision-masking corner: dim, then dark, moving away from the player's
  // own token at (1,1) — no light sources needed at all: the player
  // character below is authored with darkvision_feet null, so
  // computeVisibilityTier's withinDarkvision branch is unreachable and a
  // dim/dark cell's tier is deterministic regardless of distance (see
  // perception.ts).
  for (const [x, y] of [[7, 0], [8, 0], [9, 0], [7, 1], [8, 1], [9, 1]]) {
    cellRows.push({ map_id: mapWithArtId, x, y, elevation: 0, terrain_type: "normal", light_level: "dim", ground_type: "default" });
  }
  for (const [x, y] of [[7, 2], [8, 2], [9, 2], [7, 3], [8, 3], [9, 3]]) {
    cellRows.push({ map_id: mapWithArtId, x, y, elevation: 0, terrain_type: "normal", light_level: "dark", ground_type: "default" });
  }
  const { error: cellsError } = await admin.from("map_cells").insert(cellRows);
  if (cellsError) throw new Error(`seeding Map With Art cells: ${cellsError.message}`);

  // A concealed pit (NOT a map_cells row — the whole point is that its
  // underlying cell stays ordinary "normal" floor, the sparse-storage
  // default) at (6,6), away from every other feature.
  const { error: concealedError } = await admin
    .from("concealed_pits")
    .insert({ map_id: mapWithArtId, x: 6, y: 6, bottom_elevation_steps: -3 });
  if (concealedError) throw new Error(`seeding concealed pit: ${concealedError.message}`);

  // The player's own character + token, placed at (1,1) — inside the
  // "bright" default region, far from the dim/dark corner and every other
  // feature. No darkvision, so the dim/dark cells above resolve to "dim"
  // and "none" respectively for her (perception.ts's own documented rule).
  const characterId = crypto.randomUUID();
  const { error: characterError } = await admin.from("characters").insert({
    id: characterId,
    campaign_id: campaign.id,
    owner_id: player.id,
    name: "Vision Tester",
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 10,
    max_hp: 10,
    armor_class: 10,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
    darkvision_feet: null,
  });
  if (characterError) throw new Error(`creating player character: ${characterError.message}`);

  const tokenId = crypto.randomUUID();
  const { error: tokenError } = await admin.from("map_tokens").insert({
    id: tokenId,
    map_id: mapWithArtId,
    character_id: characterId,
    x: 1,
    y: 1,
    elevation: 0,
    allegiance: "party",
  });
  if (tokenError) throw new Error(`placing player token: ${tokenError.message}`);

  // Seed a REAL accepted map_art row pointing at a REAL, valid PNG — one of
  // E1's own already-generated example images (docs/map-art-poc-output/
  // final-small-room.png) — via the service-role client and the map-art
  // Storage bucket, per this prompt's own standing lesson. No live ComfyUI
  // generation is needed for this prompt's own rendering test.
  const artPngPath = join(rootDir, "docs", "map-art-poc-output", "final-small-room.png");
  const artPngBytes = readFileSync(artPngPath);
  const artImageRef = `${mapWithArtId}/${crypto.randomUUID()}.png`;
  const { error: uploadError } = await admin.storage
    .from("map-art")
    .upload(artImageRef, artPngBytes, { contentType: "image/png" });
  if (uploadError) throw new Error(`uploading test map art: ${uploadError.message}`);
  const { error: artRowError } = await admin
    .from("map_art")
    .upsert(
      { map_id: mapWithArtId, image_ref: artImageRef, style_prompt: "verify-map-art-rendering test fixture" },
      { onConflict: "map_id" }
    );
  if (artRowError) throw new Error(`seeding map_art row: ${artRowError.message}`);

  // ═══════════════════════════════════════════════════════════════════
  // Map B ("Map Without Art") — the zero-regression case: a small mixed
  // map (elevation + water) with NO accepted art at all.
  // ═══════════════════════════════════════════════════════════════════
  const { data: mapWithoutArt, error: mapWithoutArtError } = await admin
    .from("campaign_maps")
    .insert({ campaign_id: campaign.id, name: "Map Without Art", grid_width: 6, grid_height: 6 })
    .select("id")
    .single();
  if (mapWithoutArtError) throw new Error(`creating Map Without Art: ${mapWithoutArtError.message}`);
  const mapWithoutArtId = mapWithoutArt.id;
  const { error: noArtCellsError } = await admin.from("map_cells").insert([
    { map_id: mapWithoutArtId, x: 2, y: 2, elevation: 2, terrain_type: "normal", light_level: "bright", ground_type: "default" },
    { map_id: mapWithoutArtId, x: 4, y: 4, elevation: 0, terrain_type: "normal", light_level: "bright", ground_type: "water" },
  ]);
  if (noArtCellsError) throw new Error(`seeding Map Without Art cells: ${noArtCellsError.message}`);

  // ═══════════════════════════════════════════════════════════════════
  // 1-6. Map With Art — DM's view: art plane, transparent floor, faint
  //      grid, elevation/water/pit legibility, concealment.
  // ═══════════════════════════════════════════════════════════════════
  await admin.from("campaigns").update({ live_map: mapWithArtId }).eq("id", campaign.id);

  const dmContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  const pageErrors = [];
  dmPage.on("pageerror", (err) => pageErrors.push(String(err)));

  await dmPage.goto(`${APP_URL}/campaigns/${campaign.id}/room`, { waitUntil: "load" });
  await dmPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  const dmMapArtState = await pollMirror(dmPage, "map-art-state", (state) => state?.active === true);
  check(
    "the DM's own table reports map art ACTIVE for Map With Art (accepted art present, texture loaded)",
    dmMapArtState?.mapId === mapWithArtId && dmMapArtState?.active === true,
    dmMapArtState
  );

  const dmSurfaceWithArt = await readMirror(dmPage, "table-surface-state");
  check(
    "the water patch still reports ground_type water in the table's own render-state mirror, unaffected by map-art mode",
    ["0,8", "0,9", "1,8", "1,9"].every((key) => dmSurfaceWithArt.groundByCell[key] === "water"),
    dmSurfaceWithArt.groundByCell
  );
  check(
    "the real, already-revealed pit cells still report as pit terrain at their real (negative) elevation",
    ["8,8", "8,9", "9,8", "9,9"].every((key) =>
      (dmSurfaceWithArt.pitCells ?? []).some((cell) => cell.key === key && cell.elevation === -3)
    ),
    dmSurfaceWithArt.pitCells
  );
  check(
    "the concealed (not yet revealed) pit does NOT appear as a pit — concealment leaks nothing new under map-art mode",
    !(dmSurfaceWithArt.pitCells ?? []).some((cell) => cell.key === "6,6"),
    dmSurfaceWithArt.pitCells
  );
  check(
    "Map With Art has no void cells (sanity: this map's floor is fully painted, not testing void interaction here)",
    (dmSurfaceWithArt.voidCells ?? []).length === 0,
    dmSurfaceWithArt.voidCells
  );

  await sleep(400);
  await collapseAllPanels(dmPage);
  await angleCameraOverTable(dmPage, { zoomTicks: 9 });
  const dmOverviewPath = join(FINAL_SCREENSHOT_DIR, "e5-01-dm-overview-transparent-floor-and-art.png");
  await dmPage.screenshot({ path: dmOverviewPath });
  await dmPage.screenshot({ path: join(SCRATCH_SCREENSHOT_DIR, "01-dm-overview.png") });
  console.log(`Saved: ${dmOverviewPath}`);

  // ═══════════════════════════════════════════════════════════════════
  // 6. Vision masking — the player's own browser context.
  // ═══════════════════════════════════════════════════════════════════
  const playerContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await playerContext.addCookies(sessionCookies(player.session));
  const playerPage = await playerContext.newPage();
  await playerPage.goto(`${APP_URL}/campaigns/${campaign.id}/room`, { waitUntil: "load" });
  await playerPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await pollMirror(playerPage, "map-art-state", (state) => state?.active === true);

  const playerVision = await readMirror(playerPage, "vision-state");
  check(
    "the player's own vision-state mirror reports real masking active (not the DM's unmasked view)",
    playerVision.masked === true && playerVision.mapId === mapWithArtId,
    playerVision
  );
  const dimCellsMasked = ["7,0", "8,0", "9,0", "7,1", "8,1", "9,1"].every((key) => playerVision.cells?.[key] === "dim");
  const darkCellsHidden = ["7,2", "8,2", "9,2", "7,3", "8,3", "9,3"].every((key) => playerVision.cells?.[key] === "hidden");
  check(
    "the dim-lit corner still resolves to the 'dim' tier for the player, with map art active on the rest of the map",
    dimCellsMasked,
    playerVision.cells
  );
  check(
    "the dark corner (beyond her non-existent darkvision) still resolves fully hidden ('none'/absent from live rendering)",
    darkCellsHidden,
    playerVision.cells
  );

  await sleep(400);
  await collapseAllPanels(playerPage);
  await angleCameraOverTable(playerPage, { zoomTicks: 9 });
  const playerVisionPath = join(FINAL_SCREENSHOT_DIR, "e5-02-player-vision-masking-with-art.png");
  await playerPage.screenshot({ path: playerVisionPath });
  await playerPage.screenshot({ path: join(SCRATCH_SCREENSHOT_DIR, "02-player-vision.png") });
  console.log(`Saved: ${playerVisionPath}`);

  // Close-up of the raised plateau + real pit + water, for a legible
  // per-feature review shot alongside the overview above — already in
  // orbit mode from the overview shot above, so this just zooms in
  // further from wherever that left the camera.
  await dmPage.bringToFront();
  const dmBox = await dmPage.locator("canvas").boundingBox();
  await dmPage.mouse.move(dmBox.x + dmBox.width / 2, dmBox.y + dmBox.height / 2);
  for (let i = 0; i < 5; i++) {
    await dmPage.mouse.wheel(0, -120);
    await sleep(15);
  }
  await sleep(300);
  const dmCloseupPath = join(FINAL_SCREENSHOT_DIR, "e5-03-dm-closeup-elevation-water-pit.png");
  await dmPage.screenshot({ path: dmCloseupPath });
  await dmPage.screenshot({ path: join(SCRATCH_SCREENSHOT_DIR, "03-dm-closeup.png") });
  console.log(`Saved: ${dmCloseupPath}`);

  check("no uncaught page errors on the DM's page across the whole Map With Art flow", pageErrors.length === 0, pageErrors.join("\n"));

  await playerContext.close();

  // ═══════════════════════════════════════════════════════════════════
  // 7. Map Without Art — zero-regression case: map-art mode fully inactive.
  // ═══════════════════════════════════════════════════════════════════
  await admin.from("campaigns").update({ live_map: mapWithoutArtId }).eq("id", campaign.id);
  await dmPage.reload({ waitUntil: "load" });
  await dmPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  // Polled, not a single read: right after a reload/map switch, this
  // mirror can transiently read null (no live map resolved into the scene
  // yet) before GameTableScene's own liveMap prop catches up — the same
  // "async state settling" reasoning as the Map With Art poll above, just
  // waiting for `mapId` to settle on the NEW map rather than for `active`
  // to flip true.
  const noArtMapArtState = await pollMirror(dmPage, "map-art-state", (state) => state?.mapId === mapWithoutArtId);
  check(
    "a map with no accepted art reports map-art mode INACTIVE",
    noArtMapArtState?.mapId === mapWithoutArtId && noArtMapArtState?.active === false,
    noArtMapArtState
  );
  const noArtSurface = await readMirror(dmPage, "table-surface-state");
  check(
    "the water cell on the art-less map still reports its ground type normally",
    noArtSurface.groundByCell["4,4"] === "water",
    noArtSurface.groundByCell
  );

  await sleep(400);
  await collapseAllPanels(dmPage);
  await angleCameraOverTable(dmPage, { zoomTicks: 9 });
  const noArtPath = join(FINAL_SCREENSHOT_DIR, "e5-04-map-without-art-unchanged.png");
  await dmPage.screenshot({ path: noArtPath });
  await dmPage.screenshot({ path: join(SCRATCH_SCREENSHOT_DIR, "04-no-art-map.png") });
  console.log(`Saved: ${noArtPath}`);

  await dmContext.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();

  if (cleanupCampaignId) {
    const { data: mapsToClean } = await admin.from("campaign_maps").select("id").eq("campaign_id", cleanupCampaignId);
    for (const { id: cleanupMapId } of mapsToClean ?? []) {
      const { data: artRow } = await admin.from("map_art").select("image_ref").eq("map_id", cleanupMapId).maybeSingle();
      if (artRow?.image_ref) {
        await admin.storage.from("map-art").remove([artRow.image_ref]).catch(() => {});
      }
    }
    const { error: deleteCampaignError } = await admin.from("campaigns").delete().eq("id", cleanupCampaignId);
    if (deleteCampaignError) console.error("warning: failed to delete test campaign:", deleteCampaignError.message);
  }

  for (const id of cleanupUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
