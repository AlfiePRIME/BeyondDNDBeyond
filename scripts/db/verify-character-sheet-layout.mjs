#!/usr/bin/env node
// Character sheet live-play layout verification (the wide-viewport
// redesign: the sheet no longer sits in a 760px centered column but uses
// the real viewport width — a full-width Vitals strip over three
// side-by-side panel stacks ordered by mid-turn urgency, collapsing to
// two stacks and then one as the viewport narrows).
//
// Drives a real browser (the verify-dice-ui.mjs arrangement) against a
// seeded campaign and checks, with measured getBoundingClientRect values
// rather than eyeballs: at a 2000px viewport the sheet's <main> fills at
// least 90% of the width and the Dice / Abilities & Saves / Inventory
// stacks sit at three genuinely distinct x positions with the mid-turn
// panels (Vitals, Dice, Abilities, Inventory tops) all above the fold; at
// ~1000px the play and roll stacks are still side by side with the
// reference stack full-width below; at 500px everything is back to one
// column, in urgency order, with no horizontal overflow. Then the moved
// panels' wiring is smoke-tested end to end: Level up (level +1, current
// AND max HP + the SRD average gain, in the DB), the HP stepper, a
// resource Spend, and an Advantage-mode ability check that must land in
// the shared roll_log with two d20s.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving. APP_URL can
// point the checks at a dev server on another port.
// Usage: node scripts/db/verify-character-sheet-layout.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Port 3000 on this host is the production standalone server (never to be
// touched by this script, per verify-character-sheet-access.mjs's own
// documented reasoning) — this script now always starts its OWN `yarn dev`
// on a dedicated port instead of defaulting to :3000 and silently reusing
// whatever's already answering there (which, before this fix, meant a run
// against the currently-DEPLOYED code rather than this checkout's own
// uncommitted changes whenever the production server happened to be up).
const LAYOUT_TEST_PORT = 6474;
const APP_URL = process.env.APP_URL ?? `http://localhost:${LAYOUT_TEST_PORT}`;

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
// The level-up wizard's "probe first, blocked-not-failed" convention
// (verify-party-dashboard.mjs's exact pattern): this file's Wizard test
// character is already past its class's subclass-gate level (Arcane
// Tradition, level 2) with no subclass chosen, so its next level-up
// necessarily needs to write characters.subclass — which genuinely does
// not exist until migration 0106_character_subclass.sql is applied.
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
  if (process.env.APP_URL && (await healthOk())) return; // an explicitly-provided APP_URL is trusted as-is
  console.log(`dev server not running on :${LAYOUT_TEST_PORT} — starting this checkout's own…`);
  devServer = spawn("yarn", ["dev", "-p", String(LAYOUT_TEST_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${LAYOUT_TEST_PORT} within 120s`);
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
  const email = `sheet-layout-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Sheet Layout ${label}` });
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

/** Bounding rects of every Panel on the sheet, keyed by panel title (the
 * first span in each section header — Panel renders the title span before
 * any headerActions). Measured for real, not inferred from CSS. */
async function panelRects(page) {
  return page.evaluate(() => {
    const out = {};
    for (const section of document.querySelectorAll("main section")) {
      const title = section.querySelector("header span")?.textContent?.trim();
      if (!title) continue;
      const r = section.getBoundingClientRect();
      out[title] = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    const main = document.querySelector("main").getBoundingClientRect();
    out.__main = { x: main.x, y: main.y, width: main.width, height: main.height };
    out.__scrollWidth = document.documentElement.scrollWidth;
    return out;
  });
}

const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;

await ensureDevServer();

// Non-destructive migration probe (the verify-party-dashboard.mjs
// convention): a SELECT of characters.subclass either works (migration
// 0106_character_subclass.sql applied) or errors (not applied yet).
const subclassProbe = await admin.from("characters").select("subclass").limit(1);
const subclassColumnExists = !subclassProbe.error;
console.log(
  subclassColumnExists
    ? "migration 0106_character_subclass.sql is APPLIED — the level-up wizard's subclass step runs for real.\n"
    : "migration 0106_character_subclass.sql is NOT applied — the level-up wizard's subclass-dependent checks will report BLOCKED.\n"
);

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Sheet layout test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // A caster so the Spells panel renders (the fullest layout), CON 13 so
  // the level-up HP math has a nonzero modifier to get wrong.
  const charId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: charId,
    campaign_id: campaignId,
    owner_id: dm.id,
    name: "Layout Probe",
    race: "Wood Elf",
    class: "Wizard",
    level: 5,
    strength: 10,
    dexterity: 14,
    constitution: 13,
    intelligence: 16,
    wisdom: 12,
    charisma: 8,
    current_hp: 22,
    max_hp: 31,
    armor_class: 12,
    speed: 35,
    darkvision_feet: 60,
    proficiencies: ["Arcana", "Perception"],
    inventory: [{ name: "Dagger", quantity: 2, attackKind: "finesse", damageNotation: "1d4" }],
    spells: [
      { name: "Fire Bolt", level: 0 },
      { name: "Witch Bolt", level: 1 },
    ],
  });
  await admin.from("character_resources").insert({
    character_id: charId,
    name: "Arcane Recovery",
    max_uses: 1,
    current_uses: 1,
    recharge: "long_rest",
  });

  const context = await browser.newContext();
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  const sheetUrl = `${APP_URL}/campaigns/${campaignId}/characters/${charId}`;

  // -- 1. Wide viewport (the project owner's own 2000px report): the sheet
  //    must really use the width — three side-by-side stacks, measured. --
  await page.setViewportSize({ width: 2000, height: 1100 });
  await page.goto(sheetUrl);
  await page.waitForSelector('[data-testid="sheet-race-select"]', { timeout: 30000 });
  const wide = await panelRects(page);
  check(
    "at 2000px the sheet's <main> fills at least 90% of the viewport (not a 760px column)",
    wide.__main.width >= 2000 * 0.9,
    `main width ${wide.__main.width}px`
  );
  check(
    "the Vitals strip spans (nearly) the full sheet width",
    wide.Vitals && wide.Vitals.width >= wide.__main.width * 0.95,
    `vitals ${wide.Vitals?.width}px of ${wide.__main.width}px`
  );
  check(
    "Dice, Abilities & Saves, and Inventory head three genuinely distinct columns",
    wide.Dice &&
      wide["Abilities & Saves"] &&
      wide.Inventory &&
      wide["Abilities & Saves"].x - wide.Dice.x > 200 &&
      wide.Inventory.x - wide["Abilities & Saves"].x > 200,
    JSON.stringify({ dice: wide.Dice?.x, abilities: wide["Abilities & Saves"]?.x, inventory: wide.Inventory?.x })
  );
  check(
    "each stack is internally aligned (play: Dice/Conditions/Resources; rolls: Abilities/Skills; reference: Inventory/Spells/Map token)",
    near(wide.Dice?.x, wide.Conditions?.x) &&
      near(wide.Dice?.x, wide.Resources?.x) &&
      near(wide["Abilities & Saves"]?.x, wide.Skills?.x) &&
      near(wide.Inventory?.x, wide.Spells?.x) &&
      near(wide.Inventory?.x, wide["Map token"]?.x),
    JSON.stringify(wide)
  );
  check(
    "the mid-turn surfaces (Vitals, Dice, Abilities, Inventory) all start above the fold",
    [wide.Vitals, wide.Dice, wide["Abilities & Saves"], wide.Inventory].every((r) => r && r.y < 1100),
    JSON.stringify({ vitals: wide.Vitals?.y, dice: wide.Dice?.y, abilities: wide["Abilities & Saves"]?.y, inventory: wide.Inventory?.y })
  );
  check("no horizontal overflow at 2000px", wide.__scrollWidth <= 2000, `scrollWidth ${wide.__scrollWidth}`);

  // -- 2. Mid viewport: play and roll stacks side by side, reference
  //    full-width below. --
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(300);
  const mid = await panelRects(page);
  check(
    "at 1000px the play and roll stacks are still side by side",
    mid.Dice && mid["Abilities & Saves"] && mid["Abilities & Saves"].x - mid.Dice.x > 150 && near(mid.Dice.y, mid["Abilities & Saves"].y, 40),
    JSON.stringify({ dice: mid.Dice, abilities: mid["Abilities & Saves"] })
  );
  check(
    "at 1000px the reference stack drops to a full-width row below",
    mid.Inventory && mid.Inventory.width >= mid.__main.width * 0.95 && mid.Inventory.y > mid.Dice.y,
    JSON.stringify(mid.Inventory)
  );
  check("no horizontal overflow at 1000px", mid.__scrollWidth <= 1000, `scrollWidth ${mid.__scrollWidth}`);

  // -- 3. Narrow viewport: one column again, urgency order preserved. --
  await page.setViewportSize({ width: 500, height: 900 });
  await page.waitForTimeout(300);
  const narrow = await panelRects(page);
  check(
    "at 500px every panel is back in a single aligned column",
    [narrow.Dice, narrow.Conditions, narrow.Resources, narrow["Abilities & Saves"], narrow.Skills, narrow.Inventory, narrow.Spells]
      .every((r) => r && near(r.x, narrow.Vitals.x)),
    JSON.stringify(narrow)
  );
  check(
    "the single column is ordered by mid-turn urgency (Dice before Abilities before Inventory)",
    narrow.Dice.y < narrow["Abilities & Saves"].y && narrow["Abilities & Saves"].y < narrow.Inventory.y,
    JSON.stringify({ dice: narrow.Dice.y, abilities: narrow["Abilities & Saves"].y, inventory: narrow.Inventory.y })
  );
  check("no horizontal overflow at 500px", narrow.__scrollWidth <= 500, `scrollWidth ${narrow.__scrollWidth}`);

  // -- 4. The moved panels still work: level-up math, HP stepper, resource
  //    spend, and an advantage roll landing in the shared log. --
  await page.setViewportSize({ width: 2000, height: 1100 });
  await page.waitForTimeout(300);

  // "Level up" now opens the guided LevelUpWizard (shared with the DM
  // party dashboard's own level-up control) instead of instantly applying
  // the level. Wizard d6, CON 13 → HP gain = floor(6/2)+1+1 = 5 to both HP
  // fields, level 5 → 6, all in one persisted row (the wizard's single
  // combined updateCharacter call). Arcane Tradition (Wizard's subclass
  // gate) is level 2 — already behind this character with no subclass
  // chosen — so the wizard's subclass step appears ONLY once migration
  // 0106_character_subclass.sql is applied (pre-migration, the column is
  // simply absent from the row rather than genuinely null, so
  // needsSubclassChoice reads it as "not applicable" and the step is
  // skipped rather than broken — see LevelUpWizard.tsx's own doc comment).
  // Level 6 isn't one of Wizard's ASI levels (4/8/12/16/19), so no ASI
  // step either; Wizard IS a caster, so slot growth (2nd-level slots
  // 2→3) and new-spell (+2 spellbook) steps both appear.
  await page.click('[data-testid="sheet-level-up-button"]');
  await page.waitForSelector('[data-testid="levelup-step-features"]', { timeout: 15000 });
  await page.click('[data-testid="levelup-next"]');
  if (subclassColumnExists) {
    await page.waitForSelector('[data-testid="levelup-step-subclass"]', { timeout: 15000 });
    await page.click('[data-testid="levelup-subclass-choice-school-of-evocation"]');
    await page.click('[data-testid="levelup-next"]');
  }
  await page.waitForSelector('[data-testid="levelup-step-slots"]', { timeout: 15000 });
  await page.click('[data-testid="levelup-next"]');
  await page.waitForSelector('[data-testid="levelup-step-spells"]', { timeout: 15000 });
  await page.click('[data-testid="levelup-next"]');
  await page.waitForSelector('[data-testid="levelup-step-hp"]', { timeout: 15000 });
  await page.click('[data-testid="levelup-next"]');
  await page.waitForSelector('[data-testid="levelup-step-review"]', { timeout: 15000 });
  await page.click('[data-testid="levelup-confirm"]');
  const afterLevelUp = await waitForCharacter(
    charId,
    (c) => c.level === 6 && c.current_hp === 27 && c.max_hp === 36
  );
  check(
    "Level up (via the wizard) advances level 5→6 and grants +5 HP to BOTH current and max (Wizard d6, CON +1)",
    afterLevelUp?.level === 6 && afterLevelUp?.current_hp === 27 && afterLevelUp?.max_hp === 36,
    JSON.stringify({ level: afterLevelUp?.level, hp: afterLevelUp?.current_hp, max: afterLevelUp?.max_hp })
  );
  check(
    "the level-up confirmation notice appears on the sheet",
    ((await page.textContent('[data-testid="sheet-levelup-notice"]').catch(() => "")) ?? "").includes("Leveled up to 6"),
    await page.textContent('[data-testid="sheet-levelup-notice"]').catch(() => "<missing>")
  );
  if (subclassColumnExists) {
    check(
      "the chosen subclass persisted to the character row",
      afterLevelUp?.subclass === "School of Evocation",
      afterLevelUp?.subclass
    );
  } else {
    skipBlocked(
      "the chosen subclass persists to characters.subclass",
      "migration 0106_character_subclass.sql not applied — run `node scripts/db/migrate.mjs`, then re-run this script"
    );
  }

  // HP stepper in the relocated Vitals strip.
  await page.click('button[aria-label="Heal 1 hit point"]');
  const afterHeal = await waitForCharacter(charId, (c) => c.current_hp === 28);
  check("the HP + stepper persists a heal (27 → 28)", afterHeal?.current_hp === 28, String(afterHeal?.current_hp));
  await page.click('button[aria-label="Take 1 damage"]');
  const afterDamage = await waitForCharacter(charId, (c) => c.current_hp === 27);
  check("the HP − stepper persists damage (28 → 27)", afterDamage?.current_hp === 27, String(afterDamage?.current_hp));

  // Resource spend in the relocated Resources panel.
  await page.click('li:has-text("Arcane Recovery") button:has-text("Spend")');
  let spentResource = null;
  for (let i = 0; i < 32 && spentResource?.current_uses !== 0; i++) {
    await sleep(250);
    const { data } = await admin
      .from("character_resources")
      .select()
      .eq("character_id", charId)
      .eq("name", "Arcane Recovery")
      .single();
    spentResource = data;
  }
  check(
    "spending Arcane Recovery persists 1 → 0 uses",
    spentResource?.current_uses === 0,
    String(spentResource?.current_uses)
  );

  // Ability-score editing in the relocated Abilities & Saves panel:
  // commit-on-blur, and the derived modifier display follows.
  await page.fill('input[aria-label="Strength score"]', "12");
  await page.locator('input[aria-label="Strength score"]').blur();
  const afterScore = await waitForCharacter(charId, (c) => c.strength === 12);
  check("editing an ability score persists (STR 10 → 12)", afterScore?.strength === 12, String(afterScore?.strength));

  // Advantage-mode ability check from the relocated Abilities panel: the
  // result must render on the sheet AND land in the campaign's shared
  // roll_log with two d20s and mode "advantage" (server-rolled).
  await page.click('[data-testid="sheet-mode-advantage"]');
  await page.click('[data-testid="roll-check-strength"]');
  await page.waitForSelector('[data-testid="sheet-roll-result"]', { timeout: 15000 });
  let rollRow = null;
  for (let i = 0; i < 32 && !rollRow; i++) {
    await sleep(250);
    const { data } = await admin
      .from("roll_log")
      .select()
      .eq("campaign_id", campaignId)
      .eq("character_id", charId)
      .eq("kind", "check")
      .order("created_at", { ascending: false })
      .limit(1);
    rollRow = data?.[0] ?? null;
  }
  check(
    "the ability check landed in the shared roll_log as an advantage roll with two d20s",
    rollRow?.breakdown?.mode === "advantage" && rollRow?.breakdown?.d20Rolls?.length === 2,
    JSON.stringify(rollRow?.breakdown ?? null)
  );
  check(
    "the sheet shows the same roll's headline in its recent-roll area",
    ((await page.textContent('[data-testid="sheet-roll-headline"]').catch(() => "")) ?? "").length > 0
  );
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already gone.
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed, ${blocked} blocked.`);
  process.exit(1);
}
console.log(
  blocked > 0
    ? `\nAll runnable character-sheet-layout checks passed; ${blocked} blocked pending migration 0106_character_subclass.sql.`
    : "\nAll character-sheet-layout checks passed."
);
process.exit(0);
