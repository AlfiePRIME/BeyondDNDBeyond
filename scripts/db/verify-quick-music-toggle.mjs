#!/usr/bin/env node
// Quick Music Toggle verification: the DM currently had no discoverable way
// to find the ambient/combat music switches — they exist, but only inside
// the 3D DM book's Day/Night tab (DmBook.tsx's calm-music-toggle/
// combat-music-toggle, three clicks deep: open the book, switch tabs, then
// the buttons). This adds a SECOND, always-visible access point —
// SoundControl.tsx's quick-calm-music-toggle/quick-combat-music-toggle,
// small icon buttons in the top bar next to the existing mute toggle — wired
// to the EXACT SAME GameRoom state/handlers the book's own toggles already
// use (not a second source of truth). DM-only: a player never sees these.
//
// Shape follows this project's own verify-game-music.mjs precedent, trimmed
// down: no live map/token/combat setup is needed here since this script
// isn't re-proving the calm<->combat music SWITCHING logic (that's already
// covered by verify-game-music.mjs) — only that these two new buttons are
// (a) visible in the top bar without ever opening the book, (b) DM-only,
// and (c) genuinely flip campaigns.calm_music_enabled/combat_music_enabled
// in the database and are reflected live, both in the clicking DM's own
// sound-manager-debug activeLoops mirror AND on a second, already-connected
// player's client who never touched anything.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, non-default port if it isn't already serving.
// Usage: node scripts/db/verify-quick-music-toggle.mjs
//        QUICK_MUSIC_APP_PORT=4275 node scripts/db/verify-quick-music-toggle.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.QUICK_MUSIC_APP_PORT ?? 4275);
const APP_URL = `http://localhost:${APP_PORT}`;

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
  console.log(`dev server not running on :${APP_PORT} — starting yarn dev -p ${APP_PORT}…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${APP_PORT} within 120s`);
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
  const email = `quick-music-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Quick Music ${label}` });
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

const gameMusicState = (page) => readTestId(page, "game-music-state");
const soundDebug = (page) => readTestId(page, "sound-manager-debug");

async function waitForSoundDebug(page, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await soundDebug(page);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  return last;
}

async function waitForGameMusicState(page, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await gameMusicState(page);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  return last;
}

/** No combat active anywhere in this script — so "calm music enabled"
 * should mean the calm_music loop is genuinely active (state "active",
 * past its own crossfade-in) and combat_music fully absent, while "calm
 * music disabled" should mean total silence (no fallback to combat_music,
 * which never has a reason to be active here at all) — the same bar
 * verify-game-music.mjs's own musicLoopsMatch establishes, trimmed to the
 * two states this script actually exercises. */
function calmOnlyActive(activeLoops) {
  const calmEntry = activeLoops.calm_music;
  return !!calmEntry && calmEntry.state === "active" && calmEntry.gainValue > 0.9 && activeLoops.combat_music === undefined;
}

function allMusicSilent(activeLoops) {
  return activeLoops.calm_music === undefined && activeLoops.combat_music === undefined;
}

async function readCampaignMusicSettings(campaignId) {
  const { data, error } = await admin
    .from("campaigns")
    .select("calm_music_enabled, combat_music_enabled")
    .eq("id", campaignId)
    .single();
  if (error) throw new Error(`reading campaigns row: ${error.message}`);
  return data;
}

const VIEWPORT = { width: 1440, height: 900 };
const AUDIO_THROTTLE_WORKAROUND_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

await ensureDevServer();

const dm = await makeTestUser("dm");
const bob = await makeTestUser("bob");
const browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS, ...AUDIO_THROTTLE_WORKAROUND_ARGS] });

