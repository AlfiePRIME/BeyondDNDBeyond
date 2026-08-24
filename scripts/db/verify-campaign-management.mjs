#!/usr/bin/env node
// Campaign management RLS verification (Prompt 15 acceptance criteria).
//
// A non-DM member cannot rename/delete a campaign (RLS, not just UI); a DM
// cannot leave their own campaign; a DM's rename/delete succeeds and a
// delete cascades to campaign_members/characters/character_resources.
//
// Usage: node scripts/db/verify-campaign-management.mjs

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
  const email = `campaign-mgmt-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Campaign Mgmt ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client };
}

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Original Name", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);
  const characterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: characterId,
    campaign_id: campaignId,
    owner_id: player.id,
    name: "Cascade Test Character",
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
  });
  await admin
    .from("character_resources")
    .insert({ character_id: characterId, name: "Test Resource", max_uses: 1, current_uses: 1, recharge: "long_rest" });

  // Non-DM rename/delete: RLS-blocked, PostgREST reports success with 0 rows.
  const { error: playerRenameError, count: playerRenameCount } = await player.client
    .from("campaigns")
    .update({ name: "Hijacked" }, { count: "exact" })
    .eq("id", campaignId);
  check(
    "non-DM rename via direct API affects 0 rows, not an explicit error",
    !playerRenameError && playerRenameCount === 0
  );

  const { data: nameAfterPlayerAttempt } = await admin.from("campaigns").select("name").eq("id", campaignId).single();
  check("campaign name unchanged after non-DM rename attempt", nameAfterPlayerAttempt.name === "Original Name");

  const { error: playerDeleteError, count: playerDeleteCount } = await player.client
    .from("campaigns")
    .delete({ count: "exact" })
    .eq("id", campaignId);
  check("non-DM delete via direct API affects 0 rows", !playerDeleteError && playerDeleteCount === 0);

  const { data: stillExists } = await admin.from("campaigns").select("id").eq("id", campaignId).maybeSingle();
  check("campaign still exists after non-DM delete attempt", stillExists !== null);

  // DM cannot leave (would orphan the campaign).
  const { error: dmLeaveError, count: dmLeaveCount } = await dm.client
    .from("campaign_members")
    .delete({ count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", dm.id);
  check("DM's own leave attempt via direct API affects 0 rows", !dmLeaveError && dmLeaveCount === 0);

  const { data: dmStillMember } = await admin
    .from("campaign_members")
    .select("role")
    .eq("campaign_id", campaignId)
    .eq("user_id", dm.id)
    .maybeSingle();
  check("DM is still a member after their own leave attempt", dmStillMember?.role === "dm");

  // Player CAN leave.
  const { error: playerLeaveError, count: playerLeaveCount } = await player.client
    .from("campaign_members")
    .delete({ count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id);
  check("a player can leave via direct API", !playerLeaveError && playerLeaveCount === 1);

  // Re-add the player so the DM-rename/delete test below has cascade rows to check.
  await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: player.id, role: "player" });

  // DM rename succeeds.
  const { error: dmRenameError, count: dmRenameCount } = await dm.client
    .from("campaigns")
    .update({ name: "Renamed By DM" }, { count: "exact" })
    .eq("id", campaignId);
  check("DM rename via direct API succeeds", !dmRenameError && dmRenameCount === 1);

  // DM delete cascades fully.
  const { error: dmDeleteError, count: dmDeleteCount } = await dm.client
    .from("campaigns")
    .delete({ count: "exact" })
    .eq("id", campaignId);
  check("DM delete via direct API succeeds", !dmDeleteError && dmDeleteCount === 1);

  const { data: membersAfterDelete } = await admin.from("campaign_members").select("id").eq("campaign_id", campaignId);
  const { data: charactersAfterDelete } = await admin.from("characters").select("id").eq("campaign_id", campaignId);
  const { data: resourcesAfterDelete } = await admin
    .from("character_resources")
    .select("id")
    .eq("character_id", characterId);
  check("no orphaned campaign_members rows after cascade delete", (membersAfterDelete ?? []).length === 0);
  check("no orphaned characters rows after cascade delete", (charactersAfterDelete ?? []).length === 0);
  check("no orphaned character_resources rows after cascade delete", (resourcesAfterDelete ?? []).length === 0);
} finally {
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll campaign management checks passed.");
