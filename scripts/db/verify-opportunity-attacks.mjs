#!/usr/bin/env node
// Opportunity attacks verification (Prompt 54 acceptance criteria).
//
// Seeds a campaign in active combat (DM + two players; Alice owns the two
// party-side PCs that do the moving, Bob owns a hostile-flipped PC
// reactor, plus an NPC goblin reactor) and checks: a tracked
// move_combat_token out of an adjacent hostile's reach — run through the
// rules engine's REAL computeOpportunityAttacks/meleeReachFeet (loaded
// from src/ via vite, not a reimplementation) over live DB state, exactly
// the inputs GameRoom's drag-end handler assembles — records a pending
// opportunity_attacks row for the right reactor, while moving within
// reach, never having been in reach, a declared Disengage, and an
// already-spent reaction each record nothing; declaring Disengage sets
// disengaged AND action_used in one write and advance_turn clears it for
// the entering combatant; a non-controller's resolve matches zero rows
// under RLS while the reactor's controller declines (reaction left
// untouched) and a resolved row is terminal; in a real browser the
// pending prompt lands LIVE in another member's open room, the reactor's
// owner takes it — melee weapon pick, typed AC for an unreadable mover —
// firing a kind:"attack" roll shape-identical to the manual flow's,
// marking reaction_used and the row taken; a second pending prompt
// against the now-spent reactor loses its Take control to a clear
// "Reaction already spent this turn" reason (Decline stays, so the stale
// offer clears); the DM's NPC-reactor Take spends the reaction with the
// swing left to the dice panel; the Declare Disengage control gates on a
// free action in Strict mode and flips both columns through the app; and
// both the pending INSERT and its resolution UPDATE reach another
// member's raw postgres_changes subscription live (retry-until-landed
// with fresh channels — the newly-published-table lesson).
//
// The drag gesture itself lives inside the react-three-fiber canvas,
// which no verify script drives (the verify-action-economy precedent:
// tracked moves are exercised at the move_combat_token RPC layer); the
// pre/post-position detection math is unit-tested in
// src/rules-engine/opportunityAttacks.test.ts and re-exercised here via
// the real module.
//
// Freeform action economy on purpose (the verify-quick-actions /
// verify-action-overrides lesson): this script fires attacks and moves
// far past a single turn's budget across its scenarios; Strict is
// flipped on only for the Declare Disengage gating check.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-opportunity-attacks.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { createServer } from "vite";

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
  const email = `oa-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `OA ${label}` });
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

// The APP'S detection code, not a lookalike: vite resolves the TS module
// chain (movement, quickActions, the SRD catalog) the same way the build
// does, so these checks exercise the exact computeOpportunityAttacks and
// meleeReachFeet the Game Room ships.
const vite = await createServer({
  root: rootDir,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
});
const rules = await vite.ssrLoadModule("/src/rules-engine/opportunityAttacks.ts");

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch();

try {
  const campaignId = crypto.randomUUID();
  // Freeform (the documented lesson): the scenarios below move and attack
  // far past one Strict turn's worth of economy.
  await admin
    .from("campaigns")
    .insert({ id: campaignId, name: "Opportunity attacks test", creator: dm.id, action_economy_strict: false });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const pc1CharacterId = crypto.randomUUID();
  const pc2CharacterId = crypto.randomUUID();
  const bobCharacterId = crypto.randomUUID();
  const baseCharacter = (id, ownerId, name, inventory) => ({
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
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory,
    spells: [],
  });
  await admin.from("characters").insert([
    // The two movers, both Alice's (one player driving two combatants is
    // the smallest honest way to stack two pending prompts on the same
    // reactor: two DIFFERENT movers provoke it on consecutive turns).
    baseCharacter(pc1CharacterId, alice.id, "Alice Vanguard", [
      { name: "Longsword", quantity: 1, attackKind: "melee", damageNotation: "1d8" },
    ]),
    baseCharacter(pc2CharacterId, alice.id, "Alice Scout", []),
    // The PC reactor: hostile-flipped token (the verify-quick-actions
    // charmed-ally arrangement), melee-tagged so Take has a weapon.
    baseCharacter(bobCharacterId, bob.id, "Bob Reactor", [
      { name: "Longsword", quantity: 1, attackKind: "melee", damageNotation: "1d8" },
    ]),
  ]);

  // A flat 40x40 map: straight walks cost 5 ft per cell, chessboard
  // diagonals included.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Opportunity arena",
    grid_width: 40,
    grid_height: 40,
  });
  const pc1TokenId = crypto.randomUUID();
  const pc2TokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  const bobTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: pc1TokenId, map_id: mapId, character_id: pc1CharacterId, x: 11, y: 10, elevation: 0, allegiance: "party" },
    { id: pc2TokenId, map_id: mapId, character_id: pc2CharacterId, x: 20, y: 21, elevation: 0, allegiance: "party" },
    { id: goblinTokenId, map_id: mapId, npc_name: "Goblin", x: 10, y: 10, elevation: 0, allegiance: "hostile" },
    { id: bobTokenId, map_id: mapId, character_id: bobCharacterId, x: 30, y: 30, elevation: 0, allegiance: "hostile" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // Combat seeded directly (start_combat is verified elsewhere). Turn
  // order: Vanguard 20 (current), Scout 15, Goblin 10, Bob Reactor 5.
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  const pc1CombatantId = crypto.randomUUID();
  const pc2CombatantId = crypto.randomUUID();
  const goblinCombatantId = crypto.randomUUID();
  const bobCombatantId = crypto.randomUUID();
  await admin.from("combat_combatants").insert([
    { id: pc1CombatantId, encounter_id: encounterId, token_id: pc1TokenId, character_id: pc1CharacterId, initiative: 20 },
    { id: pc2CombatantId, encounter_id: encounterId, token_id: pc2TokenId, character_id: pc2CharacterId, initiative: 15 },
    { id: goblinCombatantId, encounter_id: encounterId, token_id: goblinTokenId, npc_name: "Goblin", initiative: 10 },
    { id: bobCombatantId, encounter_id: encounterId, token_id: bobTokenId, character_id: bobCharacterId, initiative: 5 },
  ]);

  const combatantRow = async (id) => {
    const { data } = await admin.from("combat_combatants").select().eq("id", id).single();
    return data;
  };
  const oaRow = async (id) => {
    const { data } = await admin.from("opportunity_attacks").select().eq("id", id).single();
    return data;
  };
  const oaCount = async () => {
    const { count } = await admin
      .from("opportunity_attacks")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    return count ?? 0;
  };
  const setToken = (id, x, y) => admin.from("map_tokens").update({ x, y }).eq("id", id);
  const chebyshevFeet = (from, to) => Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5;

  // GameRoom.handleTokenDragEnd's tracked-move-then-detect chain, run with
  // the mover's REAL signed-in client and the REAL rules-engine module:
  // move_combat_token first, then assemble hostiles from what that client
  // can see — opposed-allegiance combatant tokens, reach from the
  // client-readable character's melee/finesse inventory (5 ft default for
  // an NPC or an unreadable PC, exactly the room's limitation), live
  // reaction flags, the mover's own disengaged column — and insert one
  // pending row per qualifying reactor through the members-may-insert
  // policy. Returns the created rows.
  async function trackedMoveAndDetect(mover, moverCombatantId, moverTokenId, from, to) {
    const moved = await mover.client.rpc("move_combat_token", {
      p_token_id: moverTokenId,
      p_x: to.x,
      p_y: to.y,
      p_elevation: 0,
      p_feet_cost: chebyshevFeet(from, to),
    });
    if (moved.error) throw new Error(`move_combat_token: ${moved.error.message}`);
    const { data: combatants } = await mover.client
      .from("combat_combatants")
      .select()
      .eq("encounter_id", encounterId);
    const { data: tokens } = await mover.client.from("map_tokens").select().eq("map_id", mapId);
    const { data: readable } = await mover.client.from("characters").select().eq("campaign_id", campaignId);
    const moverRow = combatants.find((c) => c.id === moverCombatantId);
    const moverToken = tokens.find((t) => t.id === moverRow.token_id);
    const opposed =
      moverToken.allegiance === "party" ? "hostile" : moverToken.allegiance === "hostile" ? "party" : null;
    const hostiles = combatants.flatMap((combatant) => {
      if (combatant.id === moverRow.id) return [];
      const token = tokens.find((t) => t.id === combatant.token_id);
      if (!token || token.allegiance !== opposed) return [];
      const character = combatant.character_id
        ? (readable.find((row) => row.id === combatant.character_id) ?? null)
        : null;
      return [
        {
          combatantId: combatant.id,
          position: { x: token.x, y: token.y },
          reachFeet: rules.meleeReachFeet(character?.inventory ?? []),
          reactionUsed: combatant.reaction_used,
          cannotReact: character !== null && (character.is_dead || character.current_hp === 0),
        },
      ];
    });
    const reactorIds = rules.computeOpportunityAttacks({
      moverFrom: from,
      moverTo: to,
      moverDisengaged: moverRow.disengaged,
      hostiles,
    });
    if (reactorIds.length === 0) return [];
    const { data, error } = await mover.client
      .from("opportunity_attacks")
      .insert(
        reactorIds.map((reactorCombatantId) => ({
          campaign_id: campaignId,
          encounter_id: encounterId,
          mover_combatant_id: moverRow.id,
          reactor_combatant_id: reactorCombatantId,
        }))
      )
      .select();
    if (error) throw new Error(`recording opportunity attacks: ${error.message}`);
    return data ?? [];
  }

  // A controller-or-not resolve attempt through a real client — the
  // resolveOpportunityAttack shape: pending-only filter, so RLS or a
  // raced resolve surfaces as zero rows.
  const resolveAs = (user, id, taken) =>
    user.client
      .from("opportunity_attacks")
      .update({ status: taken ? "taken" : "declined", resolved_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending")
      .select();

  // ── 1. Detection over live state: leaving reach records a pending row
  //    for the right reactor; within-reach / never-in-reach / disengaged /
  //    reaction-spent record nothing. Vanguard's turn throughout (all
  //    moves are the current combatant's tracked moves). ──

  // 1A. Adjacent (5 ft) to 15 ft: out of the goblin's reach; the
  // hostile-side Bob Reactor is 20+ cells away and never in reach.
  const provoked = await trackedMoveAndDetect(alice, pc1CombatantId, pc1TokenId, { x: 11, y: 10 }, { x: 14, y: 10 });
  check(
    "a tracked move out of an adjacent hostile's reach records exactly one pending opportunity attack",
    provoked.length === 1 && provoked[0].status === "pending",
    JSON.stringify(provoked)
  );
  check(
    "…for the right reactor (the goblin left behind), with the right mover",
    provoked[0]?.reactor_combatant_id === goblinCombatantId && provoked[0]?.mover_combatant_id === pc1CombatantId,
    JSON.stringify(provoked[0])
  );
  check(
    "a hostile that was never in reach (Bob Reactor, 20+ cells off) is not offered anything",
    !provoked.some((row) => row.reactor_combatant_id === bobCombatantId)
  );
  const goblinRowId = provoked[0]?.id;

  // 1B. Movement entirely within reach: adjacent to adjacent-diagonal.
  await setToken(pc1TokenId, 10, 11);
  const withinReach = await trackedMoveAndDetect(alice, pc1CombatantId, pc1TokenId, { x: 10, y: 11 }, { x: 11, y: 11 });
  check("moving within the hostile's reach records nothing", withinReach.length === 0, JSON.stringify(withinReach));

  // 1C. Never in reach: 50 ft away moving further.
  await setToken(pc1TokenId, 20, 10);
  const neverInReach = await trackedMoveAndDetect(alice, pc1CombatantId, pc1TokenId, { x: 20, y: 10 }, { x: 25, y: 10 });
  check("moving while never having been in reach records nothing", neverInReach.length === 0);

  // 1D. A hostile whose reaction is already spent is never offered a new
  // prompt, even for a clean reach-leaving move.
  await admin.from("combat_combatants").update({ reaction_used: true }).eq("id", goblinCombatantId);
  await setToken(pc1TokenId, 11, 10);
  const spentReaction = await trackedMoveAndDetect(alice, pc1CombatantId, pc1TokenId, { x: 11, y: 10 }, { x: 14, y: 10 });
  check("a hostile with its reaction already spent is never offered a new prompt", spentReaction.length === 0);
  await admin.from("combat_combatants").update({ reaction_used: false }).eq("id", goblinCombatantId);

  // 1E. Disengage: the owner's one-write declaration (disengaged AND
  // action_used together, the declareDisengage shape through
  // can_write_combatant), then the same reach-leaving move provokes
  // nothing at all.
  const { data: disengageWrite, error: disengageError } = await alice.client
    .from("combat_combatants")
    .update({ disengaged: true, action_used: true })
    .eq("id", pc1CombatantId)
    .select()
    .single();
  check(
    "the combatant's owner declares Disengage in one write: disengaged AND action_used together",
    !disengageError && disengageWrite?.disengaged === true && disengageWrite?.action_used === true,
    disengageError?.message ?? JSON.stringify(disengageWrite)
  );
  await setToken(pc1TokenId, 11, 10);
  const disengagedMove = await trackedMoveAndDetect(alice, pc1CombatantId, pc1TokenId, { x: 11, y: 10 }, { x: 14, y: 10 });
  check("a disengaged mover provokes nothing, however cleanly they leave reach", disengagedMove.length === 0);

  // 1F. advance_turn clears disengaged (with the rest of the economy) the
  // moment the disengager's own next turn begins: cycle the full round.
  for (let i = 0; i < 4; i++) {
    const { error } = await dm.client.rpc("advance_turn", { p_encounter_id: encounterId });
    if (error) throw new Error(`advance_turn: ${error.message}`);
  }
  const pc1AfterWrap = await combatantRow(pc1CombatantId);
  check(
    "advance_turn resets disengaged for the entering combatant (alongside the four economy columns)",
    pc1AfterWrap.disengaged === false && pc1AfterWrap.action_used === false,
    JSON.stringify(pc1AfterWrap)
  );

  // ── 2. Resolution RLS on 1A's still-pending goblin row: a plain player
  //    is no one's controller here; the DM is the NPC's; resolved rows
  //    are terminal. ──

  const { data: bobResolveNpc } = await resolveAs(bob, goblinRowId, true);
  check(
    "a non-controller's resolve attempt matches zero rows under RLS (player vs an NPC reactor's row)",
    (bobResolveNpc ?? []).length === 0 && (await oaRow(goblinRowId)).status === "pending",
    JSON.stringify(bobResolveNpc)
  );
  const { data: dmDecline } = await resolveAs(dm, goblinRowId, false);
  const goblinAfterDecline = await combatantRow(goblinCombatantId);
  check(
    "the reactor's controller (the DM, for an NPC) declines: row declined + resolved_at, reaction left untouched",
    dmDecline?.[0]?.status === "declined" &&
      dmDecline?.[0]?.resolved_at !== null &&
      goblinAfterDecline.reaction_used === false,
    JSON.stringify(dmDecline)
  );
  const { data: reResolve } = await resolveAs(dm, goblinRowId, true);
  check("a resolved row is terminal — even its controller cannot resolve it again", (reResolve ?? []).length === 0);

  // ── 3. The browser half: the prompt lands live in the reactor's
  //    owner's open room; Take fires the real attack roll; the stacked
  //    second prompt degrades to a clear reason; Decline clears it; the
  //    DM's NPC Take spends the reaction. ──

  // Positions for the two-movers-one-reactor stack: Bob Reactor at
  // (20,20) with Vanguard and Scout adjacent; goblin parked far away.
  await setToken(bobTokenId, 20, 20);
  await setToken(pc1TokenId, 21, 20);
  await setToken(pc2TokenId, 20, 21);
  await setToken(goblinTokenId, 35, 35);

  const bobContext = await browser.newContext();
  await bobContext.addCookies(sessionCookies(bob.session));
  const bobRoom = await bobContext.newPage();
  await bobRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await bobRoom.waitForSelector('[data-testid="combat-panel"]', { timeout: 30000 });
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  await dmRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmRoom.waitForSelector('[data-testid="combat-panel"]', { timeout: 30000 });
  // Let both rooms' opportunity_attacks subscriptions establish before
  // the first row lands, so "appears live" can't race the join.
  await sleep(2000);

  check(
    "no prompt banner renders while nothing is pending",
    (await bobRoom.$('[data-testid="opportunity-attack-panel"]')) === null
  );

  // Mover 1: Vanguard (current turn, round 2) walks out of Bob Reactor's
  // 5 ft reach.
  const [row1] = await trackedMoveAndDetect(alice, pc1CombatantId, pc1TokenId, { x: 21, y: 20 }, { x: 24, y: 20 });
  check(
    "a PC reactor is offered the attack (right reactor again, now a player's combatant)",
    row1?.reactor_combatant_id === bobCombatantId && row1?.status === "pending",
    JSON.stringify(row1)
  );
  const promptLanded = await bobRoom
    .waitForSelector(`[data-testid="opportunity-prompt-${row1.id}"]`, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("the pending prompt lands LIVE in the reactor's owner's already-open room (no reload)", promptLanded);
  check(
    "the whole table sees the offer (the DM's open room shows the same prompt)",
    await dmRoom
      .waitForSelector(`[data-testid="opportunity-prompt-${row1.id}"]`, { timeout: 15000 })
      .then(() => true)
      .catch(() => false)
  );

  // Mover 2: advance to the Scout (its owner may advance off her own
  // turn), who also walks out — a second pending prompt against the SAME
  // reactor before the first is resolved.
  const { error: aliceAdvanceError } = await alice.client.rpc("advance_turn", { p_encounter_id: encounterId });
  check("the current combatant's owner advances the turn to her second PC", !aliceAdvanceError, aliceAdvanceError?.message);
  const [row2] = await trackedMoveAndDetect(alice, pc2CombatantId, pc2TokenId, { x: 20, y: 21 }, { x: 20, y: 24 });
  check(
    "a second mover stacks a second pending prompt against the same reactor",
    row2?.reactor_combatant_id === bobCombatantId && row2?.status === "pending",
    JSON.stringify(row2)
  );
  await bobRoom.waitForSelector(`[data-testid="opportunity-prompt-${row2.id}"]`, { timeout: 15000 }).catch(() => undefined);

  // A non-controller (the mover's owner) cannot resolve the reactor's
  // pending prompt — RLS again, now player-vs-player.
  const { data: aliceResolve } = await resolveAs(alice, row1.id, false);
  check(
    "the mover's owner cannot resolve the reactor's pending prompt (RLS, player vs a PC reactor's row)",
    (aliceResolve ?? []).length === 0 && (await oaRow(row1.id)).status === "pending",
    JSON.stringify(aliceResolve)
  );

  // Take the first: single tagged melee weapon shows as a label; the
  // mover is another player's (unreadable) PC, so AC is typed in — the
  // established NPC-AC convention.
  check(
    "the Take flow offers the reactor's tagged melee weapon",
    ((await bobRoom.textContent(`[data-testid="opportunity-weapon-label-${row1.id}"]`).catch(() => "")) ?? "").includes(
      "Longsword"
    )
  );
  check(
    "an unreadable mover means a typed AC (no auto-fill claimed)",
    (await bobRoom.$(`[data-testid="opportunity-ac-${row1.id}"]`)) !== null &&
      (await bobRoom.$(`[data-testid="opportunity-known-ac-${row1.id}"]`)) === null
  );
  const attackRollIds = async () => {
    const { data } = await admin.from("roll_log").select("id").eq("campaign_id", campaignId).eq("kind", "attack");
    return new Set((data ?? []).map((row) => row.id));
  };
  const known = await attackRollIds();
  await bobRoom.fill(`[data-testid="opportunity-ac-${row1.id}"]`, "1");
  await bobRoom.click(`[data-testid="opportunity-take-${row1.id}"]`);
  let takeRoll = null;
  for (let i = 0; i < 27 && !takeRoll; i++) {
    await sleep(300);
    const { data } = await admin
      .from("roll_log")
      .select()
      .eq("campaign_id", campaignId)
      .eq("kind", "attack")
      .order("created_at", { ascending: false })
      .limit(3);
    takeRoll = (data ?? []).find((row) => !known.has(row.id)) ?? null;
  }
  check(
    "Take fires a kind:'attack' roll by the reactor's character against the mover",
    takeRoll !== null &&
      takeRoll.character_id === bobCharacterId &&
      takeRoll.roller_user_id === bob.id &&
      takeRoll.breakdown.attack?.targetCharacterId === pc1CharacterId &&
      takeRoll.breakdown.attack?.targetAc === 1 &&
      takeRoll.breakdown.attack?.attackKind === "melee",
    JSON.stringify(takeRoll?.breakdown?.attack ?? takeRoll)
  );
  // The row and the reaction flip land right after the roll resolves.
  let row1After = null;
  for (let i = 0; i < 27; i++) {
    row1After = await oaRow(row1.id);
    if (row1After.status !== "pending") break;
    await sleep(300);
  }
  const bobAfterTake = await combatantRow(bobCombatantId);
  check(
    "the take marks reaction_used on the reactor and the row taken (+resolved_at) — hit or miss",
    row1After?.status === "taken" && row1After?.resolved_at !== null && bobAfterTake.reaction_used === true,
    JSON.stringify({ row: row1After?.status, reaction: bobAfterTake.reaction_used })
  );

  // Shape identity with the manual flow: the same attack through the
  // manual roll endpoint produces a structurally identical row.
  const manual = await postRoll(bob, campaignId, {
    kind: "attack",
    characterId: bobCharacterId,
    attackKind: "melee",
    damageNotation: "1d8",
    targetAc: 1,
    targetName: "Goblin",
  });
  const manualRoll = manual.body?.roll;
  const keys = (obj) => Object.keys(obj ?? {}).sort().join(",");
  check(
    "the opportunity attack's roll is shape-identical to a manual attack roll (kind, breakdown keys, attack keys, label, modifier labels)",
    takeRoll !== null &&
      manualRoll !== undefined &&
      manualRoll.kind === takeRoll.kind &&
      keys(manualRoll.breakdown) === keys(takeRoll.breakdown) &&
      keys(manualRoll.breakdown.attack) === keys(takeRoll.breakdown.attack) &&
      manualRoll.breakdown.label === takeRoll.breakdown.label &&
      JSON.stringify(manualRoll.breakdown.modifiers.map((m) => m.label)) ===
        JSON.stringify(takeRoll.breakdown.modifiers.map((m) => m.label)),
    JSON.stringify({ manual: keys(manualRoll?.breakdown), take: keys(takeRoll?.breakdown) })
  );

  // The stacked second prompt, its reaction now spent by the first take:
  // Take degrades to a clear reason, Decline stays available.
  const staleReason = await bobRoom
    .waitForSelector(`[data-testid="opportunity-no-reaction-${row2.id}"]`, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(
    "the second pending prompt against the now-spent reactor loses Take to a clear 'Reaction already spent this turn' reason",
    staleReason &&
      ((await bobRoom.textContent(`[data-testid="opportunity-no-reaction-${row2.id}"]`).catch(() => "")) ?? "").includes(
        "Reaction already spent"
      ) &&
      (await bobRoom.$(`[data-testid="opportunity-take-${row2.id}"]`)) === null
  );
  await bobRoom.click(`[data-testid="opportunity-decline-${row2.id}"]`);
  let row2After = null;
  for (let i = 0; i < 27; i++) {
    row2After = await oaRow(row2.id);
    if (row2After.status !== "pending") break;
    await sleep(300);
  }
  check("Decline clears the stale offer (declined + resolved_at)", row2After?.status === "declined" && row2After?.resolved_at !== null);
  const panelGone = await bobRoom
    .waitForFunction(() => document.querySelector('[data-testid="opportunity-attack-panel"]') === null, {
      timeout: 15000,
    })
    .then(() => true)
    .catch(() => false);
  const dmPanelGone = await dmRoom
    .waitForFunction(() => document.querySelector('[data-testid="opportunity-attack-panel"]') === null, {
      timeout: 15000,
    })
    .then(() => true)
    .catch(() => false);
  check("once everything is resolved the banner disappears for everyone, live", panelGone && dmPanelGone);

  // ── 4. NPC reactor: the Scout (still the current combatant) leaves the
  //    goblin's reach; the DM's Take spends the reaction while the swing
  //    itself stays manual; the spent Bob Reactor is NOT re-offered. ──
  await setToken(goblinTokenId, 10, 10);
  await setToken(pc2TokenId, 11, 10);
  const npcRows = await trackedMoveAndDetect(alice, pc2CombatantId, pc2TokenId, { x: 11, y: 10 }, { x: 14, y: 10 });
  check(
    "the NPC reactor is offered the attack — and the reaction-spent PC reactor is not re-offered",
    npcRows.length === 1 && npcRows[0].reactor_combatant_id === goblinCombatantId,
    JSON.stringify(npcRows)
  );
  const npcRowId = npcRows[0].id;
  check(
    "a player who controls neither side just sees who's being waited on",
    await bobRoom
      .waitForSelector(`[data-testid="opportunity-waiting-${npcRowId}"]`, { timeout: 15000 })
      .then(() => true)
      .catch(() => false)
  );
  await dmRoom.waitForSelector(`[data-testid="opportunity-take-${npcRowId}"]`, { timeout: 15000 });
  await dmRoom.click(`[data-testid="opportunity-take-${npcRowId}"]`);
  let npcRowAfter = null;
  for (let i = 0; i < 27; i++) {
    npcRowAfter = await oaRow(npcRowId);
    if (npcRowAfter.status !== "pending") break;
    await sleep(300);
  }
  const goblinAfterTake = await combatantRow(goblinCombatantId);
  check(
    "the DM's NPC Take spends the reaction and marks the row taken (the swing itself stays a manual dice-panel roll)",
    npcRowAfter?.status === "taken" && goblinAfterTake.reaction_used === true,
    JSON.stringify({ row: npcRowAfter?.status, reaction: goblinAfterTake.reaction_used })
  );

  // ── 5. The Declare Disengage control (CombatPanel): gated on a free
  //    action in Strict mode, and one click flips both columns through
  //    the app. The Scout is still the current combatant; the DM's room
  //    carries the control for any current combatant. ──
  await admin.from("campaigns").update({ action_economy_strict: true }).eq("id", campaignId);
  await admin
    .from("combat_combatants")
    .update({ action_used: true, disengaged: false })
    .eq("id", pc2CombatantId);
  await dmRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmRoom.waitForSelector('[data-testid="economy-declare-disengage"]', { timeout: 30000 });
  check(
    "in Strict mode with the action already spent, Declare Disengage is unavailable with the reason spelled out",
    (await dmRoom.$eval('[data-testid="economy-declare-disengage"]', (el) => el.disabled)) === true &&
      ((await dmRoom.textContent('[data-testid="economy-declare-disengage"]')) ?? "").includes(
        "Disengage needs your action"
      )
  );
  await admin.from("combat_combatants").update({ action_used: false }).eq("id", pc2CombatantId);
  await dmRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmRoom.waitForSelector('[data-testid="economy-declare-disengage"]', { timeout: 30000 });
  await dmRoom.waitForFunction(
    () => document.querySelector('[data-testid="economy-declare-disengage"]')?.disabled === false,
    { timeout: 8000 }
  );
  await dmRoom.click('[data-testid="economy-declare-disengage"]');
  let pc2Declared = null;
  for (let i = 0; i < 27; i++) {
    pc2Declared = await combatantRow(pc2CombatantId);
    if (pc2Declared.disengaged) break;
    await sleep(300);
  }
  check(
    "clicking Declare Disengage sets disengaged AND action_used in one write through the app",
    pc2Declared?.disengaged === true && pc2Declared?.action_used === true,
    JSON.stringify({ disengaged: pc2Declared?.disengaged, action: pc2Declared?.action_used })
  );
  check(
    "the table-wide Disengaged badge appears",
    await dmRoom
      .waitForSelector('[data-testid="economy-disengaged"]', { timeout: 8000 })
      .then(() => true)
      .catch(() => false)
  );
  await admin.from("campaigns").update({ action_economy_strict: false }).eq("id", campaignId);
  await bobRoom.close();
  await dmRoom.close();

  // ── 6. The raw feed: a pending INSERT and its resolution UPDATE both
  //    reach another member's postgres_changes subscription live.
  //    Fresh-channel retry-until-landed (the verify-action-economy
  //    arrangement for a newly-published table): each probe is a fresh
  //    member-inserted row immediately declined by the DM, and a failed
  //    attempt resubscribes from scratch. ──
  await bob.client.realtime.setAuth(bob.session.access_token);
  let liveResult = null;
  let liveDetail = "no realtime events";
  for (let attempt = 0; attempt < 3 && !liveResult; attempt++) {
    liveResult = await new Promise((resolve) => {
      let probeTimer = null;
      let settled = false;
      let sawPending = false;
      let sawResolved = false;
      const channel = bob.client
        .channel(`verify-oa:${campaignId}:${attempt}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "opportunity_attacks", filter: `campaign_id=eq.${campaignId}` },
          (payload) => {
            if (payload.eventType === "INSERT" && payload.new.status === "pending") sawPending = true;
            if (payload.eventType === "UPDATE" && payload.new.status === "declined") sawResolved = true;
            if (sawPending && sawResolved) settle({ sawPending, sawResolved });
          }
        );
      const settle = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (probeTimer) clearInterval(probeTimer);
        void bob.client.removeChannel(channel);
        resolve(value);
      };
      const timer = setTimeout(() => {
        liveDetail = `attempt ${attempt + 1}: pending=${sawPending} resolved=${sawResolved} within 15s`;
        settle(null);
      }, 15000);
      // Each probe replays the full lifecycle: a member records an offer,
      // the NPC reactor's controller declines it.
      const probe = () =>
        void (async () => {
          const { data: probeRow } = await alice.client
            .from("opportunity_attacks")
            .insert({
              campaign_id: campaignId,
              encounter_id: encounterId,
              mover_combatant_id: pc2CombatantId,
              reactor_combatant_id: goblinCombatantId,
            })
            .select()
            .single();
          if (probeRow) await resolveAs(dm, probeRow.id, false);
        })().catch(() => undefined);
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          probe();
          probeTimer = setInterval(probe, 2500);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          liveDetail = `attempt ${attempt + 1}: channel ${status}`;
          settle(null);
        }
      });
    });
  }
  check(
    "the pending prompt and its resolution both reach another member's postgres_changes subscription live",
    liveResult !== null && liveResult.sawPending && liveResult.sawResolved,
    liveDetail
  );

  // Bookkeeping sanity for the whole run: every recorded row belongs to
  // this campaign's encounter and none was ever deleted (no DELETE policy
  // — the audit-trail posture).
  check("every recorded offer is still on the audit trail", (await oaCount()) >= 5);
} finally {
  await browser.close();
  await vite.close();
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
console.log("\nAll opportunity-attacks checks passed.");
process.exit(0);
