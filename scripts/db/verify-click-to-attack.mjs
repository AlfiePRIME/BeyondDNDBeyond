#!/usr/bin/env node
// Click-to-attack (move onto an enemy/NPC prompts Roll!/Cancel) + the
// allegiance-based hit sound follow-up, verified together since the second
// rides on the first's own roll.
//
// Part 1 — resolve_pc_attack_on_npc_damage (migration 0089), tested directly
// via admin.rpc() the same way verify-npc-stat-blocks.mjs tests
// apply_npc_hp_delta: deterministic, no die-roll flakiness. Covers: damage
// clamps to [0, stat block max_hp] on map_tokens.current_hp; an
// unauthorized caller (owns neither the attacking character nor is DM) is
// rejected; a PC target token is rejected (no HP to track there); a
// currently-seated combatant's own npc_current_hp is kept in sync
// alongside the token; apply_npc_hp_delta (the DM's existing manual
// control) now writes the same value back to the token; and start_combat/
// add_combatant seed a fresh combatant's npc_current_hp from the token's
// own already-damaged current_hp rather than always resetting to max_hp.
//
// Part 2 — the real map gesture and the allegiance-keyed hit sound, in a
// real Playwright browser: reuses verify-token-click-select.mjs's own
// scanGridClick blind-aim technique (no way to compute a WebGL raycast
// target from camera math) and its exact Alice-PC-plus-adjacent-hostile-
// Goblin arena shape. Alice is put in a tracked combat turn with a
// zero-remaining movement budget purely as a test-harness safety net — it
// makes every stray scan click a silent cancel rather than an accidental
// move, so a full-grid scan can safely search for the one specific cell
// (the Goblin's) instead of a small ring around Alice's own token, which
// risks simply missing that cell's actual on-screen footprint at this
// camera's perspective. This has no bearing on the "whether in combat or
// not" claim itself — Part 1 above already proves the RPC/data layer works
// with NO encounter at all. Covers: moving Alice's token onto
// the Goblin's cell opens the Roll!/Cancel prompt instead of moving (the
// token's position never changes, hit or miss or cancelled); the prompt's
// AC is auto-filled from the Goblin's stat block; Cancel leaves no trace;
// Roll! posts a real attack roll through the ordinary roll route and the
// resulting roll_log row's own hit/critical/miss flags predict EXACTLY
// which of hit_enemy/hit_critical/hit_miss the shared sound manager's play
// log recorded — the same attackRollSoundKey logic, checked against real
// server output rather than assumed.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: node scripts/db/verify-click-to-attack.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 6120;
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
  console.log(`dev server not running on :${PORT} — starting this worktree's own…`);
  devServer = spawn("yarn", ["dev", "-p", String(PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${PORT} within 120s`);
}

const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;

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
  const email = `click-to-attack-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Attack ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function tokenRow(id) {
  const { data } = await admin.from("map_tokens").select().eq("id", id).single();
  return data;
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

/** A FINE local scan around a known screen point — a real screenshot taken
 * during this test's own development showed the whole 7x7 grid rendering
 * at only ~130x65 screen px (an individual cell barely 18x9px), far
 * smaller than scanGridClick's own coarse 34px full-canvas step; this
 * targets a single specific ADJACENT cell (not "any" reachable cell),
 * which that coarse scan can trivially step clean over. Small step, small
 * radius, sorted nearest-to-center-first. */
async function scanLocalGrid(page, center, done, opts = {}) {
  const { radius = 30, step = 3, settleMs = 150, onMiss } = opts;
  const points = [];
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      points.push({ x: center.x + dx, y: center.y + dy });
    }
  }
  points.sort((a, b) => (a.x - center.x) ** 2 + (a.y - center.y) ** 2 - ((b.x - center.x) ** 2 + (b.y - center.y) ** 2));
  for (const point of points) {
    await page.mouse.click(point.x, point.y);
    await sleep(settleMs);
    if (await done(point)) return point;
    if (onMiss) await onMiss(point);
  }
  return null;
}

/** verify-token-click-select.mjs's own blind grid scan, unchanged. */
async function scanGridClick(page, done, opts = {}) {
  const { xFrom = 0.12, xTo = 0.88, yFrom = 0.24, yTo = 0.7, step = 34, settleMs = 160, onMiss } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const [offset, settle] of [
    [0, settleMs],
    [step / 2, settleMs * 1.5],
  ]) {
    const points = [];
    for (let y = box.y + box.height * yFrom + offset; y <= box.y + box.height * yTo; y += step) {
      for (let x = box.x + box.width * xFrom + offset; x <= box.x + box.width * xTo; x += step) {
        points.push({ x, y });
      }
    }
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.5;
    points.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
    for (const point of points) {
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) return point;
      if (onMiss) await onMiss(point);
    }
  }
  return null;
}

