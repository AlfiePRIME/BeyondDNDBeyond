#!/usr/bin/env node
// Homebrew race in character creation (CharacterWizard.tsx) verification.
//
// Previously the wizard required picking a race from the fixed SRD RACES
// list — saving was blocked without a match, and the pick auto-derived
// speed/darkvision/ability score increases. This adds a "Homebrew / Other"
// card alongside the SRD list: picking it unlocks a free-text race name and
// manual speed/darkvision/per-ability-bonus fields, and the `!race`
// validation now treats a non-empty homebrew name as genuinely "chosen".
//
// Drives a real browser (the verify-action-overrides.mjs/verify-campaign-
// onboarding.mjs arrangement) through the ACTUAL wizard UI — not a direct
// DB insert — end to end: fill the name, pick Homebrew/Other, confirm the
// sensible (not silent) defaults, type a custom race name, set custom
// speed/darkvision/ability bonuses, pick a class, pick equipment, confirm
// the review step shows the homebrew values, save, and confirm both the
// stored row AND the campaign page's roster badge AND the character sheet
// show the homebrew race correctly. A second pass through the wizard
// picking a real SRD race (Elf → Wood Elf) confirms the existing
// auto-derivation path is completely unaffected.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000.
// Usage: node scripts/db/verify-homebrew-race.mjs
//        APP_URL=http://localhost:3947 node scripts/db/verify-homebrew-race.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

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
  const email = `homebrew-race-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Homebrew Race ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch();

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Homebrew race test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  const playerContext = await browser.newContext();
  await playerContext.addCookies(sessionCookies(player.session));
  const page = await playerContext.newPage();

  // -- 1. Build a homebrew-race character through the real wizard UI. --
  await page.goto(`${APP_URL}/campaigns/${campaignId}/characters/new`);
  await page.waitForSelector('[data-testid="wizard-race-homebrew"]', { timeout: 30000 });

  await page.getByLabel("Character name").fill("Zeph Starkin");

  // Before picking homebrew, Next is gated on an SRD race exactly like
  // before — no homebrew fields are visible yet.
  check(
    "the homebrew race name/speed/darkvision fields are hidden until the homebrew card is picked",
    (await page.locator('[data-testid="wizard-homebrew-race-name"]').count()) === 0
  );

  await page.click('[data-testid="wizard-race-homebrew"]');
  await page.waitForSelector('[data-testid="wizard-homebrew-race-name"]');

  // Sensible, VISIBLE defaults — not a silent zero and not a fixed race's
  // values smuggled in.
  check(
    "picking homebrew seeds a visible, editable default speed (30 ft) and darkvision (0 = none)",
    (await page.inputValue('[data-testid="wizard-homebrew-speed"]')) === "30" &&
      (await page.inputValue('[data-testid="wizard-homebrew-darkvision"]')) === "0"
  );

  // An empty race name is "nothing chosen" — Next stays blocked even with
  // a class picked, same as the old !race check.
  await page.locator('button:has(span:text-is("Fighter"))').click();
  check(
    "Next is still blocked with the homebrew card selected but no race name typed",
    await page.isDisabled('button:has-text("Next")')
  );

  await page.fill('[data-testid="wizard-homebrew-race-name"]', "Starkin");
  await page.fill('[data-testid="wizard-homebrew-speed"]', "45");
  await page.fill('[data-testid="wizard-homebrew-darkvision"]', "90");
  check(
    "Next becomes enabled once the homebrew race is genuinely chosen (name + valid speed/darkvision)",
    !(await page.isDisabled('button:has-text("Next")'))
  );

  await page.click('button:has-text("Next")');

  // -- 2. Ability Scores step: manual per-ability homebrew bonuses. --
  await page.waitForSelector('[data-testid="wizard-homebrew-bonus-strength"]');
  check(
    "the ability-score step shows manual homebrew bonus fields instead of SRD choice dropdowns",
    (await page.locator('[data-testid="wizard-homebrew-bonus-strength"]').count()) === 1
  );
  await page.fill('[data-testid="wizard-homebrew-bonus-strength"]', "2");
  await page.fill('[data-testid="wizard-homebrew-bonus-charisma"]', "-1");
  check("Next is enabled on the ability step with valid homebrew bonuses", !(await page.isDisabled('button:has-text("Next")')));
  await page.click('button:has-text("Next")');

  // -- 3. Equipment step (Fighter's four choice groups — pick the first
  //    option in each, same as any other class). --
  await page.waitForSelector('button:has-text("Chain Mail")');
  await page.getByRole("button", { name: "Chain Mail", exact: true }).click();
  await page.getByRole("button", { name: "Martial Weapon + Shield", exact: true }).click();
  await page.getByRole("button", { name: "Light Crossbow + 20 Bolts", exact: true }).click();
  await page.getByRole("button", { name: "Dungeoneer's Pack", exact: true }).click();
  await page.click('button:has-text("Next")');

  // -- 4. Review & Create: the homebrew values show up exactly like an
  //    SRD race's derived values would. --
  await page.waitForSelector('[data-testid="wizard-summary-race"]');
  const summaryRace = await page.textContent('[data-testid="wizard-summary-race"]');
  const summaryVision = await page.textContent('[data-testid="wizard-vision"]');
  const summarySpeed = await page.locator("li", { hasText: "Speed" }).textContent();
  check("the review step shows the homebrew race name", summaryRace?.trim() === "Starkin", summaryRace);
  check("the review step shows the custom darkvision", (summaryVision ?? "").includes("Darkvision 90"), summaryVision);
  check("the review step shows the custom speed", (summarySpeed ?? "").includes("45 ft"), summarySpeed);

  await page.click('button:has-text("Create character")');
  await page.waitForURL(`${APP_URL}/campaigns/${campaignId}`, { timeout: 15000 });

  // -- 5. The saved row matches what the wizard showed. --
  const { data: homebrewChar } = await admin
    .from("characters")
    .select()
    .eq("campaign_id", campaignId)
    .eq("name", "Zeph Starkin")
    .maybeSingle();
  check(
    "the homebrew character saved with the custom race name, speed, and darkvision",
    homebrewChar?.race === "Starkin" && homebrewChar?.speed === 45 && homebrewChar?.darkvision_feet === 90,
    JSON.stringify({ race: homebrewChar?.race, speed: homebrewChar?.speed, darkvision: homebrewChar?.darkvision_feet })
  );
  check(
    "the homebrew ability bonuses (STR +2, CHA -1) were applied to the final scores (15→17, 8→7)",
    homebrewChar?.strength === 17 && homebrewChar?.charisma === 7,
    JSON.stringify({ strength: homebrewChar?.strength, charisma: homebrewChar?.charisma })
  );
  check("the homebrew character's class saved normally", homebrewChar?.class === "Fighter", homebrewChar?.class);

  // -- 6. Displays correctly on the campaign roster page — a plain string,
  //    same as any SRD race. --
  await page.waitForSelector(`text=Zeph Starkin`, { timeout: 15000 });
  check(
    "the campaign roster shows the homebrew race next to the character",
    await page.getByText("Starkin", { exact: true }).first().isVisible()
  );

  // -- 7. Displays correctly on the character sheet too. --
  await page.goto(`${APP_URL}/campaigns/${campaignId}/characters/${homebrewChar.id}`);
  await page.waitForSelector('[data-testid="sheet-race-select"]', { timeout: 30000 });
  check(
    "the character sheet's race control shows the homebrew name as the current selection",
    (await page.inputValue('[data-testid="sheet-race-select"]')) === "Starkin"
  );
  check(
    "the character sheet shows the custom darkvision",
    ((await page.textContent('[data-testid="sheet-vision"]').catch(() => "")) ?? "").includes("Darkvision 90")
  );

  // -- 8. A real SRD race (with a subrace) is completely unaffected. Same
  //    Fighter/equipment shape as the homebrew run above so this is a
  //    clean apples-to-apples regression check, not a new fragile path. --
  await page.goto(`${APP_URL}/campaigns/${campaignId}/characters/new`);
  await page.waitForSelector('[data-testid="wizard-race-homebrew"]', { timeout: 30000 });
  await page.getByLabel("Character name").fill("Mira Woodwalker");
  await page.locator('button:has(span:text-is("Elf"))').click();
  await page.selectOption("select", { label: "Wood Elf" });
  check(
    "no homebrew fields appear when an SRD race is picked",
    (await page.locator('[data-testid="wizard-homebrew-race-name"]').count()) === 0
  );
  await page.locator('button:has(span:text-is("Fighter"))').click();
  await page.click('button:has-text("Next")');

  // Elf (Dex +2 fixed) / Wood Elf (Wis +1 fixed) have no "choice" increases
  // and no homebrew fields either — straight through to equipment.
  check(
    "the ability step shows neither homebrew bonus fields nor SRD choice dropdowns for a race with only fixed increases",
    (await page.locator('[data-testid="wizard-homebrew-bonus-strength"]').count()) === 0
  );
  await page.click('button:has-text("Next")');

  await page.waitForSelector('button:has-text("Chain Mail")');
  await page.getByRole("button", { name: "Chain Mail", exact: true }).click();
  await page.getByRole("button", { name: "Martial Weapon + Shield", exact: true }).click();
  await page.getByRole("button", { name: "Light Crossbow + 20 Bolts", exact: true }).click();
  await page.getByRole("button", { name: "Dungeoneer's Pack", exact: true }).click();
  await page.click('button:has-text("Next")');

  await page.waitForSelector('[data-testid="wizard-vision"]');
  const srdVision = await page.textContent('[data-testid="wizard-vision"]');
  check("the SRD race path still auto-derives darkvision (Elf/Wood Elf → 60 ft)", (srdVision ?? "").includes("60"), srdVision);
  await page.click('button:has-text("Create character")');
  await page.waitForURL(`${APP_URL}/campaigns/${campaignId}`, { timeout: 15000 });

  const { data: srdChar } = await admin
    .from("characters")
    .select()
    .eq("campaign_id", campaignId)
    .eq("name", "Mira Woodwalker")
    .maybeSingle();
  check(
    "the SRD-race character's auto-derived speed/darkvision are completely unaffected (Wood Elf → 35 ft, darkvision 60)",
    srdChar?.race === "Wood Elf" && srdChar?.speed === 35 && srdChar?.darkvision_feet === 60,
    JSON.stringify({ race: srdChar?.race, speed: srdChar?.speed, darkvision: srdChar?.darkvision_feet })
  );
  check(
    "the SRD-race character's fixed racial ability increases still applied (Dex +2, Wis +1: 14→16, 10→11)",
    srdChar?.dexterity === 16 && srdChar?.wisdom === 11,
    JSON.stringify({ dexterity: srdChar?.dexterity, wisdom: srdChar?.wisdom })
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
console.log("\nAll homebrew race checks passed.");
process.exit(0);
