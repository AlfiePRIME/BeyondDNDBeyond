#!/usr/bin/env node
// Phase 4 (Game Room ambiance/tools plan) verification: the DM's book — a
// plain 2D screen-space overlay replacing MonsterPanel/DmOverridesPanel's
// old unconditional DM-only mounts (and the Phase 2 standalone day/night
// button) with one fixed-position book the DM opens on demand, switching
// between five pages: Enemies (MonsterPanel), DM Controls
// (DmOverridesPanel), Notes (DmNotes), Lore (DmBookLorePage), Day/Night.
//
// Hybrid shape per verify-day-night-mode.mjs / verify-private-dice-rolls.mjs:
// a service-role client for setup and DB-state assertions, real signed-in
// browsers (a DM and a player, both in the same live Game Room) for the
// actual UI. Checks:
//   1. The book mounts ONLY for the DM — a player's room has no
//      [data-testid="dm-book"] at all.
//   2. The DM's book starts collapsed to just the tab; opening it reveals
//      the five-tab strip, defaulting to the Enemies page.
//   3. Every tab switches to its own page (the crossfaded pageContent's
//      data-page attribute, plus each page's own root testid).
//   4. The Enemies page's MonsterPanel mounts with NO live map at all (the
//      whole point of Phase 4's adjustment — stat blocks can be prepped
//      between maps), and its Quick add control is specifically disabled
//      while there's no live map, then enabled once one goes live.
//   5. A real create round trip through EACH embedded page reaches the
//      database: Enemies (a stat block), DM Controls (the action-economy
//      strict/freeform toggle), Notes (a note), Lore (a page — and that
//      page is then independently visible to the PLAYER on the standalone
//      /lore route, proving it's the same real narrative.ts data, not a
//      book-local mock).
//   6. The Day/Night page's Day/Night buttons actually flip
//      campaigns.day_night_mode, reaching both the DM's own client and a
//      second, idle client (the player) live via their day-night-state
//      debug mirrors — the same mirror verify-day-night-mode.mjs uses.
//   7. Closing the book collapses it back to just the tab.
//   8. DmToolPeel.tsx/.module.css and verify-dm-peel-reveal.mjs (the
//      abandoned Phase C attempt) are gone from disk, and nothing in the
//      app source still imports DmToolPeel (tsc would already catch a
//      dangling import; this re-confirms it directly).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000.
// Usage: node scripts/db/verify-dm-book.mjs
//        APP_URL=http://localhost:3120 node scripts/db/verify-dm-book.mjs

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

// The @supabase/ssr cookie format: sb-<host>-auth-token = "base64-" +
// base64url(JSON session), chunked at 3180 chars into name.0, name.1, ...
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
  const email = `dmbook-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `DmBook ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// Same debug-mirror reasoning as verify-day-night-mode.mjs — WebGL has no
// DOM to inspect, so this mirrors exactly what campaigns.day_night_mode
// currently is on this client.
async function dayNightState(page) {
  const text = await page.textContent('[data-testid="day-night-state"]');
  return JSON.parse(text);
}

async function waitForDayNight(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await dayNightState(page);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

// A locator's own auto-waiting only covers actionability (visible,
// stable, ...) — it still throws immediately if the element isn't in the
// DOM yet at all, so a plain `$()` right after a click races the
// component's own re-render. This polls instead, the same shape as
// pollRow but against the DOM.
async function waitForTestId(page, testId, timeoutMs = 10000) {
  return page
    .waitForSelector(`[data-testid="${testId}"]`, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

async function pollRow(table, filter, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    let query = admin.from(table).select();
    for (const [key, value] of Object.entries(filter)) query = query.eq(key, value);
    const { data } = await query;
    last = data ?? [];
    const match = last.find(predicate);
    if (match) return match;
    await sleep(300);
  }
  return null;
}

// ── 0. Static check: the abandoned Phase C attempt is actually gone, and
//    nothing still imports it (tsc would already fail on a dangling
//    import — this re-confirms it directly, per the spec's ask). ──
const deletedPaths = [
  join(rootDir, "src/app/campaigns/[id]/room/DmToolPeel.tsx"),
  join(rootDir, "src/app/campaigns/[id]/room/DmToolPeel.module.css"),
  join(rootDir, "scripts/db/verify-dm-peel-reveal.mjs"),
];
check(
  "DmToolPeel.tsx/.module.css and verify-dm-peel-reveal.mjs are deleted from disk",
  deletedPaths.every((path) => !existsSync(path)),
  JSON.stringify(deletedPaths.filter(existsSync))
);

function walkSourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walkSourceFiles(full, acc);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) acc.push(full);
  }
  return acc;
}
// A real IMPORT specifier only — not any textual mention. Doc comments
// (this file's own header, DmBook.tsx's/DraggablePanel.tsx's "here's what
// we replaced" history) legitimately name DmToolPeel as context; a dangling
// import naming it in a `from "..."` clause is the actual bug this guards.
const danglingImports = walkSourceFiles(join(rootDir, "src"))
  .concat(walkSourceFiles(join(rootDir, "scripts")))
  .filter((path) => /from\s+["'][^"']*DmToolPeel["']/.test(readFileSync(path, "utf8")));
