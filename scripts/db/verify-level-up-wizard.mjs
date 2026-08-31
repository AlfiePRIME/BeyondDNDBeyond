#!/usr/bin/env node
// "make sure when level ups happen new spells/character traits/advantages
// are added to character sheets and users are walked through them" — the
// project owner's explicit FULL-SYSTEM choice (author subclasses + build
// the ASI UI too, not the smaller HP-only MVP).
//
// What this verifies (confirmed by reading the actual shipped code, not
// assumed):
//   - src/app/campaigns/[id]/LevelUpWizard.tsx: a shared guided level-up
//     flow opened from BOTH the character sheet's "Level up" button AND
//     the DM party dashboard's "Confirm level N" button (replacing both
//     pages' old one-click instant actions).
//   - The class-features-gained diff (rules-engine/levelUp.ts's
//     featuresGainedBetween), sourced from the now-ASI-complete
//     srd/classes.ts feature tables and the new srd/subclasses.ts catalog
//     (one real SRD subclass per class).
//   - The subclass-choice step: appears ONLY at the class's own SRD gate
//     level (from the base class's own named feature, not a hardcoded
//     level) and ONLY while no subclass is chosen yet — never a second
//     time after that.
//   - Spell-slot resync (data-access/characterResources.ts's
//     growCharacterResourceMax): an ALREADY-EXISTING character_resources
//     slot row has its max_uses (and current_uses, by the same delta)
//     genuinely bumped, not just left stale or duplicated — the exact gap
//     the character sheet page's old load-time-only provisioning left.
//   - The new-spells step, filtered to the character's own class via the
//     new srd/spells.ts `classes` field (a Cleric-only spell must NOT
//     appear as pickable for a Wizard, and vice versa).
//   - The Ability Score Improvement picker: +2 to one score OR +1 to two
//     DIFFERENT scores — the UI structurally can't pick the same ability
//     twice in the two-score mode (the second dropdown excludes whatever
//     the first one picked).
//   - The full flow committing everything (level, HP, ability scores,
//     spells, subclass, spell-slot resources) in one confirm.
//
// IMPORTANT — authored while migration 0106_character_subclass.sql is
// deliberately UNAPPLIED (this task forbids running it; a human applies it
// via `node scripts/db/migrate.mjs`). The verify-party-dashboard.mjs
// "probe first, blocked-not-failed" convention applies: characters.subclass
// is probed non-destructively up front, and every check that genuinely
// needs that column reports BLOCKED (not FAIL) until it's applied — every
// other check (feature diffing, spell-slot math and resync, ASI math and
// UI enforcement, class-restricted spell filtering, the full non-subclass
// commit path, opening from both trigger points) runs for real today.
//
// Needs the real dev server (starts `yarn dev` itself if the target port
// isn't already serving) and the real shared Supabase instance this
// project's .env points at. Ephemeral test users/campaign/characters are
// created here and torn down in `finally`.
// Usage: node scripts/db/verify-level-up-wizard.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 6473;
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  process.env.SCREENSHOT_DIR ??
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";

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
let blocked = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}
function skipBlocked(label, reason) {
  console.log(`BLOCKED  ${label} — ${reason}`);
  blocked++;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on :${PORT} — starting this checkout's own…`);
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
  const email = `levelup-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `LevelUp ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

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

function sheetUrl(campaignId, characterId) {
  return `${APP_URL}/campaigns/${campaignId}/characters/${characterId}`;
}

await ensureDevServer();

// ---------------------------------------------------------------------
// Non-destructive migration probe: a SELECT of the new column either
// works (applied) or errors (not applied) without touching any data.
// ---------------------------------------------------------------------
const probe = await admin.from("characters").select("subclass").limit(1);
const migrationApplied = !probe.error;
console.log(
  migrationApplied
    ? "migration 0106_character_subclass.sql is APPLIED — running the full check suite.\n"
    : "migration 0106_character_subclass.sql is NOT applied — subclass-persistence checks will report BLOCKED, everything else runs for real.\n"
);

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const campaignId = crypto.randomUUID();

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Level Up Wizard Test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  // Character A: a Rogue at level 2, owned by the player — leveling to 3
  // lands EXACTLY on Rogue's subclass gate (Roguish Archetype), the
  // normal "first time" case (as opposed to the other two updated
  // verify-character-sheet-*.mjs scripts' "already past the gate"
  // catch-up case) — driven from the CHARACTER SHEET trigger point.
  const rogueId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: rogueId,
    campaign_id: campaignId,
    owner_id: player.id,
    name: "Vex Nightblade",
    race: "Halfling",
    class: "Rogue",
    level: 2,
    strength: 10,
    dexterity: 16,
    constitution: 12,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 14,
    max_hp: 14,
    armor_class: 14,
    speed: 25,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  // Character B: a Wizard at level 3 with a PRE-EXISTING, partially-spent
  // 2nd-level spell slot resource (max 2, 1 already spent) — level 3→4
  // grows that slot level to 3, so this is the "resync an EXISTING row"
  // case, not "create a missing one" (Character A's own 1st-level slots
  // will separately exercise the create-missing path). Driven from the
  // DM PARTY DASHBOARD trigger point.
  const wizardId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: wizardId,
    campaign_id: campaignId,
    owner_id: player.id,
    name: "Ferrin Quill",
    race: "Human",
    class: "Wizard",
    level: 3,
    strength: 8,
    dexterity: 14,
    constitution: 12,
    intelligence: 17,
    wisdom: 10,
    charisma: 10,
    current_hp: 18,
    max_hp: 18,
    armor_class: 12,
    speed: 30,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: [
      { name: "Fire Bolt", level: 0 },
      { name: "Magic Missile", level: 1 },
    ],
  });
  const { data: seededSlotResource } = await admin
    .from("character_resources")
    .insert({
      character_id: wizardId,
      name: "2nd-Level Spell Slots",
      max_uses: 2,
      current_uses: 1,
      recharge: "long_rest",
    })
    .select()
    .single();

  // Character C: a freshly-created level-1 Cleric — Cleric's own SRD
  // subclass gate (Divine Domain) is ALSO level 1, the same level
  // CharacterWizard.tsx always creates a character at (no starting-level
  // picker exists). The level-up wizard alone can never record this
  // character's subclass without ALSO bumping them to level 2 — a real,
  // incorrect level/HP change for a character who hasn't earned it — so
  // CharacterSheet.tsx's own standalone "Choose subclass" section
  // (independent of any level-up) is the only way to record it. This
  // phase exercises exactly that path and asserts the one thing that
  // matters most: level and HP are BYTE-FOR-BYTE unchanged before and
  // after, proving this is genuinely independent of the level-up flow.
  const clericId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: clericId,
    campaign_id: campaignId,
    owner_id: player.id,
    name: "Sera Dawnbringer",
    race: "Human",
    class: "Cleric",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 14,
    intelligence: 10,
    wisdom: 16,
    charisma: 10,
    current_hp: 9,
    max_hp: 9,
    armor_class: 16,
    speed: 30,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const playerContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await playerContext.addCookies(sessionCookies(player.session));

  // -------------------------------------------------------------------
  // Phase 1 — Rogue, opened from the CHARACTER SHEET (the player's own
  // page). Level 2 → 3: subclass gate, no ASI (Rogue's ASI levels are
  // 4/8/10/12/16/19), non-caster (no slots/spells steps).
  // -------------------------------------------------------------------
  const rogueSheet = await playerContext.newPage();
  await rogueSheet.goto(sheetUrl(campaignId, rogueId));
  await rogueSheet.waitForSelector('[data-testid="sheet-level-up-button"]', { timeout: 30000 });

  // Dismissing the wizard without confirming must leave the character
  // completely untouched — the "no accidental partial apply" safety net.
  await rogueSheet.click('[data-testid="sheet-level-up-button"]');
  await rogueSheet.waitForSelector('[data-testid="level-up-wizard"]', { timeout: 15000 });
  await rogueSheet.waitForSelector('[data-testid="levelup-step-features"]', { timeout: 15000 });
  const rogueFeaturesText = (await rogueSheet.textContent('[data-testid="levelup-step-features"]')) ?? "";
  check(
    "the Class Features step shows the genuinely new feature (Roguish Archetype) gained at this level",
    rogueFeaturesText.includes("Roguish Archetype"),
    rogueFeaturesText
  );
  check(
    "it also shows the feature's description, not just its bare name",
    (await rogueSheet.textContent(`[data-testid="levelup-feature-roguish-archetype"]`))?.includes(
      "archetype"
    ) ?? false
  );
  await rogueSheet.click('[data-testid="levelup-back"]'); // "Cancel" at step 0
  await sleep(800);
  {
    const { data } = await admin.from("characters").select("level").eq("id", rogueId).single();
    check("canceling the wizard at step 0 leaves the character's level unchanged", data?.level === 2, data?.level);
  }
  await rogueSheet.screenshot({ path: join(SCREENSHOT_DIR, "levelup-features-step.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "levelup-features-step.png")}`);

  // Reopen and actually complete it this time.
  await rogueSheet.click('[data-testid="sheet-level-up-button"]');
  await rogueSheet.waitForSelector('[data-testid="levelup-step-features"]', { timeout: 15000 });
  await rogueSheet.click('[data-testid="levelup-next"]');

  if (migrationApplied) {
    await rogueSheet.waitForSelector('[data-testid="levelup-step-subclass"]', { timeout: 15000 });
    const thiefCard = rogueSheet.locator('[data-testid="levelup-subclass-choice-thief"]');
    check("the subclass-choice step offers Thief for a Rogue", (await thiefCard.count()) === 1);
    check(
      "Next is disabled until a subclass is actually picked",
      await rogueSheet.locator('[data-testid="levelup-next"]').isDisabled()
    );
    await thiefCard.click();
    const subclassFeatureText =
      (await rogueSheet.textContent('[data-testid="levelup-subclass-features"]').catch(() => "")) ?? "";
    check(
      "picking Thief immediately previews its own 3rd-level features (Fast Hands, Second-Story Work)",
      subclassFeatureText.includes("Fast Hands") && subclassFeatureText.includes("Second-Story Work"),
      subclassFeatureText
    );
    await rogueSheet.screenshot({ path: join(SCREENSHOT_DIR, "levelup-subclass-step.png") });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "levelup-subclass-step.png")}`);
    await rogueSheet.click('[data-testid="levelup-next"]');
  } else {
    skipBlocked(
      "the subclass-choice step appears at Rogue's gate level (3) and offers Thief",
      "migration 0106_character_subclass.sql not applied — characters.subclass is absent from the row, so the wizard correctly treats it as not-yet-applicable rather than erroring"
    );
  }

  await rogueSheet.waitForSelector('[data-testid="levelup-step-hp"]', { timeout: 15000 });
  await rogueSheet.click('[data-testid="levelup-next"]');
  await rogueSheet.waitForSelector('[data-testid="levelup-step-review"]', { timeout: 15000 });
  const rogueReviewText = (await rogueSheet.textContent('[data-testid="levelup-review"]')) ?? "";
  check(
    "the review step summarizes the level change and gained features before commit",
    rogueReviewText.includes("2") && rogueReviewText.includes("3") && rogueReviewText.includes("Roguish Archetype"),
    rogueReviewText
  );
  await rogueSheet.click('[data-testid="levelup-confirm"]');
  // Rogue d8, CON 12 (+1) -> average gain = floor(8/2)+1+1 = 6.
  const rogueAfterFirst = await waitForCharacter(rogueId, (c) => c.level === 3);
  check(
    "confirming commits level 2→3 with the SRD average HP gain (d8, CON +1 -> +6)",
    rogueAfterFirst?.level === 3 && rogueAfterFirst?.current_hp === 20 && rogueAfterFirst?.max_hp === 20,
    JSON.stringify({ level: rogueAfterFirst?.level, hp: rogueAfterFirst?.current_hp, max: rogueAfterFirst?.max_hp })
  );
  if (migrationApplied) {
    check(
      "the chosen subclass (Thief) persisted",
      rogueAfterFirst?.subclass === "Thief",
      rogueAfterFirst?.subclass
    );
  }

  // -- Level 3 → 4: Rogue's own ASI level. Also proves the subclass step
  //    does NOT appear a second time now that one is already chosen. --
  await rogueSheet.click('[data-testid="sheet-level-up-button"]');
  await rogueSheet.waitForSelector('[data-testid="levelup-step-features"]', { timeout: 15000 });
  await rogueSheet.click('[data-testid="levelup-next"]');
  if (migrationApplied) {
    check(
      "the subclass step does NOT reappear once a subclass is already chosen",
      (await rogueSheet.locator('[data-testid="levelup-step-subclass"]').count()) === 0
    );
  } else {
    skipBlocked(
      "the subclass step never reappears for an already-subclassed character",
      "migration 0106_character_subclass.sql not applied — subclass could not be set in the first place to test against"
    );
  }
  await rogueSheet.waitForSelector('[data-testid="levelup-step-asi"]', { timeout: 15000 });
  check(
    "the ASI step is offered at Rogue's SRD level 4 (an ASI level)",
    (await rogueSheet.locator('[data-testid="levelup-step-asi"]').count()) === 1
  );
  check("Next is disabled before any ability score choice is made", await rogueSheet.locator('[data-testid="levelup-next"]').isDisabled());
  // Switch to "+1 to two scores" and prove the SRD rule is structurally
  // enforced: picking the first ability REMOVES it from the second
  // dropdown's options, so the same score can never be picked twice.
  await rogueSheet.click('[data-testid="levelup-asi-mode-double"]');
  await rogueSheet.selectOption('[data-testid="levelup-asi-double-ability-a"]', "dexterity");
  const secondDropdownOptions = await rogueSheet
    .locator('[data-testid="levelup-asi-double-ability-b"] option')
    .allTextContents();
  check(
    "picking Dexterity as the first +1 removes it from the second dropdown's options (can't double up)",
    !secondDropdownOptions.some((label) => label.startsWith("Dexterity")),
    JSON.stringify(secondDropdownOptions)
  );
  check(
    "Next is still disabled with only one of the two +1 abilities chosen",
    await rogueSheet.locator('[data-testid="levelup-next"]').isDisabled()
  );
  // Switch back to the simpler, fully-deterministic "+2 to one score" mode
  // for the actual commit (keeps this test's expected final scores exact).
  await rogueSheet.click('[data-testid="levelup-asi-mode-single"]');
  await rogueSheet.selectOption('[data-testid="levelup-asi-single-ability"]', "dexterity");
  check("Next becomes enabled once a valid single +2 choice is made", !(await rogueSheet.locator('[data-testid="levelup-next"]').isDisabled()));
  await rogueSheet.click('[data-testid="levelup-next"]');
  await rogueSheet.waitForSelector('[data-testid="levelup-step-hp"]', { timeout: 15000 });
  await rogueSheet.click('[data-testid="levelup-next"]');
  await rogueSheet.waitForSelector('[data-testid="levelup-step-review"]', { timeout: 15000 });
  await rogueSheet.click('[data-testid="levelup-confirm"]');
  const rogueAfterSecond = await waitForCharacter(rogueId, (c) => c.level === 4);
  check(
    "the +2 Dexterity ASI persisted (16 → 18) alongside the level/HP gain",
    rogueAfterSecond?.level === 4 && rogueAfterSecond?.dexterity === 18,
    JSON.stringify({ level: rogueAfterSecond?.level, dexterity: rogueAfterSecond?.dexterity })
  );
  await rogueSheet.screenshot({ path: join(SCREENSHOT_DIR, "levelup-asi-step.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "levelup-asi-step.png")}`);

  // -------------------------------------------------------------------
  // Phase 2 — Wizard, opened from the DM PARTY DASHBOARD (the OTHER
  // trigger point), via XP crossing the level-4 SRD threshold. Level
  // 3 → 4: spell-slot resync (an EXISTING 2nd-level row grows 2→3, a
  // brand new 1st-level row is created), class-restricted new spells,
  // Wizard's own ASI level 4.
  // -------------------------------------------------------------------
  // Directly via the admin (service-role) client, which bypasses the
  // award_xp RPC's DM-only RLS/trigger checks entirely — equivalent here
  // since this is just seeding the threshold for the dashboard's own
  // suggest-then-confirm UI to react to, not testing award_xp itself
  // (verify-party-dashboard.mjs already owns that).
  await admin.from("characters").update({ xp: 2700 }).eq("id", wizardId);

  const dmParty = await dmContext.newPage();
  await dmParty.goto(`${APP_URL}/campaigns/${campaignId}/party`);
  await dmParty.waitForSelector('[data-testid="party-dashboard"]', { timeout: 30000 });
  await dmParty.waitForSelector(`[data-testid="party-levelup-${wizardId}"]`, { timeout: 15000 });
  const levelUpButton = dmParty.locator(`[data-testid="party-levelup-${wizardId}"]`);
  check(
    "the party dashboard offers a level-up for the Wizard once past the XP threshold",
    (await levelUpButton.count()) === 1
  );
  await levelUpButton.click();
  await dmParty.waitForSelector('[data-testid="level-up-wizard"]', { timeout: 15000 });
  await dmParty.waitForSelector('[data-testid="levelup-step-features"]', { timeout: 15000 });
  await dmParty.click('[data-testid="levelup-next"]');
  if (migrationApplied) {
    await dmParty.waitForSelector('[data-testid="levelup-step-subclass"]', { timeout: 15000 });
    await dmParty.click('[data-testid="levelup-subclass-choice-school-of-evocation"]');
    await dmParty.click('[data-testid="levelup-next"]');
  }
  await dmParty.waitForSelector('[data-testid="levelup-step-slots"]', { timeout: 15000 });
  const slotText = (await dmParty.textContent('[data-testid="levelup-slot-2"]')) ?? "";
  check(
    "the Spell Slots step shows the 2nd-level slot count growing 2 → 3",
    slotText.replace(/\s+/g, " ").includes("2 → 3"),
    slotText
  );
  await dmParty.screenshot({ path: join(SCREENSHOT_DIR, "levelup-slots-step.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "levelup-slots-step.png")}`);
  await dmParty.click('[data-testid="levelup-next"]');

  await dmParty.waitForSelector('[data-testid="levelup-step-spells"]', { timeout: 15000 });
  check(
    "a genuine Wizard spell (Web) is offered on the New Spells step",
    (await dmParty.locator('[data-testid="levelup-spell-web"]').count()) === 1
  );
  check(
    "a Cleric-only spell (Guiding Bolt) is correctly ABSENT from a Wizard's offered spells",
    (await dmParty.locator('[data-testid="levelup-spell-guiding-bolt"]').count()) === 0
  );
  await dmParty.click('[data-testid="levelup-spell-web"]');
  await dmParty.screenshot({ path: join(SCREENSHOT_DIR, "levelup-spells-step.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "levelup-spells-step.png")}`);
  await dmParty.click('[data-testid="levelup-next"]');

  await dmParty.waitForSelector('[data-testid="levelup-step-asi"]', { timeout: 15000 });
  await dmParty.click('[data-testid="levelup-asi-mode-single"]');
  await dmParty.selectOption('[data-testid="levelup-asi-single-ability"]', "intelligence");
  await dmParty.click('[data-testid="levelup-next"]');
  await dmParty.waitForSelector('[data-testid="levelup-step-hp"]', { timeout: 15000 });
  await dmParty.click('[data-testid="levelup-next"]');
  await dmParty.waitForSelector('[data-testid="levelup-step-review"]', { timeout: 15000 });
  await dmParty.click('[data-testid="levelup-confirm"]');

  // Wizard d6, INT ASI doesn't touch CON 12 (+1) -> average gain = floor(6/2)+1+1 = 5.
  const wizardAfter = await waitForCharacter(wizardId, (c) => c.level === 4);
  check(
    "confirming from the PARTY DASHBOARD commits level 3→4 with the SRD average HP gain (18 → 23)",
    wizardAfter?.level === 4 && wizardAfter?.current_hp === 23 && wizardAfter?.max_hp === 23,
    JSON.stringify({ level: wizardAfter?.level, hp: wizardAfter?.current_hp, max: wizardAfter?.max_hp })
  );
  check(
    "the ASI (+2 Intelligence) persisted (17 → 19)",
    wizardAfter?.intelligence === 19,
    wizardAfter?.intelligence
  );
  check(
    "the newly-picked spell (Web) was added to the character's spell list",
    (wizardAfter?.spells ?? []).some((s) => s.name === "Web"),
    JSON.stringify(wizardAfter?.spells)
  );
  if (migrationApplied) {
    check(
      "the chosen subclass (School of Evocation) persisted",
      wizardAfter?.subclass === "School of Evocation",
      wizardAfter?.subclass
    );
  } else {
    skipBlocked(
      "the chosen subclass persists for the Wizard too",
      "migration 0106_character_subclass.sql not applied"
    );
  }

  const { data: resourcesAfter } = await admin
    .from("character_resources")
    .select()
    .eq("character_id", wizardId)
    .order("name");
  const grownSlot = resourcesAfter.find((r) => r.id === seededSlotResource.id);
  check(
    "the PRE-EXISTING 2nd-level slot resource row's max_uses grew 2 → 3 (not just a new row appearing)",
    grownSlot?.max_uses === 3,
    JSON.stringify(grownSlot)
  );
  check(
    "current_uses moved by the SAME delta as max_uses (1 → 2), not reset to full",
    grownSlot?.current_uses === 2,
    JSON.stringify(grownSlot)
  );
  check(
    "it's still the SAME row (same id) — resized in place, not deleted and recreated",
    grownSlot?.id === seededSlotResource.id
  );
  const newFirstLevelSlot = resourcesAfter.find((r) => r.name === "1st-Level Spell Slots");
  check(
    "a brand-new 1st-level slot resource was CREATED (this character had none before) at the full new count (4)",
    newFirstLevelSlot?.max_uses === 4 && newFirstLevelSlot?.current_uses === 4,
    JSON.stringify(newFirstLevelSlot)
  );

  await dmParty.screenshot({ path: join(SCREENSHOT_DIR, "levelup-review-and-confirm.png"), fullPage: true });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "levelup-review-and-confirm.png")}`);

  // -------------------------------------------------------------------
  // Phase 4 — the standalone subclass picker, independent of any
  // level-up, for the level-1 Cleric created above.
  // -------------------------------------------------------------------
  const clericSheet = await playerContext.newPage();
  await clericSheet.goto(sheetUrl(campaignId, clericId));
  await clericSheet.waitForSelector('[data-testid="sheet-level-up-button"]', { timeout: 30000 });

  if (migrationApplied) {
    check(
      "the standalone subclass choice appears for a level-1 Cleric (SRD gate = level 1, the same level they were created at)",
      await clericSheet.locator('[data-testid="sheet-subclass-choice"]').isVisible()
    );
    const clericLevelBefore = await clericSheet.inputValue('[data-testid="sheet-level-input"]');

    await clericSheet.click('[data-testid="sheet-subclass-choice-life-domain"]');
    const clericPreviewText = (await clericSheet.textContent('[data-testid="sheet-subclass-choice"]')) ?? "";
    check(
      "picking Life Domain previews its own level-1 features (Bonus Proficiency, Disciple of Life) without needing a level-up",
      clericPreviewText.includes("Bonus Proficiency") && clericPreviewText.includes("Disciple of Life"),
      clericPreviewText
    );

    await clericSheet.click('[data-testid="sheet-subclass-confirm"]');
    await sleep(1200);

    const clericLevelAfter = await clericSheet.inputValue('[data-testid="sheet-level-input"]');
    check(
      "confirming the standalone subclass pick leaves the character's LEVEL completely unchanged (still 1, never bumped to 2)",
      clericLevelAfter === clericLevelBefore && clericLevelAfter === "1",
      JSON.stringify({ clericLevelBefore, clericLevelAfter })
    );
    const { data: clericRowAfter } = await admin.from("characters").select().eq("id", clericId).single();
    check(
      "confirming the standalone subclass pick leaves the character's HIT POINTS completely unchanged (no HP gain attached)",
      clericRowAfter?.current_hp === 9 && clericRowAfter?.max_hp === 9,
      JSON.stringify({ current_hp: clericRowAfter?.current_hp, max_hp: clericRowAfter?.max_hp })
    );
    check(
      "the chosen subclass (Life Domain) persisted for the standalone picker too",
      clericRowAfter?.subclass === "Life Domain",
      JSON.stringify(clericRowAfter?.subclass)
    );
    await clericSheet.reload();
    await clericSheet.waitForSelector('[data-testid="sheet-level-up-button"]', { timeout: 30000 });
    check(
      "the standalone subclass section no longer renders once a subclass is already chosen",
      (await clericSheet.locator('[data-testid="sheet-subclass-choice"]').count()) === 0
    );
    await clericSheet.screenshot({ path: join(SCREENSHOT_DIR, "levelup-standalone-subclass.png"), fullPage: true });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "levelup-standalone-subclass.png")}`);
  } else {
    // Pre-migration, a real fetch of `characters` has NO `subclass` field
    // at all (the column doesn't exist yet) — the fetched row's
    // `character.subclass` comes back `undefined`, not `null`, so
    // needsStandaloneSubclassChoice's own `character.subclass === null`
    // gate never holds and the section correctly stays absent, the exact
    // same "not-yet-applicable rather than erroring" behavior the wizard's
    // OWN subclass step already has pre-migration. Nothing here can run
    // for real until the column exists.
    skipBlocked(
      "the standalone subclass choice appears for a level-1 Cleric (SRD gate = level 1, the same level they were created at)",
      "migration 0106_character_subclass.sql not applied — characters.subclass is absent from the row, so the section correctly stays hidden rather than erroring"
    );
    skipBlocked(
      "picking Life Domain previews its own level-1 features without needing a level-up",
      "migration 0106_character_subclass.sql not applied"
    );
    skipBlocked(
      "confirming the standalone subclass pick leaves level/HP completely unchanged and persists the subclass",
      "migration 0106_character_subclass.sql not applied"
    );
    skipBlocked(
      "the standalone subclass section no longer renders once a subclass is already chosen",
      "migration 0106_character_subclass.sql not applied — subclass could not be set in the first place to test against"
    );
  }
} finally {
  await browser.close();
  await admin.from("campaigns").delete().eq("id", campaignId);
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

console.log(`\n${failures} failure(s), ${blocked} blocked (migration pending) check(s).`);
if (failures > 0) {
  console.error("Level-up wizard verification FAILED.");
  process.exit(1);
}
console.log(
  blocked > 0
    ? "Level-up wizard verification PASSED every check runnable today; the rest are BLOCKED pending the (deliberately unapplied) migration 0106_character_subclass.sql — apply via `node scripts/db/migrate.mjs`, then re-run."
    : "All level-up wizard checks passed."
);
process.exit(0);
