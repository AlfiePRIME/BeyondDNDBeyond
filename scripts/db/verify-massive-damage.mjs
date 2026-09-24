#!/usr/bin/env node
// Migration 0120 verification: massive damage — damage that drops a
// character from above 0 HP to 0 with leftover >= max HP kills outright;
// less than that just knocks them unconscious. Pure RPC test with a fresh
// test user — no app server needed.
//
// Usage: node scripts/db/verify-massive-damage.mjs
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
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq !== -1) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}
const env = { ...loadEnv(join(rootDir, ".env")), ...loadEnv(join(rootDir, "supabase", ".env")), ...process.env };
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    console.error(`FAIL  ${label}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
    failures++;
  }
}

const email = `massive-damage-${Date.now()}@example.test`;
const password = "test-password-1234!";
const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (createError) throw createError;
const userId = created.user.id;
await admin.from("profiles").insert({ id: userId, display_name: "Massive Damage" });
const player = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
await player.auth.signInWithPassword({ email, password });

const campaignId = crypto.randomUUID();
await admin.from("campaigns").insert({ id: campaignId, name: "Massive damage test", creator: userId });
await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: userId, role: "dm" });

async function makeCharacter(currentHp) {
  const id = crypto.randomUUID();
  const { error } = await admin.from("characters").insert({
    id, campaign_id: campaignId, owner_id: userId, name: `Wizard ${currentHp}`, race: "Human", class: "Wizard", level: 1,
    strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    current_hp: currentHp, max_hp: 10, armor_class: 10, speed: 30, proficiencies: [], inventory: [], spells: [],
  });
  if (error) throw error;
  return id;
}

try {
  const a = await makeCharacter(5);
  const { data: dead, error: e1 } = await player.rpc("apply_hp_delta", { p_character_id: a, p_delta: -15 });
  if (e1) throw e1;
  check("5/10 HP taking 15 (leftover 10 = max HP) dies instantly", dead.is_dead === true && dead.current_hp === 0, dead);

  const b = await makeCharacter(5);
  const { data: down, error: e2 } = await player.rpc("apply_hp_delta", { p_character_id: b, p_delta: -14 });
  if (e2) throw e2;
  check("5/10 HP taking 14 (leftover 9 < max HP) is only knocked down", down.is_dead === false && down.current_hp === 0, down);
} finally {
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(userId);
}

console.log(failures === 0 ? "\nAll massive damage checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
