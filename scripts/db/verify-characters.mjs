#!/usr/bin/env node
// Character data model verification (Prompt 8 acceptance criteria).
//
// Creates a campaign with a DM and two players, gives each player a
// representative character (a fighter and a wizard) with inventory items
// and a limited-use resource, and checks: both characters (and their
// resources) can be built as described, the DM can read/write either
// character, each owner can read/write their own character, and neither
// player can read or write the OTHER player's character.
//
// Usage: node scripts/db/verify-characters.mjs

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
  const email = `characters-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Characters Test ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client };
}

const dm = await makeTestUser("dm");
const fighterPlayer = await makeTestUser("fighter-player");
const wizardPlayer = await makeTestUser("wizard-player");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Characters test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: fighterPlayer.id, role: "player" },
    { campaign_id: campaignId, user_id: wizardPlayer.id, role: "player" },
  ]);

  // Fighter, built by its owning player.
  const fighterId = crypto.randomUUID();
  const { error: fighterInsertError } = await fighterPlayer.client.from("characters").insert({
    id: fighterId,
    campaign_id: campaignId,
    owner_id: fighterPlayer.id,
    name: "Bram Ironhide",
    race: "Mountain Dwarf",
    class: "Fighter",
    level: 3,
    strength: 16,
    dexterity: 12,
    constitution: 15,
    intelligence: 9,
    wisdom: 11,
    charisma: 8,
    current_hp: 28,
    max_hp: 28,
    armor_class: 18,
    speed: 25,
    proficiencies: ["Athletics", "Intimidation", "Strength Saving Throws", "Constitution Saving Throws", "Smith's Tools"],
    inventory: [
      { name: "Longsword", quantity: 1, equipped: true },
      { name: "Shield", quantity: 1, equipped: true },
      { name: "Handaxe", quantity: 2 },
      { name: "Chain Mail", quantity: 1, equipped: true },
    ],
    spells: [],
  });
  check("the fighter player can create their own character", !fighterInsertError);

  const { error: fighterResourceError } = await fighterPlayer.client.from("character_resources").insert({
    character_id: fighterId,
    name: "Second Wind",
    max_uses: 1,
    current_uses: 1,
    recharge: "short_rest",
  });
  check("the fighter player can add a limited-use resource to their character", !fighterResourceError);

  // Wizard, built by its owning player.
  const wizardId = crypto.randomUUID();
  const { error: wizardInsertError } = await wizardPlayer.client.from("characters").insert({
    id: wizardId,
    campaign_id: campaignId,
    owner_id: wizardPlayer.id,
    name: "Elowen Vask",
    race: "High Elf",
    class: "Wizard",
    level: 3,
    strength: 8,
    dexterity: 14,
    constitution: 12,
    intelligence: 17,
    wisdom: 13,
    charisma: 10,
    current_hp: 17,
    max_hp: 17,
    armor_class: 12,
    speed: 30,
    proficiencies: ["Arcana", "Investigation", "Intelligence Saving Throws", "Wisdom Saving Throws"],
    inventory: [
      { name: "Quarterstaff", quantity: 1, equipped: true },
      { name: "Spellbook", quantity: 1 },
      { name: "Component Pouch", quantity: 1 },
    ],
    spells: [
      { name: "Fire Bolt", level: 0 },
      { name: "Mage Hand", level: 0 },
      { name: "Magic Missile", level: 1, prepared: true },
      { name: "Fireball", level: 3, prepared: true },
    ],
  });
  check("the wizard player can create their own character", !wizardInsertError);

  const { error: wizardResourceError } = await wizardPlayer.client.from("character_resources").insert({
    character_id: wizardId,
    name: "Arcane Recovery",
    max_uses: 1,
    current_uses: 1,
    recharge: "long_rest",
  });
  check("the wizard player can add a limited-use resource to their character", !wizardResourceError);

  // Owner can read/update their own character.
  const { data: fighterSelfRead } = await fighterPlayer.client.from("characters").select().eq("id", fighterId).maybeSingle();
  check("the fighter player can read their own character", fighterSelfRead?.name === "Bram Ironhide");

  const { error: fighterSelfUpdateError } = await fighterPlayer.client
    .from("characters")
    .update({ current_hp: 20 })
    .eq("id", fighterId);
  check("the fighter player can update their own character", !fighterSelfUpdateError);

  // The DM can read/write either character.
  const { data: dmReadsFighter } = await dm.client.from("characters").select().eq("id", fighterId).maybeSingle();
  check("the DM can read the fighter's character", dmReadsFighter?.name === "Bram Ironhide");

  const { data: dmReadsWizard } = await dm.client.from("characters").select().eq("id", wizardId).maybeSingle();
  check("the DM can read the wizard's character", dmReadsWizard?.name === "Elowen Vask");

  const { error: dmUpdatesWizardError } = await dm.client.from("characters").update({ current_hp: 5 }).eq("id", wizardId);
  check("the DM can update the wizard's character", !dmUpdatesWizardError);

  const { data: dmReadsWizardResources } = await dm.client
    .from("character_resources")
    .select()
    .eq("character_id", wizardId);
  check("the DM can read the wizard's resources", (dmReadsWizardResources ?? []).length === 1);

  // A fellow player (not the owner, not the DM) cannot see or touch the
  // other player's character or its resources.
  const { data: wizardReadsFighter } = await wizardPlayer.client.from("characters").select().eq("id", fighterId).maybeSingle();
  check("the wizard player cannot read the fighter's character", wizardReadsFighter === null);

  const { data: fighterReadsWizard } = await fighterPlayer.client.from("characters").select().eq("id", wizardId).maybeSingle();
  check("the fighter player cannot read the wizard's character", fighterReadsWizard === null);

  const { error: wizardUpdatesFighterError, count: wizardUpdatesFighterCount } = await wizardPlayer.client
    .from("characters")
    .update({ current_hp: 0 })
    .eq("id", fighterId)
    .select("id", { count: "exact" });
  check(
    "the wizard player cannot update the fighter's character",
    !wizardUpdatesFighterError && (wizardUpdatesFighterCount ?? 0) === 0
  );

  const { data: fighterReadsWizardResources } = await fighterPlayer.client
    .from("character_resources")
    .select()
    .eq("character_id", wizardId);
  check(
    "the fighter player cannot read the wizard's resources",
    (fighterReadsWizardResources ?? []).length === 0
  );

  const { error: fighterInsertsWizardResourceError } = await fighterPlayer.client.from("character_resources").insert({
    character_id: wizardId,
    name: "Sneaky Extra Resource",
    max_uses: 1,
    current_uses: 1,
    recharge: "daily",
  });
  check(
    "the fighter player cannot add a resource to the wizard's character",
    !!fighterInsertsWizardResourceError
  );
} finally {
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(fighterPlayer.id);
  await admin.auth.admin.deleteUser(wizardPlayer.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll character data model checks passed.");
