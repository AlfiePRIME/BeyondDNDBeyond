#!/usr/bin/env node
// Combatant conditions verification (Prompt 47 acceptance criteria, the
// server-side half).
//
// Seeds a campaign (DM + two players, each with a character and a token on
// the live map, plus an NPC token), starts combat, and checks: multiple
// on/off conditions stack on one combatant without clobbering each other,
// re-applying is a no-op, removing clears exactly one, a non-owner non-DM
// player is rejected in both directions, NPC conditions are DM-only,
// exhaustion clamps at 6 going up and clears its row at 0 going down (never
// negative), the level-shape CHECK holds, and the exhaustion RPC rejects
// unauthorized callers.
//
// Usage: node scripts/db/verify-conditions.mjs

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
  const email = `conditions-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Conditions Test ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client };
}

function makeCharacter(id, campaignId, ownerId, name) {
  return {
    id,
    campaign_id: campaignId,
    owner_id: ownerId,
    name,
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 14,
    dexterity: 12,
    constitution: 13,
    intelligence: 10,
    wisdom: 11,
    charisma: 10,
    current_hp: 12,
    max_hp: 12,
    armor_class: 15,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  };
}

const dm = await makeTestUser("dm");
const owner = await makeTestUser("owner");
const bystander = await makeTestUser("bystander");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Conditions test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: owner.id, role: "player" },
    { campaign_id: campaignId, user_id: bystander.id, role: "player" },
  ]);

  const ownerCharacterId = crypto.randomUUID();
  const bystanderCharacterId = crypto.randomUUID();
  await admin.from("characters").insert([
    makeCharacter(ownerCharacterId, campaignId, owner.id, "Owner PC"),
    makeCharacter(bystanderCharacterId, campaignId, bystander.id, "Bystander PC"),
  ]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Conditions arena",
    grid_width: 10,
    grid_height: 10,
  });
  await admin.from("map_tokens").insert([
    { id: crypto.randomUUID(), map_id: mapId, character_id: ownerCharacterId, x: 1, y: 1, elevation: 0, allegiance: "party" },
    { id: crypto.randomUUID(), map_id: mapId, character_id: bystanderCharacterId, x: 2, y: 1, elevation: 0, allegiance: "party" },
    { id: crypto.randomUUID(), map_id: mapId, npc_name: "Goblin", x: 3, y: 1, elevation: 0, allegiance: "hostile" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const { data: encounterId, error: startError } = await dm.client.rpc("start_combat", { p_campaign_id: campaignId });
  if (startError) throw new Error(`starting combat: ${startError.message}`);

  const { data: combatants } = await admin.from("combat_combatants").select().eq("encounter_id", encounterId);
  const ownerCombatant = combatants.find((c) => c.character_id === ownerCharacterId);
  const npcCombatant = combatants.find((c) => c.npc_name === "Goblin");

  // -- Multiple on/off conditions stack without clobbering. --
  for (const key of ["poisoned", "prone", "blinded"]) {
    const { error } = await owner.client
      .from("combatant_conditions")
      .upsert(
        { combatant_id: ownerCombatant.id, condition_key: key },
        { onConflict: "combatant_id,condition_key", ignoreDuplicates: true }
      );
    check(`the owner can apply ${key} to their own combatant`, !error);
  }
  let { data: stored } = await admin.from("combatant_conditions").select().eq("combatant_id", ownerCombatant.id);
  check(
    "all three conditions are stored simultaneously",
    stored.length === 3 && ["poisoned", "prone", "blinded"].every((k) => stored.some((row) => row.condition_key === k))
  );

  // -- Re-applying an already-present condition is a harmless no-op. --
  const { error: reapplyError } = await owner.client
    .from("combatant_conditions")
    .upsert(
      { combatant_id: ownerCombatant.id, condition_key: "poisoned" },
      { onConflict: "combatant_id,condition_key", ignoreDuplicates: true }
    );
  ({ data: stored } = await admin.from("combatant_conditions").select().eq("combatant_id", ownerCombatant.id));
  check("re-applying poisoned neither errors nor duplicates", !reapplyError && stored.length === 3);

  // -- Removing one clears exactly that one. --
  const { error: removeError } = await owner.client
    .from("combatant_conditions")
    .delete()
    .eq("combatant_id", ownerCombatant.id)
    .eq("condition_key", "prone");
  ({ data: stored } = await admin.from("combatant_conditions").select().eq("combatant_id", ownerCombatant.id));
  check(
    "removing prone clears only prone",
    !removeError &&
      stored.length === 2 &&
      stored.some((row) => row.condition_key === "poisoned") &&
      stored.some((row) => row.condition_key === "blinded")
  );

  // -- A non-owner non-DM player is rejected in both directions. --
  const { error: bystanderApplyError } = await bystander.client
    .from("combatant_conditions")
    .insert({ combatant_id: ownerCombatant.id, condition_key: "stunned" });
  check("a non-owner non-DM player cannot apply a condition", !!bystanderApplyError);

  const { count: bystanderDeleteCount } = await bystander.client
    .from("combatant_conditions")
    .delete({ count: "exact" })
    .eq("combatant_id", ownerCombatant.id)
    .eq("condition_key", "poisoned");
  ({ data: stored } = await admin.from("combatant_conditions").select().eq("combatant_id", ownerCombatant.id));
  check(
    "a non-owner non-DM player cannot remove a condition",
    (bystanderDeleteCount ?? 0) === 0 && stored.length === 2
  );

  const { data: bystanderReads } = await bystander.client
    .from("combatant_conditions")
    .select()
    .eq("combatant_id", ownerCombatant.id);
  check("but every member can READ the combatant's conditions", (bystanderReads ?? []).length === 2);

  // -- The DM can write anyone's conditions; NPC rows are DM-only. --
  const { error: dmNpcError } = await dm.client
    .from("combatant_conditions")
    .insert({ combatant_id: npcCombatant.id, condition_key: "frightened" });
  check("the DM can apply a condition to an NPC combatant", !dmNpcError);

  const { error: playerNpcError } = await owner.client
    .from("combatant_conditions")
    .insert({ combatant_id: npcCombatant.id, condition_key: "charmed" });
  check("a player cannot apply a condition to an NPC combatant", !!playerNpcError);

  // -- The level-shape CHECK: on/off conditions can't carry a level, and
  //    exhaustion can't be written out of range even by the DM. --
  const { error: levelOnBooleanError } = await dm.client
    .from("combatant_conditions")
    .insert({ combatant_id: ownerCombatant.id, condition_key: "grappled", level: 3 });
  check("a non-exhaustion condition cannot carry a level", !!levelOnBooleanError);

  const { error: level7Error } = await dm.client
    .from("combatant_conditions")
    .insert({ combatant_id: ownerCombatant.id, condition_key: "exhaustion", level: 7 });
  check("an exhaustion row cannot be written past level 6", !!level7Error);

  // -- Exhaustion: climbs, clamps at 6, descends, clears at 0. --
  const { data: up2 } = await owner.client.rpc("apply_exhaustion_delta", {
    p_combatant_id: ownerCombatant.id,
    p_delta: 2,
  });
  check("exhaustion +2 from nothing lands at level 2", up2 === 2);

  const { data: up10 } = await owner.client.rpc("apply_exhaustion_delta", {
    p_combatant_id: ownerCombatant.id,
    p_delta: 10,
  });
  ({ data: stored } = await admin
    .from("combatant_conditions")
    .select()
    .eq("combatant_id", ownerCombatant.id)
    .eq("condition_key", "exhaustion"));
  check("exhaustion clamps at 6 going up", up10 === 6 && stored[0]?.level === 6);

  const { data: down3 } = await owner.client.rpc("apply_exhaustion_delta", {
    p_combatant_id: ownerCombatant.id,
    p_delta: -3,
  });
  check("exhaustion -3 from 6 lands at 3", down3 === 3);

  const { data: down10 } = await owner.client.rpc("apply_exhaustion_delta", {
    p_combatant_id: ownerCombatant.id,
    p_delta: -10,
  });
  ({ data: stored } = await admin
    .from("combatant_conditions")
    .select()
    .eq("combatant_id", ownerCombatant.id)
    .eq("condition_key", "exhaustion"));
  check("exhaustion clamps at 0 going down and deletes its row", down10 === 0 && stored.length === 0);

  const { data: downAgain, error: downAgainError } = await owner.client.rpc("apply_exhaustion_delta", {
    p_combatant_id: ownerCombatant.id,
    p_delta: -1,
  });
  check("decrementing with no exhaustion stays a clean 0", !downAgainError && downAgain === 0);

  // -- The exhaustion RPC rejects unauthorized callers (the combatant-row
  //    lock rides can_write_combatant's UPDATE policy). --
  const { error: bystanderRpcError } = await bystander.client.rpc("apply_exhaustion_delta", {
    p_combatant_id: ownerCombatant.id,
    p_delta: 1,
  });
  check("a non-owner non-DM player cannot change exhaustion", !!bystanderRpcError);

  const { error: playerNpcRpcError } = await owner.client.rpc("apply_exhaustion_delta", {
    p_combatant_id: npcCombatant.id,
    p_delta: 1,
  });
  check("a player cannot change an NPC's exhaustion", !!playerNpcRpcError);

  const { data: dmNpcLevel, error: dmNpcRpcError } = await dm.client.rpc("apply_exhaustion_delta", {
    p_combatant_id: npcCombatant.id,
    p_delta: 1,
  });
  check("the DM can change an NPC's exhaustion", !dmNpcRpcError && dmNpcLevel === 1);

  // -- Two concurrent increments both land (the FOR UPDATE serialization). --
  await dm.client.rpc("apply_exhaustion_delta", { p_combatant_id: npcCombatant.id, p_delta: -10 });
  await Promise.all([
    dm.client.rpc("apply_exhaustion_delta", { p_combatant_id: npcCombatant.id, p_delta: 1 }),
    dm.client.rpc("apply_exhaustion_delta", { p_combatant_id: npcCombatant.id, p_delta: 1 }),
  ]);
  ({ data: stored } = await admin
    .from("combatant_conditions")
    .select()
    .eq("combatant_id", npcCombatant.id)
    .eq("condition_key", "exhaustion"));
  check("two near-simultaneous +1s both land (level 2, not 1)", stored[0]?.level === 2);
} finally {
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(owner.id);
  await admin.auth.admin.deleteUser(bystander.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll combatant condition checks passed.");
