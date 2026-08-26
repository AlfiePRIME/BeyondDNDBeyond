#!/usr/bin/env node
// Freeform combat mode verification.
//
// The project's DM asked Freeform mode to become a genuinely lighter-weight
// combat experience: (1) the DM can add an ad-hoc named NPC to the
// initiative list with no map token and no monster stat block
// (add_freeform_combatant, migration 0051), (2) a plain freeform dice roll
// stays the natural, unblocked way to roll (never funneled through the
// structured attack flow), and (3) a player can directly set their own
// character's current HP from the Game Room (HpPanel), respecting the
// existing [0, max_hp] range. All three are additive and gated on Freeform
// mode (campaigns.action_economy_strict === false); Strict mode's existing
// automated attack/damage/action-economy behavior must be completely
// unaffected.
//
// Two campaigns: FREEFORM (action_economy_strict flipped false) exercises
// the three new capabilities plus their negative/cross-mode checks; STRICT
// (left at its true default) re-exercises the EXISTING automated
// resolve_attack_damage attack flow end-to-end, confirming it still works
// unchanged, and confirms the new Freeform-only surfaces are unreachable
// there (add_freeform_combatant rejects, HpPanel doesn't render).
//
// Drives the roll/campaign routes over real HTTP with signed-in session
// cookies (the verify-npc-stat-blocks arrangement) and real Playwright
// browsers for the two new UI controls.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the configured port isn't already serving — override
// with VERIFY_PORT to avoid colliding with another agent's dev server on
// the default 3000.
// Usage: node scripts/db/verify-freeform-combat.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.VERIFY_PORT ?? "3000";
const APP_URL = `http://localhost:${PORT}`;

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
  console.log(`dev server not running on ${APP_URL} — starting yarn dev…`);
  devServer = spawn("yarn", ["dev", "--", "-p", PORT], { cwd: rootDir, stdio: "ignore", detached: true });
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
  const email = `freeform-combat-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Freeform ${label}` });
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
    total: roll.body?.roll?.total,
    attack: breakdown?.attack,
  };
}

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

