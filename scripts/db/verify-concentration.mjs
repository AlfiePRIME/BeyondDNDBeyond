#!/usr/bin/env node
// Concentration tracking verification (Prompt 50 acceptance criteria).
//
// Seeds a campaign (DM + two players, each with a character, tokens on a
// live map, combat started) and exercises the whole mechanic: starting
// concentration on a new spell silently replaces the old one (no save, no
// log entry) and moots any stale pending check; dropping a concentrating
// character to exactly 0 HP clears concentration outright with no pending
// check (both damage paths); damage that leaves them above 0 sets
// pending_concentration_dc = max(10, floor(damage / 2)) — the DC-10 floor
// band and the above-10 band, both paths, including the floor on odd
// damage; a second hit before the first check resolves OVERWRITES the
// pending DC (no queue — the documented scope simplification); the live
// roll route (kind: "concentration_save") re-reads the stored DC, rolls a
// plain normal-mode d20 + CON save bonus, keeps the spell on total >= DC
// and clears it otherwise (both observed for real by retrying the route),
// always clearing the pending flag; rolling with nothing pending is a 400
// that logs nothing; the Game Room's incapacitating-condition
// orchestration (apply condition, then stop concentrating — mirrored here
// at the data layer, since the React handler itself needs a browser)
// clears concentration for stunned but not for poisoned; a non-owner
// non-DM can neither start, stop, nor roll for someone else's character;
// and both a concentration_save roll and a start/stop-concentrating
// characters UPDATE reach another client's postgres_changes subscription
// live (gated on the channel being joined and retried until landed — the
// documented fixed-timeout flakiness lesson).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-concentration.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = "http://localhost:3000";

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

// Start the dev server only if :3000 isn't already serving; if we started
// it, we kill it (its whole detached process group) on the way out.
let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log("dev server not running — starting yarn dev…");
  devServer = spawn("yarn", ["dev"], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error("dev server did not become healthy within 120s");
}

// The @supabase/ssr cookie format: sb-<host>-auth-token = "base64-" +
// base64url(JSON session), chunked at 3180 chars into name.0, name.1, ...
const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;

function sessionCookieHeader(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return `${COOKIE_NAME}=${value}`;
  const chunks = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    chunks.push(`${COOKIE_NAME}.${i}=${value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK)}`);
  }
  return chunks.join("; ");
}

