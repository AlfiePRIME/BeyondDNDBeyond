#!/usr/bin/env node
// DM NPC/monster stat block verification (Prompt 61 acceptance criteria).
//
// Seeds a campaign (DM + one player) on a 10x1 bright corridor with two
// player-owned PCs (attacker/target "Target Tim", hider "Sneaky Alice" —
// DEX 18, not Stealth-proficient, totals 5-24) and a bare NPC "Goblin
// Watcher". The DM stats up "Goblin Boss" (HP 30 / AC 15 / PP 25, attacks
// Claw +5 1d4+2, Bite +5 2d4+10, Slam +5 10d10+60) and "Sentinel" (HP 20 /
// AC 13 / PP 25), places the Boss BEFORE combat (nothing to join — the
// quick-add's no-combat half) and the Sentinel DURING combat via
// add_combatant (the mid-fight half). Drives the roll Route Handler over
// real HTTP with signed-in session cookies (the verify-hide-stealth
// arrangement) and a real Playwright browser for the AC auto-fill checks.
//
// Checks: DM-only stat block CRUD (a player's insert/update/delete is
// rejected/no-ops under 0038 RLS); quick-add before combat just places a
// linked token; start_combat's seed snapshots monster_stat_block_id and
// initializes npc_current_hp from the template; add_combatant seats a
// mid-fight monster at its initiative in the canonical turn order, rejects
// a duplicate add, and is DM-only; a monster attack rolls through the roll
// route using the STORED bonus/damage (total = d20 + stored bonus, damage
// dice = the stored notation, attackKind "stat_block", character_id null),
// hits/misses resolve via the same resolveAttackOutcome semantics, and a
// hit applies damage to a PC via resolve_npc_attack_damage with the SAME
// death-save/instant-death/concentration bookkeeping resolve_attack_damage
// provides (drop-to-0 starts the sequence, at-0 damage adds 1 failure or 2
// on a crit, >= max HP at 0 kills outright, damage while concentrating
// sets the pending DC); NPC attacks are action-economy gated in Strict
// mode exactly like PC attacks; apply_npc_hp_delta clamps to [0, template
// max_hp] and is DM-only; target AC auto-fills from a stat block in both
// the DM's and a player's open room (a bare NPC still needs manual entry);
// a stat-blocked NPC observer's Hide resolution uses its REAL
// passive_perception while a bare NPC observer keeps the flat default of
// 10; a stat-blocked NPC hider rolls Prompt 60's plain d20 unchanged, and
// its own stat-block attack reveals it with "attacking from hiding"
// advantage; and a non-DM can neither fire a monster attack (403) nor call
// add_combatant/apply_npc_hp_delta/resolve_npc_attack_damage directly.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-npc-stat-blocks.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

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

