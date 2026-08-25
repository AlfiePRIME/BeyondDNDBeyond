#!/usr/bin/env node
// Quick-actions panel verification (Prompt 51 acceptance criteria).
//
// Drives a real browser (the verify-dice-ui.mjs arrangement) against a
// seeded campaign in active combat: a melee weapon tagged on the
// current-turn character surfaces as a quick action against an adjacent-
// enough hostile and NOT against one beyond speed + reach; moving the
// hostile to exactly speed + reach surfaces it (movement-extends-reach
// boundary); a ranged weapon's longer range reaches a hostile melee
// can't; a leveled attack spell surfaces only while its matching
// spell-slot resource has uses (and firing it spends one), while a
// cantrip surfaces regardless of resource state; firing against an NPC
// target requires the inline AC (no stored NPC AC anywhere — the
// deliberate schema decision) and firing against a readable PC target
// auto-fills AC and fires in one click, applying damage through
// resolve_attack_damage; the resulting roll_log rows are shape-identical
// to the manual DiceLogPanel attack flow's for equivalent inputs; the
// panel disappears on an NPC's turn; and the character sheet (including
// the new weapon-tagging affordance) and the manual attack form remain
// fully functional alongside.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-quick-actions.mjs

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
  const email = `quick-actions-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Quick Actions ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch();

// Attack rolls already in the log, so "the roll this click produced" can be
// isolated as the newest row past the last-seen count.
async function newestAttackRollAfter(campaignId, knownIds, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await admin
      .from("roll_log")
      .select()
      .eq("campaign_id", campaignId)
      .eq("kind", "attack")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(5);
    const fresh = (data ?? []).find((row) => !knownIds.has(row.id));
    if (fresh) return fresh;
    await sleep(300);
  }
  return null;
}

async function attackRollIds(campaignId) {
  const { data } = await admin
    .from("roll_log")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("kind", "attack");
  return new Set((data ?? []).map((row) => row.id));
}

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Quick actions test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // Wizard: spellcasting ability INT, so spell quick actions are legal for
  // the roll route; STR 16 + prof gives melee +5, so vs AC 1 only a
  // natural 1 misses.
  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice PC",
    race: "Human",
    class: "Wizard",
    level: 3,
    strength: 16,
    dexterity: 14,
    constitution: 13,
    intelligence: 16,
    wisdom: 12,
    charisma: 8,
    current_hp: 20,
    max_hp: 20,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [
      { name: "Longsword", quantity: 1, attackKind: "melee", damageNotation: "1d8" },
      { name: "Longbow", quantity: 1, attackKind: "ranged", damageNotation: "1d8", rangeFeet: 150 },
    ],
    spells: [
      { name: "Fire Bolt", level: 0 },
      { name: "Witch Bolt", level: 1 },
    ],
  });
  const slotInsert = await admin
    .from("character_resources")
    .insert({
      character_id: aliceCharacterId,
      name: "1st-Level Spell Slots",
      max_uses: 2,
      current_uses: 2,
      recharge: "long_rest",
    })
    .select()
    .single();
  const slotResourceId = slotInsert.data.id;

  // A second character ALICE owns, so its token can be flipped hostile
  // (the charmed-ally case) to give her a READABLE PC target whose AC
  // auto-fills — another player's PC would be unreadable under RLS. AC 1
  // so nearly every roll hits and applies damage.
  const allyCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: allyCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Charmed Ally",
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 30,
    max_hp: 30,
    armor_class: 1,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Quick actions arena",
    grid_width: 40,
    grid_height: 40,
  });
  const aliceTokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  const allyTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: aliceTokenId, map_id: mapId, character_id: aliceCharacterId, x: 0, y: 0, elevation: 0, allegiance: "party" },
    // 8 cells = 40 ft: beyond the longsword's 5 ft reach + 30 ft speed.
    { id: goblinTokenId, map_id: mapId, npc_name: "Goblin", x: 8, y: 0, elevation: 0, allegiance: "hostile" },
    // Starts friendly; flipped hostile later for the PC-target phase.
    { id: allyTokenId, map_id: mapId, character_id: allyCharacterId, x: 1, y: 0, elevation: 0, allegiance: "party" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // Combat seeded directly (start_combat is DM-browser territory —
  // verified elsewhere); initiative puts Alice PC first, so it's her turn.
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  await admin.from("combat_combatants").insert([
    { encounter_id: encounterId, token_id: aliceTokenId, character_id: aliceCharacterId, initiative: 20 },
    { encounter_id: encounterId, token_id: goblinTokenId, npc_name: "Goblin", initiative: 10 },
    { encounter_id: encounterId, token_id: allyTokenId, character_id: allyCharacterId, initiative: 5 },
  ]);

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const room = await aliceContext.newPage();

  async function loadRoom() {
    await room.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await room.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });
  }
  const visible = (testid) =>
    room
      .waitForSelector(`[data-testid="${testid}"]`, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
  const absent = async (testid) => (await room.$(`[data-testid="${testid}"]`)) === null;

  // -- 1. The panel, and range-with-movement filtering. --
  await loadRoom();
  check("the quick-actions panel appears on the owning player's PC turn", await visible("quick-actions-panel"));
  check(
    "it names the current-turn character",
    ((await room.textContent('[data-testid="quick-actions-character"]').catch(() => "")) ?? "").includes("Alice PC")
  );
  // Wait for an action that depends on the async resource fetch before
  // asserting absences, so "absent" can't be a not-loaded-yet snapshot.
  check(
    "a leveled attack spell with a full matching slot surfaces (Witch Bolt, 30 ft + 30 ft speed vs 40 ft)",
    await visible("quick-action-spell-witch-bolt")
  );
  check(
    "a melee weapon does NOT surface against a hostile beyond reach + full speed (40 ft vs 35 ft)",
    await absent("quick-action-weapon-longsword")
  );
  check(
    "a ranged weapon's longer range surfaces the hostile melee can't reach (Longbow, 150 ft)",
    await visible("quick-action-weapon-longbow")
  );
  check(
    "an attack-roll cantrip surfaces (Fire Bolt, 120 ft)",
    await visible("quick-action-spell-fire-bolt")
  );
  check(
    "the single qualifying target is shown without a picker",
    ((await room.textContent('[data-testid="quick-action-target-label-weapon-longbow"]').catch(() => "")) ?? "").includes("Goblin")
  );

  // -- 2. Slot exhaustion hides the leveled spell; the cantrip stays. --
  await admin.from("character_resources").update({ current_uses: 0 }).eq("id", slotResourceId);
  await loadRoom();
  check(
    "the cantrip still surfaces with the slot exhausted",
    await visible("quick-action-spell-fire-bolt")
  );
  check(
    "the leveled spell disappears once its matching slot is exhausted",
    await absent("quick-action-spell-witch-bolt")
  );
  await admin.from("character_resources").update({ current_uses: 2 }).eq("id", slotResourceId);

  // -- 3. Movement extends reach: the same melee weapon surfaces once the
  //    hostile is at exactly speed + reach (7 cells = 35 ft). --
  await admin.from("map_tokens").update({ x: 7 }).eq("id", goblinTokenId);
  await loadRoom();
  check(
    "moving the hostile to exactly reach + speed surfaces the melee weapon",
    await visible("quick-action-weapon-longsword")
  );

  // -- 4. NPC target: pre-filled attack, inline AC required, then the
  //    same roll/log path as a manual attack. --
  const fireDisabled = await room.$eval(
    '[data-testid="quick-action-fire-weapon-longsword"]',
    (el) => el.disabled
  );
  check("firing at an NPC target is blocked until its AC is typed in", fireDisabled === true);
  check(
    "no auto-filled AC is claimed for an NPC target",
    await absent("quick-action-known-ac-weapon-longsword")
  );
  let known = await attackRollIds(campaignId);
  await room.fill('[data-testid="quick-action-ac-weapon-longsword"]', "1");
  await room.click('[data-testid="quick-action-fire-weapon-longsword"]');
  const npcRoll = await newestAttackRollAfter(campaignId, known);
  check("firing the quick action logs a roll_log row", npcRoll !== null);
  if (npcRoll) {
    check(
      "the NPC-target quick action logs kind 'attack' with the manual flow's breakdown shape",
      npcRoll.kind === "attack" &&
        npcRoll.breakdown.type === "d20" &&
        npcRoll.breakdown.label === "Melee attack" &&
        npcRoll.breakdown.attack?.attackKind === "melee" &&
        npcRoll.breakdown.attack?.targetAc === 1 &&
        npcRoll.breakdown.attack?.targetName === "Goblin" &&
        npcRoll.breakdown.attack?.targetCharacterId === null &&
        npcRoll.character_id === aliceCharacterId &&
        npcRoll.roller_user_id === alice.id,
      JSON.stringify(npcRoll?.breakdown)
    );
  }

  // -- 5. Firing a leveled spell spends its slot. --
  known = await attackRollIds(campaignId);
  await room.fill('[data-testid="quick-action-ac-spell-witch-bolt"]', "1");
  await room.click('[data-testid="quick-action-fire-spell-witch-bolt"]');
  const spellRoll = await newestAttackRollAfter(campaignId, known);
  check(
    "a spell quick action rolls as a spell attack through the same route",
    spellRoll !== null &&
      spellRoll.breakdown.label === "Spell attack" &&
      spellRoll.breakdown.attack?.attackKind === "spell" &&
      spellRoll.breakdown.modifiers.some((m) => m.label === "Intelligence modifier"),
    JSON.stringify(spellRoll?.breakdown)
  );
  await sleep(1000); // the slot spend lands right after the roll resolves
  const { data: slotAfter } = await admin
    .from("character_resources")
    .select("current_uses")
    .eq("id", slotResourceId)
    .single();
  check("firing the leveled spell spent one matching spell slot (2 → 1)", slotAfter?.current_uses === 1, `current_uses=${slotAfter?.current_uses}`);

  // -- 6. PC target: the charmed-ally token turns hostile; its owner can
  //    read its row, so AC auto-fills and the action fires in one click,
  //    applying damage via resolve_attack_damage. --
  await admin.from("map_tokens").update({ allegiance: "hostile" }).eq("id", allyTokenId);
  await loadRoom();
  await room.waitForSelector('[data-testid="quick-action-target-weapon-longsword"]', { timeout: 8000 });
  await room.selectOption('[data-testid="quick-action-target-weapon-longsword"]', allyTokenId);
  check(
    "with two qualifying hostiles the action offers a target picker",
    (await room.$$eval('[data-testid="quick-action-target-weapon-longsword"] option', (os) => os.length)) === 2
  );
  check(
    "a readable PC target auto-fills its AC (no input needed)",
    ((await room.textContent('[data-testid="quick-action-known-ac-weapon-longsword"]').catch(() => "")) ?? "").includes("AC 1") &&
      (await absent("quick-action-ac-weapon-longsword"))
  );
  // Only a natural 1 misses vs AC 1 — retry a couple of times so the
  // applied-damage assertion isn't flaky. NOTE the STORED breakdown keeps
  // `applied: null` — resolve_attack_damage logs the placeholder breakdown
  // in-transaction and splices the applied outcome only into the entry
  // returned to the client (see resolveAttackDamage) — so the hit is
  // detected from hit/damage and the application from the stored HP.
  let hitRoll = null;
  let hpBefore = 30;
  for (let attempt = 0; attempt < 5 && !hitRoll; attempt++) {
    const { data: before } = await admin
      .from("characters")
      .select("current_hp")
      .eq("id", allyCharacterId)
      .single();
    hpBefore = before.current_hp;
    known = await attackRollIds(campaignId);
    await room.click('[data-testid="quick-action-fire-weapon-longsword"]');
    const roll = await newestAttackRollAfter(campaignId, known);
    if (roll?.breakdown.attack?.hit && roll.breakdown.attack.damage?.total > 0) hitRoll = roll;
  }
  check(
    "the one-click PC-target attack resolves as a targeted hit (auto-filled AC 1, no typing)",
    hitRoll !== null &&
      hitRoll.breakdown.attack.targetCharacterId === allyCharacterId &&
      hitRoll.breakdown.attack.targetAc === 1,
    hitRoll ? JSON.stringify(hitRoll.breakdown.attack) : "no hit landed in 5 attempts"
  );
  const { data: allyAfter } = await admin
    .from("characters")
    .select("current_hp")
    .eq("id", allyCharacterId)
    .single();
  check(
    "the hit's damage landed on the target's stored HP via resolve_attack_damage",
    hitRoll !== null &&
      allyAfter?.current_hp === Math.max(0, hpBefore - hitRoll.breakdown.attack.damage.total),
    `before=${hpBefore} after=${allyAfter?.current_hp}`
  );

  // -- 7. Shape identity with the manual flow: the same attack made
  //    through DiceLogPanel's form produces a structurally identical row. --
  known = await attackRollIds(campaignId);
  await room.selectOption('[data-testid="attack-attacker-select"]', aliceCharacterId);
  await room.selectOption('[data-testid="attack-kind-select"]', "melee");
  await room.selectOption('[data-testid="attack-target-select"]', allyTokenId);
  await room.fill('[data-testid="attack-damage-input"]', "1d8");
  const manualAutoAc = await room.inputValue('[data-testid="attack-target-ac-input"]');
  check("the manual form's PC-target AC auto-fill still works alongside the panel", manualAutoAc === "1");
  await room.click('[data-testid="attack-roll-button"]');
  const manualRoll = await newestAttackRollAfter(campaignId, known);
  check("the manual DiceLogPanel attack form still logs a roll", manualRoll !== null);
  if (hitRoll && manualRoll) {
    const keys = (obj) => Object.keys(obj ?? {}).sort().join(",");
    check(
      "quick-action and manual rolls are identical in shape (kind, breakdown keys, attack keys, modifiers, label)",
      manualRoll.kind === hitRoll.kind &&
        keys(manualRoll.breakdown) === keys(hitRoll.breakdown) &&
        keys(manualRoll.breakdown.attack) === keys(hitRoll.breakdown.attack) &&
        manualRoll.breakdown.label === hitRoll.breakdown.label &&
        manualRoll.breakdown.mode === hitRoll.breakdown.mode &&
        JSON.stringify(manualRoll.breakdown.modifiers.map((m) => m.label)) ===
          JSON.stringify(hitRoll.breakdown.modifiers.map((m) => m.label)) &&
        manualRoll.breakdown.attack.targetCharacterId === hitRoll.breakdown.attack.targetCharacterId,
      JSON.stringify({ manual: keys(manualRoll.breakdown), quick: keys(hitRoll.breakdown) })
    );
  }

  // -- 8. The panel is a per-PC-turn surface: an NPC's turn shows none. --
  await admin.from("combat_encounters").update({ current_turn_index: 1 }).eq("id", encounterId);
  await loadRoom();
  check("the panel disappears on an NPC combatant's turn", await absent("quick-actions-panel"));
  await admin.from("combat_encounters").update({ current_turn_index: 0 }).eq("id", encounterId);

  // -- 9. The character sheet stays fully functional, including the new
  //    weapon-tagging affordance producing a working quick action. --
  const sheet = await aliceContext.newPage();
  await sheet.goto(`${APP_URL}/campaigns/${campaignId}/characters/${aliceCharacterId}`);
  await sheet.waitForSelector('[data-testid="roll-check-strength"]', { timeout: 30000 });
  check(
    "the sheet shows the stored weapon tag on its inventory row",
    ((await sheet.textContent('[data-testid="weapon-badge-0"]').catch(() => "")) ?? "").includes("1d8")
  );
  await sheet.click('[data-testid="roll-check-strength"]');
  const sheetRolled = await sheet
    .waitForSelector('[data-testid="sheet-roll-result"]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("sheet dice rolls still work alongside the panel", sheetRolled);

  // Tag a brand-new item as a finesse weapon through the sheet UI…
  await sheet.getByLabel("Item", { exact: true }).fill("Dagger");
  await sheet.click('button:has-text("Add item")');
  await sheet.waitForSelector('[data-testid="weapon-toggle-2"]', { timeout: 8000 });
  await sheet.click('[data-testid="weapon-toggle-2"]');
  await sheet.selectOption('[data-testid="weapon-kind-select"]', "finesse");
  await sheet.fill('[data-testid="weapon-damage-input"]', "1d4");
  await sheet.click('[data-testid="weapon-save"]');
  await sheet.waitForSelector('[data-testid="weapon-badge-2"]', { timeout: 8000 });
  const { data: taggedRow } = await admin
    .from("characters")
    .select("inventory")
    .eq("id", aliceCharacterId)
    .single();
  const dagger = (taggedRow?.inventory ?? []).find((item) => item.name === "Dagger");
  check(
    "tagging an item as a weapon on the sheet stores the new inventory fields",
    dagger?.attackKind === "finesse" && dagger?.damageNotation === "1d4" && dagger?.rangeFeet === undefined,
    JSON.stringify(dagger)
  );

  // …and it becomes a quick action in the room (adjacent hostile ally at
  // 5 ft, within finesse default reach even before moving).
  await loadRoom();
  check(
    "the freshly tagged weapon surfaces as a quick action",
    await visible("quick-action-weapon-dagger")
  );
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
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
console.log("\nAll quick-actions checks passed.");
process.exit(0);
