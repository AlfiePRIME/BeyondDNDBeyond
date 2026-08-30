#!/usr/bin/env node
// Four small, related fixes from one project-owner request:
//   1. A player can open their OWN character's sheet from the Game Room's
//      Tokens panel even before that character has been placed on the live
//      map (TokenPanel.tsx's "placeable" section previously had only a
//      "Place on table" button, no "View sheet" link — the link already
//      existed for a PLACED token's own row, just not this one).
//   2. The account page's "Character library" list gets a rename form for
//      each owned character (updateCharacter's existing generic patch
//      already permits `name`, no new RLS).
//   3. ...and a two-step-confirm delete button (the existing deleteCharacter
//      function, RLS already permits owner-or-DM — previously only ever
//      called from the DM's own "remove a member" flow).
//   4. The DM's party dashboard (/campaigns/:id/party) no longer plays
//      lobby_music (GlobalMusic.tsx's shouldPlayLobbyMusic gained a new
//      PARTY_DASHBOARD_PATTERN exclusion, the same shape as the existing
//      Game Room/map-editor exclusions).
//
// Needs the real dev server (starts `yarn dev` itself, polling /api/health,
// if the target port isn't already serving) and the real shared Supabase
// instance this project's .env points at. Ephemeral test users/campaign/
// characters are created here and torn down in `finally`.
// Usage: node scripts/db/verify-character-self-service.mjs
//        APP_URL=http://localhost:6480 node scripts/db/verify-character-self-service.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 6480;
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;

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
  console.log(`dev server not running on :${PORT} — starting yarn dev -p ${PORT}…`);
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
  const email = `self-service-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `SelfService ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function readTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}

function lobbyMusicActive(activeLoops) {
  const entry = activeLoops?.lobby_music;
  return !!entry && entry.state === "active" && entry.gainValue > 0.9;
}

async function waitForSoundDebug(page, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readTestId(page, "sound-manager-debug");
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  return last;
}

const PANEL_IDS = ["combat", "opportunityAttack", "quickActions", "diceLog", "handout", "hp", "liveObjects", "chatLog", "map"];
async function dockAllPanels(page) {
  for (const panelId of PANEL_IDS) {
    await page.click(`[data-testid="close-toggle-${panelId}"]`, { timeout: 1000 }).catch(() => undefined);
  }
  await sleep(300);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Self Service test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const keepCharacterId = crypto.randomUUID();
  const spareCharacterId = crypto.randomUUID();
  const baseCharacter = {
    campaign_id: campaignId,
    owner_id: alice.id,
    race: "Human",
    class: "Ranger",
    level: 3,
    strength: 12,
    dexterity: 14,
    constitution: 13,
    intelligence: 10,
    wisdom: 16,
    charisma: 8,
    current_hp: 26,
    max_hp: 26,
    armor_class: 14,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  };
  // Deliberately never placed on any map — Test 1's whole point.
  await admin.from("characters").insert({ id: keepCharacterId, name: "Original Name", ...baseCharacter });
  await admin
    .from("characters")
    .insert({ id: spareCharacterId, name: "Spare To Delete", ...baseCharacter, level: 1 });

  const GRID = 5;
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: mapId, campaign_id: campaignId, name: "Empty Room", grid_width: GRID, grid_height: GRID });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();

  // ── Test 1: "View sheet" for an UNPLACED character, from the Game Room. ──
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="token-panel"]', { state: "attached", timeout: 60000 });
  await sleep(1500);
  await dockAllPanels(alicePage);

  const viewSheetLink = alicePage.locator(`[data-testid="view-sheet-placeable-${keepCharacterId}"]`);
  check("the player's unplaced character shows a View sheet link in the Tokens panel", await viewSheetLink.count() === 1);
  const href = await viewSheetLink.getAttribute("href").catch(() => null);
  check(
    "that link points at the character's real sheet route",
    href === `/campaigns/${campaignId}/characters/${keepCharacterId}`,
    `href: ${href}`
  );
  await viewSheetLink.click();
  await alicePage.waitForSelector('[data-testid="sheet-xp"]', { state: "attached", timeout: 30000 });
  check(
    "clicking it actually navigates to the sheet (the Vitals panel renders)",
    alicePage.url().endsWith(`/campaigns/${campaignId}/characters/${keepCharacterId}`)
  );

  // ── Test 2: rename from the account page. ──
  await alicePage.goto(`${APP_URL}/account`);
  await alicePage.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });

  const keepRow = alicePage.locator("li", { hasText: "Original Name" });
  check("the account page lists the character under its original name", await keepRow.count() >= 1);
  await keepRow.locator('input[name="name"]').fill("Renamed By Player");
  await keepRow.getByRole("button", { name: "Rename" }).click();
  await alicePage.waitForSelector("li:has-text('Renamed By Player')", { timeout: 15000 });
  const { data: renamedRow } = await admin.from("characters").select("name").eq("id", keepCharacterId).maybeSingle();
  check(
    "the rename persisted to the database",
    renamedRow?.name === "Renamed By Player",
    JSON.stringify(renamedRow)
  );

  // ── Test 3: delete (two-step confirm) from the account page. ──
  const spareRow = alicePage.locator("li", { hasText: "Spare To Delete" });
  check("the spare character is listed before deletion", await spareRow.count() === 1);
  await spareRow.getByRole("button", { name: "Delete character" }).click();
  check(
    "a single click alone has NOT deleted it — a confirm row appears instead",
    await spareRow.getByRole("button", { name: "Confirm delete" }).count() === 1
  );
  const { data: stillThere } = await admin.from("characters").select("id").eq("id", spareCharacterId).maybeSingle();
  check("...and the database row is still there after just one click", stillThere !== null);
  await spareRow.getByRole("button", { name: "Confirm delete" }).click();
  await alicePage.waitForSelector("li:has-text('Spare To Delete')", { state: "detached", timeout: 15000 });
  const { data: deletedRow } = await admin.from("characters").select("id").eq("id", spareCharacterId).maybeSingle();
  check("confirming actually deletes the character from the database", deletedRow === null);
  const { data: keptRow } = await admin.from("characters").select("id, name").eq("id", keepCharacterId).maybeSingle();
  check(
    "the OTHER character (the renamed one) is completely untouched by deleting the spare",
    keptRow?.name === "Renamed By Player",
    JSON.stringify(keptRow)
  );

  // ── Test 4: the DM's party dashboard doesn't play lobby music. ──
  const dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();

  // Baseline/control: an ordinary page (the campaign detail page) DOES
  // play lobby music — proves the assertion below is a real distinction,
  // not lobby_music being broken everywhere.
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}`);
  await dmPage.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });
  const onCampaignPage = await waitForSoundDebug(dmPage, (d) => lobbyMusicActive(d.activeLoops));
  check(
    "control: an ordinary page (the campaign detail page) DOES play lobby_music",
    lobbyMusicActive(onCampaignPage?.activeLoops),
    JSON.stringify(onCampaignPage?.activeLoops)
  );

  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/party`);
  await dmPage.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });
  const onPartyPage = await waitForSoundDebug(dmPage, (d) => !lobbyMusicActive(d.activeLoops), 8000);
  check(
    "the party dashboard does NOT play lobby_music",
    !lobbyMusicActive(onPartyPage?.activeLoops),
    JSON.stringify(onPartyPage?.activeLoops)
  );

  await dmContext.close();
  await aliceContext.close();
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

console.log(`\n${failures} failure(s).`);
if (failures > 0) {
  console.error("Character self-service verification FAILED.");
  process.exit(1);
}
console.log("All character self-service checks passed.");
process.exit(0);
