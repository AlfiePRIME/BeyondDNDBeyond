#!/usr/bin/env node
// Rest mechanic verification (Prompt 12 acceptance criteria).
//
// A character with a short-rest resource, a long-rest resource, a daily
// resource, and reduced HP: taking a short rest resets only the short-rest
// resource; taking a long rest resets everything (including a spell-slot-
// shaped long-rest resource) and restores HP to max.
//
// Usage: node scripts/db/verify-rest-mechanic.mjs

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
  const email = `rest-mechanic-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Rest Test ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client };
}

const owner = await makeTestUser("owner");
const stranger = await makeTestUser("stranger");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Rest mechanic test", creator: owner.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: owner.id, role: "dm" }]);

  const characterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: characterId,
    campaign_id: campaignId,
    owner_id: owner.id,
    name: "Rest Test Wizard",
    race: "Human",
    class: "Wizard",
    level: 3,
    strength: 8,
    dexterity: 14,
    constitution: 12,
    intelligence: 17,
    wisdom: 13,
    charisma: 10,
    current_hp: 3,
    max_hp: 20,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  await admin.from("character_resources").insert([
    { character_id: characterId, name: "Second Wind", max_uses: 1, current_uses: 0, recharge: "short_rest" },
    {
      character_id: characterId,
      name: "1st-Level Spell Slots",
      max_uses: 4,
      current_uses: 1,
      recharge: "long_rest",
    },
    { character_id: characterId, name: "Amulet Charge", max_uses: 3, current_uses: 1, recharge: "daily" },
  ]);

  const { error: strangerShortRestError, data: strangerShortRestData } = await stranger.client.rpc("short_rest", {
    p_character_id: characterId,
  });
  const { data: resourcesAfterStrangerAttempt } = await admin
    .from("character_resources")
    .select("name, current_uses")
    .eq("character_id", characterId)
    .eq("name", "Second Wind")
    .single();
  check(
    "a non-owner/non-DM's short_rest call is a silent no-op (RLS-filtered, not an error)",
    !strangerShortRestError && resourcesAfterStrangerAttempt.current_uses === 0
  );

  const { error: shortRestError } = await owner.client.rpc("short_rest", { p_character_id: characterId });
  check("owner can call short_rest without error", !shortRestError);

  const { data: afterShortRest } = await admin
    .from("character_resources")
    .select("name, recharge, current_uses, max_uses")
    .eq("character_id", characterId)
    .order("name");

  const secondWind = afterShortRest.find((r) => r.name === "Second Wind");
  const spellSlots = afterShortRest.find((r) => r.name === "1st-Level Spell Slots");
  const amulet = afterShortRest.find((r) => r.name === "Amulet Charge");

  check("short rest resets the short-rest resource to max", secondWind.current_uses === secondWind.max_uses);
  check("short rest leaves the long-rest resource untouched", spellSlots.current_uses === 1);
  check("short rest leaves the daily resource untouched", amulet.current_uses === 1);

  const { data: hpAfterShortRest } = await admin
    .from("characters")
    .select("current_hp")
    .eq("id", characterId)
    .single();
  check("short rest does not restore HP", hpAfterShortRest.current_hp === 3);

  // Spend the short-rest resource again so the long rest test can prove it
  // resets short-rest resources too, not just long-rest/daily ones.
  await admin.from("character_resources").update({ current_uses: 0 }).eq("character_id", characterId).eq("name", "Second Wind");

  const { error: longRestError } = await owner.client.rpc("long_rest", { p_character_id: characterId });
  check("owner can call long_rest without error", !longRestError);

  const { data: afterLongRest } = await admin
    .from("character_resources")
    .select("name, current_uses, max_uses")
    .eq("character_id", characterId)
    .order("name");

  for (const resource of afterLongRest) {
    check(`long rest resets "${resource.name}" to max`, resource.current_uses === resource.max_uses);
  }

  const { data: hpAfterLongRest } = await admin
    .from("characters")
    .select("current_hp, max_hp")
    .eq("id", characterId)
    .single();
  check("long rest restores HP to max", hpAfterLongRest.current_hp === hpAfterLongRest.max_hp);
} finally {
  await admin.auth.admin.deleteUser(owner.id);
  await admin.auth.admin.deleteUser(stranger.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll rest mechanic checks passed.");