try {
  const pageErrors = [];

  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Quick music toggle test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  const initialSettings = await readCampaignMusicSettings(campaignId);
  check(
    "campaigns row starts with both music toggles on (migration 0087's own defaults)",
    initialSettings.calm_music_enabled === true && initialSettings.combat_music_enabled === true,
    JSON.stringify(initialSettings)
  );

  // ===========================================================================
  // Part 1 — the DM's client: both quick toggles are visible in the top bar
  // WITHOUT ever opening the 3D book, and clicking them flips the real
  // campaigns row and is reflected in the DM's own live sound-manager-debug
  // mirror (no combat anywhere in this script, so calm_music is the only
  // channel ever audible — combat_music is checked via the DB + the
  // game-music-state "what SHOULD be active" mirror instead).
  // ===========================================================================
  const dmContext = await browser.newContext({ viewport: VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  dmPage.on("pageerror", (err) => pageErrors.push(`[dm] ${err.message}`));

  const bobContext = await browser.newContext({ viewport: VIEWPORT });
  await bobContext.addCookies(sessionCookies(bob.session));
  const bobPage = await bobContext.newPage();
  bobPage.on("pageerror", (err) => pageErrors.push(`[bob] ${err.message}`));

  await dmPage.goto(roomUrl);
  await dmPage.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await dmPage.waitForSelector('[data-testid="sound-control"]', { timeout: 30000 });

  await bobPage.goto(roomUrl);
  await bobPage.waitForSelector('[data-testid="sound-control"]', { timeout: 60000 });

  // Never call openDmBook here on purpose — the whole point of this prompt
  // is that these two are reachable WITHOUT the book.
  const dmCalmToggleVisible = await dmPage
    .waitForSelector('[data-testid="quick-calm-music-toggle"]', { state: "visible", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("the DM sees the quick calm-music toggle in the top bar without opening the book", dmCalmToggleVisible);

  const dmCombatToggleVisible = await dmPage
    .waitForSelector('[data-testid="quick-combat-music-toggle"]', { state: "visible", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("the DM sees the quick combat-music toggle in the top bar without opening the book", dmCombatToggleVisible);

  const dmBookNeverOpened = (await dmPage.$('[data-testid="dm-book-panel"]')) === null;
  check("the book was never opened to see either quick toggle", dmBookNeverOpened);

  const dmStartCalmLoops = await waitForSoundDebug(dmPage, (d) => calmOnlyActive(d.activeLoops));
  check(
    "before any click, calm_music is already the only active channel (both toggles on, no combat)",
    calmOnlyActive(dmStartCalmLoops?.activeLoops ?? {}),
    JSON.stringify(dmStartCalmLoops?.activeLoops)
  );

  // --- Click the quick calm-music toggle off ---
  await dmPage.click('[data-testid="quick-calm-music-toggle"]');

  const dmCalmOffMirror = await waitForGameMusicState(dmPage, (d) => d.calmMusicEnabled === false);
  check(
    "clicking the quick calm-music toggle flips game-music-state's calmMusicEnabled to false",
    dmCalmOffMirror?.calmMusicEnabled === false,
    JSON.stringify(dmCalmOffMirror)
  );

  const afterCalmOff = await readCampaignMusicSettings(campaignId);
  check(
    "clicking the quick calm-music toggle persists calm_music_enabled=false to the real campaigns row",
    afterCalmOff.calm_music_enabled === false,
    JSON.stringify(afterCalmOff)
  );

  const dmSilentLoops = await waitForSoundDebug(dmPage, (d) => allMusicSilent(d.activeLoops));
  check(
    "the DM's own sound-manager-debug activeLoops mirror goes silent (no fallback to combat_music) after disabling calm music",
    allMusicSilent(dmSilentLoops?.activeLoops ?? {}),
    JSON.stringify(dmSilentLoops?.activeLoops)
  );

  const bobSilentLoops = await waitForSoundDebug(bobPage, (d) => allMusicSilent(d.activeLoops));
  check(
    "Bob's client — a second, already-connected client who never clicked anything — ALSO goes silent live",
    allMusicSilent(bobSilentLoops?.activeLoops ?? {}),
    JSON.stringify(bobSilentLoops?.activeLoops)
  );

  // --- Click the quick calm-music toggle back on ---
  await dmPage.click('[data-testid="quick-calm-music-toggle"]');

  const dmCalmOnMirror = await waitForGameMusicState(dmPage, (d) => d.calmMusicEnabled === true);
  check(
    "clicking the quick calm-music toggle again flips game-music-state's calmMusicEnabled back to true",
    dmCalmOnMirror?.calmMusicEnabled === true,
    JSON.stringify(dmCalmOnMirror)
  );

  const afterCalmOn = await readCampaignMusicSettings(campaignId);
  check(
    "re-enabling the quick calm-music toggle persists calm_music_enabled=true back to the real campaigns row",
    afterCalmOn.calm_music_enabled === true,
    JSON.stringify(afterCalmOn)
  );

  const dmCalmBackLoops = await waitForSoundDebug(dmPage, (d) => calmOnlyActive(d.activeLoops));
  check(
    "the DM's own activeLoops mirror resumes calm_music live after re-enabling it",
    calmOnlyActive(dmCalmBackLoops?.activeLoops ?? {}),
    JSON.stringify(dmCalmBackLoops?.activeLoops)
  );

  const bobCalmBackLoops = await waitForSoundDebug(bobPage, (d) => calmOnlyActive(d.activeLoops));
  check(
    "Bob's client ALSO resumes calm_music live after the DM re-enables it",
    calmOnlyActive(bobCalmBackLoops?.activeLoops ?? {}),
    JSON.stringify(bobCalmBackLoops?.activeLoops)
  );

  // --- Click the quick combat-music toggle off/on — no combat is active in
  // this script, so this only exercises the DB write + the "what SHOULD be
  // active" game-music-state mirror (the real audible channel-switch
  // behavior is verify-game-music.mjs's job, unchanged and untouched here).
  await dmPage.click('[data-testid="quick-combat-music-toggle"]');

  const dmCombatOffMirror = await waitForGameMusicState(dmPage, (d) => d.combatMusicEnabled === false);
  check(
    "clicking the quick combat-music toggle flips game-music-state's combatMusicEnabled to false",
    dmCombatOffMirror?.combatMusicEnabled === false,
    JSON.stringify(dmCombatOffMirror)
  );

  const afterCombatOff = await readCampaignMusicSettings(campaignId);
  check(
    "clicking the quick combat-music toggle persists combat_music_enabled=false to the real campaigns row",
    afterCombatOff.combat_music_enabled === false,
    JSON.stringify(afterCombatOff)
  );

  const bobCombatOffMirror = await waitForGameMusicState(bobPage, (d) => d.combatMusicEnabled === false);
  check(
    "Bob's client ALSO sees combatMusicEnabled flip to false live (real campaigns postgres_changes sync)",
    bobCombatOffMirror?.combatMusicEnabled === false,
    JSON.stringify(bobCombatOffMirror)
  );

  // Restore both settings to their starting state so this run leaves the
  // campaign exactly as it found it — same cleanup convention as
  // verify-game-music.mjs's own final restore.
  await dmPage.click('[data-testid="quick-combat-music-toggle"]');
  await waitForGameMusicState(dmPage, (d) => d.combatMusicEnabled === true);

  const restoredSettings = await readCampaignMusicSettings(campaignId);
  check(
    "both music settings are restored to their starting (enabled) state at the end of this run",
    restoredSettings.calm_music_enabled === true && restoredSettings.combat_music_enabled === true,
    JSON.stringify(restoredSettings)
  );

  // ===========================================================================
  // Part 2 — Bob is a player, not the DM: the book's OWN toggles were never
  // exposed to players, and this second quick-access surface must not leak
  // them either.
  // ===========================================================================
  const bobHasQuickCalmToggle = (await bobPage.$('[data-testid="quick-calm-music-toggle"]')) !== null;
  check("a non-DM player does NOT see the quick calm-music toggle", !bobHasQuickCalmToggle);

  const bobHasQuickCombatToggle = (await bobPage.$('[data-testid="quick-combat-music-toggle"]')) !== null;
  check("a non-DM player does NOT see the quick combat-music toggle", !bobHasQuickCombatToggle);

  const bobHasMuteToggle = (await bobPage.$('[data-testid="sound-mute-toggle"]')) !== null;
  check(
    "sanity check: Bob's SoundControl otherwise renders normally (mute toggle present) — the two quick toggles are the only thing gated",
    bobHasMuteToggle
  );

  check("no uncaught page error occurred on any client during this run", pageErrors.length === 0, pageErrors.join("; "));

  console.log(failures === 0 ? "\nAll quick music toggle checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already exited on its own.
    }
  }
}
