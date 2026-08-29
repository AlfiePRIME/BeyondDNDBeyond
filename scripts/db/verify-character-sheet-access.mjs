#!/usr/bin/env node
// Character-sheet-from-the-Game-Room verification: the Vitals panel's new
// real "Level up" action, and TokenPanel's new "View sheet" link.
//
// Drives a real browser (the verify-character-edit.mjs arrangement) against
// a seeded campaign and checks: a real click on a PC token's "View sheet"
// link in the Game Room's TokenPanel navigates to that character's sheet
// URL; the link is present for the DM and the owner but absent for a
// co-player who can't read that character (RLS-filtered characters list)
// and absent for an NPC token (no Character behind it at all); clicking
// "Level up" on the sheet increases level by exactly 1 and both current_hp
// and max_hp by the SRD average-hit-die-plus-Constitution-modifier amount
// for the character's class, landing in ONE PATCH; character_resources rows
// and the spells array are byte-identical/unchanged before and after (a
// real diff, not just "we didn't call that code"); the action is disabled
// at the SRD max level (20); and it's disabled for a character whose class
// isn't in the SRD catalog (homebrew/unrecognized — no known hit die).
//
// Port 3000 on this host is the production standalone server (never to be
// touched by this script) and other ports may be in use by sibling
// worktree agents' own dev servers, so this script always starts its own
// `yarn dev` on a freshly-picked free port rather than assuming :3000.
//
// Needs network access to the shared Supabase instance in .env.
// Usage: node scripts/db/verify-character-sheet-access.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

async function pickFreePort() {
  // Deliberately not 3000 (the host's production standalone server, per
  // this task's own "do not touch" rule) and picked from an uncommon range
  // to keep collisions with sibling worktree agents' own dev servers
  // unlikely.
  const candidates = [4127, 4231, 4339, 4447, 4559, 4661, 4773];
  for (const port of candidates) {
    if (await isPortFree(port)) return port;
  }
  throw new Error("no free port found among candidates");
}

async function healthOk(url) {
  return fetch(`${url}/api/health`).then((res) => res.ok).catch(() => false);
}

// Always starts a fresh dev server on the freshly-picked port (never reuses
// :3000, which is production) and always kills it on the way out.
let devServer = null;
async function ensureDevServer(url, port) {
  console.log(`starting yarn dev on port ${port}…`);
  devServer = spawn("yarn", ["dev"], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk(url)) return;
  }
  throw new Error(`dev server did not become healthy on port ${port} within 120s`);
}

const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;

function sessionCookies(session, url) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value, url }];
  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url,
    });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `sheet-access-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Sheet Access ${label}` });
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

