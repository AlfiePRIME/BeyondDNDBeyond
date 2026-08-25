#!/usr/bin/env node
// Dice roller verification (Prompt 48 acceptance criteria, the server-side
// half).
//
// Seeds a campaign (DM + two players, each with a character and a token on
// the live map, plus an NPC token) and exercises the roll Route Handler
// with real authenticated cookies, checking: an ability check's total is
// exactly the server-rolled die plus the rules-engine bonus, advantage/
// disadvantage log both d20s and use the higher/lower across repeated
// rolls, a guaranteed hit applies exactly the logged damage to the target
// PC's HP via resolve_attack_damage, a guaranteed miss applies none, any
// natural 20 against unreachable AC crits with doubled dice (and any
// natural 1 against AC 1 misses), a free-form roll needs no character, the
// attacker-based (not target-owner) authorization lets player A damage
// player B's PC where apply_hp_delta would reject, a direct RPC call
// (bypassing the roll route entirely) still leaves a matching roll_log
// row because the insert is folded into the same transaction as the HP
// write, unauthorized paths are rejected, initiative rolling stores a
// sorted turn order, and a roll INSERT reaches another member's
// postgres_changes subscription live.
//
// Needs the dev server on :3000 and the local Supabase stack.
// Usage: node scripts/db/verify-dice-rolls.mjs

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
  const email = `dice-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Dice Test ${label}` });
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

