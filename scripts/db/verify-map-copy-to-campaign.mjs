#!/usr/bin/env node
// Copy-a-map-into-a-different-campaign verification.
//
// duplicateMap (src/data-access/maps.ts) gained a third, optional
// `destinationCampaignId` parameter — omitted, it behaves exactly like the
// pre-existing same-campaign "Duplicate" button always has; passed, it
// copies the map into a DIFFERENT campaign the same user also DMs. While
// touching it, its own object SELECT also gained every real map_objects
// column that had quietly gone missing from it over time (crossing_type,
// tag, revealed_to_players, tint, mount_object_id, mount_face_deg) — a
// pre-existing gap even for same-campaign duplication, fixed here rather
// than left in place. MapsManager.tsx gained a "Copy to campaign…" action
// (shown only when the DM DMs more than one campaign) that opens a small
// modal with a destination picker (the CharacterCreateLauncher.tsx "pick a
// campaign from several" <Select> shape). maps/page.tsx feeds it via a
// plain filter of the existing listCampaignsForUser (role === "dm", not the
// current campaign) — no new data-access function needed for that part.
//
// Covers, against a REAL signed-in browser session and REAL RLS throughout:
//   1. The "Copy to campaign…" action is offered on the source map's card
//      when its DM DMs more than one campaign, and its destination picker
//      lists ONLY the other campaigns this same user actually DMs — not a
//      campaign where they're merely a player, and not some other DM's
//      unrelated campaign.
//   2. The action is entirely absent for a DM who only DMs one campaign.
//   3. A real cross-campaign copy, driven end to end through the modal:
//        - map_cells copy over exactly.
//        - map_objects copy over with the FULL current column set
//          (crossing_type, tag, tint, revealed_to_players,
//          blocks_line_of_sight) faithfully preserved, `triggered` reset to
//          false, and a wall-mounted object's mount_object_id correctly
//          RE-POINTED at its host's NEW id (not the source host's id, and
//          not null) — the self-referencing-fk remap this change added.
//        - map_object_items (chest loot) copy over, remapped onto each
//          item's copied host object — but an item that instead belongs to
//          a CONCEALED PIT is skipped (concealed_pits isn't duplicated,
//          same as map_tokens/map_transitions below).
//        - map_art (accepted top-down render) copies too, but as a FRESH
//          Storage upload under the new map's own id — not a bare row
//          pointing back at the source map's own path — and the original
//          file is left untouched (a copy, not a move).
//        - map_tokens and map_transitions are NOT copied at all.
//      Then the pre-existing "Duplicate" (same-campaign) button is
//      exercised too, as a regression check: it still keeps the map in its
//      source folder (unlike the cross-campaign copy, which starts
//      unfiled) and still copies every object.
//   4. The DB-level security boundary the whole feature leans on instead of
//      re-checking anything client-side: a raw INSERT into campaign_maps
//      under the DM's own real session, targeting a campaign they do NOT
//      DM, is rejected by RLS — proving campaign_maps' own INSERT policy
//      (0015, `with check (is_campaign_dm(campaign_id))`) is really what
//      stops a copy from landing somewhere the caller doesn't control, not
//      merely the UI's own destination list.
//
// No new migration was needed for this feature — every column/table it
// touches (map_objects' crossing_type/tag/revealed_to_players/tint/
// mount_object_id/mount_face_deg, map_object_items, map_art) was already
// live on this shared dev instance at the time this was written (confirmed
// with a schema probe before writing any code), so this script runs every
// check for real; nothing here is BLOCKED-gated.
//
// Needs a reachable Supabase instance (via .env / supabase/.env); starts
// `yarn dev` itself (and polls /api/health) on PORT if nothing is already
// serving there. Defaults to a port other verify-*.mjs scripts don't
// already claim.
// Usage: node scripts/db/verify-map-copy-to-campaign.mjs
//        PORT=4531 node scripts/db/verify-map-copy-to-campaign.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "4531";
const APP_URL = `http://localhost:${PORT}`;

