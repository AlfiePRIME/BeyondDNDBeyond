#!/usr/bin/env node
// Racial skill proficiencies at character creation: an Elf is granted
// Perception automatically (and can't waste a class pick on it), and a
// Half-Elf picks two extra skills of their choice — all saved into the
// character's proficiencies.
//
// Usage: RACE_SKILLS_APP_URL=http://localhost:5871 node scripts/db/verify-race-skills.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.RACE_SKILLS_APP_URL ?? process.env.APP_URL ?? "http://localhost:3000";

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
  const email = `race-skills-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Race Skills ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function chooseCard(page, title) {
  await page.locator("button", { has: page.getByText(title, { exact: true }) }).first().click();
}

// Walks the wizard for a Fighter of `race`, runs `onSkillsStep` on the
// Skills step, finishes, and returns the saved row.
async function createFighter(page, campaignId, { name, race, onSkillsStep }) {
  await page.goto(`${APP_URL}/campaigns/${campaignId}/characters/new`);
  await page.waitForSelector('[data-testid="wizard-race-homebrew"]', { timeout: 30000 });
  await page.getByLabel("Character name").fill(name);
  await chooseCard(page, race);
  await chooseCard(page, "Fighter");
  if (await page.isDisabled('button:has-text("Next")')) {
    const subrace = page.locator("select").first();
    const values = await subrace.locator("option").evaluateAll((opts) => opts.map((o) => o.value).filter(Boolean));
    if (values.length) await subrace.selectOption(values[0]);
  }
  await page.click('button:has-text("Next")'); // → Ability Scores
  // Races with "+1 to your choice" bonuses (Half-Elf) need each picked.
  const selects = page.locator("main select");
  for (let i = 0; i < (await selects.count()); i++) {
    const select = selects.nth(i);
    const value = await select.locator("option:not([disabled])").evaluateAll(
      (opts) => opts.map((o) => o.value).find(Boolean) ?? null
    );
    if (value && !(await select.inputValue())) await select.selectOption(value);
  }
  await page.click('button:has-text("Next")'); // → Skills
  await page.waitForSelector('[data-testid^="wizard-skill-"]');
  await onSkillsStep();
  await page.click('button:has-text("Next")'); // → Equipment
  await page.waitForSelector('button:has-text("Chain Mail")');
  await page.getByRole("button", { name: "Chain Mail", exact: true }).click();
  await page.getByRole("button", { name: "Martial Weapon + Shield", exact: true }).click();
  await page.getByRole("button", { name: "Light Crossbow + 20 Bolts", exact: true }).click();
  await page.getByRole("button", { name: "Dungeoneer's Pack", exact: true }).click();
  await page.click('button:has-text("Next")'); // → Review
  await page.click('button:has-text("Create character")');
  await page.waitForURL(`${APP_URL}/campaigns/${campaignId}`, { timeout: 15000 });
  const { data } = await admin.from("characters").select().eq("campaign_id", campaignId).eq("name", name).single();
  return data;
}

async function pickClassSkills(page, n) {
  for (let i = 0; i < n; i++) {
    await page.locator('[data-testid^="wizard-skill-"][aria-pressed="false"]:not([disabled])').first().click();
  }
}

await ensureDevServer();
const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const campaignId = crypto.randomUUID();

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Race skills test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);
  const context = await browser.newContext();
  await context.addCookies(sessionCookies(player.session));
  const page = await context.newPage();

  // ── Elf: Perception is granted, not offered as a class pick. ──
  const elf = await createFighter(page, campaignId, {
    name: "Ilyra Elf",
    race: "Elf",
    onSkillsStep: async () => {
      check(
        "the Skills step tells an Elf they're proficient in Perception",
        ((await page.textContent('[data-testid="wizard-race-fixed-skills"]')) ?? "").includes("Perception")
      );
      check(
        "Perception is not offered as a Fighter class pick for an Elf",
        (await page.locator('[data-testid="wizard-skill-perception"]').count()) === 0
      );
      await pickClassSkills(page, 2);
      check("Next unlocks with the two Fighter picks", !(await page.isDisabled('button:has-text("Next")')));
    },
  });
  check(
    "the Elf saved with Perception plus two class skills",
    elf.proficiencies.includes("Perception") &&
      elf.proficiencies.filter((p) => !p.endsWith("Saving Throws")).length === 3,
    JSON.stringify(elf.proficiencies)
  );

  // ── Half-Elf: two extra skills of their choice. ──
  const halfElf = await createFighter(page, campaignId, {
    name: "Tamsin Half-Elf",
    race: "Half-Elf",
    onSkillsStep: async () => {
      await pickClassSkills(page, 2);
      check(
        "Next stays locked until the Half-Elf's two racial picks are made",
        await page.isDisabled('button:has-text("Next")')
      );
      await page.click('[data-testid="wizard-race-skill-arcana"]');
      await page.click('[data-testid="wizard-race-skill-stealth"]');
      check(
        "the racial pick counter reads 2 / 2",
        ((await page.textContent('[data-testid="wizard-race-skills-count"]')) ?? "").includes("2 / 2")
      );
      check("Next unlocks once all picks are made", !(await page.isDisabled('button:has-text("Next")')));
    },
  });
  check(
    "the Half-Elf saved with Arcana and Stealth plus two class skills",
    halfElf.proficiencies.includes("Arcana") &&
      halfElf.proficiencies.includes("Stealth") &&
      halfElf.proficiencies.filter((p) => !p.endsWith("Saving Throws")).length === 4,
    JSON.stringify(halfElf.proficiencies)
  );
} finally {
  await browser.close();
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
  if (devServer) process.kill(-devServer.pid);
}

console.log(failures === 0 ? "\nAll race skill checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