check(
  "no source file still imports DmToolPeel",
  danglingImports.length === 0,
  JSON.stringify(danglingImports)
);

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch();

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "DM book test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="day-night-state"]', { state: "attached", timeout: 30000 });

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="day-night-state"]', { state: "attached", timeout: 30000 });

  // -- 1. The book mounts ONLY for the DM. --
  check(
    "the DM's room renders the book",
    (await dmPage.$('[data-testid="dm-book"]')) !== null
  );
  check(
    "a non-DM player's room has no book at all — not even a collapsed tab",
    (await alicePage.$('[data-testid="dm-book"]')) === null
  );

  // -- 2. Starts collapsed to just the tab. --
  check(
    "the book starts collapsed (just the toggle tab, no open panel)",
    (await dmPage.$('[data-testid="dm-book-toggle"]')) !== null &&
      (await dmPage.$('[data-testid="dm-book-panel"]')) === null
  );

  // -- 3. Opening it reveals all five tabs, defaulting to Enemies. --
  await dmPage.click('[data-testid="dm-book-toggle"]');
  await dmPage.waitForSelector('[data-testid="dm-book-panel"]', { timeout: 10000 });
  const tabIds = ["enemies", "dmControls", "notes", "lore", "dayNight"];
  for (const id of tabIds) {
    check(`the "${id}" tab is present`, (await dmPage.$(`[data-testid="dm-book-tab-${id}"]`)) !== null);
  }
  check(
    "opening the book defaults to the Enemies page (MonsterPanel mounted)",
    (await dmPage.getAttribute('[data-testid="dm-book-page"]', "data-page")) === "enemies" &&
      (await dmPage.$('[data-testid="monster-panel"]')) !== null
  );

  // -- 4. Enemies mounts with NO live map, and Quick add is specifically
  //    disabled until one goes live (the Phase 4 adjustment). --
  check(
    "there is no live map on this fresh campaign, yet the Enemies page still rendered",
    (await dmPage.$('[data-testid="monster-panel"]')) !== null
  );

  // -- Every tab switches to its own page. --
  await dmPage.click('[data-testid="dm-book-tab-dmControls"]');
  await sleep(300);
  check(
    "the DM Controls tab shows data-page=dmControls and mounts DmOverridesPanel",
    (await dmPage.getAttribute('[data-testid="dm-book-page"]', "data-page")) === "dmControls" &&
      (await dmPage.$('[data-testid="dm-controls-panel"]')) !== null
  );

  await dmPage.click('[data-testid="dm-book-tab-notes"]');
  await sleep(300);
  check(
    "the Notes tab shows data-page=notes and mounts DmNotes",
    (await dmPage.getAttribute('[data-testid="dm-book-page"]', "data-page")) === "notes" &&
      (await dmPage.$('[data-testid="create-dm-note-button"]')) !== null
  );

  await dmPage.click('[data-testid="dm-book-tab-lore"]');
  await sleep(300);
  check(
    "the Lore tab shows data-page=lore and mounts DmBookLorePage",
    (await dmPage.getAttribute('[data-testid="dm-book-page"]', "data-page")) === "lore" &&
      (await dmPage.$('[data-testid="dm-book-lore-list"]')) !== null
  );

  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');
  await sleep(300);
  check(
    "the Day/Night tab shows data-page=dayNight and mounts the Day/Night controls",
    (await dmPage.getAttribute('[data-testid="dm-book-page"]', "data-page")) === "dayNight" &&
      (await dmPage.$('[data-testid="day-night-day-button"]')) !== null &&
      (await dmPage.$('[data-testid="day-night-night-button"]')) !== null
  );

  await dmPage.click('[data-testid="dm-book-tab-enemies"]');
  await sleep(300);
  check(
    "switching back to Enemies shows data-page=enemies again",
    (await dmPage.getAttribute('[data-testid="dm-book-page"]', "data-page")) === "enemies"
  );

  // Quick add's disabled-without-a-live-map state, checked on the Enemies
  // page BEFORE any stat block exists — seed one directly via the DM's own
  // client (RLS-legal, and independent of the UI create flow tested next)
  // purely to have a Quick add button to inspect.
  const probeBlock = await dm.client
    .from("monster_stat_blocks")
    .insert({ campaign_id: campaignId, name: "Probe Rat", max_hp: 4, armor_class: 10, passive_perception: 10, attacks: [] })
    .select()
    .single();
  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="day-night-state"]', { state: "attached", timeout: 30000 });
  await dmPage.click('[data-testid="dm-book-toggle"]');
  await dmPage.waitForSelector('[data-testid="dm-book-panel"]', { timeout: 10000 });
  const quickAddSelector = `[data-testid="quick-add-${probeBlock.data.id}"]`;
  await dmPage.waitForSelector(quickAddSelector, { timeout: 10000 });
  const quickAddDisabledNoMap = await dmPage.$eval(quickAddSelector, (el) => el.disabled);
  check(
    "Quick add is disabled while there is no live map",
    quickAddDisabledNoMap === true
  );

  // Bring a map live and confirm Quick add becomes enabled.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: mapId, campaign_id: campaignId, name: "Test map", grid_width: 5, grid_height: 5 });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="day-night-state"]', { state: "attached", timeout: 30000 });
  await dmPage.click('[data-testid="dm-book-toggle"]');
  await dmPage.waitForSelector('[data-testid="dm-book-panel"]', { timeout: 10000 });
  await dmPage.waitForSelector(quickAddSelector, { timeout: 10000 });
  const quickAddDisabledWithMap = await dmPage.$eval(quickAddSelector, (el) => el.disabled);
  check(
    "Quick add becomes enabled once a live map exists",
    quickAddDisabledWithMap === false
  );

  // -- 5a. Enemies: a real create round trip. --
  await dmPage.fill('[data-testid="stat-block-name-input"]', "Cave Bear");
  await dmPage.fill('[data-testid="stat-block-hp-input"]', "42");
  await dmPage.fill('[data-testid="stat-block-ac-input"]', "13");
  await dmPage.fill('[data-testid="stat-block-pp-input"]', "12");
  await dmPage.click('[data-testid="stat-block-save"]');
  const caveBear = await pollRow(
    "monster_stat_blocks",
    { campaign_id: campaignId },
    (row) => row.name === "Cave Bear" && row.max_hp === 42
  );
  check("creating a stat block through the book's Enemies page reaches the database", caveBear !== null, JSON.stringify(caveBear));
  check(
    "the newly created stat block renders in the book",
    caveBear !== null && (await waitForTestId(dmPage, `stat-block-${caveBear.id}`))
  );

  // -- 5b. DM Controls: a real toggle round trip. --
  await dmPage.click('[data-testid="dm-book-tab-dmControls"]');
  await dmPage.waitForSelector('[data-testid="dm-controls-panel"]', { timeout: 10000 });
  const { data: beforeStrict } = await admin.from("campaigns").select("action_economy_strict").eq("id", campaignId).single();
  const targetTestId = beforeStrict.action_economy_strict ? "economy-freeform-button" : "economy-strict-button";
  await dmPage.click(`[data-testid="${targetTestId}"]`);
  await sleep(500);
  const { data: afterStrict } = await admin.from("campaigns").select("action_economy_strict").eq("id", campaignId).single();
  check(
    "toggling Strict/Freeform through the book's DM Controls page reaches the database",
    afterStrict.action_economy_strict !== beforeStrict.action_economy_strict,
    JSON.stringify({ before: beforeStrict, after: afterStrict })
  );

  // -- 5c. Notes: a real create round trip. --
  await dmPage.click('[data-testid="dm-book-tab-notes"]');
  await dmPage.waitForSelector('[data-testid="create-dm-note-button"]', { timeout: 10000 });
  await dmPage.click('[data-testid="create-dm-note-button"]');
  await dmPage.fill('[data-testid="dm-note-body-input"]', "The tavern keeper is secretly a doppelganger.");
  await dmPage.click('[data-testid="save-dm-note-button"]');
  const doppelgangerNote = await pollRow(
    "dm_notes",
    { campaign_id: campaignId },
    (row) => (row.body ?? "").includes("doppelganger")
  );
  check("creating a note through the book's Notes page reaches the database", doppelgangerNote !== null, JSON.stringify(doppelgangerNote));
  check(
    "the new note renders in the book's Notes page",
    doppelgangerNote !== null && (await waitForTestId(dmPage, `dm-note-${doppelgangerNote.id}`))
  );
  // dm_notes has no member-read RLS policy at all (0020) — the player must
  // never be able to read this row, even directly.
  const { data: aliceReadNotes } = await alice.client.from("dm_notes").select().eq("campaign_id", campaignId);
  check(
    "a non-DM member cannot read dm_notes at all, even directly (RLS)",
    (aliceReadNotes ?? []).length === 0,
    `${(aliceReadNotes ?? []).length} row(s) visible to the player`
  );

  // -- 5d. Lore: a real create round trip, then cross-checked from the
  //    PLAYER's standalone /lore route (proving it's the same real
  //    narrative.ts data, not a book-local mock). --
  await dmPage.click('[data-testid="dm-book-tab-lore"]');
  await dmPage.waitForSelector('[data-testid="dm-book-lore-list"]', { timeout: 10000 });
  await dmPage.click('[data-testid="dm-book-lore-new-button"]');
  await dmPage.waitForSelector('[data-testid="dm-book-lore-form"]', { timeout: 10000 });
  await dmPage.fill('[data-testid="dm-book-lore-title-input"]', "The Sunken Bell Tower");
  await dmPage.fill('[data-testid="dm-book-lore-body-input"]', "Rings once a century, and something always answers.");
  await dmPage.click('[data-testid="dm-book-lore-save"]');
  const bellTower = await pollRow(
    "lore_pages",
    { campaign_id: campaignId },
    (row) => row.title === "The Sunken Bell Tower"
  );
  check("creating a lore page through the book's Lore page reaches the database", bellTower !== null, JSON.stringify(bellTower));
  check(
    "the book switches to viewing the newly created page",
    bellTower !== null &&
      (await dmPage.textContent('[data-testid="dm-book-lore-view-title"]').catch(() => "")) === "The Sunken Bell Tower"
  );
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/lore`);
  await alicePage.waitForSelector('[data-testid="lore-index-empty"], [data-testid^="lore-page-card-"]', { timeout: 15000 });
  check(
    "the page created via the book is visible to the PLAYER on the standalone /lore route — the same real data, not a book-local mock",
    bellTower !== null && (await alicePage.$(`[data-testid="lore-page-card-${bellTower.id}"]`)) !== null
  );

  // -- 6. Day/Night: the buttons actually flip campaigns.day_night_mode,
  //    reaching both the DM's own client and the idle player live. --
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="day-night-state"]', { state: "attached", timeout: 30000 });
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="day-night-state"]', { state: "attached", timeout: 30000 });
  check(
    "a non-DM player is never offered the Day/Night controls (no book at all)",
    (await alicePage.$('[data-testid="day-night-night-button"]')) === null
  );
  await dmPage.click('[data-testid="dm-book-toggle"]');
  await dmPage.waitForSelector('[data-testid="dm-book-panel"]', { timeout: 10000 });
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');
  await dmPage.waitForSelector('[data-testid="day-night-night-button"]', { timeout: 10000 });
  await dmPage.click('[data-testid="day-night-night-button"]');
  const dmNight = await waitForDayNight(dmPage, (state) => state.mode === "night");
  check("clicking Night in the book flips the DM's own table lighting", dmNight?.mode === "night", JSON.stringify(dmNight));
  const aliceNight = await waitForDayNight(alicePage, (state) => state.mode === "night");
  check(
    "the flip reaches a second, idle client (the player) live via its own debug mirror",
    aliceNight?.mode === "night",
    JSON.stringify(aliceNight)
  );
  await dmPage.click('[data-testid="day-night-day-button"]');
  const dmDay = await waitForDayNight(dmPage, (state) => state.mode === "day");
  const aliceDay = await waitForDayNight(alicePage, (state) => state.mode === "day");
  check(
    "clicking Day flips back for both the DM and the idle player",
    dmDay?.mode === "day" && aliceDay?.mode === "day",
    JSON.stringify({ dm: dmDay, alice: aliceDay })
  );

  // -- 7. Closing the book collapses it back to just the tab. --
  await dmPage.click('[data-testid="dm-book-close"]');
  await sleep(300);
  check(
    "closing the book collapses it back to just the tab",
    (await dmPage.$('[data-testid="dm-book-panel"]')) === null &&
      (await dmPage.$('[data-testid="dm-book-toggle"]')) !== null
  );
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll DM book checks passed.");
process.exit(0);