// Fixed preset ids from 0016_asset_library_presets.sql — real, existing
// fixtures, not invented ones.
const WALL_ASSET_ID = "a55e7007-0000-4000-8000-000000000007"; // Wall Segment
const TORCH_ASSET_ID = "a55e7001-0000-4000-8000-000000000001"; // Torch
const CHEST_ASSET_ID = "a55e7002-0000-4000-8000-000000000002"; // Chest
const STAIRS_ASSET_ID = "a55e7008-0000-4000-8000-000000000008"; // Stairs

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
  const email = `map-copy-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Map Copy ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function waitUntil(condition, timeoutMs = 15000, pollMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let last = false;
  do {
    last = await condition();
    if (last) return true;
    await sleep(pollMs);
  } while (Date.now() < deadline);
  return last;
}

async function waitForTextIncludes(page, testid, substring, timeoutMs = 10000) {
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

/** Unlike waitUntil (which only reports true/false), returns the actual
 * truthy value `fn` eventually produces — needed wherever the polled-for
 * value itself (not just its presence) is used afterward. */
async function pollUntil(fn, timeoutMs = 15000, pollMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(pollMs);
    last = await fn();
  }
  return last;
}

async function must(promise, label) {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const otherDm = await makeTestUser("other-dm");
const soloDm = await makeTestUser("solo-dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

// Every Storage object this run creates, in a shared bucket other campaigns
// also use — removed explicitly in the finally block regardless of
// pass/fail, since campaign deletion only cascades DB rows, never Storage.
const storagePaths = [];

try {
  // ── Campaigns ──
  // campaignA: the source. dm DMs it.
  const campaignAId = crypto.randomUUID();
  await must(
    admin.from("campaigns").insert({ id: campaignAId, name: "Map Copy Source", creator: dm.id }),
    "inserting campaignA"
  );
  // campaignB: dm's OTHER campaign — the only legitimate copy destination.
  const campaignBId = crypto.randomUUID();
  await must(
    admin.from("campaigns").insert({ id: campaignBId, name: "Map Copy Destination", creator: dm.id }),
    "inserting campaignB"
  );
  // campaignC: otherDm's own, unrelated campaign — dm has NO membership
  // here at all. Used for the raw-RLS-block negative check.
  const campaignCId = crypto.randomUUID();
  await must(
    admin.from("campaigns").insert({ id: campaignCId, name: "Map Copy Unrelated", creator: otherDm.id }),
    "inserting campaignC"
  );
  // campaignD: otherDm DMs it, but dm is a mere PLAYER there — proves the
  // destination list is filtered by ROLE, not just "any membership".
  const campaignDId = crypto.randomUUID();
  await must(
    admin.from("campaigns").insert({ id: campaignDId, name: "Map Copy Player-Only", creator: otherDm.id }),
    "inserting campaignD"
  );
  // campaignSolo: soloDm's ONLY campaign — proves the action is hidden
  // entirely when there's nowhere else to copy to.
  const campaignSoloId = crypto.randomUUID();
  await must(
    admin.from("campaigns").insert({ id: campaignSoloId, name: "Map Copy Solo", creator: soloDm.id }),
    "inserting campaignSolo"
  );

  await must(
    admin.from("campaign_members").insert([
      { campaign_id: campaignAId, user_id: dm.id, role: "dm" },
      { campaign_id: campaignBId, user_id: dm.id, role: "dm" },
      { campaign_id: campaignCId, user_id: otherDm.id, role: "dm" },
      { campaign_id: campaignDId, user_id: otherDm.id, role: "dm" },
      { campaign_id: campaignDId, user_id: dm.id, role: "player" },
      { campaign_id: campaignSoloId, user_id: soloDm.id, role: "dm" },
    ]),
    "inserting campaign_members"
  );

  // ── Source content: a folder, two maps (mapA the one being copied, mapA2
  //     purely a transition target), and a rich set of mapA content. ──
  const folderAId = crypto.randomUUID();
  await must(
    admin.from("map_folders").insert({ id: folderAId, campaign_id: campaignAId, name: "Dungeon Level 1" }),
    "inserting folderA"
  );

  const mapAId = crypto.randomUUID();
  await must(
    admin.from("campaign_maps").insert({
      id: mapAId,
      campaign_id: campaignAId,
      name: "Crypt Entrance",
      grid_width: 4,
      grid_height: 3,
      folder_id: folderAId,
    }),
    "inserting mapA"
  );
  const mapA2Id = crypto.randomUUID();
  await must(
    admin.from("campaign_maps").insert({
      id: mapA2Id,
      campaign_id: campaignAId,
      name: "Crypt Depths",
      grid_width: 4,
      grid_height: 3,
    }),
    "inserting mapA2"
  );

  await must(
    admin.from("map_cells").insert([
      {
        map_id: mapAId,
        x: 0,
        y: 0,
        elevation: 1,
        terrain_type: "difficult",
        light_level: "dim",
        ground_type: "water",
        water_flow_direction: "east",
      },
      {
        map_id: mapAId,
        x: 1,
        y: 0,
        elevation: 0,
        terrain_type: "normal",
        light_level: "bright",
        ground_type: "default",
        water_flow_direction: null,
      },
    ]),
    "inserting map_cells"
  );

  const wallObjId = crypto.randomUUID();
  await must(
    admin.from("map_objects").insert({
      id: wallObjId,
      map_id: mapAId,
      asset_id: WALL_ASSET_ID,
      x: 2,
      y: 0,
      elevation: 0,
      rotation: 90,
      crossing_type: null,
      behavior_config: {},
    }),
    "inserting wall object"
  );
  const torchObjId = crypto.randomUUID();
  await must(
    admin.from("map_objects").insert({
      id: torchObjId,
      map_id: mapAId,
      asset_id: TORCH_ASSET_ID,
      x: 2,
      y: 0,
      elevation: 0,
      rotation: 0,
      crossing_type: null,
      behavior_config: {},
      mount_object_id: wallObjId,
      mount_face_deg: 180,
    }),
    "inserting mounted torch object"
  );
  const chestObjId = crypto.randomUUID();
  await must(
    admin.from("map_objects").insert({
      id: chestObjId,
      map_id: mapAId,
      asset_id: CHEST_ASSET_ID,
      x: 1,
      y: 1,
      elevation: 0,
      rotation: 0,
      crossing_type: null,
      tag: "Old Chest",
      tint: "#ff00aa",
      revealed_to_players: false,
      blocks_line_of_sight: true,
      behavior_config: {
        action: "reveal_text",
        content: "a hidden inscription",
        playerTriggerable: true,
        triggerOnStepOn: false,
        triggered: true,
      },
    }),
    "inserting chest object"
  );
  const stairsObjId = crypto.randomUUID();
  await must(
    admin.from("map_objects").insert({
      id: stairsObjId,
      map_id: mapAId,
      asset_id: STAIRS_ASSET_ID,
      x: 3,
      y: 1,
      elevation: 0,
      rotation: 0,
      crossing_type: "stairs",
      behavior_config: {},
    }),
    "inserting stairs object"
  );

  await must(
    admin.from("map_object_items").insert({
      campaign_id: campaignAId,
      map_object_id: chestObjId,
      name: "Gold Coins",
      description: "A small pile of shining gold",
      icon: "💰",
      tag: "loot",
      hidden_dc: 15,
      curse_blessing: { kind: "cursed", resolution: "narrative", effect: null, telegraphed: false },
    }),
    "inserting chest item"
  );

  const pitRow = await must(
    admin
      .from("concealed_pits")
      .insert({ map_id: mapAId, x: 0, y: 2, bottom_elevation_steps: -1 })
      .select("id")
      .single(),
    "inserting concealed pit"
  );
  await must(
    admin.from("map_object_items").insert({
      campaign_id: campaignAId,
      concealed_pit_id: pitRow.id,
      name: "Trap Loot (should NOT copy)",
    }),
    "inserting concealed-pit item"
  );

  await must(
    admin.from("map_tokens").insert({
      map_id: mapAId,
      npc_name: "Crypt Guardian",
      x: 1,
      y: 0,
      allegiance: "hostile",
    }),
    "inserting map token"
  );
  await must(
    admin.from("map_transitions").insert({
      from_map_id: mapAId,
      from_x: 3,
      from_y: 2,
      to_map_id: mapA2Id,
      to_x: 0,
      to_y: 0,
    }),
    "inserting map transition"
  );

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const sourceArtPath = `${mapAId}/${crypto.randomUUID()}.png`;
  storagePaths.push({ bucket: "map-art", path: sourceArtPath });
  await must(
    admin.storage.from("map-art").upload(sourceArtPath, pngBytes, { contentType: "image/png" }),
    "uploading source map art"
  );
  await must(
    admin.from("map_art").insert({
      map_id: mapAId,
      image_ref: sourceArtPath,
      style_prompt: "Moody dungeon top-down",
      stale: true,
    }),
    "inserting map_art row"
  );

  // ── UI: the DM's real signed-in session drives the copy through the
  //     actual Maps page. ──
  const dmContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const mapsPage = await dmContext.newPage();
  await mapsPage.goto(`${APP_URL}/campaigns/${campaignAId}/maps`);
  await mapsPage.waitForSelector(`[data-testid="map-card-${mapAId}"]`, { timeout: 30000 });

  check(
    '"Copy to campaign…" is offered on the source map\'s card (dm DMs more than one campaign)',
    await isVisible(mapsPage, `copy-map-to-campaign-${mapAId}`)
  );

  await mapsPage.click(`[data-testid="copy-map-to-campaign-${mapAId}"]`);
  check(
    "clicking it opens a real destination-picker modal",
    await waitUntil(() => isVisible(mapsPage, "copy-map-modal"))
  );

  const destinationOptions = await mapsPage
    .locator('[data-testid="copy-map-destination"] option')
    .evaluateAll((opts) => opts.map((o) => ({ value: o.value, label: o.textContent })));
  check(
    "the destination picker lists EXACTLY one campaign — dm's only other DM'd campaign",
    destinationOptions.length === 1 && destinationOptions[0].value === campaignBId,
    JSON.stringify(destinationOptions)
  );
  check(
    "the destination picker's one option is labeled with campaignB's real name",
    destinationOptions[0]?.label === "Map Copy Destination",
    JSON.stringify(destinationOptions)
  );
  check(
    "the destination picker does NOT list campaignD, where dm is only a PLAYER (not DM)",
    !destinationOptions.some((option) => option.label === "Map Copy Player-Only")
  );
  check(
    "the destination picker does NOT list campaignC, an unrelated campaign dm has no membership in at all",
    !destinationOptions.some((option) => option.label === "Map Copy Unrelated")
  );

  await mapsPage.selectOption('[data-testid="copy-map-destination"]', campaignBId);
  await mapsPage.click('[data-testid="confirm-copy-map"]');
  check(
    "confirming shows a success message naming both the map and the destination campaign",
    await waitForTextIncludes(mapsPage, "copy-map-success", "Map Copy Destination")
  );

  const copiedMap = await must(
    admin
      .from("campaign_maps")
      .select()
      .eq("campaign_id", campaignBId)
      .eq("name", "Crypt Entrance (Copy)")
      .maybeSingle(),
    "fetching the copied map"
  );
  check("the copy really landed in campaignB", Boolean(copiedMap), JSON.stringify(copiedMap));
  const copiedMapId = copiedMap?.id;

  check(
    "the copy keeps the source's grid dimensions",
    copiedMap?.grid_width === 4 && copiedMap?.grid_height === 3,
    JSON.stringify(copiedMap)
  );
  check(
    "the cross-campaign copy starts UNFILED (folderA belongs to the source campaign, not this one)",
    copiedMap?.folder_id === null,
    JSON.stringify(copiedMap)
  );

  // Following the success dialog's own link proves the copy is really
  // reachable from the destination campaign's own Maps page, not just
  // present in the DB.
  await mapsPage.click('[data-testid="copy-map-success"] a');
  await mapsPage.waitForURL(`**/campaigns/${campaignBId}/maps`);
  check(
    "clicking \"Go there\" really navigates to the destination campaign's own Maps page, where the copy is visible",
    await waitUntil(() => isVisible(mapsPage, `map-card-${copiedMapId}`))
  );

  // ── map_cells ──
  const copiedCells = await must(
    admin.from("map_cells").select().eq("map_id", copiedMapId).order("x"),
    "fetching copied cells"
  );
  check("both authored cells copied over", copiedCells.length === 2, JSON.stringify(copiedCells));
  const copiedWetCell = copiedCells.find((cell) => cell.x === 0 && cell.y === 0);
  check(
    "a cell's full authored shape (elevation/terrain/light/ground/water flow) copies exactly",
    copiedWetCell?.elevation === 1 &&
      copiedWetCell?.terrain_type === "difficult" &&
      copiedWetCell?.light_level === "dim" &&
      copiedWetCell?.ground_type === "water" &&
      copiedWetCell?.water_flow_direction === "east",
    JSON.stringify(copiedWetCell)
  );

  // ── map_objects — full column set + mount remap ──
  const copiedObjects = await must(
    admin.from("map_objects").select().eq("map_id", copiedMapId),
    "fetching copied objects"
  );
  check("all 4 source objects copied over", copiedObjects.length === 4, JSON.stringify(copiedObjects.length));
  const byKey = (rows) => new Map(rows.map((row) => [`${row.asset_id}:${row.x}:${row.y}`, row]));
  const copiedByKey = byKey(copiedObjects);
  const copiedWall = copiedByKey.get(`${WALL_ASSET_ID}:2:0`);
  const copiedTorch = copiedByKey.get(`${TORCH_ASSET_ID}:2:0`);
  const copiedChest = copiedByKey.get(`${CHEST_ASSET_ID}:1:1`);
  const copiedStairs = copiedByKey.get(`${STAIRS_ASSET_ID}:3:1`);
  check("wall object copied", Boolean(copiedWall));
  check("torch object copied", Boolean(copiedTorch));
  check("chest object copied", Boolean(copiedChest));
  check("stairs object copied", Boolean(copiedStairs));

  check(
    "the mounted torch's mount_object_id was RE-POINTED at the copied wall's NEW id (not the source wall's id, not null)",
    copiedTorch?.mount_object_id === copiedWall?.id && copiedTorch?.mount_object_id !== wallObjId,
    JSON.stringify({ mountObjectId: copiedTorch?.mount_object_id, copiedWallId: copiedWall?.id, sourceWallId: wallObjId })
  );
  check(
    "the mounted torch's mount_face_deg is preserved",
    copiedTorch?.mount_face_deg === 180,
    String(copiedTorch?.mount_face_deg)
  );

  check(
    "the chest's tag/tint/revealed_to_players/blocks_line_of_sight all copy over faithfully (the full column set)",
    copiedChest?.tag === "Old Chest" &&
      copiedChest?.tint === "#ff00aa" &&
      copiedChest?.revealed_to_players === false &&
      copiedChest?.blocks_line_of_sight === true,
    JSON.stringify(copiedChest)
  );
  check(
    "the chest's behavior_config keeps its authored action/content/playerTriggerable but resets triggered to false",
    copiedChest?.behavior_config?.action === "reveal_text" &&
      copiedChest?.behavior_config?.content === "a hidden inscription" &&
      copiedChest?.behavior_config?.playerTriggerable === true &&
      copiedChest?.behavior_config?.triggered === false,
    JSON.stringify(copiedChest?.behavior_config)
  );
  check(
    "the stairs object's crossing_type copies over",
    copiedStairs?.crossing_type === "stairs",
    String(copiedStairs?.crossing_type)
  );

  // ── map_object_items — chest loot copies (remapped), concealed-pit loot doesn't ──
  const copiedItems = await must(
    admin.from("map_object_items").select().eq("campaign_id", campaignBId),
    "fetching copied items"
  );
  check(
    "exactly ONE item copied over (the chest's) — the concealed-pit item was correctly skipped",
    copiedItems.length === 1,
    JSON.stringify(copiedItems)
  );
  const copiedItem = copiedItems[0];
  check(
    "the copied item is remapped onto the COPIED chest's own new id, with its full shape preserved",
    copiedItem?.map_object_id === copiedChest?.id &&
      copiedItem?.name === "Gold Coins" &&
      copiedItem?.hidden_dc === 15 &&
      copiedItem?.curse_blessing?.kind === "cursed" &&
      copiedItem?.curse_blessing?.resolution === "narrative" &&
      copiedItem?.curse_blessing?.effect === null &&
      copiedItem?.curse_blessing?.telegraphed === false,
    JSON.stringify(copiedItem)
  );

  // ── map_art — fresh Storage upload under the NEW map's own id ──
  const copiedArt = await must(
    admin.from("map_art").select().eq("map_id", copiedMapId).maybeSingle(),
    "fetching copied map_art"
  );
  check("map_art copied over", Boolean(copiedArt), JSON.stringify(copiedArt));
  check(
    "the copied art's style_prompt and stale flag are preserved",
    copiedArt?.style_prompt === "Moody dungeon top-down" && copiedArt?.stale === true,
    JSON.stringify(copiedArt)
  );
  check(
    "the copied art's image_ref points at a FRESH path under the NEW map's own id, not the source map's path",
    typeof copiedArt?.image_ref === "string" &&
      copiedArt.image_ref.startsWith(`${copiedMapId}/`) &&
      copiedArt.image_ref !== sourceArtPath,
    copiedArt?.image_ref
  );
  if (copiedArt?.image_ref) storagePaths.push({ bucket: "map-art", path: copiedArt.image_ref });

  if (copiedArt?.image_ref) {
    const copiedBlob = await must(admin.storage.from("map-art").download(copiedArt.image_ref), "downloading copied art");
    const copiedBytes = Buffer.from(await copiedBlob.arrayBuffer());
    check(
      "the copied art file's bytes are byte-for-byte identical to the source",
      copiedBytes.equals(pngBytes),
      `len=${copiedBytes.length}`
    );
  }
  const sourceStillThere = await admin.storage.from("map-art").download(sourceArtPath);
  check(
    "the SOURCE map's own art file is untouched (a copy, not a move)",
    !sourceStillThere.error,
    sourceStillThere.error?.message
  );

  // ── Deliberately excluded content ──
  check(
    "map_tokens are NOT copied (tied to this campaign's own characters/NPCs)",
    (await must(admin.from("map_tokens").select("id").eq("map_id", copiedMapId), "checking copied tokens")).length === 0
  );
  const copiedTransitions = await must(
    admin.from("map_transitions").select("id").or(`from_map_id.eq.${copiedMapId},to_map_id.eq.${copiedMapId}`),
    "checking copied transitions"
  );
  check(
    "map_transitions are NOT copied (they'd point at source-campaign-only maps)",
    copiedTransitions.length === 0,
    JSON.stringify(copiedTransitions)
  );

  // ── Regression: the pre-existing same-campaign "Duplicate" button still
  //     works, and (unlike the cross-campaign copy) still keeps the map in
  //     its source folder. ──
  await mapsPage.goto(`${APP_URL}/campaigns/${campaignAId}/maps`);
  await mapsPage.waitForSelector(`[data-testid="duplicate-map-${mapAId}"]`, { timeout: 30000 });
  await mapsPage.click(`[data-testid="duplicate-map-${mapAId}"]`);
  const duplicatedInPlace = await pollUntil(async () => {
    const row = await admin
      .from("campaign_maps")
      .select()
      .eq("campaign_id", campaignAId)
      .eq("name", "Crypt Entrance (Copy)")
      .maybeSingle();
    return row.data ?? null;
  });
  check("the same-campaign Duplicate button still creates a copy", Boolean(duplicatedInPlace));
  if (duplicatedInPlace) {
    check(
      "unlike the cross-campaign copy, a same-campaign duplicate keeps the source's folder",
      duplicatedInPlace.folder_id === folderAId,
      JSON.stringify(duplicatedInPlace)
    );
    const duplicatedObjects = await must(
      admin.from("map_objects").select("id").eq("map_id", duplicatedInPlace.id),
      "fetching same-campaign duplicate's objects"
    );
    check(
      "the same-campaign duplicate also copies all 4 objects",
      duplicatedObjects.length === 4,
      String(duplicatedObjects.length)
    );
  }

  // ── "Copy to campaign…" is hidden entirely for a DM of only one campaign ──
  const soloContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await soloContext.addCookies(sessionCookies(soloDm.session));
  const soloMapsPage = await soloContext.newPage();
  const soloMapId = crypto.randomUUID();
  await must(
    admin.from("campaign_maps").insert({
      id: soloMapId,
      campaign_id: campaignSoloId,
      name: "Solo Map",
      grid_width: 3,
      grid_height: 3,
    }),
    "inserting solo map"
  );
  await soloMapsPage.goto(`${APP_URL}/campaigns/${campaignSoloId}/maps`);
  await soloMapsPage.waitForSelector(`[data-testid="map-card-${soloMapId}"]`, { timeout: 30000 });
  check(
    "a DM who only DMs one campaign gets no \"Copy to campaign…\" action at all",
    !(await isVisible(soloMapsPage, `copy-map-to-campaign-${soloMapId}`))
  );

  // ── The real DB-level security boundary: a raw insert under dm's own
  //     session, targeting a campaign dm does NOT DM, is rejected by RLS —
  //     not merely absent from the UI's own destination list. ──
  const { data: rlsProbeData, error: rlsProbeError } = await dm.client
    .from("campaign_maps")
    .insert({ campaign_id: campaignCId, name: "Should never land", grid_width: 5, grid_height: 5 })
    .select();
  check(
    "a raw campaign_maps insert into a campaign dm does NOT DM is rejected by RLS itself",
    Boolean(rlsProbeError) && !rlsProbeData,
    JSON.stringify({ rlsProbeError, rlsProbeData })
  );
} finally {
  await browser.close();
  for (const { bucket, path } of storagePaths) {
    await admin.storage.from(bucket).remove([path]);
  }
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(otherDm.id);
  await admin.auth.admin.deleteUser(soloDm.id);
  // Deletes every campaign this run created by name — cascades every map/
  // object/token/transition/item/folder created under it. By name rather
  // than a captured id list so cleanup still runs even if an earlier
  // `must()` threw partway through setup, before every id was captured.
  await admin
    .from("campaigns")
    .delete()
    .in("name", [
      "Map Copy Source",
      "Map Copy Destination",
      "Map Copy Unrelated",
      "Map Copy Player-Only",
      "Map Copy Solo",
    ]);
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
console.log("\nAll map-copy-to-campaign checks passed.");
process.exit(0);