async function makeTestUser(label) {
  const email = `concentration-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Concentration Test ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, cookie: sessionCookieHeader(signIn.session) };
}

async function postRoll(user, campaignId, body) {
  const response = await fetch(`${APP_URL}/campaigns/${campaignId}/roll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: user.cookie },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Concentration test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  // Fighter: CON among saving-throw proficiencies, so the route's CON save
  // bonus is +1 (CON 13) +3 (proficiency at level 5) = +4 — exercising
  // BOTH modifier parts of the shared saving-throw logic.
  const aliceCharacterId = crypto.randomUUID();
  const bobCharacterId = crypto.randomUUID();
  const baseCharacter = (id, ownerId, name) => ({
    id,
    campaign_id: campaignId,
    owner_id: ownerId,
    name,
    race: "Human",
    class: "Fighter",
    level: 5,
    strength: 16,
    dexterity: 14,
    constitution: 13,
    intelligence: 10,
    wisdom: 12,
    charisma: 8,
    current_hp: 40,
    max_hp: 40,
    armor_class: 15,
    speed: 30,
    proficiencies: ["Athletics"],
    inventory: [],
    spells: [{ name: "Bless", level: 1 }, { name: "Hold Person", level: 2 }],
  });
  await admin.from("characters").insert([
    baseCharacter(aliceCharacterId, alice.id, "Alice PC"),
    baseCharacter(bobCharacterId, bob.id, "Bob PC"),
  ]);

  // A live map with tokens plus a started encounter, so the condition
  // checks have real combatant rows to hang combatant_conditions on.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Concentration arena",
    grid_width: 10,
    grid_height: 10,
  });
  await admin.from("map_tokens").insert([
    { id: crypto.randomUUID(), map_id: mapId, character_id: aliceCharacterId, x: 1, y: 1, elevation: 0, allegiance: "party" },
    { id: crypto.randomUUID(), map_id: mapId, character_id: bobCharacterId, x: 2, y: 1, elevation: 0, allegiance: "party" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  const { data: encounterId, error: startError } = await dm.client.rpc("start_combat", { p_campaign_id: campaignId });
  if (startError) throw new Error(`starting combat: ${startError.message}`);
  const { data: combatants } = await admin.from("combat_combatants").select().eq("encounter_id", encounterId);
  const aliceCombatant = combatants.find((c) => c.character_id === aliceCharacterId);

  async function setState(characterId, state) {
    const { error } = await admin
      .from("characters")
      .update({
        current_hp: 40,
        death_save_successes: 0,
        death_save_failures: 0,
        is_stable: false,
        is_dead: false,
        concentrating_on: null,
        pending_concentration_dc: null,
        ...state,
      })
      .eq("id", characterId);
    if (error) throw new Error(`resetting character state: ${error.message}`);
  }

  async function getState(characterId) {
    const { data, error } = await admin
      .from("characters")
      .select("current_hp, max_hp, concentrating_on, pending_concentration_dc, death_save_failures, is_dead")
      .eq("id", characterId)
      .single();
    if (error) throw new Error(`reading character state: ${error.message}`);
    return data;
  }

  async function countConcentrationSaveLogs() {
    const { count } = await admin
      .from("roll_log")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("kind", "concentration_save");
    return count ?? 0;
  }

  // The direct-RPC attack path, verify-death-saves' fakeBreakdown shape —
  // deterministic damage, unlike retrying the HTTP attack route.
  async function attackDamage(attacker, attackerCharacterId, targetCharacterId, damage) {
    const { data, error } = await attacker.client
      .rpc("resolve_attack_damage", {
        p_attacker_character_id: attackerCharacterId,
        p_target_character_id: targetCharacterId,
        p_damage: damage,
        p_critical: false,
        p_breakdown: {
          type: "d20",
          label: "verify-concentration attack",
          mode: "normal",
          d20Rolls: [15],
          d20Result: 15,
          modifiers: [],
          attack: {
            attackKind: "melee",
            targetAc: 10,
            targetName: "target",
            targetCharacterId,
            natural20: false,
            natural1: false,
            hit: true,
            critical: false,
            damage: null,
            applied: null,
            instantDeath: false,
            deathSaveFailureAdded: 0,
          },
        },
        p_total: 15,
      })
      .select();
    if (error) throw new Error(`resolve_attack_damage: ${error.message}`);
    return data?.[0];
  }

  // -- 1. Starting concentration, and replacing it, through the plain
  //    owner RLS write (what startConcentrating does) — no save, no log. --
  const { data: started, error: startConcError } = await alice.client
    .from("characters")
    .update({ concentrating_on: "Bless", pending_concentration_dc: null, updated_at: new Date().toISOString() })
    .eq("id", aliceCharacterId)
    .select()
    .single();
  check(
    "the owner can start concentrating on a spell",
    !startConcError && started?.concentrating_on === "Bless",
    startConcError?.message
  );

  const { data: replaced } = await alice.client
    .from("characters")
    .update({ concentrating_on: "Hold Person", pending_concentration_dc: null, updated_at: new Date().toISOString() })
    .eq("id", aliceCharacterId)
    .select()
    .single();
  check(
    "starting a new concentration spell silently replaces the old one (no save)",
    replaced?.concentrating_on === "Hold Person" && replaced?.pending_concentration_dc === null,
    JSON.stringify(replaced)
  );
  check("replacing a concentration spell logged no roll", (await countConcentrationSaveLogs()) === 0);

  await setState(aliceCharacterId, { concentrating_on: "Bless", pending_concentration_dc: 12 });
  const { data: mooted } = await alice.client
    .from("characters")
    .update({ concentrating_on: "Hold Person", pending_concentration_dc: null, updated_at: new Date().toISOString() })
    .eq("id", aliceCharacterId)
    .select()
    .single();
  check(
    "starting a new spell moots a stale pending check on the old one",
    mooted?.concentrating_on === "Hold Person" && mooted?.pending_concentration_dc === null,
    JSON.stringify(mooted)
  );

  // -- 2. Dropping to exactly 0 HP clears concentration outright — no
  //    save, no pending check — through BOTH damage paths. --
  await setState(aliceCharacterId, { current_hp: 5, concentrating_on: "Bless", pending_concentration_dc: 11 });
  const { data: droppedManual, error: dropError } = await alice.client.rpc("apply_hp_delta", {
    p_character_id: aliceCharacterId,
    p_delta: -5,
  });
  check(
    "apply_hp_delta dropping a concentrating character to exactly 0 clears concentration with no pending check",
    !dropError &&
      droppedManual?.current_hp === 0 &&
      droppedManual?.concentrating_on === null &&
      droppedManual?.pending_concentration_dc === null,
    dropError?.message ?? JSON.stringify(droppedManual)
  );

  await setState(bobCharacterId, { current_hp: 5, concentrating_on: "Bless" });
  await attackDamage(alice, aliceCharacterId, bobCharacterId, 20);
  let bobState = await getState(bobCharacterId);
  check(
    "resolve_attack_damage dropping a concentrating target to 0 clears concentration with no pending check",
    bobState.current_hp === 0 && bobState.concentrating_on === null && bobState.pending_concentration_dc === null,
    JSON.stringify(bobState)
  );

  // While already at 0 (concentration long gone), further damage keeps the
  // death-save machinery running and never resurrects a pending check —
  // the walked-through invariant that the transition TO 0 already ended it.
  await attackDamage(alice, aliceCharacterId, bobCharacterId, 5);
  bobState = await getState(bobCharacterId);
  check(
    "a later hit on the already-0-HP target adds its death-save failure and still no concentration state",
    bobState.death_save_failures === 1 && bobState.concentrating_on === null && bobState.pending_concentration_dc === null,
    JSON.stringify(bobState)
  );

  // -- 3. Damage that leaves a concentrating character above 0 sets the
  //    pending DC at max(10, floor(damage / 2)) — both bands, both paths. --
  await setState(aliceCharacterId, { concentrating_on: "Bless" });
  const { data: chip8 } = await alice.client.rpc("apply_hp_delta", {
    p_character_id: aliceCharacterId,
    p_delta: -8,
  });
  check(
    "8 damage via apply_hp_delta → DC 10 (the floor), concentration still held",
    chip8?.pending_concentration_dc === 10 && chip8?.concentrating_on === "Bless" && chip8?.current_hp === 32,
    JSON.stringify(chip8)
  );

  await setState(aliceCharacterId, { concentrating_on: "Bless" });
  const { data: chip30 } = await alice.client.rpc("apply_hp_delta", {
    p_character_id: aliceCharacterId,
    p_delta: -30,
  });
  check(
    "30 damage via apply_hp_delta → DC 15",
    chip30?.pending_concentration_dc === 15 && chip30?.concentrating_on === "Bless",
    JSON.stringify(chip30)
  );

  await setState(aliceCharacterId, { concentrating_on: "Bless" });
  const { data: chip25 } = await alice.client.rpc("apply_hp_delta", {
    p_character_id: aliceCharacterId,
    p_delta: -25,
  });
  check(
    "25 damage → DC 12 (floor of 12.5, not rounded to 13)",
    chip25?.pending_concentration_dc === 12,
    JSON.stringify(chip25)
  );

  await setState(bobCharacterId, { concentrating_on: "Hold Person" });
  await attackDamage(alice, aliceCharacterId, bobCharacterId, 8);
  bobState = await getState(bobCharacterId);
  check(
    "8 damage via resolve_attack_damage → DC 10, concentration still held",
    bobState.pending_concentration_dc === 10 && bobState.concentrating_on === "Hold Person" && bobState.current_hp === 32,
    JSON.stringify(bobState)
  );

  await setState(bobCharacterId, { concentrating_on: "Hold Person" });
  await attackDamage(alice, aliceCharacterId, bobCharacterId, 30);
  bobState = await getState(bobCharacterId);
  check(
    "30 damage via resolve_attack_damage → DC 15",
    bobState.pending_concentration_dc === 15 && bobState.concentrating_on === "Hold Person",
    JSON.stringify(bobState)
  );

  // Damage to a NON-concentrating character never creates a check.
  await setState(aliceCharacterId, {});
  const { data: nonConc } = await alice.client.rpc("apply_hp_delta", {
    p_character_id: aliceCharacterId,
    p_delta: -30,
  });
  check(
    "damage to a non-concentrating character creates no pending check",
    nonConc?.pending_concentration_dc === null,
    JSON.stringify(nonConc)
  );

  // -- 4. A second hit before the first check resolves OVERWRITES the
  //    pending DC (no queue — the documented scope simplification). --
  await setState(aliceCharacterId, { concentrating_on: "Bless" });
  await alice.client.rpc("apply_hp_delta", { p_character_id: aliceCharacterId, p_delta: -8 });
  const { data: overwritten } = await alice.client.rpc("apply_hp_delta", {
    p_character_id: aliceCharacterId,
    p_delta: -30,
  });
  check(
    "a second hit overwrites the pending DC with the fresh one (10 → 15), not a queue",
    overwritten?.pending_concentration_dc === 15,
    JSON.stringify(overwritten)
  );
  await setState(aliceCharacterId, { concentrating_on: "Bless", pending_concentration_dc: 15 });
  const { data: overwrittenDown } = await alice.client.rpc("apply_hp_delta", {
    p_character_id: aliceCharacterId,
    p_delta: -8,
  });
  check(
    "the overwrite goes DOWN too (15 → 10) — the freshest hit's DC wins",
    overwrittenDown?.pending_concentration_dc === 10,
    JSON.stringify(overwrittenDown)
  );

  // -- 5. The live roll route: a plain normal-mode d20 + CON save bonus
  //    (+1 CON, +3 proficiency for a level-5 Fighter) against the STORED
  //    DC; >= keeps the spell, < clears it, the pending flag clears either
  //    way. Retry from a clean slate until both outcomes are observed. --
  let sawPass = false;
  let sawFail = false;
  let shapeOk = true;
  let mathOk = true;
  let detail = null;
  for (let i = 0; i < 300 && !(sawPass && sawFail); i++) {
    await setState(aliceCharacterId, { concentrating_on: "Bless", pending_concentration_dc: 10 });
    // mode sent on purpose — the server must force "normal" for this kind.
    const roll = await postRoll(alice, campaignId, {
      kind: "concentration_save",
      characterId: aliceCharacterId,
      mode: "advantage",
    });
    const breakdown = roll.body?.roll?.breakdown;
    const resolution = breakdown?.concentrationSave;
    if (!roll.body?.ok || !resolution) {
      shapeOk = false;
      detail = JSON.stringify(roll.body);
      break;
    }
    const bonus = breakdown.modifiers.reduce((sum, part) => sum + part.value, 0);
    if (
      roll.body.roll.kind !== "concentration_save" ||
      breakdown.mode !== "normal" ||
      breakdown.d20Rolls.length !== 1 ||
      breakdown.label !== "Concentration save (DC 10)" ||
      bonus !== 4 ||
      !breakdown.modifiers.some((part) => part.label === "Constitution modifier" && part.value === 1) ||
      !breakdown.modifiers.some((part) => part.label === "Proficiency" && part.value === 3) ||
      roll.body.roll.total !== breakdown.d20Result + bonus ||
      resolution.dc !== 10 ||
      resolution.total !== roll.body.roll.total ||
      resolution.spellName !== "Bless"
    ) {
      shapeOk = false;
      detail = JSON.stringify(breakdown);
      break;
    }
    const state = await getState(aliceCharacterId);
    const expectedPass = roll.body.roll.total >= 10;
    if (resolution.passed !== expectedPass || state.pending_concentration_dc !== null) {
      mathOk = false;
      detail = JSON.stringify({ resolution, state });
      break;
    }
    if (expectedPass) {
      sawPass = true;
      if (state.concentrating_on !== "Bless") {
        mathOk = false;
        detail = `pass → ${JSON.stringify(state)}`;
        break;
      }
    } else {
      sawFail = true;
      if (state.concentrating_on !== null) {
        mathOk = false;
        detail = `fail → ${JSON.stringify(state)}`;
        break;
      }
    }
  }
  check(
    "every live concentration save is a single normal-mode d20 + CON save bonus vs the stored DC (client mode ignored)",
    shapeOk,
    detail
  );
  check("a passed save (total >= DC) keeps the spell and clears the pending flag", mathOk && sawPass, detail);
  check("a failed save (total < DC) clears both the spell and the pending flag", mathOk && sawFail, detail);

  // -- 6. Nothing pending → 400, and nothing logged. --
  await setState(aliceCharacterId, { concentrating_on: "Bless" });
  const logsBefore = await countConcentrationSaveLogs();
  const nothingPending = await postRoll(alice, campaignId, {
    kind: "concentration_save",
    characterId: aliceCharacterId,
  });
  check(
    "rolling with no pending check is rejected with a 400",
    nothingPending.status === 400 && /no concentration check is pending/i.test(nothingPending.body?.message ?? ""),
    JSON.stringify(nothingPending.body)
  );
  check("the rejected roll logged nothing", (await countConcentrationSaveLogs()) === logsBefore);

  // A stale double-submit at the RPC level is also rejected distinctly.
  const { error: staleError } = await alice.client.rpc("resolve_concentration_save", {
    p_character_id: aliceCharacterId,
    p_passed: true,
  });
  check(
    "resolve_concentration_save re-validates server-side: no pending check → distinct exception",
    staleError?.message?.includes("No concentration check is pending"),
    staleError?.message
  );

  // -- 7. The incapacitating-condition flow, mirrored at the data layer
  //    exactly as GameRoom.handleToggleCondition orchestrates it (apply
  //    the condition through the untouched 0029 path, then — only when
  //    the catalog flags the condition incapacitated — a separate
  //    stop-concentrating write). stunned sets effects.incapacitated in
  //    the rules-engine catalog; poisoned does not. --
  const INCAPACITATING = { stunned: true, poisoned: false }; // mirrors CONDITION_BY_KEY effects
  await setState(aliceCharacterId, { concentrating_on: "Hold Person" });
  for (const key of ["poisoned", "stunned"]) {
    const { error: applyError } = await alice.client
      .from("combatant_conditions")
      .upsert(
        { combatant_id: aliceCombatant.id, condition_key: key },
        { onConflict: "combatant_id,condition_key", ignoreDuplicates: true }
      );
    if (applyError) throw new Error(`applying ${key}: ${applyError.message}`);
    if (key === "poisoned") {
      const state = await getState(aliceCharacterId);
      check(
        "a non-incapacitating condition (poisoned) does NOT touch concentration",
        state.concentrating_on === "Hold Person" && state.pending_concentration_dc === null,
        JSON.stringify(state)
      );
    }
    if (INCAPACITATING[key]) {
      // The room's second step: stopConcentrating through the owner RLS.
      const { error: stopError } = await alice.client
        .from("characters")
        .update({ concentrating_on: null, pending_concentration_dc: null, updated_at: new Date().toISOString() })
        .eq("id", aliceCharacterId);
      if (stopError) throw new Error(`stop concentrating after ${key}: ${stopError.message}`);
      const state = await getState(aliceCharacterId);
      check(
        "an incapacitating condition (stunned) ends concentration immediately, no save involved",
        state.concentrating_on === null && state.pending_concentration_dc === null,
        JSON.stringify(state)
      );
      check("the condition-break involved no concentration_save log entry", (await countConcentrationSaveLogs()) === logsBefore);
    }
  }

  // -- 8. Authorization: a non-owner non-DM can't start, stop, or roll
  //    concentration for someone else's character — but the DM can. --
  await setState(aliceCharacterId, { concentrating_on: "Bless", pending_concentration_dc: 10 });
  const { data: bobStartRows } = await bob.client
    .from("characters")
    .update({ concentrating_on: "Fireball", updated_at: new Date().toISOString() })
    .eq("id", aliceCharacterId)
    .select();
  let aliceState = await getState(aliceCharacterId);
  check(
    "another player cannot start/replace concentration on a character they don't own (RLS: zero rows)",
    (bobStartRows ?? []).length === 0 && aliceState.concentrating_on === "Bless",
    JSON.stringify({ bobStartRows, aliceState })
  );

  const { data: bobStopRows } = await bob.client
    .from("characters")
    .update({ concentrating_on: null, pending_concentration_dc: null, updated_at: new Date().toISOString() })
    .eq("id", aliceCharacterId)
    .select();
  aliceState = await getState(aliceCharacterId);
  check(
    "another player cannot stop someone else's concentration",
    (bobStopRows ?? []).length === 0 && aliceState.concentrating_on === "Bless" && aliceState.pending_concentration_dc === 10,
    JSON.stringify({ bobStopRows, aliceState })
  );

  const { error: bobRpcError } = await bob.client.rpc("resolve_concentration_save", {
    p_character_id: aliceCharacterId,
    p_passed: true,
  });
  check(
    "another player's direct resolve_concentration_save call is rejected opaquely",
    bobRpcError?.message?.includes("Character not found"),
    bobRpcError?.message
  );

  const bobRouteRoll = await postRoll(bob, campaignId, {
    kind: "concentration_save",
    characterId: aliceCharacterId,
  });
  check("another player's route roll for an unreadable character is a 404", bobRouteRoll.status === 404, JSON.stringify(bobRouteRoll.body));

  const dmRouteRoll = await postRoll(dm, campaignId, {
    kind: "concentration_save",
    characterId: aliceCharacterId,
  });
  check(
    "the DM can roll a player's pending concentration save",
    dmRouteRoll.status === 200 && dmRouteRoll.body?.roll?.kind === "concentration_save",
    JSON.stringify(dmRouteRoll.body)
  );

  // -- 9. Live sync, both feeds — gated on the channel actually being
  //    joined, and retried until the event lands (the documented
  //    fixed-timeout flakiness lesson from this repo's older scripts). --
  await bob.client.realtime.setAuth((await bob.client.auth.getSession()).data.session.access_token);
  await dm.client.realtime.setAuth((await dm.client.auth.getSession()).data.session.access_token);

  // 9a. A concentration_save roll_log INSERT reaches another member.
  let lastLiveRoll = null;
  const rollReceived = new Promise((resolve, reject) => {
    let rollTimer = null;
    const timer = setTimeout(() => {
      if (rollTimer) clearInterval(rollTimer);
      reject(new Error(`no roll_log event within 20s (last roll: ${JSON.stringify(lastLiveRoll?.body)})`));
    }, 20000);
    // Each retry re-arms the pending check and inserts a fresh row — even
    // gating on the joined channel, the postgres subscription can become
    // active moments after the join, so a single immediate insert can
    // slip past it.
    const rollOnce = async () => {
      await setState(aliceCharacterId, { concentrating_on: "Bless", pending_concentration_dc: 10 });
      lastLiveRoll = await postRoll(alice, campaignId, { kind: "concentration_save", characterId: aliceCharacterId });
    };
    const channel = bob.client
      .channel(`verify-concentration-rolls:${campaignId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "roll_log", filter: `campaign_id=eq.${campaignId}` },
        (payload) => {
          if (payload.new.kind !== "concentration_save") return;
          clearTimeout(timer);
          if (rollTimer) clearInterval(rollTimer);
          resolve(payload.new);
        }
      )
      .subscribe();
    const waitSubscribed = setInterval(() => {
      if (channel.state === "joined") {
        clearInterval(waitSubscribed);
        void rollOnce();
        rollTimer = setInterval(() => void rollOnce(), 1500);
      }
    }, 100);
  });
  try {
    const event = await rollReceived;
    check(
      "another member's postgres_changes subscription received the concentration save live",
      event.kind === "concentration_save" &&
        event.campaign_id === campaignId &&
        event.character_id === aliceCharacterId &&
        event.breakdown?.concentrationSave !== undefined,
      JSON.stringify(event)
    );
  } catch (err) {
    check("another member's postgres_changes subscription received the concentration save live", false, err.message);
  }

  // 9b. A start/stop-concentrating characters UPDATE reaches the DM's
  // per-character subscription (characters RLS hides Alice's row from
  // Bob, so the DM is the "another member" who can legitimately see it —
  // exactly who subscribeToCharacterChanges serves on the sheet page).
  await setState(aliceCharacterId, {});
  const characterReceived = new Promise((resolve, reject) => {
    let writeTimer = null;
    const timer = setTimeout(() => {
      if (writeTimer) clearInterval(writeTimer);
      reject(new Error("no characters UPDATE event within 20s"));
    }, 20000);
    // Alternate start/stop so every retry is a real change.
    let flip = false;
    const writeOnce = async () => {
      flip = !flip;
      await alice.client
        .from("characters")
        .update({
          concentrating_on: flip ? "Hold Person" : null,
          pending_concentration_dc: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", aliceCharacterId);
    };
    const channel = dm.client
      .channel(`verify-concentration-characters:${aliceCharacterId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "characters", filter: `id=eq.${aliceCharacterId}` },
        (payload) => {
          if (payload.new.concentrating_on !== "Hold Person") return;
          clearTimeout(timer);
          if (writeTimer) clearInterval(writeTimer);
          resolve(payload.new);
        }
      )
      .subscribe();
    const waitSubscribed = setInterval(() => {
      if (channel.state === "joined") {
        clearInterval(waitSubscribed);
        void writeOnce();
        writeTimer = setInterval(() => void writeOnce(), 1500);
      }
    }, 100);
  });
  try {
    const event = await characterReceived;
    check(
      "a start-concentrating change reached the DM's postgres_changes character subscription live",
      event.id === aliceCharacterId && event.concentrating_on === "Hold Person",
      JSON.stringify(event)
    );
  } catch (err) {
    check("a start-concentrating change reached the DM's postgres_changes character subscription live", false, err.message);
  }
} finally {
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
  await admin.auth.admin.deleteUser(bob.id);
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
console.log("\nAll concentration checks passed.");
process.exit(0);
