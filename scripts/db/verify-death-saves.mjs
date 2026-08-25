#!/usr/bin/env node
// Death saving throw verification (Prompt 49 acceptance criteria).
//
// Seeds a campaign (DM + two players, each with a character) and exercises
// the death-save state machine end to end: dropping a PC to exactly 0 HP
// via an attack starts eligibility without adding a failure; the live roll
// route (kind: "death_save") forces a plain normal-mode d20 and maps
// 2-9 → one failure, 10-19 → one success, natural 1 → two failures,
// natural 20 → back up at 1 HP with a cleared slate (each observed for
// real by retrying the route, plus the exact boundary math via direct
// apply_death_save_roll calls with explicit deltas); three successes
// stabilizes (and further rolls/damage reflect it), three failures — or a
// natural 1's double from one — kills; damage while already at 0 adds one
// failure (two on a crit, forced via the nat-20-retry pattern) unless it's
// >= max_hp, which is instant death with the tally untouched; healing a
// 0-HP character clears the slate; ineligible rolls are rejected and log
// nothing; and the kind='death_save' roll_log row reaches another member's
// postgres_changes subscription live.
//
// Needs the dev server on :3000 and the local Supabase stack.
// Usage: node scripts/db/verify-death-saves.mjs

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
  const email = `deathsave-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Death Save Test ${label}` });
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

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Death save test", creator: dm.id });
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

  async function setState(characterId, state) {
    const { error } = await admin
      .from("characters")
      .update({
        current_hp: 0,
        death_save_successes: 0,
        death_save_failures: 0,
        is_stable: false,
        is_dead: false,
        ...state,
      })
      .eq("id", characterId);
    if (error) throw new Error(`resetting character state: ${error.message}`);
  }

  async function getState(characterId) {
    const { data, error } = await admin
      .from("characters")
      .select("current_hp, max_hp, death_save_successes, death_save_failures, is_stable, is_dead")
      .eq("id", characterId)
      .single();
    if (error) throw new Error(`reading character state: ${error.message}`);
    return data;
  }

  async function countDeathSaveLogs(characterId) {
    const { count } = await admin
      .from("roll_log")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("kind", "death_save")
      .eq("character_id", characterId);
    return count ?? 0;
  }

  // Retry an attack until its resolution matches; the same helper (and the
  // same natural-20/natural-1 forcing pattern) as verify-dice-rolls.mjs.
  async function attackUntil(user, body, predicate, attempts = 30) {
    for (let i = 0; i < attempts; i++) {
      const roll = await postRoll(user, campaignId, body);
      const attack = roll.body?.roll?.breakdown?.attack;
      if (!roll.body?.ok) return { roll, attack: null };
      if (predicate(attack)) return { roll, attack };
    }
    return { roll: null, attack: null };
  }

  // -- 1. Dropping a PC from above 0 to exactly 0 via an attack starts
  //    eligibility but does NOT itself add a death-save failure. --
  await setState(bobCharacterId, { current_hp: 5 });
  const drop = await attackUntil(
    alice,
    {
      kind: "attack",
      characterId: aliceCharacterId,
      attackKind: "melee",
      damageNotation: "1d4+20",
      targetAc: 1,
      targetCharacterId: bobCharacterId,
      targetName: "Bob PC",
    },
    (attack) => attack && attack.hit
  );
  if (drop.attack) {
    const bobState = await getState(bobCharacterId);
    check(
      "an attack dropping a PC to exactly 0 HP adds no death-save failure (it only starts eligibility)",
      bobState.current_hp === 0 &&
        bobState.death_save_failures === 0 &&
        bobState.death_save_successes === 0 &&
        bobState.is_dead === false &&
        drop.attack.deathSaveFailureAdded === 0 &&
        drop.attack.instantDeath === false,
      JSON.stringify(bobState)
    );
  } else {
    check("an attack against AC 1 eventually hits", false, JSON.stringify(drop.roll?.body));
  }

  // -- 2. The exact boundary math, via apply_death_save_roll directly
  //    (randomness can't be injected through the real HTTP route). --
  await setState(aliceCharacterId, {});
  const { data: oneSuccess, error: oneSuccessError } = await alice.client.rpc("apply_death_save_roll", {
    p_character_id: aliceCharacterId,
    p_successes_delta: 1,
    p_failures_delta: 0,
    p_recovers: false,
  });
  check(
    "a success delta adds one success",
    !oneSuccessError && oneSuccess?.death_save_successes === 1 && oneSuccess?.death_save_failures === 0,
    oneSuccessError?.message
  );

  const { data: negated } = await alice.client.rpc("apply_death_save_roll", {
    p_character_id: aliceCharacterId,
    p_successes_delta: -3,
    p_failures_delta: -3,
    p_recovers: false,
  });
  check(
    "negative deltas cannot erase counts (greatest(0, ...) guard)",
    negated?.death_save_successes === 1 && negated?.death_save_failures === 0,
    JSON.stringify(negated)
  );

  const { data: oneFailure } = await alice.client.rpc("apply_death_save_roll", {
    p_character_id: aliceCharacterId,
    p_successes_delta: 0,
    p_failures_delta: 1,
    p_recovers: false,
  });
  check(
    "a failure delta adds one failure",
    oneFailure?.death_save_failures === 1 && oneFailure?.is_dead === false,
    JSON.stringify(oneFailure)
  );

  const { data: recovered } = await alice.client.rpc("apply_death_save_roll", {
    p_character_id: aliceCharacterId,
    p_successes_delta: 0,
    p_failures_delta: 0,
    p_recovers: true,
  });
  check(
    "a natural-20 recovery restores 1 HP and clears both counts",
    recovered?.current_hp === 1 &&
      recovered?.death_save_successes === 0 &&
      recovered?.death_save_failures === 0 &&
      recovered?.is_stable === false,
    JSON.stringify(recovered)
  );

  // A natural 1's double failure can kill on its own from two failures —
  // and even from one failure it reaches exactly the 3 cap.
  await setState(aliceCharacterId, { death_save_failures: 1 });
  const { data: natOneKill } = await alice.client.rpc("apply_death_save_roll", {
    p_character_id: aliceCharacterId,
    p_successes_delta: 0,
    p_failures_delta: 2,
    p_recovers: false,
  });
  check(
    "a natural 1 (two failures at once) can kill on its own: 1 + 2 caps at 3 and sets is_dead",
    natOneKill?.death_save_failures === 3 && natOneKill?.is_dead === true,
    JSON.stringify(natOneKill)
  );

  // Three failures one at a time also kills.
  await setState(aliceCharacterId, {});
  let third = null;
  for (let i = 0; i < 3; i++) {
    const { data } = await alice.client.rpc("apply_death_save_roll", {
      p_character_id: aliceCharacterId,
      p_successes_delta: 0,
      p_failures_delta: 1,
      p_recovers: false,
    });
    third = data;
  }
  check(
    "three accumulated failures set is_dead",
    third?.death_save_failures === 3 && third?.is_dead === true,
    JSON.stringify(third)
  );

  // -- 3. Three successes stabilize, and the stable/dead states refuse
  //    further saves (and log nothing through the route). --
  await setState(aliceCharacterId, {});
  let stabilized = null;
  for (let i = 0; i < 3; i++) {
    const { data } = await alice.client.rpc("apply_death_save_roll", {
      p_character_id: aliceCharacterId,
      p_successes_delta: 1,
      p_failures_delta: 0,
      p_recovers: false,
    });
    stabilized = data;
  }
  check(
    "three successes set is_stable (unconscious at 0 HP, safe)",
    stabilized?.death_save_successes === 3 && stabilized?.is_stable === true && stabilized?.is_dead === false,
    JSON.stringify(stabilized)
  );

  const { error: stableRejected } = await alice.client.rpc("apply_death_save_roll", {
    p_character_id: aliceCharacterId,
    p_successes_delta: 1,
    p_failures_delta: 0,
    p_recovers: false,
  });
  check(
    "a further save on a stable character is rejected",
    stableRejected?.message?.includes("No death save is needed"),
    stableRejected?.message
  );

  const logsBeforeIneligible = await countDeathSaveLogs(aliceCharacterId);
  const stableRouteRoll = await postRoll(alice, campaignId, { kind: "death_save", characterId: aliceCharacterId });
  check(
    "the route rejects a save for a stable character with a 400",
    stableRouteRoll.status === 400,
    JSON.stringify(stableRouteRoll.body)
  );

  // Further damage reflects stability: it breaks it and restarts the tally
  // with the damage's own failure.
  const { data: unstabilized, error: unstabilizedError } = await alice.client.rpc("apply_hp_delta", {
    p_character_id: aliceCharacterId,
    p_delta: -5,
  });
  check(
    "damage to a STABLE 0-HP character breaks stability and restarts the tally at one failure",
    !unstabilizedError &&
      unstabilized?.is_stable === false &&
      unstabilized?.death_save_successes === 0 &&
      unstabilized?.death_save_failures === 1 &&
      unstabilized?.current_hp === 0,
    unstabilizedError?.message ?? JSON.stringify(unstabilized)
  );

  await setState(aliceCharacterId, { current_hp: 10 });
  const consciousRoll = await postRoll(alice, campaignId, { kind: "death_save", characterId: aliceCharacterId });
  check(
    "the route rejects a save for a conscious (HP > 0) character with a 400",
    consciousRoll.status === 400,
    JSON.stringify(consciousRoll.body)
  );

  await setState(aliceCharacterId, { is_dead: true, death_save_failures: 3 });
  const deadRoll = await postRoll(alice, campaignId, { kind: "death_save", characterId: aliceCharacterId });
  check(
    "the route rejects a save for a dead character with a 400",
    deadRoll.status === 400,
    JSON.stringify(deadRoll.body)
  );
  check(
    "rejected death saves logged nothing",
    (await countDeathSaveLogs(aliceCharacterId)) === logsBeforeIneligible
  );

  // -- 4. Authorization through the route: another player can't roll for a
  //    character they can't read; the DM can. --
  await setState(aliceCharacterId, {});
  const crossPlayer = await postRoll(bob, campaignId, { kind: "death_save", characterId: aliceCharacterId });
  check("another player cannot roll a death save for a character they can't read", crossPlayer.status === 404);
  const dmRoll = await postRoll(dm, campaignId, { kind: "death_save", characterId: aliceCharacterId });
  check(
    "the DM can roll a death save for a dying player character",
    dmRoll.status === 200 && dmRoll.body?.roll?.kind === "death_save",
    JSON.stringify(dmRoll.body)
  );

  // -- 5. The live route, repeatedly from a clean dying slate: every roll
  //    is a plain single normal-mode d20 (any client-sent mode ignored),
  //    and each band's outcome lands correctly. Retry until a success, a
  //    plain failure, a natural 1, AND a natural 20 have each been
  //    observed for real. --
  let sawSuccess = false;
  let sawFailure = false;
  let sawNatural1 = false;
  let sawNatural20 = false;
  let shapeOk = true;
  let mathOk = true;
  let detail = null;
  for (let i = 0; i < 500 && !(sawSuccess && sawFailure && sawNatural1 && sawNatural20); i++) {
    await setState(aliceCharacterId, {});
    // mode sent on purpose — the server must force "normal" for this kind.
    const roll = await postRoll(alice, campaignId, {
      kind: "death_save",
      characterId: aliceCharacterId,
      mode: "advantage",
    });
    const breakdown = roll.body?.roll?.breakdown;
    const deathSave = breakdown?.deathSave;
    if (!roll.body?.ok || !deathSave) {
      shapeOk = false;
      detail = JSON.stringify(roll.body);
      break;
    }
    if (
      breakdown.mode !== "normal" ||
      breakdown.d20Rolls.length !== 1 ||
      breakdown.modifiers.length !== 0 ||
      roll.body.roll.total !== breakdown.d20Result ||
      roll.body.roll.kind !== "death_save"
    ) {
      shapeOk = false;
      detail = JSON.stringify(breakdown);
      break;
    }
    const die = breakdown.d20Result;
    const state = await getState(aliceCharacterId);
    if (die === 20) {
      sawNatural20 = true;
      if (
        !deathSave.recovers ||
        state.current_hp !== 1 ||
        state.death_save_successes !== 0 ||
        state.death_save_failures !== 0 ||
        state.is_stable
      ) {
        mathOk = false;
        detail = `nat 20 → ${JSON.stringify({ deathSave, state })}`;
        break;
      }
    } else if (die === 1) {
      sawNatural1 = true;
      if (!deathSave.natural1 || deathSave.failuresAfter !== 2 || state.death_save_failures !== 2) {
        mathOk = false;
        detail = `nat 1 → ${JSON.stringify({ deathSave, state })}`;
        break;
      }
    } else if (die >= 10) {
      sawSuccess = true;
      if (deathSave.successesAfter !== 1 || state.death_save_successes !== 1 || state.death_save_failures !== 0) {
        mathOk = false;
        detail = `roll ${die} → ${JSON.stringify({ deathSave, state })}`;
        break;
      }
    } else {
      sawFailure = true;
      if (deathSave.failuresAfter !== 1 || state.death_save_failures !== 1 || state.death_save_successes !== 0) {
        mathOk = false;
        detail = `roll ${die} → ${JSON.stringify({ deathSave, state })}`;
        break;
      }
    }
  }
  check("every live death save is a single plain normal-mode d20 (client-sent mode ignored)", shapeOk, detail);
  check("a live 10+ roll added exactly one success", mathOk && sawSuccess, detail);
  check("a live 2-9 roll added exactly one failure", mathOk && sawFailure, detail);
  check("a live natural 1 counted as two failures", mathOk && sawNatural1, detail);
  check("a live natural 20 restored 1 HP and cleared both counts", mathOk && sawNatural20, detail);

  // -- 6. Damage while already at 0 HP (not enough to instant-kill) adds
  //    exactly one failure — two when the attack was a critical hit. --
  await setState(bobCharacterId, {});
  const chip = await attackUntil(
    alice,
    {
      kind: "attack",
      characterId: aliceCharacterId,
      attackKind: "melee",
      damageNotation: "1d4",
      targetAc: 1,
      targetCharacterId: bobCharacterId,
      targetName: "Bob PC",
    },
    (attack) => attack && attack.hit && !attack.critical
  );
  if (chip.attack) {
    const bobState = await getState(bobCharacterId);
    check(
      "a non-crit hit on an already-0-HP target adds exactly one failure",
      bobState.death_save_failures === 1 &&
        bobState.current_hp === 0 &&
        bobState.is_dead === false &&
        chip.attack.deathSaveFailureAdded === 1 &&
        chip.attack.instantDeath === false,
      JSON.stringify({ state: bobState, attack: chip.attack })
    );
  } else {
    check("a non-crit hit on a 0-HP target eventually lands", false);
  }

  await setState(bobCharacterId, {});
  const crit = await attackUntil(
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
  if (crit.attack) {
    const bobState = await getState(bobCharacterId);
    check(
      "a CRITICAL hit on an already-0-HP target adds two failures",
      bobState.death_save_failures === 2 &&
        bobState.is_dead === false &&
        crit.attack.deathSaveFailureAdded === 2 &&
        crit.attack.instantDeath === false,
      JSON.stringify({ state: bobState, attack: crit.attack })
    );
  } else {
    check("a natural 20 occurred within 200 attack rolls", false);
  }

  // -- 7. Instant death: damage >= max HP while already at 0 kills
  //    outright, skipping the failure tally entirely. --
  await setState(bobCharacterId, {});
  const overkill = await attackUntil(
    alice,
    {
      kind: "attack",
      characterId: aliceCharacterId,
      attackKind: "melee",
      damageNotation: "10d4+30", // minimum 40 = Bob's max HP, guaranteed
      targetAc: 1,
      targetCharacterId: bobCharacterId,
      targetName: "Bob PC",
    },
    (attack) => attack && attack.hit
  );
  if (overkill.attack) {
    const bobState = await getState(bobCharacterId);
    check(
      "damage >= max HP while at 0 sets is_dead directly, without touching the failure tally",
      bobState.is_dead === true &&
        bobState.death_save_failures === 0 &&
        bobState.current_hp === 0 &&
        overkill.attack.instantDeath === true &&
        overkill.attack.deathSaveFailureAdded === 0,
      JSON.stringify({ state: bobState, attack: overkill.attack })
    );
  } else {
    check("an overkill attack against AC 1 eventually hits", false);
  }

  // Direct-RPC paths (bypassing the route): p_critical threads through,
  // instant death reports, and the atomic roll_log insert is preserved.
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
      instantDeath: false,
      deathSaveFailureAdded: 0,
    },
  });

  await setState(bobCharacterId, {});
  const { data: rpcCritRows, error: rpcCritError } = await alice.client
    .rpc("resolve_attack_damage", {
      p_attacker_character_id: aliceCharacterId,
      p_target_character_id: bobCharacterId,
      p_damage: 3,
      p_critical: true,
      p_breakdown: fakeBreakdown("direct crit on a downed PC"),
      p_total: 15,
    })
    .select();
  const rpcCrit = rpcCritRows?.[0];
  check(
    "resolve_attack_damage's p_critical doubles the failure on a direct call too",
    !rpcCritError && rpcCrit?.out_failure_added === 2 && rpcCrit?.out_instant_death === false,
    rpcCritError?.message ?? JSON.stringify(rpcCrit)
  );

  await setState(bobCharacterId, {});
  const { data: rpcOverkillRows } = await alice.client
    .rpc("resolve_attack_damage", {
      p_attacker_character_id: aliceCharacterId,
      p_target_character_id: bobCharacterId,
      p_damage: 40,
      p_critical: false,
      p_breakdown: fakeBreakdown("direct overkill on a downed PC"),
      p_total: 15,
    })
    .select();
  const rpcOverkill = rpcOverkillRows?.[0];
  const { data: rpcOverkillLog } = await admin
    .from("roll_log")
    .select()
    .eq("id", rpcOverkill?.out_roll_id ?? crypto.randomUUID())
    .maybeSingle();
  check(
    "a direct instant-death RPC call reports out_instant_death and still leaves its atomic roll_log row",
    rpcOverkill?.out_instant_death === true &&
      rpcOverkill?.out_failure_added === 0 &&
      rpcOverkillLog?.kind === "attack" &&
      rpcOverkillLog?.breakdown?.label === "direct overkill on a downed PC",
    JSON.stringify(rpcOverkill)
  );

  // -- 8. apply_hp_delta (the manual damage/heal control) shares the
  //    already-at-0 rules, minus any crit concept. --
  await setState(bobCharacterId, {});
  const { data: manualChip } = await bob.client.rpc("apply_hp_delta", {
    p_character_id: bobCharacterId,
    p_delta: -5,
  });
  check(
    "manual damage while at 0 HP adds one failure (apply_hp_delta has no crit concept)",
    manualChip?.death_save_failures === 1 && manualChip?.current_hp === 0 && manualChip?.is_dead === false,
    JSON.stringify(manualChip)
  );

  await setState(bobCharacterId, {});
  const { data: manualOverkill } = await bob.client.rpc("apply_hp_delta", {
    p_character_id: bobCharacterId,
    p_delta: -40,
  });
  check(
    "manual damage >= max HP while at 0 is instant death with the tally untouched",
    manualOverkill?.is_dead === true && manualOverkill?.death_save_failures === 0,
    JSON.stringify(manualOverkill)
  );

  await setState(bobCharacterId, { death_save_successes: 2, death_save_failures: 2 });
  const { data: healed } = await bob.client.rpc("apply_hp_delta", {
    p_character_id: bobCharacterId,
    p_delta: 5,
  });
  check(
    "healing a 0-HP character above 0 clears both counts and is_stable",
    healed?.current_hp === 5 &&
      healed?.death_save_successes === 0 &&
      healed?.death_save_failures === 0 &&
      healed?.is_stable === false,
    JSON.stringify(healed)
  );

  // -- 9. The roll is in roll_log with kind='death_save' and reaches
  //    another member's postgres_changes subscription live — gated on the
  //    channel actually being joined (a fixed timeout here has been a
  //    documented source of false failures). --
  await bob.client.realtime.setAuth((await bob.client.auth.getSession()).data.session.access_token);
  let lastLiveRoll = null;
  const received = new Promise((resolve, reject) => {
    let rollTimer = null;
    const timer = setTimeout(() => {
      if (rollTimer) clearInterval(rollTimer);
      reject(new Error(`no realtime event within 20s (last roll: ${JSON.stringify(lastLiveRoll?.body)})`));
    }, 20000);
    // Reset Alice to dying and roll — repeated below because each retry
    // inserts a fresh row: even gating on the joined channel state, the
    // postgres subscription can become active moments after the join, so
    // a single immediate insert can slip past it (the same class of race
    // as the documented fixed-timeout false failures).
    const rollOnce = async () => {
      await setState(aliceCharacterId, {});
      lastLiveRoll = await postRoll(alice, campaignId, { kind: "death_save", characterId: aliceCharacterId });
    };
    const channel = bob.client
      .channel(`verify-death-saves:${campaignId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "roll_log", filter: `campaign_id=eq.${campaignId}` },
        (payload) => {
          if (payload.new.kind !== "death_save") return;
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
    const event = await received;
    check(
      "another member's postgres_changes subscription received the death save live",
      event.kind === "death_save" &&
        event.campaign_id === campaignId &&
        event.character_id === aliceCharacterId &&
        event.breakdown?.deathSave !== undefined,
      JSON.stringify(event)
    );
  } catch (err) {
    check("another member's postgres_changes subscription received the death save live", false, err.message);
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
console.log("\nAll death save checks passed.");
process.exit(0);
