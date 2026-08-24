#!/usr/bin/env node
// Map and asset data model verification (Prompt 23 acceptance criteria).
//
// Builds a 10x10 test map with a couple of elevation steps and one placed
// object referencing a placeholder asset, then checks: the DM can read/
// write every map in their campaign, a member can read only the live map
// (not a non-live one), and a non-member can read nothing.
//
// Usage: node scripts/db/verify-maps.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
function check(label, condition) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failures++;
  }
}

async function makeTestUser(label) {
  const email = `maps-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Maps Test ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client };
}

const dm = await makeTestUser("dm");
const member = await makeTestUser("member");
const stranger = await makeTestUser("stranger");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Maps test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: member.id, role: "player" },
  ]);

  // A 10x10 test map with a couple of elevation steps.
  const liveMapId = crypto.randomUUID();
  const { error: liveMapInsertError } = await dm.client.from("campaign_maps").insert({
    id: liveMapId,
    campaign_id: campaignId,
    name: "The Live Map",
    grid_width: 10,
    grid_height: 10,
  });
  check("DM can create a 10x10 map", !liveMapInsertError);

  const cells = [];
  for (let x = 0; x < 10; x++) {
    for (let y = 0; y < 10; y++) {
      cells.push({
        map_id: liveMapId,
        x,
        y,
        elevation: x < 3 ? 0 : x < 7 ? 1 : 2,
        terrain_type: y === 5 ? "difficult" : "normal",
      });
    }
  }
  const { error: cellsError } = await dm.client.from("map_cells").insert(cells);
  check("DM can populate all 100 cells with elevation steps and terrain", !cellsError);

  const { data: elevationCheck } = await admin
    .from("map_cells")
    .select("elevation")
    .eq("map_id", liveMapId)
    .eq("x", 8)
    .eq("y", 0)
    .single();
  check("a couple of distinct elevation steps are present", elevationCheck.elevation === 2);

  // A placeholder preset asset (global) and a placed object referencing it.
  const assetId = crypto.randomUUID();
  const { error: assetError } = await admin.from("asset_library").insert({
    id: assetId,
    name: "Placeholder Crate",
    source_type: "preset",
    model_ref: "/assets/presets/crate.glb",
  });
  check("a preset (global) asset can be seeded", !assetError);

  const { error: objectError } = await dm.client.from("map_objects").insert({
    map_id: liveMapId,
    asset_id: assetId,
    x: 4,
    y: 4,
    elevation: 1,
    rotation: 90,
    behavior_config: { locked: false },
  });
  check("DM can place an object referencing the asset", !objectError);

  // A second, non-live map in the same campaign.
  const otherMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: otherMapId,
    campaign_id: campaignId,
    name: "A Different Map",
    grid_width: 5,
    grid_height: 5,
  });

  // Before live_map is set: member can't read either map yet.
  const { data: memberMapsBeforeLive } = await member.client.from("campaign_maps").select().eq("campaign_id", campaignId);
  check("before live_map is set, a member reads no maps", (memberMapsBeforeLive ?? []).length === 0);

  await admin.from("campaigns").update({ live_map: liveMapId }).eq("id", campaignId);

  // DM can read/write every map.
  const { data: dmMaps } = await dm.client.from("campaign_maps").select().eq("campaign_id", campaignId);
  check("DM can read every map in their campaign", (dmMaps ?? []).length === 2);

  const { error: dmRenameError } = await dm.client
    .from("campaign_maps")
    .update({ name: "Renamed by DM" })
    .eq("id", otherMapId);
  check("DM can write the non-live map too", !dmRenameError);

  // Member can read only the live map.
  const { data: memberMaps } = await member.client.from("campaign_maps").select().eq("campaign_id", campaignId);
  check("member reads exactly one map (the live one)", (memberMaps ?? []).length === 1 && memberMaps[0].id === liveMapId);

  const { data: memberCells } = await member.client.from("map_cells").select("x, y").eq("map_id", liveMapId);
  check("member can read the live map's cells", (memberCells ?? []).length === 100);

  const { data: memberOtherCells } = await member.client
    .from("map_cells")
    .select("x, y")
    .eq("map_id", otherMapId);
  check("member cannot read the non-live map's cells", (memberOtherCells ?? []).length === 0);

  const { data: memberObjects } = await member.client.from("map_objects").select().eq("map_id", liveMapId);
  check("member can read the live map's placed object", (memberObjects ?? []).length === 1);

  const { error: memberWriteError, count: memberWriteCount } = await member.client
    .from("map_cells")
    .update({ terrain_type: "difficult" })
    .eq("map_id", liveMapId)
    .eq("x", 0)
    .eq("y", 0)
    .select("map_id", { count: "exact" });
  check("member cannot write to the live map's cells", !memberWriteError && (memberWriteCount ?? 0) === 0);

  // Non-member can read nothing.
  const { data: strangerMaps } = await stranger.client.from("campaign_maps").select().eq("campaign_id", campaignId);
  check("non-member reads no maps at all", (strangerMaps ?? []).length === 0);

  const { data: strangerCells } = await stranger.client.from("map_cells").select("x").eq("map_id", liveMapId);
  check("non-member reads no cells", (strangerCells ?? []).length === 0);

  const { data: strangerObjects } = await stranger.client.from("map_objects").select().eq("map_id", liveMapId);
  check("non-member reads no objects", (strangerObjects ?? []).length === 0);

  // Custom asset scoping.
  const customAssetId = crypto.randomUUID();
  const { error: customAssetError } = await dm.client.from("asset_library").insert({
    id: customAssetId,
    name: "Campaign-Specific Statue",
    source_type: "custom",
    model_ref: `${campaignId}/statue.glb`,
    campaign_id: campaignId,
  });
  check("DM can add a custom asset scoped to their campaign", !customAssetError);

  const { data: memberCustomAssets } = await member.client.from("asset_library").select().eq("id", customAssetId);
  check("a fellow member can read the campaign's custom asset", (memberCustomAssets ?? []).length === 1);

  const { data: strangerCustomAssets } = await stranger.client.from("asset_library").select().eq("id", customAssetId);
  check("a non-member cannot read the campaign's custom asset", (strangerCustomAssets ?? []).length === 0);

  const { data: presetAssets } = await stranger.client.from("asset_library").select().eq("id", assetId);
  check("presets are readable by any authenticated user, even a non-member", (presetAssets ?? []).length === 1);

  const { error: badPresetInsertError } = await dm.client
    .from("asset_library")
    .insert({ name: "Sneaky preset", source_type: "preset", model_ref: "/x.glb" });
  check("a regular user cannot insert a preset asset via RLS", !!badPresetInsertError);

  // Cascade delete: removing the campaign removes its maps/cells/objects.
  await admin.from("campaigns").delete().eq("id", campaignId);
  const { data: mapsAfterDelete } = await admin.from("campaign_maps").select("id").eq("campaign_id", campaignId);
  const { data: cellsAfterDelete } = await admin.from("map_cells").select("map_id").eq("map_id", liveMapId);
  const { data: objectsAfterDelete } = await admin.from("map_objects").select("id").eq("map_id", liveMapId);
  const { data: customAssetsAfterDelete } = await admin.from("asset_library").select("id").eq("id", customAssetId);
  check("cascade delete removes campaign_maps", (mapsAfterDelete ?? []).length === 0);
  check("cascade delete removes map_cells", (cellsAfterDelete ?? []).length === 0);
  check("cascade delete removes map_objects", (objectsAfterDelete ?? []).length === 0);
  check("cascade delete removes the campaign's custom assets", (customAssetsAfterDelete ?? []).length === 0);

  // Cleanup the global preset asset (not campaign-scoped, survives the cascade).
  await admin.from("asset_library").delete().eq("id", assetId);
} finally {
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(member.id);
  await admin.auth.admin.deleteUser(stranger.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll map and asset data model checks passed.");
