#!/usr/bin/env node
// Map deletion verification (Map Editor Batch A2).
//
// maps.ts gained deleteMap(mapId) plus a listMapsLinkingInto(mapId) helper
// the DM's confirmation dialog (MapsManager.tsx) calls before it, so the
// dialog can name any OTHER map whose own transition leads into the map
// about to be deleted (that link cascades away right along with it).
// deleteMap itself: cleans up the two Storage-bucket files (thumbnail,
// reference image — the only things a DB-level FK cascade can't reach),
// then deletes the campaign_maps row. Every other table referencing the map
// (cells, objects, tokens, transitions in both directions, light sources,
// concealed pits, whiteboard tiles) already cascades via its own FK — see
// maps.ts's own doc comment above deleteMap for the full migration audit —
// and campaigns.live_map's "on delete set null" (0014) means a campaign
// whose live map is the one being deleted just loses it rather than
// blocking the delete.
//
// This script seeds ALL of that via the admin/service-role client directly
// (never a blind UI click-scan — this batch's own hard-won lesson), then
// drives the actual delete through the DM's real signed-in browser session
// against the maps list page (plain DOM, no WebGL canvas here, so no
// scanClick trickery is needed), and verifies every acceptance criterion
// with a DIRECT admin query afterward — not just that the UI stops showing
// the map.
//
// Covers:
//   1. A DM can delete a map from the maps list after confirming (a real
//      Modal, not a bare browser confirm).
//   2. The confirmation dialog names another map that has a transition
//      pointing INTO the map being deleted, before deletion proceeds.
//   3. After deletion: that other map's own incoming transition is
//      genuinely gone (queried on the OTHER map's own transitions, not the
//      deleted map's), the deleted map's own outgoing transition is gone,
//      and its cells/objects/tokens/light sources/concealed pits/whiteboard
//      tiles are all gone too (all via direct admin queries).
//   4. The thumbnail and reference-image Storage objects are removed.
//   5. Deleting the campaign's current live map leaves campaigns.live_map
//      null, and the Game Room loads with no crash afterward (proven via
//      its own map-view-state debug mirror, not just "the page didn't
//      throw").
//   6. A non-DM member: the whole /maps route 404s for them (a stronger
//      gate than a hidden button), AND a raw delete attempt against
//      campaign_maps under their own session matches zero rows — RLS
//      itself blocks it, independent of any client-side gating.
//
// Needs a reachable Supabase instance (via .env / supabase/.env); starts
// `yarn dev` itself (and polls /api/health) on PORT if nothing is already
// serving there. Defaults to a non-3000 port so it doesn't collide with
// another agent's dev server (or the live production server) already
// bound to :3000.
// Usage: node scripts/db/verify-map-deletion.mjs
//        PORT=4513 node scripts/db/verify-map-deletion.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "4512";
const APP_URL = `http://localhost:${PORT}`;

