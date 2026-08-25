#!/usr/bin/env node
// Hide/Stealth verification (Prompt 60 acceptance criteria).
//
// Seeds a campaign whose live map is a 30x1 corridor (bright cells x 0-9,
// dark cells x 10-29) with hider Alice (PC, DEX 18, not Stealth-proficient
// — Stealth totals span 5-24) and, owned by a DIFFERENT player Bob (so
// Alice's session genuinely cannot read their character rows under the
// 0008 RLS — the gap get_encounter_vision_stats exists to bridge), four
// observers tuned for determinism against any d20: "High Watch" (passive
// Perception 25 — always strictly above Alice's total, so she always hides
// from him), "Low Watch" (passive 5 — never above her total, tie-or-better
// notices, so he always perceives her), blinded "Blind Watch" (passive 25
// but vision-blocked — could never perceive her, so no row regardless of
// the roll), and darkvision "Dwarf Watch" for the darkness phase; plus an
// NPC "Goblin Watcher" (no character row — the flat default passive 10).
// Drives the roll Route Handler over real HTTP with signed-in session
// cookies (the verify-vision-advantage.mjs arrangement) and real
// Playwright browsers for the rendering checks (the
// verify-vision-rendering.mjs arrangement, reading the room's hidden
// [data-testid="vision-state"] render-state mirror).
//
// Checks: a Hide roll hides from exactly the observers whose passive
// Perception strictly beats the Stealth total (High always, Low never, the
// NPC against the default 10 — asserted per-roll from the ACTUAL logged
// total, both NPC outcomes observed across retries), with the per-observer
// verdict legible in the stored roll_log breakdown; a fresh attempt
// REPLACES prior hidden state (a pre-seeded stale row is gone after the
// next roll, and row counts never accumulate); an observer who couldn't
// perceive the hider at all — blinded, or the hider standing in darkness
// beyond their vision — gets no row even when their passive would
// otherwise always win; an NPC hider rolls a plain unmodified d20
// (DM-only); the hidden token is genuinely absent from the specific
// observer's rendering state (live, via postgres_changes reaching an open
// room) while the cell and another token ON that cell render normally, and
// the DM's view is never masked; a hidden attacker's attack rolls with
// advantage sourced "attacking from hiding" against the target it was
// hidden from and then reveals it to EVERYONE (all rows gone, not just the
// target's); a manual "Stop hiding" delete clears hidden state with no
// attack; a non-controller can neither roll Hide (403) nor insert/delete
// hidden rows (RLS); and both the Hide roll and hidden-from changes reach
// another member's postgres_changes subscriptions live (retry-until-
// landed).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-hide-stealth.mjs

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
  const email = `hide-stealth-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Hide ${label}` });
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

async function hiddenRowsFor(hiderCombatantId) {
  const { data } = await admin
    .from("combatant_hidden_from")
    .select()
    .eq("hider_combatant_id", hiderCombatantId);
  return data ?? [];
}

async function visionState(page) {
  const text = await page.textContent('[data-testid="vision-state"]');
  return JSON.parse(text);
}

