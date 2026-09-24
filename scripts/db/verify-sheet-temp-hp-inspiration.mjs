#!/usr/bin/env node
// Character sheet: temporary HP, hit dice, and inspiration controls, driven
// through the real sheet UI as the owning player and the DM.
//
// Usage: SHEET_EXTRAS_APP_URL=http://localhost:5871 node scripts/db/verify-sheet-temp-hp-inspiration.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.SHEET_EXTRAS_APP_URL ?? process.env.APP_URL ?? "http://localhost:3000";

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
  const email = `sheet-extras-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Sheet Extras ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

const row = async (id) => (await admin.from("characters").select().eq("id", id).single()).data;
async function until(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  return null;
}

await ensureDevServer();
const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const campaignId = crypto.randomUUID();
const characterId = crypto.randomUUID();

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Sheet extras test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);
  await admin.from("characters").insert({
    id: characterId, campaign_id: campaignId, owner_id: player.id, name: "Brakka", race: "Human", class: "Barbarian",
    level: 3, strength: 16, dexterity: 12, constitution: 14, intelligence: 8, wisdom: 10, charisma: 10,
    current_hp: 10, max_hp: 32, armor_class: 13, speed: 30, proficiencies: [], inventory: [], spells: [],
  });
  const sheetUrl = `${APP_URL}/campaigns/${campaignId}/characters/${characterId}`;

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  const playerContext = await browser.newContext();
  await playerContext.addCookies(sessionCookies(player.session));
  const page = await playerContext.newPage();

  await page.goto(sheetUrl);
  await page.waitForSelector('[data-testid="sheet-temp-hp"]', { timeout: 30000 });
  check("the player sees no Award inspiration control", (await page.locator('[data-testid="sheet-award-inspiration"]').count()) === 0);

  // Temp HP
  await page.fill('[data-testid="sheet-temp-hp"]', "6");
  await page.locator('[data-testid="sheet-temp-hp"]').blur();
  check("setting temp HP on the sheet saves it", (await until(async () => (await row(characterId)).temp_hp === 6)) !== null);

  // Hit dice: level 3 Barbarian → 3 × d12, rolled + CON (+2).
  const hitDiceText = (await page.textContent('[data-testid="sheet-hit-dice"]')) ?? "";
  check("the sheet shows 3 / 3 hit dice (d12)", hitDiceText.includes("d12") && hitDiceText.includes("3 / 3"), hitDiceText);
  await page.click('[data-testid="sheet-spend-hit-die"]');
  const afterDie = await until(async () => {
    const r = await row(characterId);
    return r.hit_dice_spent === 1 ? r : null;
  });
  check("spending a hit die heals 3–14 HP (1d12+2) and uses one die",
    afterDie !== null && afterDie.current_hp >= 13 && afterDie.current_hp <= 24, afterDie && afterDie.current_hp);
  check("the hit dice count drops to 2 / 3",
    (await until(async () => ((await page.textContent('[data-testid="sheet-hit-dice"]')) ?? "").includes("2 / 3"))) !== null);

  // Inspiration: DM awards from their view of the sheet; player spends it.
  await dmPage.goto(sheetUrl);
  await dmPage.waitForSelector('[data-testid="sheet-award-inspiration"]', { timeout: 30000 });
  await dmPage.click('[data-testid="sheet-award-inspiration"]');
  check("the DM can award inspiration from the sheet", (await until(async () => (await row(characterId)).inspiration)) !== null);

  await page.reload();
  await page.waitForSelector('[data-testid="sheet-use-inspiration"]', { timeout: 30000 });
  await page.click('[data-testid="sheet-use-inspiration"]');
  const spent = await until(async () => {
    const r = await row(characterId);
    return !r.inspiration && r.pending_roll_mode === "advantage" ? r : null;
  });
  check("the player spends inspiration for advantage on their next roll", spent !== null);
  check("the sheet says the next roll has advantage",
    (await until(async () => ((await page.textContent('[data-testid="sheet-inspiration"]')) ?? "").includes("advantage"))) !== null);
} finally {
  await browser.close();
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
  if (devServer) process.kill(-devServer.pid);
}

console.log(failures === 0 ? "\nAll sheet temp HP / hit dice / inspiration checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