// Fixed UUID from 0016_asset_library_presets.sql (Chest) — any real preset
// works here, this one is just a convenient existing fixture.
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
  const email = `map-deletion-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Map Deletion ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function waitUntil(condition, timeoutMs = 5000, pollMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let last = false;
  do {
    last = await condition();
    if (last) return true;
    await sleep(pollMs);
  } while (Date.now() < deadline);
  return last;
}

async function waitForTextIncludes(page, testid, substring, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await page.textContent(`[data-testid="${testid}"]`).catch(() => null);
    if (last?.includes(substring)) return true;
    await sleep(150);
  } while (Date.now() < deadline);
  console.error(`  (waitForTextIncludes timed out on ${testid} — last saw: ${JSON.stringify(last)})`);
  return false;
}

async function rowCount(table, column, value) {
  const { data, error } = await admin.from(table).select("*").eq(column, value);
  if (error) throw new Error(`querying ${table}.${column}=${value}: ${error.message}`);
  return data.length;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Map Deletion Test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  // Map A: the map that gets deleted — carries one row of every content
  // type the acceptance criteria calls out by name.
  const mapAId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapAId,
    campaign_id: campaignId,
    name: "Doomed Crypt",
    grid_width: 6,
    grid_height: 6,
  });

  // Map B: has its OWN transition leading INTO Map A — the cross-map
  // warning case. Its name must show up in the confirm dialog.
  const mapBId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapBId,
    campaign_id: campaignId,
    name: "Upper Ward",
    grid_width: 6,
    grid_height: 6,
  });

  // Map C: purely the target of Map A's own OUTGOING transition, so that
  // transition (A -> C) is distinguishable from B's incoming one (B -> A)
  // in the assertions below.
  const mapCId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapCId,
    campaign_id: campaignId,
    name: "Lower Catacombs",
    grid_width: 6,
    grid_height: 6,
  });

  // Map D: untouched by the delete flow — exists solely so the non-DM
  // enforcement check below has something real to attempt deleting.
  const mapDId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapDId,
    campaign_id: campaignId,
    name: "Guard Tower",
    grid_width: 4,
    grid_height: 4,
  });

  // Content on Map A: one row in every table the acceptance criteria names.
  await admin.from("map_cells").insert({ map_id: mapAId, x: 1, y: 1, elevation: 1, terrain_type: "normal" });
  await admin
    .from("map_objects")
    .insert({ map_id: mapAId, asset_id: CHEST_PRESET_ID, x: 2, y: 2, elevation: 0, rotation: 0 });
  await admin
    .from("map_tokens")
    .insert({ map_id: mapAId, npc_name: "Crypt Guardian", x: 3, y: 3, allegiance: "hostile" });
  await admin
    .from("light_sources")
    .insert({ map_id: mapAId, radius_feet: 20, brightness: "bright", x: 1, y: 1 });
  await admin.from("concealed_pits").insert({ map_id: mapAId, x: 4, y: 4, bottom_elevation_steps: -1 });
  // Same hex-bytea literal convention verify-whiteboard-drawing.mjs uses.
  await admin.from("map_whiteboard_tiles").insert({ map_id: mapAId, x: 0, y: 0, tile_png: "\\x89504e470d0a1a0a" });
  // Map A's own outgoing transition, to Map C.
  await admin
    .from("map_transitions")
    .insert({ from_map_id: mapAId, from_x: 5, from_y: 5, to_map_id: mapCId, to_x: 0, to_y: 0 });
  // Map B's transition INTO Map A — the cross-map warning fixture.
  await admin
    .from("map_transitions")
    .insert({ from_map_id: mapBId, from_x: 0, from_y: 0, to_map_id: mapAId, to_x: 1, to_y: 1 });

  // Thumbnail + reference-image Storage objects on Map A.
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const thumbPath = `${mapAId}/${crypto.randomUUID()}.png`;
  const { error: thumbUploadError } = await admin.storage
    .from("map-thumbnails")
    .upload(thumbPath, pngBytes, { contentType: "image/png" });
  if (thumbUploadError) throw new Error(`seeding thumbnail: ${thumbUploadError.message}`);
  const refPath = `${mapAId}/${crypto.randomUUID()}.png`;
  const { error: refUploadError } = await admin.storage
    .from("map-references")
    .upload(refPath, pngBytes, { contentType: "image/png" });
  if (refUploadError) throw new Error(`seeding reference image: ${refUploadError.message}`);
  await admin
    .from("campaign_maps")
    .update({
      thumbnail_ref: thumbPath,
      reference_image_ref: refPath,
      reference_image_x: 0,
      reference_image_y: 0,
      reference_image_scale: 1,
    })
    .eq("id", mapAId);

  // Map A is the campaign's current live map — the "deleting the live map"
  // scenario.
  await admin.from("campaigns").update({ live_map: mapAId }).eq("id", campaignId);

  // ── UI flow: the DM deletes Map A from the real maps list page. ──
  const dmContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const mapsPage = await dmContext.newPage();
  await mapsPage.goto(`${APP_URL}/campaigns/${campaignId}/maps`);
  await mapsPage.waitForSelector(`[data-testid="map-card-${mapAId}"]`, { timeout: 30000 });

  check("Map A's card is present before deletion", await isVisible(mapsPage, `map-card-${mapAId}`));

  await mapsPage.click(`[data-testid="delete-map-${mapAId}"]`);
  check(
    "clicking Delete opens a real confirmation dialog (not a bare browser confirm)",
    await waitUntil(() => isVisible(mapsPage, "delete-map-modal"))
  );

  check(
    "the confirm dialog names the OTHER map (Upper Ward) whose own transition leads into the map being deleted",
    await waitForTextIncludes(mapsPage, "delete-map-linked-warning", "Upper Ward")
  );
  check(
    "the confirm dialog states the deletion is permanent",
    await waitForTextIncludes(mapsPage, "delete-map-modal", "permanent")
  );

  const countBeforeConfirm = await rowCount("campaign_maps", "id", mapAId);
  check("opening the dialog and seeing the warning deletes nothing yet", countBeforeConfirm === 1);

  await mapsPage.click('[data-testid="confirm-delete-map"]');
  check(
    "Map A's card disappears from the list after confirming",
    await waitUntil(async () => !(await isVisible(mapsPage, `map-card-${mapAId}`)), 15000)
  );

  // ── Direct admin queries: everything on Map A is really gone. ──
  check("campaign_maps row for Map A is gone", (await rowCount("campaign_maps", "id", mapAId)) === 0);
  check("Map A's cells are gone", (await rowCount("map_cells", "map_id", mapAId)) === 0);
  check("Map A's objects are gone", (await rowCount("map_objects", "map_id", mapAId)) === 0);
  check("Map A's tokens are gone", (await rowCount("map_tokens", "map_id", mapAId)) === 0);
  check("Map A's light sources are gone", (await rowCount("light_sources", "map_id", mapAId)) === 0);
  check("Map A's concealed pits are gone", (await rowCount("concealed_pits", "map_id", mapAId)) === 0);
  check("Map A's whiteboard tiles are gone", (await rowCount("map_whiteboard_tiles", "map_id", mapAId)) === 0);
  check(
    "Map A's own outgoing transition (to Map C) is gone",
    (await rowCount("map_transitions", "from_map_id", mapAId)) === 0
  );
  check(
    "Map B's transition INTO Map A is genuinely gone — verified via a direct query on MAP B's own " +
      "transitions, not just that Map A itself is gone",
    (await rowCount("map_transitions", "from_map_id", mapBId)) === 0
  );
  // Maps B, C, D themselves must survive — this is a targeted delete, not a
  // campaign-wide wipe.
  check("Map B itself still exists", (await rowCount("campaign_maps", "id", mapBId)) === 1);
  check("Map C itself still exists", (await rowCount("campaign_maps", "id", mapCId)) === 1);
  check("Map D itself still exists", (await rowCount("campaign_maps", "id", mapDId)) === 1);

  const thumbList = await admin.storage.from("map-thumbnails").list(mapAId);
  check(
    "the thumbnail Storage file was removed",
    (thumbList.data ?? []).length === 0,
    JSON.stringify(thumbList.data)
  );
  const refList = await admin.storage.from("map-references").list(mapAId);
  check(
    "the reference-image Storage file was removed",
    (refList.data ?? []).length === 0,
    JSON.stringify(refList.data)
  );

  const { data: campaignAfterDelete } = await admin
    .from("campaigns")
    .select("live_map")
    .eq("id", campaignId)
    .maybeSingle();
  check(
    "the campaign's live map is now null (it was the deleted map)",
    campaignAfterDelete?.live_map === null,
    JSON.stringify(campaignAfterDelete)
  );

  // ── No crash anywhere reading the now-null live map. ──
  const roomPage = await dmContext.newPage();
  const roomResponse = await roomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  check("the Game Room page itself loads (200), not an error page", roomResponse?.status() === 200);
  await roomPage.waitForSelector('[data-testid="map-view-state"]', { state: "attached", timeout: 30000 });
  const mapViewState = JSON.parse((await roomPage.textContent('[data-testid="map-view-state"]')) ?? "{}");
  check(
    "the Game Room renders with no crash and reports no campaign default map",
    mapViewState.campaignDefaultMapId === null && mapViewState.viewingMapId === null,
    JSON.stringify(mapViewState)
  );

  // ── Non-DM enforcement: the whole /maps route is gated, AND a raw
  //     delete under the player's own session is blocked server-side. ──
  const playerContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await playerContext.addCookies(sessionCookies(player.session));
  const playerMapsPage = await playerContext.newPage();
  const playerMapsResponse = await playerMapsPage.goto(`${APP_URL}/campaigns/${campaignId}/maps`);
  check(
    "a non-DM member can't even reach the maps route (404) — stronger than a merely hidden button",
    playerMapsResponse?.status() === 404
  );

  const { error: playerDeleteError, count: playerDeleteCount } = await player.client
    .from("campaign_maps")
    .delete({ count: "exact" })
    .eq("id", mapDId);
  check(
    "a non-DM member's raw delete request (bypassing the UI entirely) matches ZERO rows — RLS itself " +
      "blocks it, not just client-side gating",
    playerDeleteCount === 0 && !playerDeleteError,
    JSON.stringify({ playerDeleteError, playerDeleteCount })
  );
  check("Map D still exists after the blocked non-DM delete attempt", (await rowCount("campaign_maps", "id", mapDId)) === 1);
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
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
console.log("\nAll map deletion checks passed.");
process.exit(0);