// Poll a page's vision-state mirror until the predicate holds — live
// checks ride this: the page is never re-navigated, only its live
// recompute is awaited.
async function waitForVision(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await visionState(page);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

// Retry-until-landed for a captured realtime event — no fixed sleep.
async function waitForEvent(events, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = events.find(predicate);
    if (match) return match;
    await sleep(200);
  }
  return null;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch();

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Hide stealth test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  // Alice the hider: DEX 18 (+4), NOT Stealth-proficient — every Stealth
  // total lands in [5, 24]. Bob's observers are tuned around that range so
  // hide/notice outcomes are deterministic for any d20 (see header).
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
  const aliceCharId = crypto.randomUUID();
  const highCharId = crypto.randomUUID(); // passive 25: 10 + wis 30 (+10) + prof 5 (level 13)
  const lowCharId = crypto.randomUUID(); // passive 5: 10 + wis 1 (-5)
  const blindCharId = crypto.randomUUID(); // passive 25 but blinded — vision-blocked
  const dwarfCharId = crypto.randomUUID(); // passive 25 with darkvision 60 ft
  await admin.from("characters").insert([
    baseCharacter(aliceCharId, alice.id, "Sneaky Alice", { dexterity: 18 }),
    baseCharacter(highCharId, bob.id, "High Watch", { level: 13, wisdom: 30, proficiencies: ["Perception"] }),
    baseCharacter(lowCharId, bob.id, "Low Watch", { wisdom: 1 }),
    baseCharacter(blindCharId, bob.id, "Blind Watch", { level: 13, wisdom: 30, proficiencies: ["Perception"] }),
    baseCharacter(dwarfCharId, bob.id, "Dwarf Watch", {
      level: 13,
      wisdom: 30,
      proficiencies: ["Perception"],
      darkvision_feet: 60,
    }),
  ]);

  // The corridor: 30x1, bright by sparse default up to x 9, dark x 10-29.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Hide corridor",
    grid_width: 30,
    grid_height: 1,
  });
  const cellRows = [];
  for (let x = 10; x < 30; x++) {
    cellRows.push({ map_id: mapId, x, y: 0, elevation: 0, terrain_type: "normal", light_level: "dark" });
  }
  await admin.from("map_cells").insert(cellRows);

  // High's token is the NEWEST of Bob's four so mostRecentOwnToken makes
  // High Watch Bob's active character in the rendering phase. The Rat is a
  // non-combatant NPC sharing Alice's cell — the "everything else on the
  // hidden token's cell still renders" control.
  const aliceTokenId = crypto.randomUUID();
  const highTokenId = crypto.randomUUID();
  const lowTokenId = crypto.randomUUID();
  const blindTokenId = crypto.randomUUID();
  const dwarfTokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  const ratTokenId = crypto.randomUUID();
  // Every row carries created_at explicitly — PostgREST null-fills missing
  // keys across a bulk payload (the main README's documented gotcha), and
  // High's must be the newest of Bob's anyway.
  await admin.from("map_tokens").insert([
    { id: aliceTokenId, map_id: mapId, character_id: aliceCharId, npc_name: null, x: 2, y: 0, elevation: 0, allegiance: "party", created_at: "2026-08-24T09:00:00.000Z" },
    { id: highTokenId, map_id: mapId, character_id: highCharId, npc_name: null, x: 0, y: 0, elevation: 0, allegiance: "party", created_at: "2026-08-24T12:00:00.000Z" },
    { id: lowTokenId, map_id: mapId, character_id: lowCharId, npc_name: null, x: 1, y: 0, elevation: 0, allegiance: "party", created_at: "2026-08-24T10:00:00.000Z" },
    { id: blindTokenId, map_id: mapId, character_id: blindCharId, npc_name: null, x: 4, y: 0, elevation: 0, allegiance: "party", created_at: "2026-08-24T10:30:00.000Z" },
    { id: dwarfTokenId, map_id: mapId, character_id: dwarfCharId, npc_name: null, x: 15, y: 0, elevation: 0, allegiance: "party", created_at: "2026-08-24T11:00:00.000Z" },
    { id: goblinTokenId, map_id: mapId, character_id: null, npc_name: "Goblin Watcher", x: 3, y: 0, elevation: 0, allegiance: "hostile", created_at: "2026-08-24T09:00:00.000Z" },
    { id: ratTokenId, map_id: mapId, character_id: null, npc_name: "Rat", x: 2, y: 0, elevation: 0, allegiance: "neutral", created_at: "2026-08-24T09:00:00.000Z" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // Combat: everyone but the Rat. Alice sorts last so the current-turn
  // pointer never lands on her (the economy gate stays out of the way).
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  const { data: combatants } = await admin
    .from("combat_combatants")
    .insert([
      { encounter_id: encounterId, token_id: highTokenId, character_id: highCharId, npc_name: null, initiative: 20 },
      { encounter_id: encounterId, token_id: lowTokenId, character_id: lowCharId, npc_name: null, initiative: 19 },
      { encounter_id: encounterId, token_id: blindTokenId, character_id: blindCharId, npc_name: null, initiative: 18 },
      { encounter_id: encounterId, token_id: dwarfTokenId, character_id: dwarfCharId, npc_name: null, initiative: 17 },
      { encounter_id: encounterId, token_id: goblinTokenId, character_id: null, npc_name: "Goblin Watcher", initiative: 15 },
      { encounter_id: encounterId, token_id: aliceTokenId, character_id: aliceCharId, npc_name: null, initiative: 1 },
    ])
    .select();
  const combatantByToken = new Map(combatants.map((row) => [row.token_id, row]));
  const aliceCombatant = combatantByToken.get(aliceTokenId).id;
  const highCombatant = combatantByToken.get(highTokenId).id;
  const lowCombatant = combatantByToken.get(lowTokenId).id;
  const blindCombatant = combatantByToken.get(blindTokenId).id;
  const dwarfCombatant = combatantByToken.get(dwarfTokenId).id;
  const goblinCombatant = combatantByToken.get(goblinTokenId).id;
  await admin.from("combatant_conditions").insert({ combatant_id: blindCombatant, condition_key: "blinded" });

  function hideFacts(roll) {
    const breakdown = roll.body?.roll?.breakdown;
    return {
      ok: roll.status === 200 && !!roll.body?.ok,
      kind: roll.body?.roll?.kind,
      total: roll.body?.roll?.total,
      d20: breakdown?.d20Result,
      modifiers: breakdown?.modifiers,
      hide: breakdown?.hide,
      id: roll.body?.roll?.id,
    };
  }
  const outcomeIds = (outcomes) => (outcomes ?? []).map((o) => o.combatantId).sort();

  // -- 1. The Hide roll, resolved per observer from the ACTUAL total. A
  //    stale pre-seeded row (as if from an earlier attempt) must be
  //    REPLACED by the next roll, not accumulated. Rolls repeat until the
  //    NPC's default-10 comparison has produced BOTH outcomes, asserting
  //    exact expectations on every single roll along the way. --
  await admin.from("combatant_hidden_from").insert({
    hider_combatant_id: aliceCombatant,
    observer_combatant_id: lowCombatant,
  });

  let sawNpcHidden = false;
  let sawNpcNoticed = false;
  let allRollsExact = true;
  let allRollsReplaced = true;
  let firstFacts = null;
  let rolls = 0;
  for (; rolls < 60 && !(sawNpcHidden && sawNpcNoticed); rolls++) {
    const facts = hideFacts(await postRoll(alice, campaignId, { kind: "hide", combatantId: aliceCombatant }));
    if (!firstFacts) firstFacts = facts;
    if (!facts.ok || !facts.hide) {
      allRollsExact = false;
      console.error("hide roll failed:", JSON.stringify(facts));
      break;
    }
    // Deterministic per-roll expectation: High always hidden-from (passive
    // 25 > any total), Low always notices (passive 5, tie-or-better),
    // Blind never perceives, Dwarf always hidden-from (passive 25, bright
    // cell visible from anywhere), Goblin hidden-from iff total < 10.
    const expectHidden = [highCombatant, dwarfCombatant, ...(facts.total < 10 ? [goblinCombatant] : [])].sort();
    const expectNoticed = [lowCombatant, ...(facts.total < 10 ? [] : [goblinCombatant])].sort();
    const rows = await hiddenRowsFor(aliceCombatant);
    const rowObservers = rows.map((row) => row.observer_combatant_id).sort();
    if (
      JSON.stringify(outcomeIds(facts.hide.hiddenFrom)) !== JSON.stringify(expectHidden) ||
      JSON.stringify(outcomeIds(facts.hide.noticedBy)) !== JSON.stringify(expectNoticed) ||
      JSON.stringify(outcomeIds(facts.hide.couldNotPerceive)) !== JSON.stringify([blindCombatant]) ||
      JSON.stringify(rowObservers) !== JSON.stringify(expectHidden)
    ) {
      allRollsExact = false;
      console.error(`roll ${rolls} mismatch:`, JSON.stringify({ facts, rows: rowObservers, expectHidden }));
    }
    // Replacement, not accumulation: the row set must be EXACTLY this
    // attempt's — the stale Low row (and any prior attempt's rows) gone.
    if (rows.length !== expectHidden.length || rowObservers.includes(lowCombatant)) {
      allRollsReplaced = false;
    }
    if (facts.total < 10) sawNpcHidden = true;
    else sawNpcNoticed = true;
  }
  check(
    "a Stealth total below an observer's passive Perception hides from exactly that observer (High passive 25: always; Low passive 5: never — tie-or-better notices)",
    allRollsExact && firstFacts?.ok,
    JSON.stringify(firstFacts)
  );
  check(
    "a bare NPC observer is compared against the default passive Perception of 10 — both outcomes observed across rolls",
    sawNpcHidden && sawNpcNoticed && allRollsExact,
    `npcHidden=${sawNpcHidden} npcNoticed=${sawNpcNoticed} after ${rolls} rolls`
  );
  check(
    "a fresh Hide attempt REPLACES prior hidden state (pre-seeded stale row gone; row sets never accumulate across attempts)",
    allRollsReplaced,
    "stale/accumulated rows detected"
  );
  check(
    "a blinded observer (passive 25, vision-blocked) gets no row — it could never perceive the hider",
    JSON.stringify(outcomeIds(firstFacts?.hide?.couldNotPerceive)) === JSON.stringify([blindCombatant]),
    JSON.stringify(firstFacts?.hide?.couldNotPerceive)
  );
  check(
    "the hider's Stealth modifiers are DEX + (no) proficiency, matching the rules engine (+4)",
    firstFacts?.total === firstFacts?.d20 + 4 &&
      firstFacts?.modifiers?.length === 1 &&
      firstFacts?.modifiers?.[0]?.label === "Dexterity modifier" &&
      firstFacts?.modifiers?.[0]?.value === 4,
    JSON.stringify(firstFacts?.modifiers)
  );

  // -- 2. The stored roll_log entry: kind "hide", with the per-observer
  //    verdict legible — NPC observers by name, an unreadable PC observer
  //    by the generic fallback, each with the passive compared against. --
  const { data: storedHide } = await admin.from("roll_log").select().eq("id", firstFacts.id).maybeSingle();
  const storedHigh = storedHide?.breakdown?.hide?.hiddenFrom?.find((o) => o.combatantId === highCombatant);
  const storedLow = storedHide?.breakdown?.hide?.noticedBy?.find((o) => o.combatantId === lowCombatant);
  // The Goblin lands in hiddenFrom or noticedBy depending on that roll's
  // total — its name resolves either way.
  const storedGoblin = [
    ...(storedHide?.breakdown?.hide?.hiddenFrom ?? []),
    ...(storedHide?.breakdown?.hide?.noticedBy ?? []),
  ].find((o) => o.combatantId === goblinCombatant);
  check(
    'the Hide roll is logged (kind "hide") with each observer\'s outcome and passive Perception in the breakdown',
    storedHide?.kind === "hide" && storedHigh?.passivePerception === 25 && storedLow?.passivePerception === 5,
    JSON.stringify(storedHide?.breakdown?.hide)
  );
  check(
    "observer names resolve where RLS allows and fall back generically where it doesn't (Bob's PC unreadable to Alice; the NPC by npc_name)",
    storedHigh?.name === "Party member" && storedGoblin?.name === "Goblin Watcher",
    JSON.stringify({ high: storedHigh?.name, goblin: storedGoblin?.name })
  );

  // -- 3. Perception eligibility from light: the hider moves into deep
  //    darkness (x 20). Only Dwarf Watch (darkvision 60 ft, 25 ft away)
  //    can perceive that cell — everyone else gets NO row despite their
  //    passives, because there is nothing to hide FROM. --
  await admin.from("map_tokens").update({ x: 20 }).eq("id", aliceTokenId);
  const darkFacts = hideFacts(await postRoll(alice, campaignId, { kind: "hide", combatantId: aliceCombatant }));
  const darkRows = await hiddenRowsFor(aliceCombatant);
  check(
    "with the hider in darkness, observers who can't perceive the cell get no row (High/Low/Goblin/Blind all skipped) while the darkvision observer still gets one",
    darkFacts.ok &&
      JSON.stringify(outcomeIds(darkFacts.hide?.hiddenFrom)) === JSON.stringify([dwarfCombatant]) &&
      JSON.stringify(outcomeIds(darkFacts.hide?.couldNotPerceive)) ===
        JSON.stringify([highCombatant, lowCombatant, blindCombatant, goblinCombatant].sort()) &&
      darkRows.length === 1 &&
      darkRows[0].observer_combatant_id === dwarfCombatant,
    JSON.stringify({ hide: darkFacts.hide, rows: darkRows.map((r) => r.observer_combatant_id) })
  );
  await admin.from("map_tokens").update({ x: 2 }).eq("id", aliceTokenId);
  await admin.from("combatant_hidden_from").delete().eq("hider_combatant_id", aliceCombatant);

  // -- 4. An NPC hider rolls a plain unmodified d20 (DM-only — everything
  //    NPC-related falls to the DM by construction). --
  const npcHide = hideFacts(await postRoll(dm, campaignId, { kind: "hide", combatantId: goblinCombatant }));
  check(
    "an NPC hider (DM-rolled) uses a plain d20 with no modifiers",
    npcHide.ok && npcHide.modifiers?.length === 0 && npcHide.total === npcHide.d20,
    JSON.stringify(npcHide)
  );
  const npcHideAsPlayer = await postRoll(bob, campaignId, { kind: "hide", combatantId: goblinCombatant });
  check(
    "a non-DM player cannot roll Hide for an NPC combatant (403)",
    npcHideAsPlayer.status === 403,
    `status ${npcHideAsPlayer.status}`
  );
  await admin.from("combatant_hidden_from").delete().eq("hider_combatant_id", goblinCombatant);

  // -- 5. Rendering: Bob's open room (his active character is High Watch)
  //    must stop drawing Alice's token the moment a hidden-from row lands
  //    — live via postgres_changes, no reload — while her bright cell and
  //    the Rat sharing it render normally; the DM's room is never masked.
  //    Deleting the row brings her back live. --
  const bobContext = await browser.newContext();
  await bobContext.addCookies(sessionCookies(bob.session));
  const bobRoom = await bobContext.newPage();
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="vision-state"]', { state: "attached", timeout: 30000 });
  }
  await loadRoom(bobRoom);
  await loadRoom(dmRoom);
  let bobVision = await waitForVision(bobRoom, (v) => v.masked === true);
  check(
    "Bob's room resolves High Watch as his active observer (masked view) and draws Alice's token normally while nothing is hidden",
    bobVision.masked === true &&
      bobVision.observerCharacterId === highCharId &&
      bobVision.tokens[aliceTokenId] === "full",
    JSON.stringify({ masked: bobVision.masked, observer: bobVision.observerCharacterId, alice: bobVision.tokens?.[aliceTokenId] })
  );

  // Retry-until-landed: the freshly-opened room's postgres_changes channel
  // may still be joining when the first insert commits (a missed event on
  // a payload-free poke feed is simply gone), so re-issue the hide —
  // delete + insert is idempotent state-wise, and each retry produces
  // fresh events — until the open page reflects it.
  const hideDeadline = Date.now() + 30000;
  do {
    await admin.from("combatant_hidden_from").delete().eq("hider_combatant_id", aliceCombatant);
    await admin.from("combatant_hidden_from").insert({
      hider_combatant_id: aliceCombatant,
      observer_combatant_id: highCombatant,
    });
    bobVision = await waitForVision(bobRoom, (v) => v.tokens[aliceTokenId] === "hidden", 4000);
  } while (bobVision.tokens[aliceTokenId] !== "hidden" && Date.now() < hideDeadline);
  check(
    "the hidden token disappears from the specific observer's rendering state LIVE (postgres_changes, no reload)",
    bobVision.tokens[aliceTokenId] === "hidden",
    JSON.stringify(bobVision.tokens?.[aliceTokenId])
  );
  check(
    "everything else on the hidden token's cell renders normally for that observer (bright cell unmasked, the Rat on the same cell drawn)",
    !("2,0" in bobVision.cells) && bobVision.tokens[ratTokenId] === "full",
    JSON.stringify({ cell: bobVision.cells?.["2,0"], rat: bobVision.tokens?.[ratTokenId] })
  );
  const dmVision = await visionState(dmRoom);
  check(
    "the DM's view is never masked by hiding (total bypass, unchanged)",
    dmVision.masked === false,
    JSON.stringify(dmVision)
  );
  await admin.from("combatant_hidden_from").delete().eq("hider_combatant_id", aliceCombatant);
  bobVision = await waitForVision(bobRoom, (v) => v.tokens[aliceTokenId] === "full");
  check(
    "clearing the hidden state brings the token back live for the observer",
    bobVision.tokens[aliceTokenId] === "full",
    JSON.stringify(bobVision.tokens?.[aliceTokenId])
  );
  await bobContext.close();
  await dmContext.close();

  // -- 6. Reveal on attack + advantage from hiding: Alice, hidden from
  //    High Watch AND the Goblin, attacks High Watch. The attack rolls
  //    with advantage sourced "attacking from hiding" (computed from the
  //    PRE-attack state), then reveals her to EVERYONE — both rows gone,
  //    not just her target's. --
  await admin.from("combatant_hidden_from").insert([
    { hider_combatant_id: aliceCombatant, observer_combatant_id: highCombatant },
    { hider_combatant_id: aliceCombatant, observer_combatant_id: goblinCombatant },
  ]);
  const attack = await postRoll(alice, campaignId, {
    kind: "attack",
    characterId: aliceCharId,
    attackKind: "melee",
    damageNotation: "1d4",
    targetAc: 1,
    targetTokenId: highTokenId,
    targetCharacterId: highCharId,
    targetName: "High Watch",
  });
  const attackBreakdown = attack.body?.roll?.breakdown;
  check(
    'a hidden attacker\'s attack rolls with advantage sourced "attacking from hiding" against the target it was hidden from',
    attack.status === 200 &&
      attackBreakdown?.mode === "advantage" &&
      attackBreakdown?.d20Rolls?.length === 2 &&
      attackBreakdown?.attack?.advantageSources?.includes("attacking from hiding"),
    JSON.stringify({ status: attack.status, mode: attackBreakdown?.mode, adv: attackBreakdown?.attack?.advantageSources })
  );
  const afterAttackRows = await hiddenRowsFor(aliceCombatant);
  check(
    "the attack reveals the hider to EVERYONE — every hidden-from row gone, not just the target's",
    afterAttackRows.length === 0,
    JSON.stringify(afterAttackRows.map((r) => r.observer_combatant_id))
  );

  // -- 7. Manual reveal: "Stop hiding" is a plain hider-side delete
  //    through the same RLS — no attack required. --
  await admin.from("combatant_hidden_from").insert({
    hider_combatant_id: aliceCombatant,
    observer_combatant_id: highCombatant,
  });
  const { error: stopError } = await alice.client
    .from("combatant_hidden_from")
    .delete()
    .eq("hider_combatant_id", aliceCombatant);
  const afterStopRows = await hiddenRowsFor(aliceCombatant);
  check(
    "the owner's manual Stop hiding clears the hidden state without an attack",
    !stopError && afterStopRows.length === 0,
    JSON.stringify({ error: stopError?.message, rows: afterStopRows.length })
  );

  // -- 8. RLS negatives: a non-controller can neither roll Hide on
  //    someone else's combatant (403, nothing logged) nor delete or forge
  //    hidden rows for it. --
  const bobHidesAlice = await postRoll(bob, campaignId, { kind: "hide", combatantId: aliceCombatant });
  check(
    "a non-controller cannot roll Hide on someone else's combatant (403)",
    bobHidesAlice.status === 403,
    `status ${bobHidesAlice.status}`
  );
  await admin.from("combatant_hidden_from").insert({
    hider_combatant_id: aliceCombatant,
    observer_combatant_id: highCombatant,
  });
  await bob.client.from("combatant_hidden_from").delete().eq("hider_combatant_id", aliceCombatant);
  const afterBobDelete = await hiddenRowsFor(aliceCombatant);
  check(
    "a non-controller's delete matches nothing under RLS — the hidden state survives",
    afterBobDelete.length === 1,
    `${afterBobDelete.length} row(s) left`
  );
  const { error: forgeError } = await bob.client.from("combatant_hidden_from").insert({
    hider_combatant_id: aliceCombatant,
    observer_combatant_id: lowCombatant,
  });
  check(
    "a non-controller cannot forge a hidden-from row for someone else's combatant (RLS insert rejected)",
    forgeError !== null,
    JSON.stringify(forgeError?.message ?? "insert unexpectedly succeeded")
  );
  await admin.from("combatant_hidden_from").delete().eq("hider_combatant_id", aliceCombatant);

  // -- 9. Live sync: the Hide roll and the hidden-from insert/delete all
  //    reach ANOTHER member's postgres_changes subscriptions (Bob's), the
  //    same feeds the app subscribes — retry-until-landed, no fixed
  //    timeout. --
  await bob.client.realtime.setAuth(bob.session.access_token);
  const hiddenEvents = [];
  const rollEvents = [];
  const liveChannel = bob.client
    .channel(`verify-hide-live-${crypto.randomUUID()}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "combatant_hidden_from" }, (payload) =>
      hiddenEvents.push(payload)
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "roll_log", filter: `campaign_id=eq.${campaignId}` },
      (payload) => rollEvents.push(payload)
    );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("live channel subscribe timed out")), 10000);
    liveChannel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        reject(new Error(`live channel subscribe: ${status}`));
      }
    });
  });

  const liveHide = hideFacts(await postRoll(alice, campaignId, { kind: "hide", combatantId: aliceCombatant }));
  const liveRollEvent = await waitForEvent(rollEvents, (e) => e.new?.kind === "hide" && e.new?.id === liveHide.id);
  check(
    "the Hide roll reaches another member's roll_log postgres_changes subscription live",
    liveHide.ok && liveRollEvent !== null,
    JSON.stringify({ ok: liveHide.ok, events: rollEvents.length })
  );
  const liveInsertEvent = await waitForEvent(
    hiddenEvents,
    (e) => e.eventType === "INSERT" && e.new?.hider_combatant_id === aliceCombatant
  );
  check(
    "the resulting hidden-from INSERT reaches another member's postgres_changes subscription live",
    liveInsertEvent !== null,
    JSON.stringify({ events: hiddenEvents.length })
  );
  await alice.client.from("combatant_hidden_from").delete().eq("hider_combatant_id", aliceCombatant);
  const liveDeleteEvent = await waitForEvent(hiddenEvents, (e) => e.eventType === "DELETE");
  check(
    "the Stop-hiding DELETE reaches the subscription live too (reveals must land as promptly as hides)",
    liveDeleteEvent !== null,
    JSON.stringify({ events: hiddenEvents.map((e) => e.eventType) })
  );
  await bob.client.removeChannel(liveChannel);
  bob.client.realtime.disconnect();
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
console.log("\nAll hide-stealth checks passed.");
process.exit(0);