function abilityModifier(score) {
  return Math.floor((score - 10) / 2);
}

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Dice test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

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
    spells: [],
  });
  await admin.from("characters").insert([
    baseCharacter(aliceCharacterId, alice.id, "Alice PC"),
    baseCharacter(bobCharacterId, bob.id, "Bob PC"),
  ]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Dice arena",
    grid_width: 10,
    grid_height: 10,
  });
  await admin.from("map_tokens").insert([
    { id: crypto.randomUUID(), map_id: mapId, character_id: aliceCharacterId, x: 1, y: 1, elevation: 0, allegiance: "party" },
    { id: crypto.randomUUID(), map_id: mapId, character_id: bobCharacterId, x: 2, y: 1, elevation: 0, allegiance: "party" },
    { id: crypto.randomUUID(), map_id: mapId, npc_name: "Goblin", x: 3, y: 1, elevation: 0, allegiance: "hostile" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // -- 1. A plain ability check: total == server-rolled die + rules-engine
  //    bonus (read the die back from the log and redo the arithmetic). --
  const checkRoll = await postRoll(alice, campaignId, {
    kind: "check",
    characterId: aliceCharacterId,
    ability: "strength",
  });
  check("an ability check succeeds", checkRoll.status === 200 && checkRoll.body?.ok, JSON.stringify(checkRoll.body));
  if (checkRoll.body?.roll) {
    const { breakdown, total } = checkRoll.body.roll;
    const die = breakdown.d20Result;
    check(
      "check total = die + STR modifier (16 → +3), recomputed from the logged die",
      die >= 1 && die <= 20 &&
        total === die + abilityModifier(16) &&
        breakdown.modifiers.length === 1 &&
        breakdown.modifiers[0].value === 3
    );
    const { data: stored } = await admin.from("roll_log").select().eq("id", checkRoll.body.roll.id).single();
    check("the check roll is persisted in roll_log", stored?.kind === "check" && stored.total === total);
  }

  // -- 2. A skill check uses proficiency; a save uses the class's save
  //    proficiencies (Fighter: STR/CON). --
  const skillRoll = await postRoll(alice, campaignId, {
    kind: "skill",
    characterId: aliceCharacterId,
    skill: "Athletics",
  });
  if (skillRoll.body?.roll) {
    const { breakdown, total } = skillRoll.body.roll;
    // Level 5 → proficiency +3; Athletics is STR-based (+3).
    check(
      "a proficient skill check adds STR modifier and proficiency separately",
      total === breakdown.d20Result + 3 + 3 &&
        breakdown.modifiers.some((m) => m.label === "Proficiency" && m.value === 3)
    );
  } else {
    check("a skill check succeeds", false, JSON.stringify(skillRoll.body));
  }

  const saveRoll = await postRoll(alice, campaignId, {
    kind: "save",
    characterId: aliceCharacterId,
    ability: "wisdom",
  });
  if (saveRoll.body?.roll) {
    const { breakdown, total } = saveRoll.body.roll;
    // Fighter has no WIS save proficiency: modifier is only WIS +1.
    check(
      "a non-proficient save is die + ability modifier only",
      total === breakdown.d20Result + 1 && breakdown.modifiers.length === 1
    );
  } else {
    check("a saving throw succeeds", false, JSON.stringify(saveRoll.body));
  }

  // -- 3. A player cannot roll for a character they can't read. --
  const forbidden = await postRoll(alice, campaignId, {
    kind: "check",
    characterId: bobCharacterId,
    ability: "strength",
  });
  check("a player cannot roll using another player's character", forbidden.status === 404);

  // -- 4. Advantage / disadvantage over repeated rolls: both dice logged,
  //    the correct one used every time, and both dice actually vary. --
  for (const [mode, pick] of [["advantage", Math.max], ["disadvantage", Math.min]]) {
    let allCorrect = true;
    let sawTwoDice = true;
    let sawDifferentDice = false;
    for (let i = 0; i < 12; i++) {
      const roll = await postRoll(alice, campaignId, {
        kind: "check",
        characterId: aliceCharacterId,
        ability: "dexterity",
        mode,
      });
      const breakdown = roll.body?.roll?.breakdown;
      if (!breakdown || breakdown.d20Rolls.length !== 2) {
        sawTwoDice = false;
        break;
      }
      if (breakdown.d20Result !== pick(...breakdown.d20Rolls)) allCorrect = false;
      if (breakdown.d20Rolls[0] !== breakdown.d20Rolls[1]) sawDifferentDice = true;
    }
    check(
      `${mode}: both d20s logged and the ${mode === "advantage" ? "higher" : "lower"} used across 12 rolls`,
      sawTwoDice && allCorrect && sawDifferentDice
    );
  }

  // -- 5. An attack that must hit (AC 1, retrying past natural 1s) applies
  //    exactly the logged damage to the target PC via resolve_attack_damage. --
  async function attackUntil(user, body, predicate, attempts = 30) {
    for (let i = 0; i < attempts; i++) {
      const roll = await postRoll(user, campaignId, body);
      const attack = roll.body?.roll?.breakdown?.attack;
      if (!roll.body?.ok) return { roll, attack: null };
      if (predicate(attack)) return { roll, attack };
    }
    return { roll: null, attack: null };
  }

  await admin.from("characters").update({ current_hp: 40 }).eq("id", bobCharacterId);
  const hit = await attackUntil(
    alice,
    {
      kind: "attack",
      characterId: aliceCharacterId,
      attackKind: "melee",
      damageNotation: "2d6+3",
      targetAc: 1,
      targetCharacterId: bobCharacterId,
      targetName: "Bob PC",
    },
    (attack) => attack && attack.hit
  );
  if (hit.attack) {
    const damage = hit.attack.damage;
    const { data: bobRow } = await admin.from("characters").select("current_hp").eq("id", bobCharacterId).single();
    const diceSum = damage.groups.reduce(
      (sum, g) => sum + g.sign * g.results.reduce((a, b) => a + b, 0),
      0
    );
    check(
      "a hit rolls damage whose groups+modifier sum to its total",
      damage.total === Math.max(0, diceSum + damage.modifier)
    );
    check(
      "the hit applied exactly the logged damage to the target PC's HP",
      bobRow.current_hp === 40 - damage.total &&
        hit.attack.applied?.characterId === bobCharacterId &&
        hit.attack.applied?.newHp === bobRow.current_hp
    );
    check(
      "PvP authorization: player A's attack damaged player B's PC (attacker-based, would fail apply_hp_delta's target-owner check)",
      hit.attack.applied !== null
    );
    check(
      "damage dice on a non-crit hit are not doubled",
      hit.attack.critical || (damage.doubled === false && damage.groups[0].count === 2)
    );
  } else {
    check("an attack against AC 1 eventually hits", false, JSON.stringify(hit.roll?.body));
  }

  // Contrast: the same cross-player damage through apply_hp_delta is
  // rejected (the target-owner model this RPC deliberately replaces).
  const { error: hpDeltaError } = await alice.client.rpc("apply_hp_delta", {
    p_character_id: bobCharacterId,
    p_delta: -5,
  });
  check("contrast: apply_hp_delta rejects player A damaging player B directly", !!hpDeltaError);

  // -- 6. An attack that must miss (AC 99, retrying past natural 20s)
  //    applies nothing. --
  await admin.from("characters").update({ current_hp: 40 }).eq("id", bobCharacterId);
  const miss = await attackUntil(
    alice,
    {
      kind: "attack",
      characterId: aliceCharacterId,
      attackKind: "melee",
      damageNotation: "2d6+3",
      targetAc: 99,
      targetCharacterId: bobCharacterId,
      targetName: "Bob PC",
    },
    (attack) => attack && !attack.natural20
  );
  if (miss.attack) {
    const { data: bobRow } = await admin.from("characters").select("current_hp").eq("id", bobCharacterId).single();
    check(
      "a sub-20 roll against AC 99 misses and applies no damage",
      miss.attack.hit === false && miss.attack.damage === null && bobRow.current_hp === 40
    );
  } else {
    check("an attack against AC 99 eventually rolls under 20", false);
  }

  // -- 7. Natural-20 and natural-1 boundary behavior in the live pipeline
  //    (the exact boundary math is unit-tested with injected randomness;
  //    here, roll until each natural shows up and verify the outcome). --
  await admin.from("characters").update({ current_hp: 40 }).eq("id", bobCharacterId);
  const nat20 = await attackUntil(
    alice,
    {
      kind: "attack",
      characterId: aliceCharacterId,
      attackKind: "melee",
      damageNotation: "1d4",
      targetAc: 99,
      targetCharacterId: bobCharacterId,
      targetName: "Bob PC",
    },
    (attack) => attack && attack.natural20,
    200
  );
  if (nat20.attack) {
    check(
      "a live natural 20 against AC 99 hits, crits, and doubles the damage dice (1d4 → 2d4)",
      nat20.attack.hit &&
        nat20.attack.critical &&
        nat20.attack.damage.doubled &&
        nat20.attack.damage.groups[0].count === 2 &&
        nat20.attack.applied !== null
    );
  } else {
    check("a natural 20 occurred within 200 attack rolls", false);
  }

  const nat1 = await attackUntil(
    alice,
    {
      kind: "attack",
      characterId: aliceCharacterId,
      attackKind: "melee",
      damageNotation: "1d4",
      targetAc: 1,
      targetName: "Goblin",
    },
    (attack) => attack && attack.natural1,
    200
  );
  if (nat1.attack) {
    check(
      "a live natural 1 against AC 1 misses despite the bonus",
      nat1.attack.hit === false && nat1.attack.damage === null
    );
  } else {
    check("a natural 1 occurred within 200 attack rolls", false);
  }

  // -- 8. An NPC-target attack (no tracked HP) just logs its numbers. --
  const npcAttack = await attackUntil(
    alice,
    {
      kind: "attack",
      characterId: aliceCharacterId,
      attackKind: "ranged",
      damageNotation: "1d6",
      targetAc: 5,
      targetName: "Goblin",
    },
    (attack) => attack && attack.hit
  );
  check(
    "hitting an NPC target logs damage with nothing to apply",
    npcAttack.attack !== null && npcAttack.attack.damage !== null && npcAttack.attack.applied === null
  );

  // -- 9. Free-form roll: no character, groups sum to the total. --
  const freeform = await postRoll(bob, campaignId, { kind: "freeform", notation: "2d6+1d4+3" });
  if (freeform.body?.roll) {
    const { breakdown, total, character_id } = freeform.body.roll;
    const diceSum = breakdown.groups.reduce(
      (sum, g) => sum + g.sign * g.results.reduce((a, b) => a + b, 0),
      0
    );
    check(
      "a free-form roll is character-free and its groups+modifier equal its total",
      character_id === null &&
        breakdown.groups.length === 2 &&
        breakdown.groups.every((g) => g.results.every((r) => r >= 1 && r <= g.sides)) &&
        total === diceSum + 3
    );
  } else {
    check("a free-form roll succeeds", false, JSON.stringify(freeform.body));
  }

  const badNotation = await postRoll(bob, campaignId, { kind: "freeform", notation: "lol" });
  check("a malformed dice expression is rejected", badNotation.status === 400);

  // -- 10. A non-member can't roll at all. --
  const outsider = await makeTestUser("outsider");
  try {
    const outsiderRoll = await postRoll(outsider, campaignId, { kind: "freeform", notation: "1d6" });
    check("a non-member cannot roll in the campaign", outsiderRoll.status === 404);
  } finally {
    await admin.auth.admin.deleteUser(outsider.id);
  }

  // -- 11. resolve_attack_damage direct-call authorization AND the
  //    atomic-logging fix: this RPC is `grant execute to authenticated`
  //    like any other, so a technically-savvy player could call it
  //    directly, bypassing the roll route's own insertRoll entirely. Since
  //    it's the one RPC that lets a player move HP on a DIFFERENT player's
  //    character, the roll_log insert now happens INSIDE the function
  //    itself (same transaction as the HP write) rather than as a
  //    separate call the route makes afterward — so even a direct call
  //    must leave a matching, auditable trace. --
  const fakeBreakdown = (label) => ({
    type: "d20",
    label,
    mode: "normal",
    d20Rolls: [15],
    d20Result: 15,
    modifiers: [],
    attack: {
      attackKind: "melee",
      targetAc: 10,
      targetName: "Bob PC",
      targetCharacterId: bobCharacterId,
      natural20: false,
      natural1: false,
      hit: true,
      critical: false,
      damage: null,
      applied: null,
    },
  });

  const { error: notAttackerOwner } = await bob.client.rpc("resolve_attack_damage", {
    p_attacker_character_id: aliceCharacterId,
    p_target_character_id: bobCharacterId,
    p_damage: 3,
    p_breakdown: fakeBreakdown("Bob impersonating Alice's attack"),
    p_total: 15,
  });
  check("resolve_attack_damage rejects a caller who doesn't own the attacker", !!notAttackerOwner);

  const { count: rejectedLogged } = await admin
    .from("roll_log")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("roller_user_id", bob.id)
    .eq("kind", "attack")
    .ilike("breakdown->>label", "Bob impersonating%");
  check("a rejected direct call logs nothing (auth check runs before any write)", (rejectedLogged ?? 0) === 0);

  await admin.from("characters").update({ current_hp: 40 }).eq("id", bobCharacterId);
  const { data: dmResolvedRows, error: dmResolveError } = await dm.client
    .rpc("resolve_attack_damage", {
      p_attacker_character_id: aliceCharacterId,
      p_target_character_id: bobCharacterId,
      p_damage: 7,
      p_breakdown: fakeBreakdown("DM-resolved direct call"),
      p_total: 15,
    })
    .select();
  const dmResolved = dmResolvedRows?.[0];
  check(
    "the DM can resolve any attacker's damage directly",
    !dmResolveError && dmResolved?.out_target_id === bobCharacterId && dmResolved?.out_target_current_hp === 33
  );
  const { data: dmRollRow } = await admin
    .from("roll_log")
    .select()
    .eq("id", dmResolved?.out_roll_id)
    .maybeSingle();
  check(
    "the security fix: a direct RPC call (bypassing the roll route entirely) still leaves a matching roll_log row, atomically",
    dmRollRow?.kind === "attack" &&
      dmRollRow.total === 15 &&
      dmRollRow.character_id === aliceCharacterId &&
      dmRollRow.roller_user_id === dm.id &&
      dmRollRow.breakdown?.label === "DM-resolved direct call"
  );
  await admin.from("characters").update({ current_hp: 40 }).eq("id", bobCharacterId);

  const { error: negativeDamage } = await alice.client.rpc("resolve_attack_damage", {
    p_attacker_character_id: aliceCharacterId,
    p_target_character_id: bobCharacterId,
    p_damage: -5,
    p_breakdown: fakeBreakdown("negative damage attempt"),
    p_total: 15,
  });
  check("resolve_attack_damage rejects negative damage (no healing back door)", !!negativeDamage);

  // Clamp floor: massive damage stops at 0, apply_hp_delta's exact clamp.
  const { data: clampedRows } = await alice.client
    .rpc("resolve_attack_damage", {
      p_attacker_character_id: aliceCharacterId,
      p_target_character_id: bobCharacterId,
      p_damage: 9999,
      p_breakdown: fakeBreakdown("overkill"),
      p_total: 15,
    })
    .select();
  check("overkill damage clamps the target at 0 HP", clampedRows?.[0]?.out_target_current_hp === 0);
  await admin.from("characters").update({ current_hp: 40 }).eq("id", bobCharacterId);

  // -- 12. Initiative: start combat, roll for every combatant, confirm
  //    stored values and turn-order sorting. --
  const { data: encounterId, error: startError } = await dm.client.rpc("start_combat", { p_campaign_id: campaignId });
  check("combat starts for the initiative test", !startError, startError?.message);
  const { data: combatants } = await admin.from("combat_combatants").select().eq("encounter_id", encounterId);

  for (const combatant of combatants) {
    const roller = combatant.character_id === aliceCharacterId ? alice : combatant.character_id === bobCharacterId ? bob : dm;
    const rolled = await postRoll(roller, campaignId, { kind: "initiative", combatantId: combatant.id });
    const breakdown = rolled.body?.roll?.breakdown;
    if (!rolled.body?.ok) {
      check(`initiative roll for ${combatant.npc_name ?? combatant.character_id}`, false, JSON.stringify(rolled.body));
      continue;
    }
    const expectedModifier = combatant.character_id ? abilityModifier(14) : 0;
    check(
      `initiative for ${combatant.npc_name ?? "a PC"} = d20 ${combatant.character_id ? "+ DEX" : "(no stats yet)"}`,
      rolled.body.roll.total === breakdown.d20Result + expectedModifier &&
        rolled.body.roll.kind === "initiative"
    );
  }
  const { data: afterRolls } = await admin
    .from("combat_combatants")
    .select()
    .eq("encounter_id", encounterId)
    .order("initiative", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  check(
    "every combatant has a stored initiative and the order is sorted descending",
    afterRolls.every((c) => c.initiative !== null) &&
      afterRolls.every((c, i) => i === 0 || afterRolls[i - 1].initiative >= c.initiative)
  );

  // A player can't roll initiative for another player's combatant.
  const bobCombatant = combatants.find((c) => c.character_id === bobCharacterId);
  const cross = await postRoll(alice, campaignId, { kind: "initiative", combatantId: bobCombatant.id });
  check("a player cannot roll initiative for another player's combatant", cross.status === 403);
  const { count: crossLogs } = await admin
    .from("roll_log")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("kind", "initiative")
    .eq("roller_user_id", alice.id)
    .eq("character_id", bobCharacterId);
  check("the rejected initiative roll logged nothing", (crossLogs ?? 0) === 0);
  await dm.client.rpc("end_combat", { p_campaign_id: campaignId });

  // -- 13. Clients can't write the log directly with fabricated results
  //    for someone else, and non-members see nothing. --
  const { error: forgedRoller } = await alice.client.from("roll_log").insert({
    campaign_id: campaignId,
    roller_user_id: bob.id,
    character_id: null,
    kind: "freeform",
    breakdown: { type: "dice", label: "forged", notation: "1d20", groups: [], modifier: 0 },
    total: 20,
  });
  check("a member cannot log a roll as someone else", !!forgedRoller);

  // -- 14. Live sync: a postgres_changes subscription as ANOTHER member
  //    receives a roll inserted via the Route Handler within seconds —
  //    the same feed both the Game Room panel and the character sheet
  //    subscribe to, independent of any broadcast channel. --
  await bob.client.realtime.setAuth((await bob.client.auth.getSession()).data.session.access_token);
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no realtime event within 10s")), 10000);
    const channel = bob.client
      .channel(`verify-roll-log:${campaignId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "roll_log", filter: `campaign_id=eq.${campaignId}` },
        (payload) => {
          clearTimeout(timer);
          resolve(payload.new);
        }
      )
      .subscribe();
    // Only roll once the subscription is actually live — a fixed timeout
    // here has been a documented source of false failures.
    const waitSubscribed = setInterval(() => {
      if (channel.state === "joined") {
        clearInterval(waitSubscribed);
        void postRoll(alice, campaignId, { kind: "freeform", notation: "1d8+2" });
      }
    }, 100);
  });
  try {
    const event = await received;
    check(
      "another member's postgres_changes subscription received the roll live",
      event.kind === "freeform" && event.campaign_id === campaignId && event.breakdown?.notation === "1d8+2"
    );
  } catch (err) {
    check("another member's postgres_changes subscription received the roll live", false, err.message);
  }
} finally {
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
  await admin.auth.admin.deleteUser(bob.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll dice roll checks passed.");
process.exit(0);