const selectionState = (page) => readMirror(page, "token-selection-state");

function reselectOnMiss(page, tokenId, tokenPoint) {
  return async () => {
    const state = await selectionState(page);
    if (state.selectedTokenId !== tokenId) {
      await page.mouse.click(tokenPoint.x, tokenPoint.y);
      await sleep(200);
    }
  };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");

try {
  // ── Part 1: resolve_pc_attack_on_npc_damage, direct RPC calls. ──
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Click-to-attack RPC test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice Vanguard",
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
    inventory: [],
    spells: [],
  });

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "RPC test map",
    grid_width: 5,
    grid_height: 5,
  });

  const { data: statBlock } = await admin
    .from("monster_stat_blocks")
    .insert({
      campaign_id: campaignId,
      name: "Target Goblin",
      max_hp: 30,
      armor_class: 15,
      attacks: [{ name: "Scimitar", bonus: 4, damageNotation: "1d6+2" }],
    })
    .select()
    .single();

  const goblinTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: goblinTokenId,
    map_id: mapId,
    npc_name: statBlock.name,
    monster_stat_block_id: statBlock.id,
    x: 2,
    y: 2,
    elevation: 0,
    allegiance: "hostile",
  });

  const fakeBreakdown = { type: "d20", label: "Melee attack", mode: "normal", d20Rolls: [15], d20Result: 15, modifiers: [] };
  const rpc1 = await alice.client
    .rpc("resolve_pc_attack_on_npc_damage", {
      p_attacker_character_id: aliceCharacterId,
      p_target_token_id: goblinTokenId,
      p_damage: 8,
      p_critical: false,
      p_breakdown: fakeBreakdown,
      p_total: 20,
    })
    .single();
  check(
    "the attacking PLAYER (owning the character) can resolve PC-attacks-NPC damage, clamped correctly",
    !rpc1.error && rpc1.data?.out_target_current_hp === 22,
    JSON.stringify({ error: rpc1.error?.message, data: rpc1.data })
  );
  const goblinAfter1 = await tokenRow(goblinTokenId);
  check(
    "the damage lands on map_tokens.current_hp directly — no combat needed at all",
    goblinAfter1.current_hp === 22,
    `current_hp=${goblinAfter1.current_hp}`
  );
  const { data: loggedRoll } = await admin.from("roll_log").select().eq("id", rpc1.data.out_roll_id).maybeSingle();
  check(
    "the RPC logs the roll atomically with the attacking character_id (not null)",
    loggedRoll?.character_id === aliceCharacterId && loggedRoll?.kind === "attack",
    JSON.stringify(loggedRoll)
  );

  const rpc2 = await alice.client
    .rpc("resolve_pc_attack_on_npc_damage", {
      p_attacker_character_id: aliceCharacterId,
      p_target_token_id: goblinTokenId,
      p_damage: 1000,
      p_critical: false,
      p_breakdown: fakeBreakdown,
      p_total: 20,
    })
    .single();
  check(
    "overkill damage clamps at 0, never negative",
    !rpc2.error && rpc2.data?.out_target_current_hp === 0,
    JSON.stringify({ error: rpc2.error?.message, data: rpc2.data })
  );

  const bobRpc = await bob.client
    .rpc("resolve_pc_attack_on_npc_damage", {
      p_attacker_character_id: aliceCharacterId,
      p_target_token_id: goblinTokenId,
      p_damage: 5,
      p_critical: false,
      p_breakdown: fakeBreakdown,
      p_total: 20,
    })
    .single();
  check(
    "a caller who neither owns the attacking character nor is the DM is rejected",
    bobRpc.error !== null,
    bobRpc.error?.message ?? "unexpectedly succeeded"
  );

  const pcTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: pcTokenId,
    map_id: mapId,
    character_id: aliceCharacterId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });
  const pcTargetRpc = await alice.client
    .rpc("resolve_pc_attack_on_npc_damage", {
      p_attacker_character_id: aliceCharacterId,
      p_target_token_id: pcTokenId,
      p_damage: 5,
      p_critical: false,
      p_breakdown: fakeBreakdown,
      p_total: 20,
    })
    .single();
  check(
    "a PC token as the target is rejected (that's resolveAttackDamage's job, not this RPC's)",
    pcTargetRpc.error !== null,
    pcTargetRpc.error?.message ?? "unexpectedly succeeded"
  );

  // Reset, then seed the Goblin into a live encounter and confirm the RPC
  // keeps BOTH counters in sync from the token side.
  await admin.from("map_tokens").update({ current_hp: 20 }).eq("id", goblinTokenId);
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  const goblinCombatantId = crypto.randomUUID();
  await admin.from("combat_combatants").insert({
    id: goblinCombatantId,
    encounter_id: encounterId,
    token_id: goblinTokenId,
    npc_name: statBlock.name,
    monster_stat_block_id: statBlock.id,
    npc_current_hp: 20,
  });
  const rpc3 = await alice.client
    .rpc("resolve_pc_attack_on_npc_damage", {
      p_attacker_character_id: aliceCharacterId,
      p_target_token_id: goblinTokenId,
      p_damage: 6,
      p_critical: false,
      p_breakdown: fakeBreakdown,
      p_total: 20,
    })
    .single();
  const goblinCombatantAfter = await admin
    .from("combat_combatants")
    .select()
    .eq("id", goblinCombatantId)
    .single();
  check(
    "while seated in a live encounter, the RPC keeps combat_combatants.npc_current_hp in sync too",
    !rpc3.error && rpc3.data?.out_target_current_hp === 14 && goblinCombatantAfter.data?.npc_current_hp === 14,
    JSON.stringify({ token: rpc3.data, combatant: goblinCombatantAfter.data })
  );

  const dmDelta = await dm.client.rpc("apply_npc_hp_delta", { p_combatant_id: goblinCombatantId, p_delta: -4 }).single();
  const goblinTokenAfterDelta = await tokenRow(goblinTokenId);
  check(
    "apply_npc_hp_delta (the DM's existing manual control) now writes the same value back to the token too",
    !dmDelta.error && dmDelta.data?.npc_current_hp === 10 && goblinTokenAfterDelta.current_hp === 10,
    JSON.stringify({ combatant: dmDelta.data, token: goblinTokenAfterDelta })
  );

  await admin.from("combat_encounters").update({ ended_at: new Date(0).toISOString() }).eq("id", encounterId);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  const { data: freshEncounterId, error: startError } = await dm.client.rpc("start_combat", {
    p_campaign_id: campaignId,
  });
  const { data: seededCombatants } = await admin
    .from("combat_combatants")
    .select()
    .eq("encounter_id", freshEncounterId);
  const seededGoblin = seededCombatants?.find((row) => row.token_id === goblinTokenId);
  check(
    "start_combat seeds a fresh combatant's HP from the token's OWN already-damaged current_hp, not a max_hp reset",
    !startError && seededGoblin?.npc_current_hp === 10,
    JSON.stringify({ error: startError?.message, seeded: seededGoblin })
  );
} finally {
  // Part 1's own cleanup happens per-user below; nothing else to release
  // here (no browser opened yet for Part 1).
}

