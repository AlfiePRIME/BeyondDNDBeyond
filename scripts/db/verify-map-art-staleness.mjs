#!/usr/bin/env node
// Map Art Generation E6 verification: growing a map's grid (grow_map_grid,
// 0046/0057/0078) flags any already-accepted map_art `stale` rather than
// deleting it, the map editor's Map drawer surfaces a DM-only notice near
// the existing "Map art" section (E4's own placement) while players see no
// different behavior anywhere, and regenerating from that same
// Generate/Regenerate button re-runs E3/E4's real pipeline against the
// map's CURRENT (grown) footprint and clears the flag on accept.
//
// This is an explicitly honest v1 limitation, not a deficiency being
// hidden: there is no inpainting/outpainting of the existing image here —
// growth just marks it stale with a clear path back to a fresh, correct
// state (regenerate). generate-art/route.ts already reads the map's live
// grid_width/grid_height at request time (getMap(...) mid-request, not a
// value cached from whenever art was first accepted), so "regenerate covers
// the grown footprint" needed no change of its own — this script verifies
// that is actually true end to end, not just asserted.
//
// Exercises the REAL live ComfyUI instance at http://10.10.1.10:8188 (the
// same one E1/E4 used) via a REAL running Next.js dev server and REAL
// Playwright browsers for the full generate → grow → stale → regenerate →
// accept cycle — not a mocked fetch, not code-reading. A real generation on
// this hardware takes ~80-120s (docs/map-art-generation-research.md §8);
// this script waits SYNCHRONOUSLY in the foreground for each real result
// (no polling-from-outside, no background job), with a generous timeout
// well above that, twice (initial generate + regenerate).
//
// Checks:
//   SECTION A (DB-level, via the DM's own real authenticated RPC call, no
//   ComfyUI/UI involved — fast, exhaustive edge coverage):
//     1. Growing north, south, or west (not just the east case Section B's
//        real UI flow exercises) each flags an existing map_art row stale —
//        confirms the new UPDATE in grow_map_grid (0078) is UNCONDITIONAL,
//        not nested inside the west/north coordinate-shift branch.
//     2. A map with NO map_art row at all: growing it on multiple edges
//        never creates a stray map_art row and the grid resize itself keeps
//        working exactly as before — the explicit zero-regression
//        requirement.
//
//   SECTION B (real end-to-end via the actual editor/Game Room UI + REAL
//   ComfyUI, twice):
//     3. A real initial generation + accept on an 8x8 map — stale is false,
//        and the accepted image's real pixel dimensions match this grid's
//        footprint exactly (1024x1024 — controlImage.ts's own
//        TARGET_LONG_EDGE/16-aligned formula, computed independently here).
//     4. Growing that map's grid (east, +8, a plain dimension bump with no
//        coordinate shift) through the REAL "Grow" button flags the art
//        stale — verified directly against map_art.stale, not inferred.
//     5. The DM sees a clear stale notice in the Map drawer, right next to
//        the Generate/Regenerate button (E4's own placement) — a real
//        rendered DOM element, not just a state flag.
//     6. A real player (Game Room, not the map editor at all) sees ZERO
//        different behavior or indicator: the page source contains no
//        trace of the stale notice, and the transparent-floor/faint-grid
//        rendering (E5) stays exactly as before — same map, same "active"
//        rendering state — covering less of the new, larger grid than it
//        ideally would, exactly as this plan's v1 scope describes.
//     7. Clicking the SAME button (already labeled "Regenerate" once art
//        exists, E4) re-runs a REAL ComfyUI generation against the map's
//        CURRENT 16x8 footprint — the real returned image's pixel
//        dimensions are 1024x512 (the new aspect ratio), not the old
//        1024x1024 — concrete proof this isn't just re-serving the old art.
//     8. Accepting that regeneration clears map_art.stale back to false,
//        replaces image_ref with a genuinely new Storage object, and the
//        stale notice disappears from the DM's own live DOM.
//
// Seeds every test user, campaign/membership, map/cells, and the one
// pre-existing map_art row directly via the service-role client — never a
// blind UI click-scan. Uses this worktree's own `next dev` on a dedicated,
// confirmed-free port, never the default :3000.
// Usage: node scripts/db/verify-map-art-staleness.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Cross-checked against every `PORT = <n>` / `PORT ?? <n>` literal under
// scripts/db/*.mjs at the time this was written — distinct from all of
// them (nearest neighbors: 4211 map-art-generation, 4325 map-art-rendering)
// — and independently confirmed free at runtime below anyway (standing
// lesson: never trust the default port).
const PORT = Number(process.env.MAP_ART_STALENESS_PORT ?? 4331);
const APP_URL = `http://localhost:${PORT}`;

