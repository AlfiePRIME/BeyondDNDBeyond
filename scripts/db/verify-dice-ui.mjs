#!/usr/bin/env node
// Dice roller UI verification (Prompt 48, the genuinely UI-dependent half —
// server-side correctness is verify-dice-rolls.mjs).
//
// Drives real browsers: BOTH live-sync paths (a roll made in one Game Room
// reaching another client's Game Room log, AND a roll made from the
// character sheet page — which is not on the room's campaign channel at
// all — reaching an open Game Room, the reason the log syncs via
// postgres_changes), the sheet's advantage toggle showing both d20s, and
// the combat panel's Roll-initiative buttons producing stored values in a
// sorted turn order.
//
// Needs the dev server on :3000 and the local Supabase stack.
// Usage: node scripts/db/verify-dice-ui.mjs

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
  const email = `dice-ui-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Dice UI ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch();

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Dice UI test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice PC",
    race: "Human",
    class: "Fighter",
    level: 3,
    strength: 16,
    dexterity: 14,
    constitution: 13,
    intelligence: 10,
    wisdom: 12,
    charisma: 8,
    current_hp: 28,
    max_hp: 28,
    armor_class: 15,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "UI arena",
    grid_width: 8,
    grid_height: 8,
  });
  await admin.from("map_tokens").insert([
    { id: crypto.randomUUID(), map_id: mapId, character_id: aliceCharacterId, x: 1, y: 1, elevation: 0, allegiance: "party" },
    { id: crypto.randomUUID(), map_id: mapId, npc_name: "Goblin", x: 3, y: 1, elevation: 0, allegiance: "hostile" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  await dmRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmRoom.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const aliceSheet = await aliceContext.newPage();
  await aliceSheet.goto(`${APP_URL}/campaigns/${campaignId}/characters/${aliceCharacterId}`);
  await aliceSheet.waitForSelector('[data-testid="roll-check-strength"]', { timeout: 30000 });

  const aliceRoom = await aliceContext.newPage();
  await aliceRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await aliceRoom.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });

  // The pages can't expose their subscription state, so instead of one
  // fixed pre-roll timeout (a documented source of false failures), each
  // sync check retries the roll until an attempt's insert is observed on
  // the other client — only the subscription being live lets one through.

  // -- 1. Character sheet → Game Room (the whole reason the log rides
  //    postgres_changes rather than the room's broadcast channel). --
  let sheetToRoom = false;
  for (let attempt = 0; attempt < 5 && !sheetToRoom; attempt++) {
    await aliceSheet.click('[data-testid="roll-check-strength"]');
    await aliceSheet.waitForSelector('[data-testid="sheet-roll-result"]');
    sheetToRoom = await dmRoom
      .waitForFunction(
        () =>
          document
            .querySelector('[data-testid="dice-log"]')
            ?.textContent.includes("Strength check"),
        { timeout: 4000 }
      )
      .then(() => true)
      .catch(() => false);
  }
  check("a roll made on the character sheet page appears live in an open Game Room", sheetToRoom);

  const sheetResult = await aliceSheet.textContent('[data-testid="sheet-roll-result"]');
  check(
    "the sheet shows the roll's breakdown (die + modifier)",
    /d20 \d+/.test(sheetResult) && sheetResult.includes("Strength modifier"),
    sheetResult
  );

  // -- 2. Advantage on the sheet: both d20s and the mode in the detail. --
  await aliceSheet.click('[data-testid="sheet-mode-advantage"]');
  await aliceSheet.click('[data-testid="roll-save-dexterity"]');
  await aliceSheet.waitForFunction(() =>
    document.querySelector('[data-testid="sheet-roll-headline"]')?.textContent.includes("Dexterity save")
  );
  const advantageDetail = await aliceSheet.textContent('[data-testid="sheet-roll-detail"]');
  check(
    "an advantage roll's breakdown shows both d20s and which was used",
    /d20 \[\d+, \d+\] advantage → \d+/.test(advantageDetail),
    advantageDetail
  );

  // -- 3. Game Room → Game Room. --
  let roomToRoom = false;
  for (let attempt = 0; attempt < 5 && !roomToRoom; attempt++) {
    const notation = `${attempt + 2}d4+1`;
    await dmRoom.fill('[data-testid="freeform-notation-input"]', notation);
    await dmRoom.click('[data-testid="freeform-roll-button"]');
    roomToRoom = await aliceRoom
      .waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="dice-log"]')?.textContent.includes(expected),
        notation,
        { timeout: 4000 }
      )
      .then(() => true)
      .catch(() => false);
  }
  check("a free-form roll in one Game Room appears live in another client's Game Room", roomToRoom);

  // -- 3b. The attack flow: selecting a PC target auto-fills its AC from
  //    the readable row; an NPC target needs manual AC; the resolved
  //    attack lands in the log. --
  await dmRoom.selectOption('[data-testid="attack-attacker-select"]', { label: "Alice PC" });
  await dmRoom.selectOption('[data-testid="attack-target-select"]', { label: "Alice PC" });
  const autoFilledAc = await dmRoom.inputValue('[data-testid="attack-target-ac-input"]');
  check("selecting a readable PC target auto-fills its AC (15)", autoFilledAc === "15");

  await dmRoom.selectOption('[data-testid="attack-target-select"]', { label: "Goblin" });
  await dmRoom.fill('[data-testid="attack-target-ac-input"]', "1");
  await dmRoom.fill('[data-testid="attack-damage-input"]', "1d4");
  await dmRoom.click('[data-testid="attack-roll-button"]');
  const attackLogged = await dmRoom
    .waitForFunction(
      () =>
        document
          .querySelector('[data-testid="dice-log"]')
          ?.textContent.includes("Melee attack vs AC 1 (Goblin)"),
      { timeout: 5000 }
    )
    .then(() => true)
    .catch(() => false);
  check("an attack rolled from the room appears in the log with target and AC", attackLogged);

  // -- 4. Roll initiative from the combat panel: stored values, sorted
  //    order, manual entry still present. --
  await dmRoom.click('[data-testid="start-combat-button"]');
  await dmRoom.waitForSelector('[data-testid="advance-turn-button"]', { timeout: 15000 });
  const rollButtons = await dmRoom.$$('[data-testid^="combatant-roll-initiative-"]');
  check("every combatant offers a Roll initiative button to the DM", rollButtons.length === 2);
  const manualInputs = await dmRoom.$$('[data-testid^="combatant-initiative-input-"]');
  check("manual initiative entry is still available alongside", manualInputs.length === 2);

  for (const button of rollButtons) {
    const testId = await button.getAttribute("data-testid");
    const combatantId = testId.replace("combatant-roll-initiative-", "");
    await button.click();
    await dmRoom.waitForFunction(
      (id) =>
        document.querySelector(`[data-testid="combatant-initiative-${id}"]`)?.textContent !== "—",
      combatantId,
      { timeout: 10000 }
    );
  }
  const { data: encounter } = await admin
    .from("combat_encounters")
    .select()
    .eq("campaign_id", campaignId)
    .is("ended_at", null)
    .single();
  const { data: combatants } = await admin
    .from("combat_combatants")
    .select()
    .eq("encounter_id", encounter.id)
    .order("initiative", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  check(
    "rolled initiative is stored for every combatant",
    combatants.every((c) => Number.isInteger(c.initiative))
  );
  const displayed = await dmRoom.$$eval('[data-testid^="combatant-initiative-"]', (nodes) =>
    nodes
      .filter((node) => /^combatant-initiative-[0-9a-f-]+$/.test(node.dataset.testid))
      .map((node) => Number(node.textContent))
  );
  check(
    "the panel lists combatants in descending initiative order",
    displayed.length === 2 &&
      displayed.every((value, i) => i === 0 || displayed[i - 1] >= value) &&
      displayed.join(",") === combatants.map((c) => c.initiative).join(","),
    JSON.stringify({ displayed, stored: combatants.map((c) => c.initiative) })
  );

  // The initiative rolls also land in the shared log.
  const initiativeLogged = await dmRoom
    .waitForFunction(
      () => document.querySelector('[data-testid="dice-log"]')?.textContent.includes("Initiative"),
      { timeout: 4000 }
    )
    .then(() => true)
    .catch(() => false);
  check("initiative rolls appear in the shared roll log", initiativeLogged);
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll dice UI checks passed.");
process.exit(0);