const port = await pickFreePort();
const APP_URL = `http://localhost:${port}`;
await ensureDevServer(APP_URL, port);

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Sheet access test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const GRID = 4;
  const mapId = crypto.randomUUID();
  await admin
    .from("campaign_maps")
    .insert({ id: mapId, campaign_id: campaignId, name: "Sheet access arena", grid_width: GRID, grid_height: GRID });
  const cells = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) cells.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright" });
  }
  await admin.from("map_cells").insert(cells);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // A Cleric (d8 hit die), CON 14 (+2 modifier) — the exact combination the
  // task calls out to verify the math against: average HP gain per level =
  // floor(8 / 2) + 1 + 2 = 7.
  const charId = crypto.randomUUID();
  const originalSpells = [
    { name: "Sacred Flame", level: 0 },
    { name: "Cure Wounds", level: 1 },
  ];
  await admin.from("characters").insert({
    id: charId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Level Up Target",
    race: "Human",
    class: "Cleric",
    level: 3,
    strength: 10,
    dexterity: 12,
    constitution: 14,
    intelligence: 10,
    wisdom: 16,
    charisma: 12,
    current_hp: 24,
    max_hp: 24,
    armor_class: 14,
    speed: 30,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: originalSpells,
  });
  const { data: seededResource } = await admin
    .from("character_resources")
    .insert({
      character_id: charId,
      name: "Channel Divinity",
      max_uses: 1,
      current_uses: 1,
      recharge: "short_rest",
    })
    .select()
    .single();

  // A second character with a class outside the SRD catalog (the exact
  // import-flow shape for an unrecognized class) — no known hit die, so
  // Level up must be disabled rather than guessing.
  const homebrewCharId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: homebrewCharId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Homebrew Character",
    race: "Human",
    class: "Warlord", // not in CLASSES
    level: 5,
    strength: 12,
    dexterity: 12,
    constitution: 12,
    intelligence: 12,
    wisdom: 12,
    charisma: 12,
    current_hp: 30,
    max_hp: 30,
    armor_class: 14,
    speed: 30,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const pcTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: pcTokenId,
    map_id: mapId,
    character_id: charId,
    x: 1,
    y: 1,
    elevation: 0,
    allegiance: "party",
  });
  const npcTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: npcTokenId,
    map_id: mapId,
    npc_name: "Goblin Scout",
    x: 2,
    y: 2,
    elevation: 0,
    allegiance: "hostile",
  });

  const sheetUrl = (characterId) => `${APP_URL}/campaigns/${campaignId}/characters/${characterId}`;
  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  async function openRoom(user) {
    const context = await browser.newContext();
    await context.addCookies(sessionCookies(user.session, APP_URL));
    const page = await context.newPage();
    await page.goto(roomUrl);
    await page.waitForSelector('[data-testid="token-panel"]', { timeout: 60000 });
    await page.waitForSelector(`[data-testid="token-${pcTokenId}"]`, { timeout: 30000 });
    return { context, page };
  }

  // -- 1. The DM's TokenPanel row for the PC token has a real "View sheet"
  //    link, and clicking it really navigates to that character's sheet. --
  const { page: dmRoom } = await openRoom(dm);
  const dmSheetLink = dmRoom.locator(`[data-testid="view-sheet-${pcTokenId}"]`);
  check("the DM's TokenPanel row shows a View sheet link for the PC token", (await dmSheetLink.count()) === 1);
  await dmSheetLink.click();
  await dmRoom.waitForURL(sheetUrl(charId), { timeout: 15000 });
  check(
    "clicking View sheet navigates to the character's sheet URL",
    dmRoom.url() === sheetUrl(charId),
    dmRoom.url()
  );
  check(
    "the NPC token's row has no View sheet link (no Character behind it)",
    (await dmRoom.locator(`[data-testid="view-sheet-${npcTokenId}"]`).count()) === 0
  );

  // -- 2. The owner also sees the link; a co-player who can't read this
  //    character (RLS-filtered characters list) sees the token row but no
  //    link at all. --
  const { page: aliceRoom } = await openRoom(alice);
  check(
    "the owner's TokenPanel row also shows a View sheet link",
    (await aliceRoom.locator(`[data-testid="view-sheet-${pcTokenId}"]`).count()) === 1
  );
  const { page: bobRoom } = await openRoom(bob);
  check(
    "a co-player who doesn't own the character and isn't the DM sees the token row but no View sheet link",
    (await bobRoom.locator(`[data-testid="token-${pcTokenId}"]`).count()) === 1 &&
      (await bobRoom.locator(`[data-testid="view-sheet-${pcTokenId}"]`).count()) === 0
  );

  // -- 3. Level up: level +1, HP +7 (average d8 gain + CON 14's +2
  //    modifier) to BOTH current_hp and max_hp, in one PATCH; resources and
  //    spells are untouched (byte-for-byte). --
  const { data: resourcesBefore } = await admin
    .from("character_resources")
    .select()
    .eq("character_id", charId)
    .order("id");

  const sheet = dmRoom; // reuse the DM's page/context — DM can edit too
  await sheet.goto(sheetUrl(charId));
  await sheet.waitForSelector('[data-testid="sheet-level-up-button"]', { timeout: 30000 });

  let characterPatches = 0;
  const countPatch = (request) => {
    if (request.method() === "PATCH" && request.url().includes("/rest/v1/characters")) characterPatches++;
  };
  sheet.on("request", countPatch);
  await sheet.click('[data-testid="sheet-level-up-button"]');
  const afterLevelUp = await waitForCharacter(charId, (c) => c.level === 4);
  sheet.off("request", countPatch);

  check("Level up increases level by exactly 1 (3 → 4)", afterLevelUp?.level === 4, String(afterLevelUp?.level));
  check(
    "Level up increases current_hp by the average d8-plus-CON-14-modifier gain (24 → 31)",
    afterLevelUp?.current_hp === 31,
    String(afterLevelUp?.current_hp)
  );
  check(
    "Level up increases max_hp by the same amount (24 → 31)",
    afterLevelUp?.max_hp === 31,
    String(afterLevelUp?.max_hp)
  );
  check(
    "level and both HP fields landed in a SINGLE updateCharacter PATCH",
    characterPatches === 1,
    `${characterPatches} PATCH request(s)`
  );

  const notice = (await sheet.textContent('[data-testid="sheet-levelup-notice"]').catch(() => "")) ?? "";
  check(
    "the sheet shows a confirmation of the level and HP gain",
    notice.includes("4") && notice.includes("+7") && notice.includes("31"),
    notice
  );

  const { data: resourcesAfter } = await admin
    .from("character_resources")
    .select()
    .eq("character_id", charId)
    .order("id");
  check(
    "Level up leaves every character_resources row byte-identical",
    JSON.stringify(resourcesBefore) === JSON.stringify(resourcesAfter) &&
      resourcesAfter.some((r) => JSON.stringify(r) === JSON.stringify(seededResource)),
    JSON.stringify({ before: resourcesBefore, after: resourcesAfter })
  );
  check(
    "Level up leaves the character's spells array completely unchanged",
    JSON.stringify(afterLevelUp?.spells) === JSON.stringify(originalSpells),
    JSON.stringify(afterLevelUp?.spells)
  );

  // -- 4. Level up is disabled at the SRD max level (20). --
  await admin.from("characters").update({ level: 20 }).eq("id", charId);
  await sheet.goto(sheetUrl(charId));
  await sheet.waitForSelector('[data-testid="sheet-level-up-button"]', { timeout: 30000 });
  const capButton = sheet.locator('[data-testid="sheet-level-up-button"]');
  check("Level up is disabled once a character is already at level 20", await capButton.isDisabled());
  const capTitle = (await capButton.getAttribute("title")) ?? "";
  check("the disabled max-level button explains why via its title", capTitle.toLowerCase().includes("20"), capTitle);
  const { data: afterCapAttempt } = await admin.from("characters").select("level").eq("id", charId).single();
  check("a level-20 character's level did not change", afterCapAttempt?.level === 20);

  // -- 5. Level up is disabled for a class outside the SRD catalog (no
  //    known hit die to compute an average HP gain from). --
  await sheet.goto(sheetUrl(homebrewCharId));
  await sheet.waitForSelector('[data-testid="sheet-level-up-button"]', { timeout: 30000 });
  const homebrewButton = sheet.locator('[data-testid="sheet-level-up-button"]');
  check("Level up is disabled for a character with an unrecognized/homebrew class", await homebrewButton.isDisabled());
  const homebrewTitle = ((await homebrewButton.getAttribute("title")) ?? "").toLowerCase();
  check(
    "the disabled unrecognized-class button explains why via its title",
    homebrewTitle.includes("class"),
    homebrewTitle
  );
  const { data: homebrewAfter } = await admin
    .from("characters")
    .select("level, current_hp, max_hp")
    .eq("id", homebrewCharId)
    .single();
  check(
    "a homebrew-class character's level and HP are unaffected",
    homebrewAfter?.level === 5 && homebrewAfter?.current_hp === 30 && homebrewAfter?.max_hp === 30
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
console.log("\nAll character-sheet-access checks passed.");
process.exit(0);
