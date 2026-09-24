#!/usr/bin/env node
// Migration 0122 verification: temporary HP soaks damage first (while the
// concentration DC still uses the full damage), long rests follow the SRD
// and recover half the hit dice, spend_hit_die heals and counts down, and
// inspiration is DM-awarded but owner-spendable for advantage.
//
// Usage: node scripts/db/verify-temp-hp-hit-dice.mjs
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

async function makeUser(label) {
  const email = `temp-hp-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Temp HP ${label}` });
  const client = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  await client.auth.signInWithPassword({ email, password });
  return { id: data.user.id, client };
}

const dm = await makeUser("dm");
const player = await makeUser("player");
const campaignId = crypto.randomUUID();

async function makeCharacter(overrides = {}) {
  const id = crypto.randomUUID();
  const { error } = await admin.from("characters").insert({
    id, campaign_id: campaignId, owner_id: player.id, name: `Hero ${id.slice(0, 4)}`, race: "Human", class: "Fighter",
    level: 4, strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    current_hp: 30, max_hp: 30, armor_class: 10, speed: 30, proficiencies: [], inventory: [], spells: [], ...overrides,
  });
  if (error) throw error;
  return id;
}
const row = async (id) => (await admin.from("characters").select().eq("id", id).single()).data;

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Temp HP test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  // ── Temp HP ──
  const a = await makeCharacter({ temp_hp: 5, concentrating_on: "Bless" });
  await player.client.rpc("apply_hp_delta", { p_character_id: a, p_delta: -3 });
  let r = await row(a);
  check("3 damage comes entirely off 5 temp HP", r.temp_hp === 2 && r.current_hp === 30, r);
  check("damage soaked by temp HP still calls for a concentration save (DC 10)", r.pending_concentration_dc === 10, r.pending_concentration_dc);
  await player.client.rpc("apply_hp_delta", { p_character_id: a, p_delta: -24 });
  r = await row(a);
  check("24 damage spends the last 2 temp HP, then 22 real HP", r.temp_hp === 0 && r.current_hp === 8, r);
  check("the concentration DC uses the full 24 damage (DC 12)", r.pending_concentration_dc === 12, r.pending_concentration_dc);
  await player.client.rpc("apply_hp_delta", { p_character_id: a, p_delta: 10 });
  r = await row(a);
  check("healing doesn't grant temp HP", r.temp_hp === 0 && r.current_hp === 18, r);

  const m = await makeCharacter({ current_hp: 5, max_hp: 10, temp_hp: 10 });
  await player.client.rpc("apply_hp_delta", { p_character_id: m, p_delta: -24 });
  r = await row(m);
  check("massive damage counts only what gets past temp HP (24 - 10 temp = 14 → 9 over max: not dead)", r.is_dead === false && r.current_hp === 0, r);

  // ── Hit dice ──
  const h = await makeCharacter({ current_hp: 10 });
  const { data: afterDie, error: dieError } = await player.client.rpc("spend_hit_die", { p_character_id: h, p_healing: 7 });
  check("spending a hit die heals by the rolled amount", !dieError && afterDie?.current_hp === 17 && afterDie?.hit_dice_spent === 1, dieError ?? afterDie);
  for (let i = 0; i < 3; i++) await player.client.rpc("spend_hit_die", { p_character_id: h, p_healing: 1 });
  const { error: outOfDice } = await player.client.rpc("spend_hit_die", { p_character_id: h, p_healing: 1 });
  check("a level-4 character can't spend a fifth hit die", outOfDice !== null && (await row(h)).hit_dice_spent === 4);

  // ── Long rest ──
  await admin.from("characters").update({ temp_hp: 6, current_hp: 12 }).eq("id", h);
  const { error: restError } = await player.client.rpc("long_rest", { p_character_id: h });
  r = await row(h);
  check("a long rest restores HP, clears temp HP, and recovers half the hit dice (4 → 2 spent)",
    !restError && r.current_hp === 30 && r.temp_hp === 0 && r.hit_dice_spent === 2, restError ?? r);
  const down = await makeCharacter({ current_hp: 0, death_save_failures: 1 });
  const { error: downRest } = await player.client.rpc("long_rest", { p_character_id: down });
  check("a character at 0 HP gets no benefit from a long rest", downRest !== null && (await row(down)).current_hp === 0);

  // ── Inspiration ──
  const i = await makeCharacter();
  const { error: selfAward } = await player.client.from("characters").update({ inspiration: true }).eq("id", i);
  check("a player can't award themselves inspiration", selfAward !== null && (await row(i)).inspiration === false);
  const { error: dmAward } = await dm.client.from("characters").update({ inspiration: true }).eq("id", i);
  check("the DM can award inspiration", !dmAward && (await row(i)).inspiration === true, dmAward);
  const { error: selfAdvantage } = await player.client.from("characters").update({ pending_roll_mode: "advantage" }).eq("id", i);
  check("a player still can't grant themselves advantage without spending inspiration", selfAdvantage !== null);
  const { error: spendError } = await player.client
    .from("characters").update({ inspiration: false, pending_roll_mode: "advantage" }).eq("id", i).eq("inspiration", true);
  r = await row(i);
  check("spending inspiration gives advantage on the next roll", !spendError && r.inspiration === false && r.pending_roll_mode === "advantage", spendError ?? r);
} finally {
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
}

console.log(failures === 0 ? "\nAll temp HP / hit dice / inspiration checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