// The exact real instance E1/E4 validated live.
const REAL_COMFYUI_URL = process.env.COMFYUI_URL ?? "http://10.10.1.10:8188";

// Real timing data point (docs/map-art-generation-research.md §8): 79-120s
// observed at this workflow's steps=8/1024px settings on this hardware.
// This script waits synchronously for real completion, with real headroom
// above that, rather than polling from outside or assuming a short timeout.
const REAL_GENERATION_WAIT_MS = 240_000;

// controlImage.ts's own renderMapArtControlImage sizing formula, mirrored
// here independently so this script can assert an EXACT expected pixel
// size for a real generated image from first principles (grid dimensions
// alone) rather than just re-reading whatever the app itself computed.
// generateMapArt.ts returns `width`/`height` as exactly the params it was
// called with (the control image's own dimensions) — ComfyUI's
// EmptyFlux2LatentImage node is forced to that exact resolution — so the
// real accepted/previewed PNG's pixel dimensions are these values exactly,
// not merely "close".
const TARGET_LONG_EDGE = 1024;
function expectedArtDims(gridWidth, gridHeight) {
  const rawCellPx = TARGET_LONG_EDGE / Math.max(gridWidth, gridHeight);
  const cellPx = Math.max(2, Math.round(rawCellPx));
  const rawWidth = gridWidth * cellPx;
  const rawHeight = gridHeight * cellPx;
  const width = Math.ceil(rawWidth / 16) * 16;
  const height = Math.ceil(rawHeight / 16) * 16;
  return { width, height };
}

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

// The @supabase/ssr cookie format — same helper as verify-map-art-generation.mjs
// / verify-map-art-rendering.mjs.
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
  const email = `map-art-stale-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
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
 * table's own texture-load effect (MapArtPlane) resolves asynchronously, so
 * `map-art-state`'s `active: true` doesn't necessarily appear on the very
 * first read (verify-map-art-rendering.mjs's own precedent). */
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

// Map editor toolbar redesign precedent (verify-map-grid-growth.mjs's own
// openMapDrawer/waitForGridLabel): handleGrowGrid's real `window.location.
// reload()` means the Map drawer is closed again and the whole document is
// briefly torn down after a real grow — this opens it (a no-op if already
// open) before each read, retrying through the reload instead of racing it.
async function openMapDrawer(page) {
  const alreadyOpen = await page
    .locator('[data-testid="grid-size-label"]')
    .isVisible()
    .catch(() => false);
  if (!alreadyOpen) {
    await page.click('[data-testid="map-drawer-toggle"]', { timeout: 2000 }).catch(() => {});
  }
}

/** Polls the Map drawer for a given testid's text (or null if absent),
 * reopening the drawer on every attempt — survives the real reload
 * handleGrowGrid triggers on success. */
async function pollDrawerText(page, testid, predicate, timeoutMs = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      await openMapDrawer(page);
      const loc = page.locator(`[data-testid="${testid}"]`);
      last = (await loc.count()) > 0 ? ((await loc.textContent({ timeout: 2000 })) ?? "").trim() : null;
      if (predicate(last)) return last;
    } catch {
      // Mid-reload — the old document is gone and the new one hasn't
      // attached yet; just retry.
    }
    await sleep(300);
  }
  return last;
}

