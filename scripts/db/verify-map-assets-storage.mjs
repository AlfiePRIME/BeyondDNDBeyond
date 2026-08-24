#!/usr/bin/env node
// Map-asset storage verification (Prompt 25). The map-assets bucket's access
// model: campaign members can read their campaign's assets, only the
// campaign's current DM can write under its {campaign_id}/ prefix — and the
// bucket itself enforces the size and MIME limits server-side. Also checks
// that asset_library custom rows stay campaign-isolated end to end.
//
// Usage: node scripts/db/verify-map-assets-storage.mjs

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
  const email = `map-assets-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Map Assets ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client };
}

async function makeCampaign(name, dmId, memberIds = []) {
  const { data, error } = await admin.from("campaigns").insert({ name, creator: dmId }).select().single();
  if (error) throw new Error(`creating campaign ${name}: ${error.message}`);
  const rows = [
    { campaign_id: data.id, user_id: dmId, role: "dm" },
    ...memberIds.map((userId) => ({ campaign_id: data.id, user_id: userId, role: "player" })),
  ];
  const { error: memberError } = await admin.from("campaign_members").insert(rows);
  if (memberError) throw new Error(`adding members to ${name}: ${memberError.message}`);
  return data.id;
}

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const otherDm = await makeTestUser("other-dm");

const campaignId = await makeCampaign("Map Assets Verify A", dm.id, [player.id]);
const otherCampaignId = await makeCampaign("Map Assets Verify B", otherDm.id);

const glb = readFileSync(join(rootDir, "public", "assets", "presets", "chest.glb"));
const uploadOpts = { contentType: "model/gltf-binary", upsert: true };
const path = `${campaignId}/crate.glb`;

try {
  const { error: uploadError } = await dm.client.storage.from("map-assets").upload(path, glb, uploadOpts);
  check("the campaign's DM can upload under the campaign path", !uploadError);

  const { error: replaceError } = await dm.client.storage.from("map-assets").upload(path, glb, uploadOpts);
  check("the DM can replace an existing asset", !replaceError);

  const { data: downloaded, error: downloadError } = await player.client.storage.from("map-assets").download(path);
  const downloadedSize = downloaded ? (await downloaded.arrayBuffer()).byteLength : 0;
  check("a campaign member can download it intact", !downloadError && downloadedSize === glb.length);

  const { error: playerWriteError } = await player.client.storage
    .from("map-assets")
    .upload(`${campaignId}/player.glb`, glb, uploadOpts);
  check("a non-DM member cannot upload", !!playerWriteError);

  const { error: crossWriteError } = await otherDm.client.storage
    .from("map-assets")
    .upload(`${campaignId}/intruder.glb`, glb, uploadOpts);
  check("another campaign's DM cannot upload under this campaign's path", !!crossWriteError);

  const { error: crossReadError } = await otherDm.client.storage.from("map-assets").download(path);
  check("a non-member cannot download this campaign's assets", !!crossReadError);

  const { error: mimeError } = await dm.client.storage
    .from("map-assets")
    .upload(`${campaignId}/notes.txt`, Buffer.from("hello"), { contentType: "text/plain" });
  check("the bucket rejects non-glTF MIME types", !!mimeError);

  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1024);
  glb.copy(oversized);
  const { error: sizeError } = await dm.client.storage
    .from("map-assets")
    .upload(`${campaignId}/huge.glb`, oversized, uploadOpts);
  check("the bucket rejects files over the 10MB limit", !!sizeError);

  const { data: assetRow, error: insertError } = await dm.client
    .from("asset_library")
    .insert({ name: "Verify Crate", source_type: "custom", model_ref: path, campaign_id: campaignId })
    .select()
    .single();
  check("the DM can catalog the upload in asset_library", !insertError && !!assetRow);

  const { data: playerList, error: playerListError } = await player.client
    .from("asset_library")
    .select()
    .or(`source_type.eq.preset,campaign_id.eq.${campaignId}`);
  check(
    "a member's palette query returns the presets plus the custom asset",
    !playerListError && playerList.length === 9 && playerList.some((a) => a.name === "Verify Crate")
  );

  const { data: otherList, error: otherListError } = await otherDm.client
    .from("asset_library")
    .select()
    .or(`source_type.eq.preset,campaign_id.eq.${otherCampaignId}`);
  check(
    "another campaign's palette query sees only the presets",
    !otherListError && otherList.length === 8 && otherList.every((a) => a.source_type === "preset")
  );

  const { data: otherLeak } = await otherDm.client.from("asset_library").select().eq("source_type", "custom");
  check("another campaign's DM cannot see the custom row at all", (otherLeak ?? []).length === 0);

  const { error: deleteError } = await dm.client.storage.from("map-assets").remove([path]);
  check("the DM can delete their campaign's asset", !deleteError);
} finally {
  await admin.storage.from("map-assets").remove([path, `${campaignId}/huge.glb`]);
  await admin.from("campaigns").delete().in("id", [campaignId, otherCampaignId]);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
  await admin.auth.admin.deleteUser(otherDm.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll map-asset storage checks passed.");