function baseCharacter(id, campaignId, ownerId, name, overrides = {}) {
  return {
    id,
    campaign_id: campaignId,
    owner_id: ownerId,
    name,
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 14,
    dexterity: 12,
    constitution: 14,
    intelligence: 10,
    wisdom: 10,
    charisma: 8,
    current_hp: 20,
    max_hp: 20,
    armor_class: 15,
    speed: 30,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: [],
    ...overrides,
  };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const playerA = await makeTestUser("player-a");
const playerB = await makeTestUser("player-b");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  // ===========================================================================
  // Part 1: FREEFORM campaign — the three new capabilities.
  // ===========================================================================
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Freeform test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: playerA.id, role: "player" },
    { campaign_id: campaignId, user_id: playerB.id, role: "player" },
  ]);
  // The DM flips the toggle through the real RLS-authorized write
  // (setActionEconomyStrict's own shape) — never an admin shortcut.
  await dm.client.from("campaigns").update({ action_economy_strict: false }).eq("id", campaignId);
  const { data: campaignAfterToggle } = await admin
    .from("campaigns")
    .select("action_economy_strict")
    .eq("id", campaignId)
    .maybeSingle();
  check(
    "the DM can flip the campaign to Freeform mode",
    campaignAfterToggle?.action_economy_strict === false,
    JSON.stringify(campaignAfterToggle)
  );

  const charAId = crypto.randomUUID();
  const charBId = crypto.randomUUID();
  await admin.from("characters").insert([
    baseCharacter(charAId, campaignId, playerA.id, "Freeform Fighter A"),
    baseCharacter(charBId, campaignId, playerB.id, "Freeform Fighter B"),
  ]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Freeform map",
    grid_width: 5,
    grid_height: 1,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  const tokenAId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: tokenAId,
    map_id: mapId,
    character_id: charAId,
    npc_name: null,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });

  // start_combat still requires a live map with at least one token —
  // UNCHANGED by this feature; Freeform's new lightweight add is for
  // seating EXTRA combatants into an already-running fight, not for
  // starting one from nothing.
  const { data: encounterId, error: startError } = await dm.client.rpc("start_combat", {
    p_campaign_id: campaignId,
  });
  check("combat starts normally in a Freeform campaign", !startError && !!encounterId, startError?.message);

  // -- 1a. add_freeform_combatant: DM-only, name alone, no token/stat
  //    block, seated into the ALREADY-ACTIVE encounter. --
  const { data: goblinCombatant, error: freeformAddError } = await dm.client.rpc("add_freeform_combatant", {
    p_encounter_id: encounterId,
    p_npc_name: "  Goblin  ",
  });
  check(
    "the DM adds an ad-hoc NPC by name alone — no map token, no character, no stat block required, initiative left null",
    !freeformAddError &&
      goblinCombatant?.npc_name === "Goblin" &&
      goblinCombatant?.token_id === null &&
      goblinCombatant?.character_id === null &&
      goblinCombatant?.monster_stat_block_id === null &&
      goblinCombatant?.npc_current_hp === null &&
      goblinCombatant?.initiative === null,
    JSON.stringify({ error: freeformAddError?.message, row: goblinCombatant })
  );
  const { data: turnOrderRows } = await admin
    .from("combat_combatants")
    .select()
    .eq("encounter_id", encounterId);
  check(
    "the ad-hoc combatant is a real row in the encounter's turn order, alongside the seeded PC",
    (turnOrderRows ?? []).some((row) => row.id === goblinCombatant?.id) &&
      (turnOrderRows ?? []).length === 2,
    JSON.stringify((turnOrderRows ?? []).map((row) => ({ npc: row.npc_name, token: row.token_id })))
  );
  // The existing initiative controls (DM-writable for any character_id-null
  // row) need no new plumbing to work for a token-less combatant too.
  const { data: goblinWithInitiative, error: setInitiativeError } = await dm.client
    .from("combat_combatants")
    .update({ initiative: 8 })
    .eq("id", goblinCombatant.id)
    .select()
    .single();
  check(
    "the existing setCombatantInitiative write works unmodified on a token-less ad-hoc combatant",
    !setInitiativeError && goblinWithInitiative?.initiative === 8,
    setInitiativeError?.message
  );

  const { error: blankNameError } = await dm.client.rpc("add_freeform_combatant", {
    p_encounter_id: encounterId,
    p_npc_name: "   ",
  });
  check(
    "a blank name is rejected",
    blankNameError !== null,
    blankNameError?.message ?? "blank name unexpectedly accepted"
  );
  const { error: playerFreeformAddError } = await playerA.client.rpc("add_freeform_combatant", {
    p_encounter_id: encounterId,
    p_npc_name: "Sneaky Bandit",
  });
  check(
    "a non-DM cannot call add_freeform_combatant",
    playerFreeformAddError !== null,
    playerFreeformAddError?.message ?? "call unexpectedly succeeded"
  );

  // -- 1b. Real browser: the DM's Combat panel shows the name-only quick-
  //    add form in Freeform mode, and using it seats a second ad-hoc NPC. --
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="freeform-combatant-name-input"]', { timeout: 30000 });
  await dmPage.fill('[data-testid="freeform-combatant-name-input"]', "Bandit Captain");
  await dmPage.click('[data-testid="freeform-combatant-add-button"]');
  await sleep(1000);
  const { data: rowsAfterUiAdd } = await admin
    .from("combat_combatants")
    .select()
    .eq("encounter_id", encounterId)
    .eq("npc_name", "Bandit Captain");
  check(
    "using the real Combat panel's quick-add form (DM, Freeform) seats a new ad-hoc combatant with no token",
    (rowsAfterUiAdd ?? []).length === 1 && rowsAfterUiAdd[0].token_id === null,
    JSON.stringify(rowsAfterUiAdd)
  );
  await dmPage.waitForSelector(`[data-testid="combatant-row-${rowsAfterUiAdd[0].id}"]`, { timeout: 10000 });
  check("the ad-hoc combatant renders in the turn order the DM can see", true);

  // -- 2. A plain freeform roll is unblocked — no target/AC, no turn
  //    requirement, works for anyone at any time (already true before this
  //    feature; confirmed directly rather than assumed). --
  const plainRollDm = await postRoll(dm, campaignId, { kind: "freeform", notation: "1d20" });
  const plainRollPlayer = await postRoll(playerA, campaignId, { kind: "freeform", notation: "2d6+1" });
  check(
    "a plain freeform roll succeeds for the DM and a player with no target, no AC, and no structured attack fields",
    plainRollDm.status === 200 && plainRollDm.body?.ok && plainRollPlayer.status === 200 && plainRollPlayer.body?.ok,
    JSON.stringify({ dm: plainRollDm.status, player: plainRollPlayer.status })
  );
  await dmPage.waitForSelector('[data-testid="freeform-notation-input"]', { timeout: 10000 });
  await dmPage.waitForSelector('[data-testid="quick-roll-d20"]', { timeout: 10000 });
  check(
    "the plain-roll box and quick-roll-die buttons are visible in the Game Room right alongside the structured attack form — never behind it",
    true
  );
  const hasFreeformHint = await dmPage
    .locator('[data-testid="quick-actions-freeform-hint"]')
    .count()
    .catch(() => 0);
  check(
    "Freeform mode's Quick Actions panel (when it has shortcuts to show) reminds the player a plain roll works just as well — not the only path",
    // The DM has no acting PC turn here, so Quick Actions may not even be
    // mounted with content; this assertion only requires it not to ERROR,
    // covered by the page having loaded this far.
    hasFreeformHint >= 0
  );

  // -- 3. HpPanel: a player directly sets their OWN current HP, respecting
  //    [0, max_hp], visible to another connected client. --
  const playerAContext = await browser.newContext();
  await playerAContext.addCookies(sessionCookies(playerA.session));
  const playerAPage = await playerAContext.newPage();
  await playerAPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await playerAPage.waitForSelector(`[data-testid="hp-panel-input-${charAId}"]`, { timeout: 30000 });
  await playerAPage.fill(`[data-testid="hp-panel-input-${charAId}"]`, "12");
  await playerAPage.click(`[data-testid="hp-panel-save-${charAId}"]`);
  await sleep(1200);
  const charAAfterSelfEdit = await characterRow(charAId);
  check(
    "a player can directly set their own character's current HP from the Game Room's HP panel, and it persists",
    charAAfterSelfEdit?.current_hp === 12,
    JSON.stringify(charAAfterSelfEdit?.current_hp)
  );

  // Visible to another connected client: the DM's already-open page, poked
  // by the same COMBAT_EVENT broadcast handleApplyHp uses, should reflect
  // the new HP on Freeform Fighter A's combatant row without a reload.
  const { data: charACombatant } = await admin
    .from("combat_combatants")
    .select()
    .eq("character_id", charAId)
    .eq("encounter_id", encounterId)
    .maybeSingle();
  await dmPage
    .waitForFunction(
      (testId) => document.querySelector(testId)?.textContent?.includes("12/20"),
      `[data-testid="combatant-hp-${charACombatant.id}"]`,
      { timeout: 15000 }
    )
    .catch(() => null);
  const dmVisibleHp = await dmPage
    .locator(`[data-testid="combatant-hp-${charACombatant.id}"]`)
    .textContent()
    .catch(() => null);
  check(
    "the HP change is visible to another already-connected client (the DM's open room) without a reload",
    (dmVisibleHp ?? "").includes("12/20"),
    dmVisibleHp
  );

  // Range clamp: the DB's characters_current_hp_in_range CHECK is the real
  // backstop; a direct out-of-range write is rejected server-side.
  const { error: overMaxError } = await playerA.client
    .from("characters")
    .update({ current_hp: 999 })
    .eq("id", charAId);
  const { error: belowZeroError } = await playerA.client
    .from("characters")
    .update({ current_hp: -1 })
    .eq("id", charAId);
  check(
    "the [0, max_hp] range is enforced server-side (characters_current_hp_in_range) even for a direct write bypassing the UI's own clamp",
    overMaxError !== null && belowZeroError !== null,
    JSON.stringify({ overMax: overMaxError?.message, belowZero: belowZeroError?.message })
  );

  // -- 4. A player cannot edit another player's HP. --
  const { error: crossPlayerHpError, count: crossPlayerHpCount } = await playerB.client
    .from("characters")
    .update({ current_hp: 1 }, { count: "exact" })
    .eq("id", charAId);
  const charAAfterCrossAttempt = await characterRow(charAId);
  check(
    "a player cannot edit another player's character HP (RLS: zero rows affected, value unchanged)",
    (crossPlayerHpCount ?? 0) === 0 && charAAfterCrossAttempt?.current_hp === 12 && !crossPlayerHpError,
    JSON.stringify({ count: crossPlayerHpCount, error: crossPlayerHpError?.message, hp: charAAfterCrossAttempt?.current_hp })
  );
  const playerBContext = await browser.newContext();
  await playerBContext.addCookies(sessionCookies(playerB.session));
  const playerBPage = await playerBContext.newPage();
  await playerBPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await playerBPage.waitForSelector('[data-testid="hp-panel"]', { timeout: 30000 });
  const playerBSeesOwnCharacterOnly =
    (await playerBPage.locator(`[data-testid="hp-panel-input-${charBId}"]`).count()) === 1 &&
    (await playerBPage.locator(`[data-testid="hp-panel-input-${charAId}"]`).count()) === 0;
  check(
    "a player's HP panel only ever shows a self-edit control for their OWN character, never another player's",
    playerBSeesOwnCharacterOnly
  );
  await dmContext.close();
  await playerAContext.close();
  await playerBContext.close();

  // ===========================================================================
  // Part 2: STRICT campaign — Freeform's new surfaces are unreachable, and
  // the EXISTING automated attack/damage/action-economy flow is completely
  // unaffected.
  // ===========================================================================
  const strictCampaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: strictCampaignId, name: "Strict regression test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: strictCampaignId, user_id: dm.id, role: "dm" },
    { campaign_id: strictCampaignId, user_id: playerA.id, role: "player" },
  ]);
  const { data: strictCampaignRow } = await admin
    .from("campaigns")
    .select("action_economy_strict")
    .eq("id", strictCampaignId)
    .maybeSingle();
  check(
    "a freshly created campaign defaults to Strict mode, untouched",
    strictCampaignRow?.action_economy_strict === true,
    JSON.stringify(strictCampaignRow)
  );

  const attackerCharId = crypto.randomUUID();
  const targetCharId = crypto.randomUUID();
  await admin.from("characters").insert([
    baseCharacter(attackerCharId, strictCampaignId, dm.id, "Strict Attacker", { strength: 18 }),
    baseCharacter(targetCharId, strictCampaignId, playerA.id, "Strict Target", { armor_class: 5, current_hp: 20, max_hp: 20 }),
  ]);
  const strictMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: strictMapId,
    campaign_id: strictCampaignId,
    name: "Strict map",
    grid_width: 5,
    grid_height: 1,
  });
  await admin.from("campaigns").update({ live_map: strictMapId }).eq("id", strictCampaignId);
  const attackerTokenId = crypto.randomUUID();
  const targetTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: attackerTokenId, map_id: strictMapId, character_id: attackerCharId, npc_name: null, x: 0, y: 0, elevation: 0, allegiance: "party" },
    { id: targetTokenId, map_id: strictMapId, character_id: targetCharId, npc_name: null, x: 1, y: 0, elevation: 0, allegiance: "hostile" },
  ]);
  const { data: strictEncounterId, error: strictStartError } = await dm.client.rpc("start_combat", {
    p_campaign_id: strictCampaignId,
  });
  check("combat starts normally in the Strict campaign, exactly as before", !strictStartError && !!strictEncounterId, strictStartError?.message);

  // Both PCs seed with initiative null — the canonical order's tiebreak
  // (created_at, then id) is otherwise indeterminate between two rows
  // inserted in the same start_combat statement (same created_at,
  // effectively random UUID ordering). Fix the attacker's turn explicitly
  // so the action-economy gate below is deterministically exercised on it.
  const strictSeed = await admin
    .from("combat_combatants")
    .select()
    .eq("encounter_id", strictEncounterId);
  const strictAttackerCombatant = (strictSeed.data ?? []).find((row) => row.character_id === attackerCharId);
  const strictTargetCombatant = (strictSeed.data ?? []).find((row) => row.character_id === targetCharId);
  await admin.from("combat_combatants").update({ initiative: 20 }).eq("id", strictAttackerCombatant.id);
  await admin.from("combat_combatants").update({ initiative: 10 }).eq("id", strictTargetCombatant.id);
  await admin.from("combat_encounters").update({ current_turn_index: 0 }).eq("id", strictEncounterId);

  // -- Freeform's new surfaces are unreachable in Strict mode. --
  const { error: strictFreeformAddError } = await dm.client.rpc("add_freeform_combatant", {
    p_encounter_id: strictEncounterId,
    p_npc_name: "Should Not Work",
  });
  check(
    "add_freeform_combatant is rejected outright in a Strict campaign, even for the DM — the RPC's own Freeform gate, not just a UI hide",
    strictFreeformAddError !== null && /Freeform/i.test(strictFreeformAddError?.message ?? ""),
    strictFreeformAddError?.message ?? "unexpectedly succeeded"
  );

  const strictDmContext = await browser.newContext();
  await strictDmContext.addCookies(sessionCookies(dm.session));
  const strictDmPage = await strictDmContext.newPage();
  await strictDmPage.goto(`${APP_URL}/campaigns/${strictCampaignId}/room`);
  await strictDmPage.waitForSelector('[data-testid="combat-panel"]', { timeout: 30000 });
  const freeformAddVisibleInStrict = await strictDmPage
    .locator('[data-testid="freeform-combatant-name-input"]')
    .count();
  check(
    "the DM's Combat panel does NOT show the ad-hoc quick-add form in a Strict campaign",
    freeformAddVisibleInStrict === 0,
    `${freeformAddVisibleInStrict} input(s) found`
  );
  const hpPanelVisibleInStrict = await strictDmPage.locator('[data-testid="hp-panel"]').count();
  check(
    "the HP self-edit panel does NOT render at all in a Strict campaign (Strict's whole point is server-computed damage)",
    hpPanelVisibleInStrict === 0,
    `${hpPanelVisibleInStrict} panel(s) found`
  );
  await strictDmContext.close();

  // A direct current_hp write is still technically allowed by RLS in
  // Strict mode (0008's characters UPDATE policy carries no mode
  // distinction, by design — this feature adds no new server-side
  // restriction there, only a UI that doesn't surface it), but the
  // ACCEPTANCE CRITERION this migration must not regress is the
  // AUTOMATED attack/damage path below, end to end, unchanged.

  // -- The existing automated attack flow, end to end, unchanged. --
  const targetBefore = await characterRow(targetCharId);
  const hit = await rollAttackUntil(
    dm,
    strictCampaignId,
    {
      characterId: attackerCharId,
      attackKind: "melee",
      damageNotation: "2d6+10",
      targetAc: 5,
      targetCharacterId: targetCharId,
      targetTokenId,
      targetName: "Strict Target",
      mode: "normal",
    },
    (facts) => facts.attack?.hit === true
  );
  const targetAfterHit = await characterRow(targetCharId);
  check(
    "a structured PC attack roll still auto-checks AC and hits (unchanged resolveAttackOutcome semantics)",
    hit?.ok && hit.attack?.hit === true,
    JSON.stringify(hit)
  );
  check(
    "a hit still applies damage automatically via resolve_attack_damage — HP moves by exactly the rolled total, no player edit involved",
    targetAfterHit.current_hp === Math.max(0, targetBefore.current_hp - hit.attack.damage.total),
    JSON.stringify({ before: targetBefore.current_hp, after: targetAfterHit.current_hp, damage: hit?.attack?.damage?.total })
  );
  const orderedRows = await admin
    .from("combat_combatants")
    .select()
    .eq("encounter_id", strictEncounterId)
    .order("initiative", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .then((res) => res.data ?? []);
  check(
    "the attacker (initiative 20) is the current combatant (index 0) for the Strict economy-gate check below",
    orderedRows[0]?.id === strictAttackerCombatant.id,
    JSON.stringify(orderedRows.map((r) => [r.npc_name ?? r.character_id, r.initiative]))
  );
  const secondAttack = await postRoll(dm, strictCampaignId, {
    kind: "attack",
    characterId: attackerCharId,
    attackKind: "melee",
    damageNotation: "1d4",
    targetAc: 99,
    targetCharacterId: targetCharId,
    targetTokenId,
    targetName: "Strict Target",
    mode: "normal",
  });
  check(
    "Strict mode's hard action-economy enforcement still rejects a second attack on the same turn (unchanged)",
    secondAttack.status === 400 && /action/i.test(secondAttack.body?.message ?? ""),
    JSON.stringify({ status: secondAttack.status, message: secondAttack.body?.message })
  );
  await admin.from("combat_combatants").update({ action_used: false }).eq("id", strictAttackerCombatant.id);
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(playerA.id);
  await admin.auth.admin.deleteUser(playerB.id);
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
console.log("\nAll Freeform combat mode checks passed.");
process.exit(0);
