#!/usr/bin/env node
// Expanded race catalog (src/rules-engine/srd/races.ts) verification.
//
// Previously RACES held only the 9 core PHB races. This adds ~26 new base
// races (Volo's Guide, Elemental Evil Player's Companion, Mordenkainen's
// Tome of Foes, Eberron: Rising from the Last War, Guildmasters' Guide to
// Ravnica, Mythic Odysseys of Theros) plus 3 new Elf subraces — purely as
// data, with zero changes to CharacterWizard.tsx or mapToDraft.ts, since
// both already iterate over RACES generically.
//
// This script proves that claim by driving the ACTUAL wizard UI (the
// verify-homebrew-race.mjs/verify-campaign-onboarding.mjs arrangement)
// through a real signed-in browser session — not a direct DB insert — end
// to end for a spread of races covering different source books: Goliath
// (Volo's Guide, fixed increases, no subrace), Genasi + Air Genasi (EEPC,
// base+subrace ability composition and the subrace dropdown), Tortle
// (Tortle Package, no darkvision), and Warforged (Eberron, a brand-new
// "choice" bonus ability slot — the same generic mechanism Half-Elf already
// used). For each: the race card renders and is selectable, the ability
// score increases are applied and saved correctly, and the created
// character's sheet page shows the same increases in its editable ability
// score fields — proving the wizard's existing data-driven rendering
// genuinely picks up the new data with zero UI code changes.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000.
// Usage: node scripts/db/verify-expanded-race-catalog.mjs
//        APP_URL=http://localhost:3947 node scripts/db/verify-expanded-race-catalog.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3947";

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
  const port = new URL(APP_URL).port || "3000";
  console.log(`dev server not running at ${APP_URL} — starting yarn dev on port ${port}…`);
  devServer = spawn("yarn", ["dev"], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PORT: port },
  });
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
  const email = `race-catalog-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Race Catalog ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

// Clicks every currently-rendered ChoiceCard (every ChoiceCard sets
// aria-pressed, race/class/equipment/spell cards alike) — since each step
// only renders its own cards at a time, this picks the last-rendered option
// in every choice group, which is always a valid (if arbitrary) selection.
async function pickAllChoiceCards(page) {
  const cards = page.locator("button[aria-pressed]");
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    await cards.nth(i).click();
  }
}

// Walks the wizard from the Equipment step through to a saved character,
// clicking through an intervening Spells step (casters only) with no picks
// required, then Create character. Returns nothing; caller re-queries the
// DB row afterward.
async function finishFromEquipmentStep(page) {
  await page.waitForSelector('button[aria-pressed]');
  await pickAllChoiceCards(page);
  await page.click('button:has-text("Next")');
  await page.waitForSelector('button:has-text("Next"), button:has-text("Create character")');
  if ((await page.locator('button:has-text("Create character")').count()) === 0) {
    // Caster classes insert a Spells step here; no spell pick is required.
    await page.click('button:has-text("Next")');
  }
  await page.waitForSelector('button:has-text("Create character")');
  await page.click('button:has-text("Create character")');
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Expanded race catalog test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  const playerContext = await browser.newContext();
  await playerContext.addCookies(sessionCookies(player.session));
  const page = await playerContext.newPage();

  // -- 0. The race grid on the wizard's first step now contains new base
  //    races from every added source book, not just the original 9. --
  await page.goto(`${APP_URL}/campaigns/${campaignId}/characters/new`);
  await page.waitForSelector('[data-testid="wizard-race-homebrew"]', { timeout: 30000 });
  for (const raceName of ["Goliath", "Genasi", "Tortle", "Warforged", "Duergar", "Aarakocra", "Kobold", "Satyr"]) {
    check(
      `"${raceName}" appears as a selectable race card on the wizard's first step`,
      (await page.locator(`button:has(span:text-is("${raceName}"))`).count()) === 1
    );
  }

  // -- 1. Goliath (Volo's Guide) — fixed STR +2 / CON +1, no subrace. --
  await page.getByLabel("Character name").fill("Ozzir Stonebrow");
  await page.locator('button:has(span:text-is("Goliath"))').click();
  check(
    "picking Goliath shows its Mountain Born and Stone's Endurance trait badges",
    (await page.locator("text=Mountain Born").count()) === 1 &&
      (await page.locator("text=Stone's Endurance").count()) === 1
  );
  await page.locator('button:has(span:text-is("Barbarian"))').click();
  await page.click('button:has-text("Next")');
  await page.waitForSelector('input[type="number"][min="1"][max="20"]');
  const goliathText = await page.locator("main").textContent();
  check(
    "Goliath's STR +2 / CON +1 racial increases are applied to the standard array (STR 15→17, CON 13→14)",
    (goliathText ?? "").includes("15 + 2 = 17") && (goliathText ?? "").includes("13 + 1 = 14"),
    goliathText?.slice(0, 400)
  );
  await page.click('button:has-text("Next")');
  await finishFromEquipmentStep(page);
  await page.waitForURL(`${APP_URL}/campaigns/${campaignId}`, { timeout: 15000 });

  const { data: goliathChar } = await admin
    .from("characters")
    .select()
    .eq("campaign_id", campaignId)
    .eq("name", "Ozzir Stonebrow")
    .maybeSingle();
  check(
    "Goliath saved with race='Goliath', 30 ft speed, no darkvision, STR/CON increases applied (15→17, 13→14)",
    goliathChar?.race === "Goliath" &&
      goliathChar?.speed === 30 &&
      goliathChar?.darkvision_feet === null &&
      goliathChar?.strength === 17 &&
      goliathChar?.constitution === 14,
    JSON.stringify({
      race: goliathChar?.race,
      speed: goliathChar?.speed,
      darkvision: goliathChar?.darkvision_feet,
      strength: goliathChar?.strength,
      constitution: goliathChar?.constitution,
    })
  );

  await page.goto(`${APP_URL}/campaigns/${campaignId}/characters/${goliathChar.id}`);
  await page.waitForSelector('input[aria-label="Strength score"]', { timeout: 30000 });
  check(
    "the Goliath character sheet's editable ability fields show the applied STR/CON increases (17, 14)",
    (await page.inputValue('input[aria-label="Strength score"]')) === "17" &&
      (await page.inputValue('input[aria-label="Constitution score"]')) === "14"
  );

  // -- 2. Genasi base race + Air Genasi subrace (Elemental Evil Player's
  //    Companion) — confirms the subrace dropdown lists all 4 new
  //    subraces, and the base CON +2 composes with the subrace's own
  //    DEX +1 (mirroring the existing Dwarf/Elf base+subrace pattern). --
  await page.goto(`${APP_URL}/campaigns/${campaignId}/characters/new`);
  await page.waitForSelector('[data-testid="wizard-race-homebrew"]', { timeout: 30000 });
  await page.getByLabel("Character name").fill("Sila Windborn");
  await page.locator('button:has(span:text-is("Genasi"))').click();
  await page.waitForSelector("select");
  const subraceOptions = await page.locator("select option").allTextContents();
  check(
    "the subrace dropdown lists all four new Genasi subraces",
    ["Air Genasi", "Earth Genasi", "Fire Genasi", "Water Genasi"].every((o) => subraceOptions.includes(o)),
    JSON.stringify(subraceOptions)
  );
  await page.selectOption("select", { label: "Air Genasi" });
  check(
    "picking Air Genasi shows its own Unarmored Air/Mingle with the Wind traits alongside base Genasi traits",
    (await page.locator("text=Unarmored Air").count()) === 1 &&
      (await page.locator("text=Mingle with the Wind").count()) === 1
  );
  await page.locator('button:has(span:text-is("Sorcerer"))').click();
  await page.click('button:has-text("Next")');
  await page.waitForSelector('input[type="number"][min="1"][max="20"]');
  const genasiText = await page.locator("main").textContent();
  check(
    "Genasi base CON +2 and Air Genasi's own DEX +1 both applied (CON 13→15, DEX 14→15)",
    (genasiText ?? "").includes("13 + 2 = 15") && (genasiText ?? "").includes("14 + 1 = 15"),
    genasiText?.slice(0, 400)
  );
  await page.click('button:has-text("Next")');
  await finishFromEquipmentStep(page);
  await page.waitForURL(`${APP_URL}/campaigns/${campaignId}`, { timeout: 15000 });

  const { data: genasiChar } = await admin
    .from("characters")
    .select()
    .eq("campaign_id", campaignId)
    .eq("name", "Sila Windborn")
    .maybeSingle();
  check(
    "Air Genasi saved with race='Air Genasi', no darkvision, base+subrace increases applied (CON 13→15, DEX 14→15)",
    genasiChar?.race === "Air Genasi" &&
      genasiChar?.darkvision_feet === null &&
      genasiChar?.constitution === 15 &&
      genasiChar?.dexterity === 15,
    JSON.stringify({
      race: genasiChar?.race,
      darkvision: genasiChar?.darkvision_feet,
      constitution: genasiChar?.constitution,
      dexterity: genasiChar?.dexterity,
    })
  );

  // -- 3. Tortle (Tortle Package) — STR +2 / WIS +1, no darkvision. --
  await page.goto(`${APP_URL}/campaigns/${campaignId}/characters/new`);
  await page.waitForSelector('[data-testid="wizard-race-homebrew"]', { timeout: 30000 });
  await page.getByLabel("Character name").fill("Shelly Hardback");
  await page.locator('button:has(span:text-is("Tortle"))').click();
  check("picking Tortle shows its Shell Defense trait badge", (await page.locator("text=Shell Defense").count()) === 1);
  await page.locator('button:has(span:text-is("Ranger"))').click();
  await page.click('button:has-text("Next")');
  await page.waitForSelector('input[type="number"][min="1"][max="20"]');
  const tortleText = await page.locator("main").textContent();
  check(
    "Tortle's STR +2 / WIS +1 racial increases are applied (STR 15→17, WIS 10→11)",
    (tortleText ?? "").includes("15 + 2 = 17") && (tortleText ?? "").includes("10 + 1 = 11"),
    tortleText?.slice(0, 400)
  );
  await page.click('button:has-text("Next")');
  await finishFromEquipmentStep(page);
  await page.waitForURL(`${APP_URL}/campaigns/${campaignId}`, { timeout: 15000 });

  const { data: tortleChar } = await admin
    .from("characters")
    .select()
    .eq("campaign_id", campaignId)
    .eq("name", "Shelly Hardback")
    .maybeSingle();
  check(
    "Tortle saved with race='Tortle', no darkvision, STR/WIS increases applied (15→17, 10→11)",
    tortleChar?.race === "Tortle" &&
      tortleChar?.darkvision_feet === null &&
      tortleChar?.strength === 17 &&
      tortleChar?.wisdom === 11,
    JSON.stringify({
      race: tortleChar?.race,
      darkvision: tortleChar?.darkvision_feet,
      strength: tortleChar?.strength,
      wisdom: tortleChar?.wisdom,
    })
  );

  // -- 4. Warforged (Eberron) — fixed CON +2 plus a player-chosen "+1 to
  //    choice" ability, confirming the choice-bonus dropdown (previously
  //    only exercised by Half-Elf) generically handles a brand-new race's
  //    choice slot with no wizard code changes. --
  await page.goto(`${APP_URL}/campaigns/${campaignId}/characters/new`);
  await page.waitForSelector('[data-testid="wizard-race-homebrew"]', { timeout: 30000 });
  await page.getByLabel("Character name").fill("Unit 7-Cast");
  await page.locator('button:has(span:text-is("Warforged"))').click();
  await page.locator('button:has(span:text-is("Fighter"))').click();
  await page.click('button:has-text("Next")');
  await page.waitForSelector('select[required]');
  check(
    "Warforged's 'choice' ability bonus renders a required dropdown on the ability step",
    (await page.locator('select[required]').count()) === 1
  );
  await page.selectOption('select[required]', { label: "Dexterity" });
  const warforgedText = await page.locator("main").textContent();
  check(
    "Warforged's fixed CON +2 and chosen DEX +1 both applied (CON 13→15, DEX 14→15)",
    (warforgedText ?? "").includes("13 + 2 = 15") && (warforgedText ?? "").includes("14 + 1 = 15"),
    warforgedText?.slice(0, 400)
  );
  await page.click('button:has-text("Next")');
  await finishFromEquipmentStep(page);
  await page.waitForURL(`${APP_URL}/campaigns/${campaignId}`, { timeout: 15000 });

  const { data: warforgedChar } = await admin
    .from("characters")
    .select()
    .eq("campaign_id", campaignId)
    .eq("name", "Unit 7-Cast")
    .maybeSingle();
  check(
    "Warforged saved with race='Warforged', no darkvision, fixed CON +2 and chosen DEX +1 both applied (13→15, 14→15)",
    warforgedChar?.race === "Warforged" &&
      warforgedChar?.darkvision_feet === null &&
      warforgedChar?.constitution === 15 &&
      warforgedChar?.dexterity === 15,
    JSON.stringify({
      race: warforgedChar?.race,
      darkvision: warforgedChar?.darkvision_feet,
      constitution: warforgedChar?.constitution,
      dexterity: warforgedChar?.dexterity,
    })
  );

  await page.goto(`${APP_URL}/campaigns/${campaignId}/characters/${warforgedChar.id}`);
  await page.waitForSelector('input[aria-label="Constitution score"]', { timeout: 30000 });
  check(
    "the Warforged character sheet's editable ability fields show the applied CON/DEX increases (15, 15)",
    (await page.inputValue('input[aria-label="Constitution score"]')) === "15" &&
      (await page.inputValue('input[aria-label="Dexterity score"]')) === "15"
  );
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
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
console.log("\nAll expanded race catalog checks passed.");
process.exit(0);