function sessionCookies(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value, url: APP_URL }];
  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `npc-stat-blocks-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Statblock ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session, cookie: sessionCookieHeader(signIn.session) };
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

function attackFacts(roll) {
  const breakdown = roll.body?.roll?.breakdown;
  return {
    ok: roll.status === 200 && !!roll.body?.ok,
    status: roll.status,
    id: roll.body?.roll?.id,
    characterId: roll.body?.roll?.character_id,
    total: roll.body?.roll?.total,
    d20: breakdown?.d20Result,
    d20Rolls: breakdown?.d20Rolls,
    mode: breakdown?.mode,
    label: breakdown?.label,
    modifiers: breakdown?.modifiers,
    attack: breakdown?.attack,
  };
}

/** Fires the Boss's named attack at the given target until the outcome
 * predicate holds (a natural 1/20 can flip any single roll), asserting the
 * stored-numbers invariants on EVERY roll along the way. */
async function rollAttackUntil(user, campaignId, request, predicate, tries = 40) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = attackFacts(await postRoll(user, campaignId, { kind: "attack", ...request }));
    if (!last.ok) return last;
    if (predicate(last)) return last;
  }
  return last;
}

async function characterRow(id) {
  const { data } = await admin.from("characters").select().eq("id", id).maybeSingle();
  return data;
}

async function combatantRow(id) {
  const { data } = await admin.from("combat_combatants").select().eq("id", id).maybeSingle();
  return data;
}

/** The canonical turn order (initiative desc nulls last, created_at, id) —
 * the exact ORDER BY advance_turn and listCombatCombatants share. */
async function turnOrder(encounterId) {
  const { data } = await admin
    .from("combat_combatants")
    .select()
    .eq("encounter_id", encounterId)
    .order("initiative", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return data ?? [];
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch();

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Stat block test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  const baseCharacter = (id, ownerId, name, overrides = {}) => ({
    id,
    campaign_id: campaignId,
    owner_id: ownerId,
    name,
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 8,
    current_hp: 50,
    max_hp: 50,
    armor_class: 15,
    speed: 30,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: [],
    ...overrides,
  });
  const timCharId = crypto.randomUUID();
  const aliceCharId = crypto.randomUUID();
  await admin.from("characters").insert([
    baseCharacter(timCharId, player.id, "Target Tim"),
    baseCharacter(aliceCharId, player.id, "Sneaky Alice", { dexterity: 18 }),
  ]);

  // A 10x1 corridor, bright by sparse default — perception never blocks
  // anything here, so hide/attack outcomes ride passives and dice alone.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Stat block corridor",
    grid_width: 10,
    grid_height: 1,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // -- 1. Stat block CRUD is DM-only (0038 RLS). --
  const { data: bossBlock, error: bossBlockError } = await dm.client
    .from("monster_stat_blocks")
    .insert({
      campaign_id: campaignId,
      name: "Goblin Boss",
      max_hp: 30,
      armor_class: 15,
      passive_perception: 25,
      attacks: [
        { name: "Claw", bonus: 5, damageNotation: "1d4+2" },
        { name: "Bite", bonus: 5, damageNotation: "2d4+10" },
        { name: "Slam", bonus: 5, damageNotation: "10d10+60" },
      ],
    })
    .select()
    .single();
  const { data: sentinelBlock, error: sentinelBlockError } = await dm.client
    .from("monster_stat_blocks")
    .insert({
      campaign_id: campaignId,
      name: "Sentinel",
      max_hp: 20,
      armor_class: 13,
      passive_perception: 25,
      attacks: [{ name: "Halberd", bonus: 4, damageNotation: "1d10+2" }],
    })
    .select()
    .single();
  check(
    "the DM can create stat blocks with several attacks",
    !bossBlockError && !sentinelBlockError && bossBlock?.attacks?.length === 3,
    JSON.stringify({ boss: bossBlockError?.message, sentinel: sentinelBlockError?.message })
  );
  const { error: playerCreateError } = await player.client.from("monster_stat_blocks").insert({
    campaign_id: campaignId,
    name: "Forged Dragon",
    max_hp: 999,
    armor_class: 25,
    attacks: [],
  });
  await player.client.from("monster_stat_blocks").update({ armor_class: 1 }).eq("id", bossBlock.id);
  await player.client.from("monster_stat_blocks").delete().eq("id", bossBlock.id);
  const { data: bossAfterPlayer } = await admin
    .from("monster_stat_blocks")
    .select()
    .eq("id", bossBlock.id)
    .maybeSingle();
  check(
    "a non-DM member cannot create stat blocks (RLS insert rejected) and their update/delete silently match nothing",
    playerCreateError !== null && bossAfterPlayer?.armor_class === 15,
    JSON.stringify({ insert: playerCreateError?.message ?? "insert unexpectedly succeeded", ac: bossAfterPlayer?.armor_class })
  );
  const { data: playerReadBlocks } = await player.client
    .from("monster_stat_blocks")
    .select()
    .eq("campaign_id", campaignId);
  check(
    "campaign members can READ stat blocks (the AC auto-fill and passive-Perception lookups need them)",
    (playerReadBlocks ?? []).length === 2,
    `${(playerReadBlocks ?? []).length} row(s) visible`
  );

  // -- 2. Quick-add BEFORE combat: placing the linked token IS the whole
  //    action — no encounter exists to join. The token write is the exact
  //    placeNpcToken shape the UI issues (DM-only under 0019 RLS). --
  const { data: bossToken, error: bossTokenError } = await dm.client
    .from("map_tokens")
    .insert({
      map_id: mapId,
      npc_name: bossBlock.name,
      monster_stat_block_id: bossBlock.id,
      x: 3,
      y: 0,
      elevation: 0,
      allegiance: "hostile",
    })
    .select()
    .single();
  const { count: encounterCount } = await admin
    .from("combat_encounters")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  check(
    "quick-adding BEFORE combat places a stat-block-linked token (npc_name from the block's name) with no encounter to join",
    !bossTokenError &&
      bossToken?.monster_stat_block_id === bossBlock.id &&
      bossToken?.npc_name === "Goblin Boss" &&
      encounterCount === 0,
    JSON.stringify({ error: bossTokenError?.message, encounters: encounterCount })
  );
  const { error: playerPlaceError } = await player.client.from("map_tokens").insert({
    map_id: mapId,
    npc_name: "Forged Boss",
    monster_stat_block_id: bossBlock.id,
    x: 5,
    y: 0,
    elevation: 0,
    allegiance: "hostile",
  });
  check(
    "a non-DM cannot place a stat-blocked NPC token (0019's NPC-placement RLS unchanged)",
    playerPlaceError !== null,
    playerPlaceError?.message ?? "insert unexpectedly succeeded"
  );

  // The PCs and the bare NPC join the map, then combat starts.
  const timTokenId = crypto.randomUUID();
  const aliceTokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: timTokenId, map_id: mapId, character_id: timCharId, npc_name: null, x: 1, y: 0, elevation: 0, allegiance: "party" },
    { id: aliceTokenId, map_id: mapId, character_id: aliceCharId, npc_name: null, x: 0, y: 0, elevation: 0, allegiance: "party" },
    { id: goblinTokenId, map_id: mapId, character_id: null, npc_name: "Goblin Watcher", x: 2, y: 0, elevation: 0, allegiance: "hostile" },
  ]);

  // -- 3. start_combat's seed snapshots the stat block link and seeds
  //    npc_current_hp from the template's max_hp. --
  const { data: encounterId, error: startError } = await dm.client.rpc("start_combat", {
    p_campaign_id: campaignId,
  });
  const seeded = await turnOrder(encounterId);
  const bossCombatant = seeded.find((row) => row.token_id === bossToken.id);
  const timCombatant = seeded.find((row) => row.token_id === timTokenId);
  const aliceCombatant = seeded.find((row) => row.token_id === aliceTokenId);
  const goblinCombatant = seeded.find((row) => row.token_id === goblinTokenId);
  check(
    "start_combat seeds a stat-blocked token's combatant with monster_stat_block_id snapshotted and npc_current_hp = the template's max_hp",
    !startError &&
      bossCombatant?.monster_stat_block_id === bossBlock.id &&
      bossCombatant?.npc_current_hp === 30 &&
      timCombatant?.npc_current_hp === null &&
      goblinCombatant?.npc_current_hp === null &&
      goblinCombatant?.monster_stat_block_id === null,
    JSON.stringify({
      error: startError?.message,
      boss: { link: bossCombatant?.monster_stat_block_id, hp: bossCombatant?.npc_current_hp },
    })
  );

  // Fixed initiatives: Alice on top so the current-turn pointer (index 0)
  // never lands on the Boss during the attack phases below.
  await admin.from("combat_combatants").update({ initiative: 30 }).eq("id", aliceCombatant.id);
  await admin.from("combat_combatants").update({ initiative: 25 }).eq("id", timCombatant.id);
  await admin.from("combat_combatants").update({ initiative: 15 }).eq("id", goblinCombatant.id);
  await admin.from("combat_combatants").update({ initiative: 10 }).eq("id", bossCombatant.id);

  // -- 4. Quick-add DURING combat: place the Sentinel's token and seat it
  //    via add_combatant at initiative 18 — the canonical turn order puts
  //    it exactly between Tim (25) and the Goblin (15). --
  const { data: sentinelToken } = await dm.client
    .from("map_tokens")
    .insert({
      map_id: mapId,
      npc_name: sentinelBlock.name,
      monster_stat_block_id: sentinelBlock.id,
      x: 4,
      y: 0,
      elevation: 0,
      allegiance: "hostile",
    })
    .select()
    .single();
  const { data: sentinelCombatant, error: addError } = await dm.client.rpc("add_combatant", {
    p_encounter_id: encounterId,
    p_token_id: sentinelToken.id,
    p_initiative: 18,
  });
  const orderAfterAdd = await turnOrder(encounterId);
  check(
    "add_combatant seats a mid-fight monster (snapshot + npc_current_hp from its template) at the given initiative",
    !addError &&
      sentinelCombatant?.monster_stat_block_id === sentinelBlock.id &&
      sentinelCombatant?.npc_current_hp === 20 &&
      sentinelCombatant?.initiative === 18,
    JSON.stringify({ error: addError?.message, row: sentinelCombatant })
  );
  check(
    "the new combatant appears at the correct sorted position in the canonical turn order (30, 25, 18, 15, 10)",
    orderAfterAdd.length === 5 &&
      orderAfterAdd[2]?.id === sentinelCombatant?.id &&
      JSON.stringify(orderAfterAdd.map((row) => row.initiative)) === JSON.stringify([30, 25, 18, 15, 10]),
    JSON.stringify(orderAfterAdd.map((row) => [row.npc_name, row.initiative]))
  );
  const { error: duplicateAddError } = await dm.client.rpc("add_combatant", {
    p_encounter_id: encounterId,
    p_token_id: sentinelToken.id,
    p_initiative: 12,
  });
  check(
    "adding the same token to the encounter twice is rejected cleanly",
    duplicateAddError !== null && /already in this encounter/i.test(duplicateAddError?.message ?? ""),
    duplicateAddError?.message ?? "duplicate add unexpectedly succeeded"
  );
  const { error: playerAddError } = await player.client.rpc("add_combatant", {
    p_encounter_id: encounterId,
    p_token_id: goblinTokenId,
    p_initiative: 50,
  });
  check(
    "a non-DM cannot call add_combatant",
    playerAddError !== null,
    playerAddError?.message ?? "call unexpectedly succeeded"
  );

  // -- 5. The monster attack through the roll route: stored bonus and
  //    damage, not rules-engine-derived values. AC 1 hits on everything
  //    but a natural 1; AC 99 misses on everything but a natural 20. --
  const clawRequest = {
    attackerCombatantId: bossCombatant.id,
    attackName: "Claw",
    targetAc: 1,
    targetCharacterId: timCharId,
    targetTokenId: timTokenId,
    targetName: "Target Tim",
  };
  const timBefore = await characterRow(timCharId);
  const hit = await rollAttackUntil(dm, campaignId, clawRequest, (facts) => facts.attack?.hit === true);
  const timAfterHit = await characterRow(timCharId);
  check(
    "a monster's attack rolls through the roll route with its STORED bonus (+5) — total = d20 + 5, a single 'Attack bonus' modifier, no ability/proficiency derivation",
    hit?.ok &&
      hit.total === hit.d20 + 5 &&
      hit.modifiers?.length === 1 &&
      hit.modifiers[0]?.label === "Attack bonus" &&
      hit.modifiers[0]?.value === 5,
    JSON.stringify({ total: hit?.total, d20: hit?.d20, modifiers: hit?.modifiers })
  );
  check(
    'the attack resolves as attackKind "stat_block" with the stored damage notation (1d4+2) and logs with character_id null (the attacker has no character row)',
    hit?.attack?.attackKind === "stat_block" &&
      hit?.attack?.attackName === "Claw" &&
      hit?.attack?.attackerCombatantId === bossCombatant.id &&
      hit?.attack?.damage?.notation === "1d4+2" &&
      hit?.characterId === null &&
      hit?.label === "Goblin Boss — Claw",
    JSON.stringify({ attack: hit?.attack, characterId: hit?.characterId, label: hit?.label })
  );
  check(
    "a hit applies the damage to the PC target via resolve_npc_attack_damage (HP moved by exactly the rolled total, applied echoed in the breakdown)",
    hit?.attack?.applied?.characterId === timCharId &&
      timAfterHit.current_hp === Math.max(0, timBefore.current_hp - hit.attack.damage.total) &&
      hit.attack.applied.newHp === timAfterHit.current_hp,
    JSON.stringify({ before: timBefore.current_hp, after: timAfterHit.current_hp, damage: hit?.attack?.damage?.total })
  );
  const { data: storedAttackRoll } = await admin.from("roll_log").select().eq("id", hit.id).maybeSingle();
  check(
    "the monster attack is persisted in roll_log (kind attack, character_id null) — same shared log as every PC attack",
    storedAttackRoll?.kind === "attack" && storedAttackRoll?.character_id === null,
    JSON.stringify({ kind: storedAttackRoll?.kind, characterId: storedAttackRoll?.character_id })
  );
  const miss = await rollAttackUntil(
    dm,
    campaignId,
    { ...clawRequest, targetAc: 99 },
    (facts) => facts.attack?.hit === false
  );
  check(
    "a miss resolves through the same resolveAttackOutcome semantics (no damage, no application) and still logs",
    miss?.ok && miss.attack?.hit === false && miss.attack?.damage === null && miss.attack?.applied === null,
    JSON.stringify({ hit: miss?.attack?.hit, damage: miss?.attack?.damage })
  );
  const badName = await postRoll(dm, campaignId, {
    kind: "attack",
    attackerCombatantId: bossCombatant.id,
    attackName: "Tail Whip",
    targetAc: 10,
  });
  check(
    "an attack name the stat block doesn't store is rejected (400) — nothing client-sent beyond the name is trusted",
    badName.status === 400,
    `status ${badName.status}`
  );
  const playerFires = await postRoll(player, campaignId, { kind: "attack", ...clawRequest });
  check(
    "a non-DM cannot fire a monster's attack through the roll route (403)",
    playerFires.status === 403,
    `status ${playerFires.status}`
  );

  // -- 6. Death-save/instant-death/concentration bookkeeping mirrors
  //    resolve_attack_damage exactly. --
  // 6a: dropping from >0 to exactly 0 starts the sequence with NO failure.
  await admin
    .from("characters")
    .update({ current_hp: 5, death_save_successes: 0, death_save_failures: 0, is_stable: false, is_dead: false })
    .eq("id", timCharId);
  const dropHit = await rollAttackUntil(
    dm,
    campaignId,
    { ...clawRequest, attackName: "Bite" }, // 2d4+10: minimum 12 > 5, never >= max 50
    (facts) => facts.attack?.hit === true
  );
  const timAtZero = await characterRow(timCharId);
  check(
    "an NPC attack dropping a PC from above 0 to exactly 0 starts the death-save sequence (0 HP, no failures, not stable, not dead) — exactly like a PC's attack",
    dropHit?.ok &&
      timAtZero.current_hp === 0 &&
      timAtZero.death_save_failures === 0 &&
      timAtZero.is_stable === false &&
      timAtZero.is_dead === false &&
      dropHit.attack?.instantDeath === false &&
      dropHit.attack?.deathSaveFailureAdded === 0,
    JSON.stringify({ hp: timAtZero.current_hp, failures: timAtZero.death_save_failures, breakdown: dropHit?.attack })
  );
  // 6b: damage while already at 0 adds one failure — two on a critical.
  const atZeroHit = await rollAttackUntil(dm, campaignId, clawRequest, (facts) => facts.attack?.hit === true);
  const timAfterZeroHit = await characterRow(timCharId);
  const expectedFailures = atZeroHit?.attack?.critical ? 2 : 1;
  check(
    "an NPC attack landing on an already-0-HP PC adds a death-save failure (two on a crit), reported in the breakdown and persisted",
    atZeroHit?.ok &&
      atZeroHit.attack?.deathSaveFailureAdded === expectedFailures &&
      timAfterZeroHit.death_save_failures === expectedFailures,
    JSON.stringify({ crit: atZeroHit?.attack?.critical, added: atZeroHit?.attack?.deathSaveFailureAdded, db: timAfterZeroHit.death_save_failures })
  );
  // 6c: at-0 damage >= max HP kills outright.
  await admin
    .from("characters")
    .update({ current_hp: 0, death_save_successes: 0, death_save_failures: 0, is_stable: false, is_dead: false })
    .eq("id", timCharId);
  const slamHit = await rollAttackUntil(
    dm,
    campaignId,
    { ...clawRequest, attackName: "Slam" }, // 10d10+60: minimum 70 >= max 50
    (facts) => facts.attack?.hit === true
  );
  const timDead = await characterRow(timCharId);
  check(
    "at-0 damage >= max HP from an NPC attack is instant death, no failure counting",
    slamHit?.ok && slamHit.attack?.instantDeath === true && timDead.is_dead === true && timDead.death_save_failures === 0,
    JSON.stringify({ instant: slamHit?.attack?.instantDeath, dead: timDead.is_dead, failures: timDead.death_save_failures })
  );
  // 6d: damage leaving a concentrating PC above 0 sets the pending CON DC.
  await admin
    .from("characters")
    .update({
      current_hp: 50,
      death_save_successes: 0,
      death_save_failures: 0,
      is_stable: false,
      is_dead: false,
      concentrating_on: "Bless",
      pending_concentration_dc: null,
    })
    .eq("id", timCharId);
  const concHit = await rollAttackUntil(dm, campaignId, clawRequest, (facts) => facts.attack?.hit === true);
  const timConcentrating = await characterRow(timCharId);
  check(
    "NPC-attack damage on a concentrating PC above 0 sets pending_concentration_dc = max(10, floor(damage/2)) without breaking the spell",
    concHit?.ok &&
      timConcentrating.concentrating_on === "Bless" &&
      timConcentrating.pending_concentration_dc ===
        Math.max(10, Math.floor(concHit.attack.damage.total / 2)),
    JSON.stringify({ dc: timConcentrating.pending_concentration_dc, damage: concHit?.attack?.damage?.total })
  );
  await admin
    .from("characters")
    .update({ current_hp: 50, concentrating_on: null, pending_concentration_dc: null })
    .eq("id", timCharId);
  const { error: playerResolveError } = await player.client.rpc("resolve_npc_attack_damage", {
    p_attacker_combatant_id: bossCombatant.id,
    p_target_character_id: timCharId,
    p_damage: 10,
    p_critical: false,
    p_breakdown: { type: "d20", label: "forged", mode: "normal", d20Rolls: [10], d20Result: 10, modifiers: [] },
    p_total: 15,
  });
  check(
    "a non-DM cannot call resolve_npc_attack_damage directly",
    playerResolveError !== null,
    playerResolveError?.message ?? "call unexpectedly succeeded"
  );

  // -- 7. NPC attacks are Strict-mode economy-gated like PC attacks: with
  //    the Boss as the CURRENT combatant, the first swing spends the
  //    action and the second is rejected before any die is rolled. --
  const bossIndex = (await turnOrder(encounterId)).findIndex((row) => row.id === bossCombatant.id);
  await admin.from("combat_encounters").update({ current_turn_index: bossIndex }).eq("id", encounterId);
  await admin.from("combat_combatants").update({ action_used: false }).eq("id", bossCombatant.id);
  const firstSwing = await postRoll(dm, campaignId, {
    kind: "attack",
    attackerCombatantId: bossCombatant.id,
    attackName: "Claw",
    targetAc: 99,
  });
  const bossAfterSwing = await combatantRow(bossCombatant.id);
  const secondSwing = await postRoll(dm, campaignId, {
    kind: "attack",
    attackerCombatantId: bossCombatant.id,
    attackName: "Claw",
    targetAc: 99,
  });
  check(
    "on the monster's own turn a Strict-mode attack spends its action (miss included) and a second attack is rejected — the Prompt 53 gate, PC and NPC alike",
    firstSwing.status === 200 &&
      bossAfterSwing.action_used === true &&
      secondSwing.status === 400 &&
      /action/i.test(secondSwing.body?.message ?? ""),
    JSON.stringify({ first: firstSwing.status, used: bossAfterSwing.action_used, second: secondSwing.status, message: secondSwing.body?.message })
  );
  await admin.from("combat_encounters").update({ current_turn_index: 0 }).eq("id", encounterId);
  await admin.from("combat_combatants").update({ action_used: false }).eq("id", bossCombatant.id);

  // -- 8. NPC HP: apply_npc_hp_delta clamps to [0, template max_hp] and is
  //    DM-only (an NPC combatant has no owning player). --
  const { data: damaged, error: damageError } = await dm.client.rpc("apply_npc_hp_delta", {
    p_combatant_id: bossCombatant.id,
    p_delta: -7,
  });
  const { data: overHealed } = await dm.client.rpc("apply_npc_hp_delta", {
    p_combatant_id: bossCombatant.id,
    p_delta: 1000,
  });
  const { data: floored } = await dm.client.rpc("apply_npc_hp_delta", {
    p_combatant_id: bossCombatant.id,
    p_delta: -1000,
  });
  check(
    "apply_npc_hp_delta applies and clamps NPC HP between 0 and the template's max_hp (30 → 23 → 30 → 0)",
    !damageError && damaged?.npc_current_hp === 23 && overHealed?.npc_current_hp === 30 && floored?.npc_current_hp === 0,
    JSON.stringify({ error: damageError?.message, damaged: damaged?.npc_current_hp, healed: overHealed?.npc_current_hp, floored: floored?.npc_current_hp })
  );
  const { error: playerNpcHpError } = await player.client.rpc("apply_npc_hp_delta", {
    p_combatant_id: bossCombatant.id,
    p_delta: -5,
  });
  const { error: pcNpcHpError } = await dm.client.rpc("apply_npc_hp_delta", {
    p_combatant_id: timCombatant.id,
    p_delta: -5,
  });
  check(
    "apply_npc_hp_delta is DM-only for NPC combatants and rejects a PC combatant (no npc_current_hp to move)",
    playerNpcHpError !== null && pcNpcHpError !== null,
    JSON.stringify({ player: playerNpcHpError?.message, pc: pcNpcHpError?.message })
  );
  await admin.from("combat_combatants").update({ npc_current_hp: 30 }).eq("id", bossCombatant.id);

  // -- 9. Hide: a stat-blocked NPC observer resolves against its REAL
  //    passive_perception (Boss/Sentinel 25 — always above Alice's 5-24
  //    totals), while the bare Goblin keeps the flat default of 10,
  //    asserted per-roll from the actual logged total. --
  const hideRoll = await postRoll(player, campaignId, { kind: "hide", combatantId: aliceCombatant.id });
  const hideBreakdown = hideRoll.body?.roll?.breakdown;
  const hideTotal = hideRoll.body?.roll?.total;
  const hiddenIds = (hideBreakdown?.hide?.hiddenFrom ?? []).map((o) => o.combatantId).sort();
  const expectHidden = [
    bossCombatant.id,
    sentinelCombatant.id,
    ...(hideTotal < 10 ? [timCombatant.id, goblinCombatant.id] : []),
  ].sort();
  const sentinelOutcome = [
    ...(hideBreakdown?.hide?.hiddenFrom ?? []),
    ...(hideBreakdown?.hide?.noticedBy ?? []),
  ].find((o) => o.combatantId === sentinelCombatant.id);
  const goblinOutcome = [
    ...(hideBreakdown?.hide?.hiddenFrom ?? []),
    ...(hideBreakdown?.hide?.noticedBy ?? []),
  ].find((o) => o.combatantId === goblinCombatant.id);
  check(
    "a stat-blocked NPC observer's Hide comparison uses its REAL passive_perception (25), not the flat default — Alice (total ≤ 24) always hides from Boss and Sentinel",
    hideRoll.status === 200 &&
      sentinelOutcome?.passivePerception === 25 &&
      JSON.stringify(hiddenIds) === JSON.stringify(expectHidden),
    JSON.stringify({ total: hideTotal, sentinel: sentinelOutcome, hidden: hiddenIds, expected: expectHidden })
  );
  check(
    "a bare NPC observer still gets the flat default of 10 (outcome matches this roll's actual total)",
    goblinOutcome?.passivePerception === 10 &&
      (hideTotal < 10) === hiddenIds.includes(goblinCombatant.id),
    JSON.stringify({ total: hideTotal, goblin: goblinOutcome })
  );
  await admin.from("combatant_hidden_from").delete().eq("hider_combatant_id", aliceCombatant.id);

  // -- 10. A stat-blocked NPC hider rides Prompt 60's machinery UNCHANGED
  //    (a plain unmodified d20, DM-only), and its own stat-block attack
  //    reveals it with "attacking from hiding" advantage. --
  const bossHide = await postRoll(dm, campaignId, { kind: "hide", combatantId: bossCombatant.id });
  const bossHideBreakdown = bossHide.body?.roll?.breakdown;
  check(
    "a stat-blocked NPC hider still rolls Prompt 60's plain unmodified d20 (no stat block Stealth field, by design)",
    bossHide.status === 200 &&
      bossHideBreakdown?.modifiers?.length === 0 &&
      bossHide.body?.roll?.total === bossHideBreakdown?.d20Result,
    JSON.stringify({ status: bossHide.status, modifiers: bossHideBreakdown?.modifiers })
  );
  // Deterministic hidden state for the reveal check, seeded directly (a
  // roll's outcome depends on the die): hidden from Tim AND Alice.
  await admin.from("combatant_hidden_from").delete().eq("hider_combatant_id", bossCombatant.id);
  await admin.from("combatant_hidden_from").insert([
    { hider_combatant_id: bossCombatant.id, observer_combatant_id: timCombatant.id },
    { hider_combatant_id: bossCombatant.id, observer_combatant_id: aliceCombatant.id },
  ]);
  const hiddenAttack = await postRoll(dm, campaignId, { kind: "attack", ...clawRequest });
  const hiddenAttackBreakdown = hiddenAttack.body?.roll?.breakdown;
  const { data: bossHiddenAfter } = await admin
    .from("combatant_hidden_from")
    .select()
    .eq("hider_combatant_id", bossCombatant.id);
  check(
    'a hidden monster\'s stat-block attack rolls with advantage sourced "attacking from hiding" against the target it was hidden from',
    hiddenAttack.status === 200 &&
      hiddenAttackBreakdown?.mode === "advantage" &&
      hiddenAttackBreakdown?.d20Rolls?.length === 2 &&
      hiddenAttackBreakdown?.attack?.advantageSources?.includes("attacking from hiding"),
    JSON.stringify({ mode: hiddenAttackBreakdown?.mode, sources: hiddenAttackBreakdown?.attack?.advantageSources })
  );
  check(
    "the monster's attack reveals it to EVERYONE — every hidden-from row gone, not just the target's",
    (bossHiddenAfter ?? []).length === 0,
    `${(bossHiddenAfter ?? []).length} row(s) left`
  );
  await admin
    .from("characters")
    .update({ current_hp: 50, death_save_successes: 0, death_save_failures: 0, is_stable: false, is_dead: false })
    .eq("id", timCharId);

  // -- 11. AC auto-fill from the stat block, in a real browser, for both
  //    the DM and a player: selecting a stat-blocked NPC target fills its
  //    armor_class; a bare NPC leaves the field for manual entry. --
  async function checkAutoFill(user, who) {
    const context = await browser.newContext();
    await context.addCookies(sessionCookies(user.session));
    const page = await context.newPage();
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="attack-target-select"]', { timeout: 30000 });
    await page.selectOption('[data-testid="attack-target-select"]', { label: "Goblin Watcher" });
    const bareAc = await page.inputValue('[data-testid="attack-target-ac-input"]');
    await page.selectOption('[data-testid="attack-target-select"]', { label: "Goblin Boss" });
    const bossAc = await page.inputValue('[data-testid="attack-target-ac-input"]');
    await page.selectOption('[data-testid="attack-target-select"]', { label: "Sentinel" });
    const sentinelAc = await page.inputValue('[data-testid="attack-target-ac-input"]');
    await context.close();
    check(
      `${who}'s attack form auto-fills a stat-blocked NPC target's AC from its stat block (Boss 15, Sentinel 13) while a bare NPC stays manual`,
      bareAc === "" && bossAc === "15" && sentinelAc === "13",
      JSON.stringify({ bare: bareAc, boss: bossAc, sentinel: sentinelAc })
    );
  }
  await checkAutoFill(dm, "the DM");
  await checkAutoFill(player, "a player");
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
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
console.log("\nAll npc-stat-block checks passed.");
process.exit(0);
