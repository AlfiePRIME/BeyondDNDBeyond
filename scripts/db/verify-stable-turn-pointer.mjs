#!/usr/bin/env node
// Migration 0107 verification: the turn stays with the same combatant when
// the initiative order is reshuffled or a combatant is removed mid-combat.
// Pure database/RPC test with fresh test users — no app server needed.
//
// Usage: node scripts/db/verify-stable-turn-pointer.mjs
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

const email = `turn-pointer-dm-${Date.now()}@example.test`;
const password = "test-password-1234!";
const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (createError) throw createError;
const dmId = created.user.id;
await admin.from("profiles").insert({ id: dmId, display_name: "Turn Pointer DM" });
const dm = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
await dm.auth.signInWithPassword({ email, password });

const campaignId = crypto.randomUUID();
const mapId = crypto.randomUUID();
await admin.from("campaigns").insert({ id: campaignId, name: "Turn pointer test", creator: dmId });
await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: dmId, role: "dm" });
await admin.from("campaign_maps").insert({ id: mapId, campaign_id: campaignId, name: "Arena", grid_width: 8, grid_height: 8 });
const names = ["Alpha", "Bravo", "Charlie", "Delta"];
const tokens = names.map((name, i) => ({ id: crypto.randomUUID(), map_id: mapId, npc_name: name, x: i, y: 0, elevation: 0, allegiance: "hostile" }));
await admin.from("map_tokens").insert(tokens);
await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

async function state() {
  const { data: encounter } = await admin
    .from("combat_encounters")
    .select()
    .eq("campaign_id", campaignId)
    .is("ended_at", null)
    .single();
  const { data: combatants } = await admin
    .from("combat_combatants")
    .select()
    .eq("encounter_id", encounter.id)
    .order("initiative", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return { encounter, combatants, current: combatants[encounter.current_turn_index]?.npc_name };
}

try {
  const { error: startError } = await dm.rpc("start_combat", { p_campaign_id: campaignId });
  if (startError) throw startError;
  let s = await state();
  const initiative = { Alpha: 20, Bravo: 15, Charlie: 10, Delta: 5 };
  for (const c of s.combatants) {
    const { error } = await dm.from("combat_combatants").update({ initiative: initiative[c.npc_name] }).eq("id", c.id);
    if (error) throw error;
  }
  s = await state();
  check("before anyone acts (round 1, index 0), the turn is the top of the order", s.current === "Alpha", s.current);

  await dm.rpc("advance_turn", { p_encounter_id: s.encounter.id });
  s = await state();
  check("advancing hands the turn to Bravo", s.current === "Bravo", s.current);
  check("the encounter records Bravo as the acting combatant", s.encounter.current_combatant_id === s.combatants.find((c) => c.npc_name === "Bravo").id);

  // Charlie rolls higher than everyone — the order reshuffles above Bravo.
  const charlie = s.combatants.find((c) => c.npc_name === "Charlie");
  await dm.from("combat_combatants").update({ initiative: 25 }).eq("id", charlie.id);
  s = await state();
  check("re-sorting initiative mid-combat keeps the turn on Bravo", s.current === "Bravo", { current: s.current, index: s.encounter.current_turn_index });

  // A combatant ahead of Bravo in the order is removed (token deleted → cascade).
  await admin.from("map_tokens").delete().eq("id", charlie.token_id);
  s = await state();
  check("removing a combatant ahead of the acting one keeps the turn on Bravo", s.current === "Bravo", { current: s.current, index: s.encounter.current_turn_index });

  // The acting combatant itself is removed — the next in order takes over.
  const bravo = s.combatants.find((c) => c.npc_name === "Bravo");
  await admin.from("map_tokens").delete().eq("id", bravo.token_id);
  s = await state();
  check("removing the acting combatant passes the turn to the next in order (Delta)", s.current === "Delta", { current: s.current, index: s.encounter.current_turn_index });

  // Last in order removed while acting — wraps to the top.
  const delta = s.combatants.find((c) => c.npc_name === "Delta");
  await admin.from("map_tokens").delete().eq("id", delta.token_id);
  s = await state();
  check("removing the acting last-in-order combatant wraps to the top (Alpha)", s.current === "Alpha", { current: s.current, index: s.encounter.current_turn_index });

  await dm.rpc("end_combat", { p_campaign_id: campaignId });
} finally {
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dmId);
}

console.log(failures === 0 ? "\nAll stable turn pointer checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