/** Real pixel dimensions of a rendered <img>, polled since a data: URL's
 * decode is asynchronous even though no network fetch is involved. */
async function readImageDims(page, testid, timeoutMs = 15000) {
  const handle = await page.waitForFunction(
    (id) => {
      const img = document.querySelector(`[data-testid="${id}"]`);
      return img && img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : false;
    },
    testid,
    { timeout: timeoutMs }
  );
  return handle.jsonValue();
}

const cleanupUserIds = [];
let cleanupCampaignId = null;
let browser = null;
let originalComfyuiHostUrl;
let originalComfyuiStylePrompt;

try {
  await assertPortFree(PORT);

  const { data: originalSettings } = await admin
    .from("app_settings")
    .select("comfyui_host_url, comfyui_style_prompt")
    .eq("singleton", true)
    .maybeSingle();
  originalComfyuiHostUrl = originalSettings?.comfyui_host_url ?? null;
  originalComfyuiStylePrompt = originalSettings?.comfyui_style_prompt ?? null;

  // Confirm the real instance is actually reachable BEFORE relying on it —
  // fail loudly and specifically here, rather than deep inside a Playwright
  // wait, if it genuinely isn't.
  const liveCheck = await fetch(`${REAL_COMFYUI_URL}/system_stats`, { signal: AbortSignal.timeout(8000) }).catch(
    (err) => ({ ok: false, statusText: String(err) })
  );
  if (!liveCheck.ok) {
    throw new Error(
      `The real ComfyUI instance at ${REAL_COMFYUI_URL} is not reachable right now (${liveCheck.status ?? liveCheck.statusText}) — this script requires it for real end-to-end verification.`
    );
  }
  console.log(`Confirmed live ComfyUI instance reachable at ${REAL_COMFYUI_URL}.`);

  const ADMIN_DEFAULT_STYLE = "hand-painted fantasy parchment map art, sun-bleached and weathered";
  const { error: settingsError } = await admin
    .from("app_settings")
    .update({ comfyui_host_url: REAL_COMFYUI_URL, comfyui_style_prompt: ADMIN_DEFAULT_STYLE })
    .eq("singleton", true);
  if (settingsError) throw new Error(`seeding app_settings: ${settingsError.message}`);

  await startServer();
  browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

  const dm = await makeTestUser("dm", "DM Tester");
  cleanupUserIds.push(dm.id);
  const player = await makeTestUser("player", "Player Tester");
  cleanupUserIds.push(player.id);

  const { data: campaign, error: campaignError } = await admin
    .from("campaigns")
    .insert({ name: "Map Art Staleness Test Campaign", creator: dm.id })
    .select("id")
    .single();
  if (campaignError) throw new Error(`creating test campaign: ${campaignError.message}`);
  cleanupCampaignId = campaign.id;

  const { error: memberError } = await admin.from("campaign_members").insert([
    { campaign_id: campaign.id, user_id: dm.id, role: "dm" },
    { campaign_id: campaign.id, user_id: player.id, role: "player" },
  ]);
  if (memberError) throw new Error(`seeding campaign membership: ${memberError.message}`);

  // A real DM-authenticated client (not the service-role one) for the
  // RPC-level checks below — exercises grow_map_grid's real RLS-gated path
  // exactly as the editor's own growMapGrid() wrapper does, not a
  // service-role bypass.
  const dmRpc = dm.client;

  const artPngPath = join(rootDir, "docs", "map-art-poc-output", "final-small-room.png");
  const artPngBytes = readFileSync(artPngPath);

  async function seedMap(name, gridWidth, gridHeight) {
    const { data: map, error } = await admin
      .from("campaign_maps")
      .insert({ campaign_id: campaign.id, name, grid_width: gridWidth, grid_height: gridHeight })
      .select("id")
      .single();
    if (error) throw new Error(`creating map ${name}: ${error.message}`);
    return map.id;
  }

  async function seedMapArt(mapId, { stale = false } = {}) {
    const imageRef = `${mapId}/${crypto.randomUUID()}.png`;
    const { error: uploadError } = await admin.storage
      .from("map-art")
      .upload(imageRef, artPngBytes, { contentType: "image/png" });
    if (uploadError) throw new Error(`uploading fixture art for ${mapId}: ${uploadError.message}`);
    const { error: rowError } = await admin
      .from("map_art")
      .upsert(
        { map_id: mapId, image_ref: imageRef, style_prompt: "verify-map-art-staleness fixture", stale },
        { onConflict: "map_id" }
      );
    if (rowError) throw new Error(`seeding map_art row for ${mapId}: ${rowError.message}`);
    return imageRef;
  }

  // ═══════════════════════════════════════════════════════════════════
  // SECTION A — DB-level: every edge flags stale (not just east, which
  // Section B's real UI flow covers below), and a map with NO art is
  // completely unaffected. Fast, no ComfyUI/UI involved.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n--- Section A: grow_map_grid staleness across every edge, DM's own real RPC call ---");

  for (const edge of ["north", "south", "west"]) {
    const mapId = await seedMap(`Edge Test (${edge})`, 6, 6);
    await seedMapArt(mapId, { stale: false });

    const { data: grown, error: growError } = await dmRpc.rpc("grow_map_grid", {
      p_map_id: mapId,
      p_edge: edge,
      p_amount: 2,
    });
    check(`growing ${edge} by 2 succeeds under the DM's own real session (RLS)`, !growError, growError);

    const expectedWidth = edge === "west" ? 8 : 6;
    const expectedHeight = edge === "north" || edge === "south" ? 8 : 6;
    check(
      `growing ${edge} updates grid dimensions correctly (${expectedWidth}x${expectedHeight})`,
      grown?.grid_width === expectedWidth && grown?.grid_height === expectedHeight,
      grown
    );

    const { data: artAfter } = await admin.from("map_art").select("stale").eq("map_id", mapId).maybeSingle();
    check(
      `growing ${edge} flags this map's existing art stale (grow_map_grid's new UNCONDITIONAL update, 0078)`,
      artAfter?.stale === true,
      artAfter
    );
  }

  const noArtMapId = await seedMap("No Art Map", 5, 5);
  for (const edge of ["east", "west", "north", "south"]) {
    const { error: growError } = await dmRpc.rpc("grow_map_grid", { p_map_id: noArtMapId, p_edge: edge, p_amount: 3 });
    check(`growing ${edge} on a map with no art at all still succeeds (zero regression)`, !growError, growError);
  }
  const { data: noArtMap } = await admin.from("campaign_maps").select("grid_width, grid_height").eq("id", noArtMapId).single();
  check(
    "the no-art map's grid actually grew on every edge (6 wider + 6 taller, from 5x5 to 11x11)",
    noArtMap?.grid_width === 11 && noArtMap?.grid_height === 11,
    noArtMap
  );
  const { data: strayArt, error: strayArtError } = await admin.from("map_art").select().eq("map_id", noArtMapId).maybeSingle();
  check(
    "growing a map with NO generated art attached never creates a stray map_art row — completely unaffected",
    !strayArtError && strayArt === null,
    strayArt ?? strayArtError
  );

  // ═══════════════════════════════════════════════════════════════════
  // SECTION B — real end-to-end: generate → grow → stale (DM notice, no
  // player-visible change) → regenerate → accept clears stale, against the
  // REAL live ComfyUI instance, driven through the real editor/Game Room UI.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n--- Section B: real end-to-end generate/grow/stale/regenerate cycle ---");

  const mainMapId = await seedMap("Staleness E2E Map", 8, 8);
  const cellRows = [];
  for (const [x, y] of [[2, 2], [2, 3], [3, 2], [3, 3]]) {
    cellRows.push({ map_id: mainMapId, x, y, elevation: 0, terrain_type: "normal", ground_type: "water" });
  }
  for (const [x, y] of [[4, 4], [4, 5], [5, 4], [5, 5]]) {
    cellRows.push({ map_id: mainMapId, x, y, elevation: 0, terrain_type: "normal", ground_type: "stone" });
  }
  const { error: cellsError } = await admin.from("map_cells").insert(cellRows);
  if (cellsError) throw new Error(`seeding map cells: ${cellsError.message}`);

  // Live — map-art's RLS (can_read_map) and GameTableScene's own live-map
  // resolution both need this true for the player-view checks below.
  const { error: liveMapError } = await admin.from("campaigns").update({ live_map: mainMapId }).eq("id", campaign.id);
  if (liveMapError) throw new Error(`setting live map: ${liveMapError.message}`);

  const dmContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  const pageErrors = [];
  dmPage.on("pageerror", (err) => pageErrors.push(String(err)));

  await dmPage.goto(`${APP_URL}/campaigns/${campaign.id}/maps/${mainMapId}/edit`, { waitUntil: "load" });
  await dmPage.waitForSelector('[data-testid="save-map"]', { state: "visible", timeout: 30000 });
  await dmPage.click('[data-testid="map-drawer-toggle"]');
  await dmPage.waitForSelector('[data-testid="map-drawer"]', { state: "visible", timeout: 10000 });

  check(
    "before any art exists, the Map drawer shows NO stale notice (sanity baseline)",
    (await dmPage.locator('[data-testid="map-art-stale-notice"]').count()) === 0
  );
  const initialButtonLabel = (await dmPage.textContent('[data-testid="generate-map-art-button"]'))?.trim();
  check('the button reads "Generate" before any art exists', initialButtonLabel === "Generate", initialButtonLabel);

  // ───────────────────────────────────────────────────────────────────
  // 3. Real initial generation (8x8 grid → expect exactly 1024x1024) + accept.
  // ───────────────────────────────────────────────────────────────────
  const expectedInitialDims = expectedArtDims(8, 8);
  console.log(
    `\n--- triggering REAL ComfyUI generation #1 (initial, 8x8 grid → expect ${expectedInitialDims.width}x${expectedInitialDims.height}) against ${REAL_COMFYUI_URL} ---`
  );
  let genStart = Date.now();
  await dmPage.click('[data-testid="generate-map-art-button"]');
  await dmPage.waitForSelector('[data-testid="map-art-preview"], [data-testid="map-art-error"]', {
    state: "visible",
    timeout: REAL_GENERATION_WAIT_MS,
  });
  let genElapsedMs = Date.now() - genStart;
  let genErrorEl = await dmPage.$('[data-testid="map-art-error"]');
  check(
    `real generation #1 (initial) completed successfully (${Math.round(genElapsedMs / 1000)}s)`,
    genErrorEl === null,
    genErrorEl ? await genErrorEl.textContent() : undefined
  );
  console.log(`Real ComfyUI generation #1 wall-clock time: ${Math.round(genElapsedMs / 1000)}s.`);

  const initialPreviewDims = await readImageDims(dmPage, "map-art-preview");
  check(
    `the real generation #1 preview's actual pixel dimensions match the 8x8 grid exactly (${expectedInitialDims.width}x${expectedInitialDims.height})`,
    initialPreviewDims.w === expectedInitialDims.width && initialPreviewDims.h === expectedInitialDims.height,
    initialPreviewDims
  );

  await dmPage.click('[data-testid="accept-map-art"]');
  await dmPage.waitForSelector('[data-testid="map-art-preview"]', { state: "detached", timeout: 30000 });

  const { data: artAfterAccept1 } = await admin.from("map_art").select().eq("map_id", mainMapId).maybeSingle();
  check("accepting the real initial generation persisted a map_art row", artAfterAccept1 !== null, artAfterAccept1);
  check("the freshly-accepted art is NOT stale", artAfterAccept1?.stale === false, artAfterAccept1?.stale);
  const firstImageRef = artAfterAccept1?.image_ref;

  const regenLabelAfterAccept = (await dmPage.textContent('[data-testid="generate-map-art-button"]'))?.trim();
  check(
    'the button now reads "Regenerate" once art has been accepted (E4\'s own existing behavior)',
    regenLabelAfterAccept === "Regenerate",
    regenLabelAfterAccept
  );

  // ───────────────────────────────────────────────────────────────────
  // 4-5. Grow the grid (east, +8 → 16x8) through the REAL Grow button —
  //      flags the art stale, and the DM sees a real, rendered notice.
  // ───────────────────────────────────────────────────────────────────
  console.log("\n--- growing the grid east by 8 through the real 'Grow' button (8x8 -> 16x8) ---");
  await dmPage.fill('[data-testid="grow-amount"]', "8");
  const growEdgeValue = await dmPage.inputValue('[data-testid="grow-edge"]');
  check("the grow-edge selector defaults to east (the plain dimension-bump case)", growEdgeValue === "east", growEdgeValue);
  await dmPage.click('[data-testid="grow-grid-button"]');

  const gridLabelAfterGrow = await pollDrawerText(dmPage, "grid-size-label", (text) => text === "16×8");
  check("the visible grid size reflects the grow after the real reload (16×8)", gridLabelAfterGrow === "16×8", gridLabelAfterGrow);

  const { data: mapAfterGrow } = await admin
    .from("campaign_maps")
    .select("grid_width, grid_height")
    .eq("id", mainMapId)
    .single();
  check(
    "campaign_maps itself actually grew to 16x8",
    mapAfterGrow?.grid_width === 16 && mapAfterGrow?.grid_height === 8,
    mapAfterGrow
  );

  const { data: artAfterGrow } = await admin.from("map_art").select().eq("map_id", mainMapId).maybeSingle();
  check("growing the grid flagged the existing accepted art stale", artAfterGrow?.stale === true, artAfterGrow?.stale);
  check("growing the grid did NOT touch image_ref (flagged, not deleted/replaced)", artAfterGrow?.image_ref === firstImageRef, {
    before: firstImageRef,
    after: artAfterGrow?.image_ref,
  });

  const staleNoticeText = await pollDrawerText(dmPage, "map-art-stale-notice", (text) => text !== null);
  check(
    "the DM sees a real, rendered stale notice in the Map drawer next to the Generate/Regenerate button",
    typeof staleNoticeText === "string" && /no longer covers the full map/i.test(staleNoticeText),
    staleNoticeText
  );
  const regenLabelWhileStale = (await dmPage.textContent('[data-testid="generate-map-art-button"]'))?.trim();
  check(
    'the button still reads "Regenerate" (the same button IS the regenerate action, per this prompt\'s own scope)',
    regenLabelWhileStale === "Regenerate",
    regenLabelWhileStale
  );

  // ───────────────────────────────────────────────────────────────────
  // 6. A real player sees ZERO different behavior or indicator — the Game
  //    Room, not the map editor, and the E5 rendering treatment is
  //    unaffected by staleness (same map, same active-rendering state).
  // ───────────────────────────────────────────────────────────────────
  const playerContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await playerContext.addCookies(sessionCookies(player.session));
  const playerPage = await playerContext.newPage();
  await playerPage.goto(`${APP_URL}/campaigns/${campaign.id}/room`, { waitUntil: "load" });
  await playerPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  const playerMapArtState = await pollMirror(playerPage, "map-art-state", (state) => state?.active === true);
  check(
    "the player's own table STILL reports map art active — the same (now-stale) art keeps rendering exactly as E5 established, unaffected by the flag",
    playerMapArtState?.mapId === mainMapId && playerMapArtState?.active === true,
    playerMapArtState
  );

  const playerPageContent = await playerPage.content();
  check(
    "the player's page contains NO trace of the stale notice anywhere — no different behavior or indicator at all",
    !/no longer covers the full map/i.test(playerPageContent) && !playerPageContent.includes("map-art-stale-notice"),
    { length: playerPageContent.length }
  );
  await playerContext.close();

  // ───────────────────────────────────────────────────────────────────
  // 7-8. Real regeneration against the CURRENT 16x8 footprint (expect
  //      1024x512 — a genuinely different aspect ratio, not the old
  //      1024x1024) + accept clears stale and replaces image_ref.
  // ───────────────────────────────────────────────────────────────────
  const expectedRegenDims = expectedArtDims(16, 8);
  console.log(
    `\n--- triggering REAL ComfyUI generation #2 (regenerate, grown 16x8 grid → expect ${expectedRegenDims.width}x${expectedRegenDims.height}) against ${REAL_COMFYUI_URL} ---`
  );
  genStart = Date.now();
  await dmPage.click('[data-testid="generate-map-art-button"]');
  await dmPage.waitForSelector('[data-testid="map-art-preview"], [data-testid="map-art-error"]', {
    state: "visible",
    timeout: REAL_GENERATION_WAIT_MS,
  });
  genElapsedMs = Date.now() - genStart;
  genErrorEl = await dmPage.$('[data-testid="map-art-error"]');
  check(
    `real generation #2 (regenerate) completed successfully (${Math.round(genElapsedMs / 1000)}s)`,
    genErrorEl === null,
    genErrorEl ? await genErrorEl.textContent() : undefined
  );
  console.log(`Real ComfyUI generation #2 wall-clock time: ${Math.round(genElapsedMs / 1000)}s.`);

  const regenPreviewDims = await readImageDims(dmPage, "map-art-preview");
  check(
    `the real regeneration's actual pixel dimensions match the GROWN 16x8 footprint exactly (${expectedRegenDims.width}x${expectedRegenDims.height}), proving it's a genuinely new render, not the old art re-served`,
    regenPreviewDims.w === expectedRegenDims.width && regenPreviewDims.h === expectedRegenDims.height,
    regenPreviewDims
  );

  await dmPage.click('[data-testid="accept-map-art"]');
  await dmPage.waitForSelector('[data-testid="map-art-preview"]', { state: "detached", timeout: 30000 });

  const { data: artAfterRegenAccept } = await admin.from("map_art").select().eq("map_id", mainMapId).maybeSingle();
  check("accepting the regeneration clears the stale flag back to false", artAfterRegenAccept?.stale === false, artAfterRegenAccept?.stale);
  check(
    "accepting the regeneration replaced image_ref with a genuinely new Storage object",
    Boolean(artAfterRegenAccept?.image_ref) && artAfterRegenAccept.image_ref !== firstImageRef,
    { before: firstImageRef, after: artAfterRegenAccept?.image_ref }
  );
  check(
    "generated_at moved forward on the regeneration",
    new Date(artAfterRegenAccept?.generated_at).getTime() > new Date(artAfterAccept1?.generated_at).getTime(),
    { before: artAfterAccept1?.generated_at, after: artAfterRegenAccept?.generated_at }
  );

  check(
    "the stale notice is gone from the DM's own live DOM immediately after accepting (no reload needed)",
    (await dmPage.locator('[data-testid="map-art-stale-notice"]').count()) === 0
  );

  check(
    "no uncaught page errors occurred on the DM's page across the whole generate/grow/stale/regenerate/accept cycle",
    pageErrors.length === 0,
    pageErrors.join("\n")
  );
  await dmContext.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();

  // Explicit Storage cleanup BEFORE the cascading campaign delete below —
  // a direct admin-level campaign delete bypasses deleteMap()'s own
  // pre-delete Storage cleanup (maps.ts), so map-art objects would
  // otherwise orphan in this shared Supabase instance.
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

  // Restore app_settings' two ComfyUI columns to whatever they were before
  // this script ran — this Supabase instance is shared with other work.
  if (originalComfyuiHostUrl !== undefined) {
    await admin
      .from("app_settings")
      .update({ comfyui_host_url: originalComfyuiHostUrl, comfyui_style_prompt: originalComfyuiStylePrompt })
      .eq("singleton", true)
      .then(
        () => {},
        (err) => console.error("warning: failed to restore app_settings:", err.message)
      );
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
