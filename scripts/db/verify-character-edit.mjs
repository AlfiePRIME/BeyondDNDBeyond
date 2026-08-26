#!/usr/bin/env node
// Character identity editing verification (race/class/level/speed on the
// sheet — the "edit an imported character" feature, which is really a
// general write-once-at-creation UI gap for EVERY character).
//
// Drives a real browser (the verify-dice-ui.mjs arrangement) against a
// seeded campaign and checks: the owner can edit race, class, level, and
// speed through the sheet's new Vitals controls and each change persists;
// changing race re-derives BOTH speed and darkvision_feet from the SRD
// catalog in the SAME single PATCH that changes race (request-counted, not
// assumed); the DM can edit any character in the campaign the same way
// (including a race whose darkvision goes back to null); a different
// player — member of the campaign but neither owner nor DM — can neither
// read nor write the character (existing RLS, re-confirmed); a character
// seeded exactly as the import flow writes one (race/class "Unknown",
// PDF-supplied speed, null darkvision) is editable identically, proving
// there is no import-specific gap; and editing class touches NEITHER the
// character's existing character_resources rows (byte-identical before and
// after) NOR its spells array.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-character-edit.mjs

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
  const email = `char-edit-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Char Edit ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

/** Polls the character row until `predicate` passes (returns the row) or
 * the timeout elapses (returns the last-seen row). */
async function waitForCharacter(characterId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { data } = await admin.from("characters").select().eq("id", characterId).single();
    last = data;
    if (data && predicate(data)) return data;
    await sleep(250);
  }
  return last;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Character edit test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  // A wizard-created-shaped character: catalog race/class, creation-derived
  // speed/darkvision (Human: 30 ft, normal vision), a caster spell list,
  // and a pre-existing limited-use resource the class edit must not touch.
  const wizardCharId = crypto.randomUUID();
  const originalSpells = [
    { name: "Fire Bolt", level: 0 },
    { name: "Witch Bolt", level: 1 },
  ];
  await admin.from("characters").insert({
    id: wizardCharId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Edit Target",
    race: "Human",
    class: "Wizard",
    level: 3,
    strength: 10,
    dexterity: 14,
    constitution: 13,
    intelligence: 16,
    wisdom: 12,
    charisma: 8,
    current_hp: 20,
    max_hp: 20,
    armor_class: 12,
    speed: 30,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: originalSpells,
  });
  const { data: seededResource } = await admin
    .from("character_resources")
    .insert({
      character_id: wizardCharId,
      name: "Arcane Recovery",
      max_uses: 1,
      current_uses: 1,
      recharge: "long_rest",
    })
    .select()
    .single();

  // An import-flow-shaped character: the exact row handleConfirm writes
  // when the PDF's race/class weren't recognized — race/class "Unknown",
  // the PDF's (possibly wrong) speed, and null darkvision.
  const importedCharId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: importedCharId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Imported Character",
    race: "Unknown",
    class: "Unknown",
    level: 1,
    strength: 15,
    dexterity: 12,
    constitution: 14,
    intelligence: 8,
    wisdom: 10,
    charisma: 10,
    current_hp: 12,
    max_hp: 12,
    armor_class: 16,
    speed: 20,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const sheetUrl = (characterId) => `${APP_URL}/campaigns/${campaignId}/characters/${characterId}`;

  // -- 1. The owner edits race/class/level/speed through the sheet. --
  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const sheet = await aliceContext.newPage();
  await sheet.goto(sheetUrl(wizardCharId));
  await sheet.waitForSelector('[data-testid="sheet-race-select"]', { timeout: 30000 });
  check(
    "the owner's sheet shows editable race/class/level/speed controls",
    (await sheet.$('[data-testid="sheet-class-select"]')) !== null &&
      (await sheet.$('[data-testid="sheet-level-input"]')) !== null &&
      (await sheet.$('[data-testid="sheet-speed-input"]')) !== null
  );
  check(
    "the race and class selects show the stored values",
    (await sheet.inputValue('[data-testid="sheet-race-select"]')) === "Human" &&
      (await sheet.inputValue('[data-testid="sheet-class-select"]')) === "Wizard"
  );

  // Race change with derived-stat side effect, request-counted: Human
  // (30 ft, normal vision) → Wood Elf (35 ft, darkvision 60) must land as
  // ONE PATCH to /rest/v1/characters carrying all three columns.
  let characterPatches = 0;
  const countPatch = (request) => {
    if (request.method() === "PATCH" && request.url().includes("/rest/v1/characters")) characterPatches++;
  };
  sheet.on("request", countPatch);
  await sheet.selectOption('[data-testid="sheet-race-select"]', "Wood Elf");
  const afterRace = await waitForCharacter(
    wizardCharId,
    (c) => c.race === "Wood Elf" && c.speed === 35 && c.darkvision_feet === 60
  );
  sheet.off("request", countPatch);
  check(
    "changing race persists it and re-derives speed and darkvision (Wood Elf → 35 ft, darkvision 60)",
    afterRace?.race === "Wood Elf" && afterRace?.speed === 35 && afterRace?.darkvision_feet === 60,
    JSON.stringify({ race: afterRace?.race, speed: afterRace?.speed, darkvision: afterRace?.darkvision_feet })
  );
  check(
    "race + derived speed/darkvision landed in a SINGLE updateCharacter call",
    characterPatches === 1,
    `${characterPatches} PATCH request(s)`
  );
  check(
    "the sheet's speed input and vision display follow the race change",
    (await sheet.inputValue('[data-testid="sheet-speed-input"]')) === "35" &&
      ((await sheet.textContent('[data-testid="sheet-vision"]').catch(() => "")) ?? "").includes("Darkvision 60"),
    await sheet.inputValue('[data-testid="sheet-speed-input"]')
  );

  // Class change — resources and spells captured immediately before, and
  // compared byte-for-byte immediately after.
  const { data: resourcesBefore } = await admin
    .from("character_resources")
    .select()
    .eq("character_id", wizardCharId)
    .order("id");
  await sheet.selectOption('[data-testid="sheet-class-select"]', "Cleric");
  const afterClass = await waitForCharacter(wizardCharId, (c) => c.class === "Cleric");
  check("changing class through the sheet persists", afterClass?.class === "Cleric", afterClass?.class);
  const { data: resourcesAfter } = await admin
    .from("character_resources")
    .select()
    .eq("character_id", wizardCharId)
    .order("id");
  check(
    "editing class leaves every pre-existing character_resources row byte-identical",
    JSON.stringify(resourcesBefore) === JSON.stringify(resourcesAfter) &&
      resourcesAfter.some((r) => JSON.stringify(r) === JSON.stringify(seededResource)),
    JSON.stringify({ before: resourcesBefore, after: resourcesAfter })
  );
  check(
    "editing class leaves the character's spells array untouched",
    JSON.stringify(afterClass?.spells) === JSON.stringify(originalSpells),
    JSON.stringify(afterClass?.spells)
  );

  // Level: commit-on-blur, clamped 1-20 (an out-of-range draft reverts).
  await sheet.fill('[data-testid="sheet-level-input"]', "5");
  await sheet.locator('[data-testid="sheet-level-input"]').blur();
  const afterLevel = await waitForCharacter(wizardCharId, (c) => c.level === 5);
  check("changing level through the sheet persists (3 → 5)", afterLevel?.level === 5, String(afterLevel?.level));
  await sheet.fill('[data-testid="sheet-level-input"]', "25");
  await sheet.locator('[data-testid="sheet-level-input"]').blur();
  await sleep(1000);
  const { data: afterBadLevel } = await admin.from("characters").select("level").eq("id", wizardCharId).single();
  check(
    "an out-of-range level (25) is rejected client-side and the stored level stands",
    afterBadLevel?.level === 5 && (await sheet.inputValue('[data-testid="sheet-level-input"]')) === "5",
    String(afterBadLevel?.level)
  );

  // Speed: manually editable too (a magic item or wrong OCR isn't racial).
  await sheet.fill('[data-testid="sheet-speed-input"]', "40");
  await sheet.locator('[data-testid="sheet-speed-input"]').blur();
  const afterSpeed = await waitForCharacter(wizardCharId, (c) => c.speed === 40);
  check("changing speed through the sheet persists (35 → 40)", afterSpeed?.speed === 40, String(afterSpeed?.speed));

  // -- 2. The DM edits ANY character in the campaign the same way. --
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmSheet = await dmContext.newPage();
  await dmSheet.goto(sheetUrl(wizardCharId));
  await dmSheet.waitForSelector('[data-testid="sheet-race-select"]', { timeout: 30000 });
  await dmSheet.selectOption('[data-testid="sheet-race-select"]', "Halfling");
  const afterDmRace = await waitForCharacter(
    wizardCharId,
    (c) => c.race === "Halfling" && c.speed === 25 && c.darkvision_feet === null
  );
  check(
    "the DM can change a player's race, with darkvision correctly derived back to null (Halfling → 25 ft, normal vision)",
    afterDmRace?.race === "Halfling" && afterDmRace?.speed === 25 && afterDmRace?.darkvision_feet === null,
    JSON.stringify({ race: afterDmRace?.race, speed: afterDmRace?.speed, darkvision: afterDmRace?.darkvision_feet })
  );
  await dmSheet.fill('[data-testid="sheet-level-input"]', "6");
  await dmSheet.locator('[data-testid="sheet-level-input"]').blur();
  const afterDmLevel = await waitForCharacter(wizardCharId, (c) => c.level === 6);
  check("the DM can change a player's level (5 → 6)", afterDmLevel?.level === 6, String(afterDmLevel?.level));

  // -- 3. A different player (not owner, not DM) can neither read nor
  //    write the character — the existing RLS, unweakened. --
  const { data: bobRead } = await bob.client.from("characters").select().eq("id", wizardCharId);
  check("another player cannot even read the character row", (bobRead ?? []).length === 0);
  const { data: bobWrite, error: bobWriteError } = await bob.client
    .from("characters")
    .update({ level: 20, race: "Drow" })
    .eq("id", wizardCharId)
    .select();
  const { data: afterBob } = await admin.from("characters").select("level, race").eq("id", wizardCharId).single();
  check(
    "another player's update is rejected by RLS and changes nothing",
    (bobWrite ?? []).length === 0 && afterBob?.level === 6 && afterBob?.race === "Halfling",
    JSON.stringify({ returned: bobWrite, error: bobWriteError?.message, stored: afterBob })
  );

  // -- 4. An imported character (race/class "Unknown") is editable exactly
  //    the same way — no import-specific gap. --
  const importSheet = await aliceContext.newPage();
  await importSheet.goto(sheetUrl(importedCharId));
  await importSheet.waitForSelector('[data-testid="sheet-race-select"]', { timeout: 30000 });
  check(
    "an imported character's unrecognized race/class still display as the current selection",
    (await importSheet.inputValue('[data-testid="sheet-race-select"]')) === "Unknown" &&
      (await importSheet.inputValue('[data-testid="sheet-class-select"]')) === "Unknown"
  );
  await importSheet.selectOption('[data-testid="sheet-race-select"]', "Mountain Dwarf");
  const importedAfterRace = await waitForCharacter(
    importedCharId,
    (c) => c.race === "Mountain Dwarf" && c.speed === 25 && c.darkvision_feet === 60
  );
  check(
    "fixing a wrongly-OCR'd race on an imported character re-derives its speed and darkvision (Mountain Dwarf → 25 ft, darkvision 60)",
    importedAfterRace?.race === "Mountain Dwarf" &&
      importedAfterRace?.speed === 25 &&
      importedAfterRace?.darkvision_feet === 60,
    JSON.stringify({
      race: importedAfterRace?.race,
      speed: importedAfterRace?.speed,
      darkvision: importedAfterRace?.darkvision_feet,
    })
  );
  await importSheet.selectOption('[data-testid="sheet-class-select"]', "Fighter");
  const importedAfterClass = await waitForCharacter(importedCharId, (c) => c.class === "Fighter");
  check(
    "fixing an imported character's class persists",
    importedAfterClass?.class === "Fighter",
    importedAfterClass?.class
  );
  await importSheet.fill('[data-testid="sheet-level-input"]', "4");
  await importSheet.locator('[data-testid="sheet-level-input"]').blur();
  const importedAfterLevel = await waitForCharacter(importedCharId, (c) => c.level === 4);
  check(
    "fixing an imported character's level persists (1 → 4)",
    importedAfterLevel?.level === 4,
    String(importedAfterLevel?.level)
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
console.log("\nAll character-edit checks passed.");
process.exit(0);