// ── Part 2: the real click-to-attack gesture + allegiance hit sound, in a
//    fresh campaign/map (verify-token-click-select.mjs's own arena shape). ──
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Click-to-attack UI test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice Vanguard",
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
    inventory: [],
    spells: [],
  });

  const GRID = 7;
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Click-to-attack arena",
    grid_width: GRID,
    grid_height: GRID,
  });

  const { data: statBlock } = await admin
    .from("monster_stat_blocks")
    .insert({
      campaign_id: campaignId,
      name: "Goblin",
      max_hp: 30,
      armor_class: 15,
      attacks: [{ name: "Scimitar", bonus: 4, damageNotation: "1d6+2" }],
    })
    .select()
    .single();

  const center = Math.floor(GRID / 2);
  const aliceTokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: aliceTokenId, map_id: mapId, character_id: aliceCharacterId, x: center, y: center, elevation: 0, allegiance: "party" },
    {
      id: goblinTokenId,
      map_id: mapId,
      npc_name: statBlock.name,
      monster_stat_block_id: statBlock.id,
      x: center,
      y: center + 1,
      elevation: 0,
      allegiance: "hostile",
    },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // A tracked turn with a ZERO remaining budget (movement_used_feet ==
  // speed) — purely a test-harness safety net, not a claim about
  // production behavior (Part 1 above already proves the RPC/data layer
  // works with NO encounter at all, the real "whether in combat or not"
  // case). With budget zero, reachableSetForSelection highlights only
  // Alice's own cell, so a FULL-GRID blind scan (unlike a small ring
  // around her token, which risks simply missing the Goblin's actual
  // on-screen footprint at this camera's perspective) can safely sweep the
  // whole canvas: every miss is a silent, harmless cancel (never an
  // accidental move to some other cell breaking the fixed alicePoint
  // reselect), and the Goblin's own cell still opens the prompt regardless
  // of the exhausted budget — handleSelectedTokenCellClick's own occupant
  // check runs BEFORE the reachable-set check.
  const encounterId2 = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId2, campaign_id: campaignId });
  await admin.from("combat_combatants").insert({
    encounter_id: encounterId2,
    token_id: aliceTokenId,
    character_id: aliceCharacterId,
    initiative: 20,
    movement_used_feet: 30,
  });

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const aliceRoom = await aliceContext.newPage();
  await aliceRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await aliceRoom.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
  await aliceRoom.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });
  await sleep(2000);

  // Dock (close) every floating panel first — by default they cover most
  // of the canvas (Combat/Quick Actions/Dice Tray/Dice/Tokens/Chat/
  // Handouts/Live Map all open at once), and a DOM panel sitting on top of
  // the canvas at a given pixel swallows a page.mouse.click() there before
  // it ever reaches the WebGL scene beneath — confirmed via a real
  // screenshot during this test's own development. Docking is the
  // existing close-to-top-bar affordance (close-toggle-<panelId>); ignore
  // any panel not currently present/open.
  for (const panelId of [
    "combat",
    "opportunityAttack",
    "quickActions",
    "diceLog",
    "handout",
    "diceTray",
    "hp",
    "liveObjects",
    "chatLog",
    "tokens",
    "map",
  ]) {
    await aliceRoom.click(`[data-testid="close-toggle-${panelId}"]`, { timeout: 1000 }).catch(() => undefined);
  }
  await sleep(300);

  const alicePoint = await scanGridClick(aliceRoom, async () => (await selectionState(aliceRoom)).selectedTokenId === aliceTokenId);
  check("Alice can click-select her own token", alicePoint !== null);

  const aliceBeforeAttack = await tokenRow(aliceTokenId);
  const opened = await scanLocalGrid(
    aliceRoom,
    alicePoint,
    async () => isVisible(aliceRoom, "attack-prompt-modal"),
    { onMiss: reselectOnMiss(aliceRoom, aliceTokenId, alicePoint) }
  );
  check("moving Alice's token onto the Goblin's cell opens the Roll!/Cancel prompt instead of moving", opened !== null);
  const acText = await aliceRoom.textContent('[data-testid="attack-prompt-modal"]').catch(() => "");
  check(
    "the prompt auto-fills the target's AC from its stat block (no manual entry)",
    acText.includes(String(statBlock.armor_class)),
    acText
  );
  const aliceDuringPrompt = await tokenRow(aliceTokenId);
  check(
    "the token has NOT moved just from opening the prompt",
    aliceDuringPrompt.x === aliceBeforeAttack.x && aliceDuringPrompt.y === aliceBeforeAttack.y
  );

  await aliceRoom.click('[data-testid="attack-prompt-cancel"]');
  await sleep(300);
  check("Cancel closes the prompt", !(await isVisible(aliceRoom, "attack-prompt-modal")));
  const aliceAfterCancel = await tokenRow(aliceTokenId);
  check(
    "Cancel leaves the token exactly where it was — no move, ever",
    aliceAfterCancel.x === aliceBeforeAttack.x && aliceAfterCancel.y === aliceBeforeAttack.y
  );
  const { count: rollsAfterCancel } = await admin
    .from("roll_log")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  check("Cancel logs no roll at all", rollsAfterCancel === 0, `${rollsAfterCancel} roll(s) logged`);

  // Re-open the prompt and actually Roll! — snapshot the sound play log
  // first so only THIS roll's own entries are inspected.
  const playLogBefore = (await readMirror(aliceRoom, "sound-manager-debug")).playLog ?? [];
  const alicePoint2 = await scanGridClick(aliceRoom, async () => (await selectionState(aliceRoom)).selectedTokenId === aliceTokenId);
  check("re-selecting Alice's token for the Roll! check works", alicePoint2 !== null);
  const reopened = await scanLocalGrid(
    aliceRoom,
    alicePoint2,
    async () => isVisible(aliceRoom, "attack-prompt-modal"),
    { onMiss: reselectOnMiss(aliceRoom, aliceTokenId, alicePoint2) }
  );
  check("re-opening the prompt on the same cell works", reopened !== null);
  await aliceRoom.click('[data-testid="attack-prompt-roll"]');
  await aliceRoom.waitForFunction(
    (testid) => !document.querySelector(`[data-testid="${testid}"]`),
    "attack-prompt-modal",
    { timeout: 15000 }
  );
  await sleep(500);

  const { data: rollsAfterRoll } = await admin
    .from("roll_log")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false })
    .limit(1);
  const landed = rollsAfterRoll?.[0] ?? null;
  check(
    "Roll! posts a real attack roll through the ordinary roll route, targeting the Goblin's token",
    landed?.kind === "attack" &&
      landed?.character_id === aliceCharacterId &&
      landed?.breakdown?.attack?.targetTokenId === goblinTokenId,
    JSON.stringify(landed?.breakdown?.attack)
  );
  const aliceAfterRoll = await tokenRow(aliceTokenId);
  check(
    "attacking (hit or miss) never moves the attacker's token onto the target's cell",
    aliceAfterRoll.x === aliceBeforeAttack.x && aliceAfterRoll.y === aliceBeforeAttack.y
  );

  const attack = landed?.breakdown?.attack;
  const expectedKey = attack?.critical ? "hit_critical" : !attack?.hit ? "hit_miss" : "hit_enemy";
  const playLogAfter = (await readMirror(aliceRoom, "sound-manager-debug")).playLog ?? [];
  const newEntries = playLogAfter.slice(playLogBefore.length);
  check(
    `the allegiance-aware hit sound fired exactly the predicted key ("${expectedKey}") for this roll's real hit/critical/miss outcome`,
    newEntries.some((entry) => entry.key === expectedKey),
    JSON.stringify({ expected: expectedKey, attack, newEntries })
  );

  await aliceContext.close();
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
console.log("\nAll click-to-attack checks passed.");
process.exit(0);
