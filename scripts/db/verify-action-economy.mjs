#!/usr/bin/env node
// Action economy verification (Prompt 53 acceptance criteria).
//
// Seeds a campaign in active combat (DM + two players with PC tokens plus
// an NPC token) and checks: advance_turn resets all four economy columns
// for the ENTERING combatant while leaving everyone else's stale state
// alone (including across the round wrap); in Strict mode a second
// "attack" roll from the current combatant is rejected with a 400 and no
// log entry while check/save/skill rolls are NEVER blocked regardless of
// action_used, and a non-current combatant's attacks are never gated; in
// Freeform mode a second attack succeeds, still logs, and still marks
// action_used; move_combat_token accumulates movement_used_feet correctly
// across two same-turn moves, rejects an over-speed cumulative move in
// Strict with the token unmoved, allows the identical move in Freeform
// while still recording the feet, and never budget-checks a
// non-current-combatant's token; the DM flipping action_economy_strict
// reaches another member's campaigns postgres_changes subscription live;
// and (in a real browser) the table-wide mode badge and current-combatant
// readout render for a player, manually marking bonus action/reaction
// locks the button in Strict but toggles freely in Freeform, and both
// flags reset on advance_turn.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-action-economy.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

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
  const email = `economy-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Economy ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, cookie: sessionCookieHeader(signIn.session), session: signIn.session };
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
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Action economy test", creator: dm.id });
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
    level: 3,
    strength: 16,
    dexterity: 14,
    constitution: 13,
    intelligence: 10,
    wisdom: 12,
    charisma: 8,
    current_hp: 30,
    max_hp: 30,
    armor_class: 15,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });
  await admin.from("characters").insert([
    baseCharacter(aliceCharacterId, alice.id, "Alice PC"),
    baseCharacter(bobCharacterId, bob.id, "Bob PC"),
  ]);

  // A flat 40x40 map (no map_cells rows → every cell normal terrain at
  // elevation 0), so a straight walk costs exactly 5 ft per cell.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Economy arena",
    grid_width: 40,
    grid_height: 40,
  });
  const aliceTokenId = crypto.randomUUID();
  const bobTokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: aliceTokenId, map_id: mapId, character_id: aliceCharacterId, x: 0, y: 0, elevation: 0, allegiance: "party" },
    { id: bobTokenId, map_id: mapId, character_id: bobCharacterId, x: 20, y: 20, elevation: 0, allegiance: "party" },
    { id: goblinTokenId, map_id: mapId, npc_name: "Goblin", x: 5, y: 0, elevation: 0, allegiance: "hostile" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // Combat seeded directly (start_combat is verified elsewhere).
  // Initiative order: Alice 20 (current), Goblin 10, Bob 5.
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  const aliceCombatantId = crypto.randomUUID();
  const goblinCombatantId = crypto.randomUUID();
  const bobCombatantId = crypto.randomUUID();
  await admin.from("combat_combatants").insert([
    { id: aliceCombatantId, encounter_id: encounterId, token_id: aliceTokenId, character_id: aliceCharacterId, initiative: 20 },
    { id: goblinCombatantId, encounter_id: encounterId, token_id: goblinTokenId, npc_name: "Goblin", initiative: 10 },
    { id: bobCombatantId, encounter_id: encounterId, token_id: bobTokenId, character_id: bobCharacterId, initiative: 5 },
  ]);

  const combatant = async (id) => {
    const { data } = await admin
      .from("combat_combatants")
      .select("action_used, bonus_action_used, reaction_used, movement_used_feet")
      .eq("id", id)
      .single();
    return data;
  };
  const attackLogCount = async () => {
    const { count } = await admin
      .from("roll_log")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("kind", "attack");
    return count ?? 0;
  };
  const tokenPosition = async (id) => {
    const { data } = await admin.from("map_tokens").select("x, y").eq("id", id).single();
    return data;
  };
  const setStrict = (strict) =>
    admin.from("campaigns").update({ action_economy_strict: strict }).eq("id", campaignId);
  const setTurnIndex = (index) =>
    admin.from("combat_encounters").update({ current_turn_index: index }).eq("id", encounterId);

  // -- 1. The default is Strict, and fresh combatants start unspent. --
  const { data: campaignRow } = await admin
    .from("campaigns")
    .select("action_economy_strict")
    .eq("id", campaignId)
    .single();
  check("a campaign defaults to Strict enforcement", campaignRow?.action_economy_strict === true);
  const fresh = await combatant(aliceCombatantId);
  check(
    "a freshly seeded combatant starts with everything unspent",
    fresh.action_used === false &&
      fresh.bonus_action_used === false &&
      fresh.reaction_used === false &&
      fresh.movement_used_feet === 0
  );

  // -- 2. Strict: the current combatant's first attack proceeds and marks
  //    action_used; the second rejects with a 400 and logs nothing. --
  const attackBody = {
    kind: "attack",
    characterId: aliceCharacterId,
    attackKind: "melee",
    damageNotation: "1d6",
    targetAc: 30,
    targetName: "Goblin",
  };
  const firstAttack = await postRoll(alice, campaignId, attackBody);
  check("the current combatant's first attack this turn proceeds", firstAttack.status === 200 && firstAttack.body?.ok === true, JSON.stringify(firstAttack.body));
  const afterFirst = await combatant(aliceCombatantId);
  check("the attack (hit or miss) marked action_used", afterFirst.action_used === true);
  const logsBeforeSecond = await attackLogCount();
  const secondAttack = await postRoll(alice, campaignId, attackBody);
  check(
    "in Strict mode a second attack the same turn is rejected with a 400 and a clear message",
    secondAttack.status === 400 && secondAttack.body?.message === "You've already used your action this turn.",
    JSON.stringify(secondAttack.body)
  );
  check("the rejected attack logged nothing", (await attackLogCount()) === logsBeforeSecond);

  // -- 3. Checks/saves/skills are NEVER economy-gated, even with the
  //    action spent. --
  const checkRoll = await postRoll(alice, campaignId, { kind: "check", characterId: aliceCharacterId, ability: "strength" });
  const saveRoll = await postRoll(alice, campaignId, { kind: "save", characterId: aliceCharacterId, ability: "dexterity" });
  const skillRoll = await postRoll(alice, campaignId, { kind: "skill", characterId: aliceCharacterId, skill: "Athletics" });
  check(
    "check/save/skill rolls are never blocked by a spent action",
    checkRoll.status === 200 && saveRoll.status === 200 && skillRoll.status === 200,
    `check=${checkRoll.status} save=${saveRoll.status} skill=${skillRoll.status}`
  );

  // -- 4. A NON-current combatant's attacks are never gated (only the
  //    current combatant's own tracked turn is economy-checked). --
  const bobAttackBody = { ...attackBody, characterId: bobCharacterId };
  const bobFirst = await postRoll(bob, campaignId, bobAttackBody);
  const bobSecond = await postRoll(bob, campaignId, bobAttackBody);
  check(
    "a non-current combatant's attacks are never economy-gated",
    bobFirst.status === 200 && bobSecond.status === 200,
    `first=${bobFirst.status} second=${bobSecond.status}`
  );
  const bobAfter = await combatant(bobCombatantId);
  check("an off-turn attack marks nothing on that combatant", bobAfter.action_used === false);

  // -- 5. advance_turn resets the ENTERING combatant only. Alice's spent
  //    state and the goblin's staged stale state prove both directions. --
  await admin
    .from("combat_combatants")
    .update({ bonus_action_used: true, reaction_used: true, movement_used_feet: 15 })
    .eq("id", goblinCombatantId);
  const { error: advanceError } = await dm.client.rpc("advance_turn", { p_encounter_id: encounterId });
  check("the DM can advance the turn", !advanceError, advanceError?.message);
  const goblinEntering = await combatant(goblinCombatantId);
  check(
    "advance_turn resets all four columns for the entering combatant",
    goblinEntering.action_used === false &&
      goblinEntering.bonus_action_used === false &&
      goblinEntering.reaction_used === false &&
      goblinEntering.movement_used_feet === 0,
    JSON.stringify(goblinEntering)
  );
  const aliceStale = await combatant(aliceCombatantId);
  check(
    "other combatants' stale state is left alone until their own turn",
    aliceStale.action_used === true,
    JSON.stringify(aliceStale)
  );

  // -- 6. …and the reset also fires across the round wrap back to Alice. --
  await dm.client.rpc("advance_turn", { p_encounter_id: encounterId }); // -> Bob
  await dm.client.rpc("advance_turn", { p_encounter_id: encounterId }); // wraps -> Alice
  const { data: wrapped } = await admin
    .from("combat_encounters")
    .select("current_turn_index, round_number")
    .eq("id", encounterId)
    .single();
  check("the turn wrapped back to the first combatant", wrapped?.current_turn_index === 0 && wrapped?.round_number === 2);
  const aliceAfterWrap = await combatant(aliceCombatantId);
  check(
    "the round wrap resets the returning combatant's economy",
    aliceAfterWrap.action_used === false &&
      aliceAfterWrap.bonus_action_used === false &&
      aliceAfterWrap.reaction_used === false &&
      aliceAfterWrap.movement_used_feet === 0,
    JSON.stringify(aliceAfterWrap)
  );

  // -- 7. Freeform: a second attack succeeds, still logs, and still marks
  //    action_used for the readout. --
  await setStrict(false);
  const freeformFirst = await postRoll(alice, campaignId, attackBody);
  const logsBeforeFreeformSecond = await attackLogCount();
  const freeformSecond = await postRoll(alice, campaignId, attackBody);
  check(
    "in Freeform mode a second attack the same turn succeeds",
    freeformFirst.status === 200 && freeformSecond.status === 200,
    `first=${freeformFirst.status} second=${freeformSecond.status}`
  );
  check("the Freeform second attack still logs normally", (await attackLogCount()) === logsBeforeFreeformSecond + 1);
  const aliceFreeform = await combatant(aliceCombatantId);
  check("Freeform still marks action_used for the readout", aliceFreeform.action_used === true);
  await setStrict(true);

  // -- 8. Movement: two in-budget moves accumulate movement_used_feet.
  //    Flat map, straight lines: 2 cells east = 10 ft each. --
  await admin.from("combat_combatants").update({ movement_used_feet: 0 }).eq("id", aliceCombatantId);
  const move1 = await alice.client.rpc("move_combat_token", {
    p_token_id: aliceTokenId,
    p_x: 2,
    p_y: 0,
    p_elevation: 0,
    p_feet_cost: 10,
  });
  check("a move within speed succeeds and returns the updated token row", !move1.error && move1.data?.x === 2, move1.error?.message);
  const move2 = await alice.client.rpc("move_combat_token", {
    p_token_id: aliceTokenId,
    p_x: 4,
    p_y: 0,
    p_elevation: 0,
    p_feet_cost: 10,
  });
  check("a second same-turn move succeeds", !move2.error && move2.data?.x === 4, move2.error?.message);
  const aliceMoved = await combatant(aliceCombatantId);
  check("movement_used_feet accumulates across the two moves (10 + 10 = 20)", aliceMoved.movement_used_feet === 20, `movement_used_feet=${aliceMoved.movement_used_feet}`);

  // -- 9. Strict: a move that would push the cumulative total past speed
  //    (20 + 15 = 35 > 30) rejects with the token unmoved. --
  const overBudget = await alice.client.rpc("move_combat_token", {
    p_token_id: aliceTokenId,
    p_x: 7,
    p_y: 0,
    p_elevation: 0,
    p_feet_cost: 15,
  });
  check(
    "in Strict mode an over-speed cumulative move is rejected with a clear reason",
    !!overBudget.error && overBudget.error.message.includes("Not enough movement"),
    overBudget.error?.message ?? "no error"
  );
  const afterRejected = await tokenPosition(aliceTokenId);
  const aliceAfterRejected = await combatant(aliceCombatantId);
  check(
    "the rejected move leaves the token unmoved and the budget uncharged",
    afterRejected.x === 4 && afterRejected.y === 0 && aliceAfterRejected.movement_used_feet === 20,
    JSON.stringify({ position: afterRejected, used: aliceAfterRejected.movement_used_feet })
  );

  // -- 10. The identical over-budget move succeeds in Freeform while
  //    still recording the used feet. --
  await setStrict(false);
  const freeformMove = await alice.client.rpc("move_combat_token", {
    p_token_id: aliceTokenId,
    p_x: 7,
    p_y: 0,
    p_elevation: 0,
    p_feet_cost: 15,
  });
  check("the identical over-budget move succeeds in Freeform", !freeformMove.error && freeformMove.data?.x === 7, freeformMove.error?.message);
  const aliceFreeformMove = await combatant(aliceCombatantId);
  check("Freeform still records the used feet (20 + 15 = 35)", aliceFreeformMove.movement_used_feet === 35, `movement_used_feet=${aliceFreeformMove.movement_used_feet}`);
  await setStrict(true);

  // -- 11. A non-current combatant's token move is never budget-checked,
  //    regardless of mode — the RPC falls through to a plain move. --
  const bobMove = await bob.client.rpc("move_combat_token", {
    p_token_id: bobTokenId,
    p_x: 30,
    p_y: 30,
    p_elevation: 0,
    p_feet_cost: 999,
  });
  check("a non-current combatant's move succeeds in Strict even far past speed", !bobMove.error && bobMove.data?.x === 30, bobMove.error?.message);
  const bobUntracked = await combatant(bobCombatantId);
  check("the off-turn move charges no movement budget", bobUntracked.movement_used_feet === 0, `movement_used_feet=${bobUntracked.movement_used_feet}`);

  // -- 12. The DM flipping strictness reaches another member's campaigns
  //    postgres_changes subscription live — the feed the Game Room and
  //    every player's mode badge ride. Fresh-channel attempts on top of
  //    the verify-dice-rolls retry-until-landed pattern: the very first
  //    subscription on a table newly added to the publication can land on
  //    a channel error rather than merely lagging, so a failed attempt
  //    resubscribes from scratch instead of waiting on a dead channel. --
  await bob.client.realtime.setAuth((await bob.client.auth.getSession()).data.session.access_token);
  let flipEvent = null;
  let flipDetail = "no realtime event";
  for (let attempt = 0; attempt < 3 && !flipEvent; attempt++) {
    flipEvent = await new Promise((resolve) => {
      let flipTimer = null;
      let settled = false;
      const channel = bob.client
        .channel(`verify-campaign-changes:${campaignId}:${attempt}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "campaigns", filter: `id=eq.${campaignId}` },
          (payload) => {
            if (payload.new.action_economy_strict !== false) return;
            settle(payload.new);
          }
        );
      const settle = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (flipTimer) clearInterval(flipTimer);
        void bob.client.removeChannel(channel);
        resolve(value);
      };
      const timer = setTimeout(() => {
        flipDetail = `attempt ${attempt + 1}: no event within 15s`;
        settle(null);
      }, 15000);
      // Each retry re-issues the DM's (member-RLS-authorized) UPDATE, so
      // an insert that slipped past a not-yet-active subscription is
      // simply repeated.
      const flipOnce = () =>
        void dm.client.from("campaigns").update({ action_economy_strict: false }).eq("id", campaignId);
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          flipOnce();
          flipTimer = setInterval(flipOnce, 1500);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          flipDetail = `attempt ${attempt + 1}: channel ${status}`;
          settle(null);
        }
      });
    });
  }
  check(
    "the DM's strictness flip reached another member's postgres_changes subscription live",
    flipEvent !== null && flipEvent.id === campaignId && flipEvent.action_economy_strict === false,
    flipDetail
  );
  await setStrict(true);

  // -- 13. The browser half: the table-wide badge and readout for a
  //    PLAYER, the manual bonus/reaction marks (locked in Strict, free in
  //    Freeform), and the advance_turn reset of both flags. --
  await admin
    .from("combat_combatants")
    .update({ action_used: false, bonus_action_used: false, reaction_used: false, movement_used_feet: 0 })
    .eq("id", aliceCombatantId);
  await setTurnIndex(0);

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const room = await aliceContext.newPage();
  await room.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await room.waitForSelector('[data-testid="combat-panel"]', { timeout: 30000 });

  check(
    "a player (not just the DM) sees the current enforcement mode",
    ((await room.textContent('[data-testid="economy-mode-badge"]').catch(() => "")) ?? "").includes("Strict")
  );
  check(
    "the current combatant's economy readout is visible to the table",
    (await room.$('[data-testid="action-economy-readout"]')) !== null
  );
  check(
    "the readout shows the action available before anything is spent",
    ((await room.textContent('[data-testid="economy-action"]').catch(() => "")) ?? "").includes("available")
  );
  check(
    "the readout shows movement against the character's speed",
    ((await room.textContent('[data-testid="economy-movement"]').catch(() => "")) ?? "").includes("0 / 30 ft")
  );

  // Polls the combatant row until the predicate holds — the click's write
  // lands via the room's async runCombatAction, so a single immediate read
  // races it.
  const combatantEventually = async (id, predicate, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    let row = await combatant(id);
    while (!predicate(row) && Date.now() < deadline) {
      await sleep(300);
      row = await combatant(id);
    }
    return row;
  };

  // Mark the bonus action: persists, and in Strict the button locks. The
  // locked label ("Bonus action spent") only renders after the refresh
  // with the persisted flag, so waiting on it can't be satisfied by the
  // transient busy-disabled state.
  await room.click('[data-testid="economy-mark-bonus-action"]');
  await room.waitForFunction(
    () =>
      (document.querySelector('[data-testid="economy-mark-bonus-action"]')?.textContent ?? "").includes(
        "spent"
      ),
    { timeout: 8000 }
  );
  const afterBonus = await combatantEventually(aliceCombatantId, (row) => row.bonus_action_used);
  check("marking the bonus action persists bonus_action_used", afterBonus.bonus_action_used === true);
  check(
    "in Strict mode the spent bonus-action mark locks until the next turn",
    (await room.$eval('[data-testid="economy-mark-bonus-action"]', (el) => el.disabled)) === true
  );
  await room.click('[data-testid="economy-mark-reaction"]');
  await room.waitForFunction(
    () =>
      (document.querySelector('[data-testid="economy-mark-reaction"]')?.textContent ?? "").includes(
        "spent"
      ),
    { timeout: 8000 }
  );
  check(
    "marking the reaction persists reaction_used",
    (await combatantEventually(aliceCombatantId, (row) => row.reaction_used)).reaction_used === true
  );

  // Freeform (flipped by the DM elsewhere) reaches this open room live and
  // unlocks the marks as free toggles.
  await dm.client.from("campaigns").update({ action_economy_strict: false }).eq("id", campaignId);
  await room.waitForFunction(
    () =>
      (document.querySelector('[data-testid="economy-mode-badge"]')?.textContent ?? "").includes("Freeform"),
    { timeout: 15000 }
  );
  check("the DM's mid-combat mode flip reaches the player's open room live", true);
  await room.waitForFunction(
    () => document.querySelector('[data-testid="economy-mark-bonus-action"]')?.disabled === false,
    { timeout: 8000 }
  );
  await room.click('[data-testid="economy-mark-bonus-action"]'); // "Clear bonus action"
  check(
    "in Freeform mode the spent mark toggles freely (cleared again)",
    (await combatantEventually(aliceCombatantId, (row) => !row.bonus_action_used)).bonus_action_used === false
  );
  await room.waitForFunction(
    () => document.querySelector('[data-testid="economy-mark-bonus-action"]')?.disabled === false,
    { timeout: 8000 }
  );
  await room.click('[data-testid="economy-mark-bonus-action"]'); // re-mark
  check(
    "…and can be re-marked",
    (await combatantEventually(aliceCombatantId, (row) => row.bonus_action_used)).bonus_action_used === true
  );
  await dm.client.from("campaigns").update({ action_economy_strict: true }).eq("id", campaignId);

  // advance_turn resets the manual marks too, at the combatant's own next
  // turn: jump the pointer to Bob (index 2), then advance to wrap to Alice.
  await setTurnIndex(2);
  await dm.client.rpc("advance_turn", { p_encounter_id: encounterId });
  const aliceReset = await combatant(aliceCombatantId);
  check(
    "advance_turn resets the manually marked bonus action and reaction",
    aliceReset.bonus_action_used === false && aliceReset.reaction_used === false,
    JSON.stringify(aliceReset)
  );
} finally {
  await browser.close();
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
console.log("\nAll action-economy checks passed.");
process.exit(0);
