#!/usr/bin/env node
// Game music verification: Lobby menu music (lobby_music) plays for the
// whole time a user is on the Lobby page and stops when they navigate away;
// the Game Room plays calm_music by default and switches to combat_music
// while combat is active (src/audio/gameMusic.ts's resolveGameMusic/
// applyGameMusic, wired into GameRoom.tsx via `combat !== null` — the same
// truth signal the room's own action-economy gating already reads).
//
// Shape follows this project's own established weather-audio verify
// precedent (verify-weather-audio.mjs): a service-role client for setup,
// two real signed-in browsers (a DM who drives the UI, and a second,
// already-connected player, Alice, who proves the music transition reaches
// every client independently — not just an echo of the clicking client's
// own local state), reading BOTH the pure "what SHOULD be active" debug
// mirror (game-music-state) and the sound manager's own REAL active-loop
// state (sound-manager-debug) so no assertion is "expected off" only in
// theory.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, non-default port if it isn't already serving.
// Usage: node scripts/db/verify-game-music.mjs
//        GAME_MUSIC_APP_PORT=4273 node scripts/db/verify-game-music.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.GAME_MUSIC_APP_PORT ?? 4273);
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
  const email = `game-music-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Game Music ${label}` });
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

/** True once `activeLoops` has EXACTLY the expected key active (state
 * "active", past its own crossfade-in) and the other key fully ABSENT (not
 * merely "stopping") — the same "no stuck/leftover channel" bar
 * verify-weather-audio.mjs's own activeLoopsMatch establishes. */
function musicLoopsMatch(activeLoops, { calm, combat }) {
  const calmEntry = activeLoops.calm_music;
  const combatEntry = activeLoops.combat_music;
  if (calm) {
    if (!calmEntry || calmEntry.state !== "active" || calmEntry.gainValue <= 0.9) return false;
  } else if (calmEntry) {
    return false;
  }
  if (combat) {
    if (!combatEntry || combatEntry.state !== "active" || combatEntry.gainValue <= 0.9) return false;
  } else if (combatEntry) {
    return false;
  }
  return true;
}

function lobbyMusicActive(activeLoops) {
  const entry = activeLoops.lobby_music;
  return !!entry && entry.state === "active" && entry.gainValue > 0.9;
}

const VIEWPORT = { width: 1440, height: 900 };
const AUDIO_THROTTLE_WORKAROUND_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS, ...AUDIO_THROTTLE_WORKAROUND_ARGS] });

try {
  const pageErrors = [];

  // ===========================================================================
  // Part 1 — Lobby menu music: active while on the Lobby page, stops once
  // navigated away.
  // ===========================================================================
  const dmLobbyContext = await browser.newContext({ viewport: VIEWPORT });
  await dmLobbyContext.addCookies(sessionCookies(dm.session));
  const dmLobbyPage = await dmLobbyContext.newPage();
  dmLobbyPage.on("pageerror", (err) => pageErrors.push(`[dm-lobby] ${err.message}`));

  await dmLobbyPage.goto(`${APP_URL}/`);
  // The Lobby page has no visible sound-control slider (no
  // PanelLayoutProvider to back one — see LobbyPresence.tsx's own doc
  // comment) — only the hidden sound-manager-debug mirror, so this waits
  // for it to be ATTACHED (present in the DOM), not the default "visible"
  // (which a `hidden` div can never satisfy).
  await dmLobbyPage.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 60000 });

  const lobbyLoops = await waitForSoundDebug(dmLobbyPage, (d) => lobbyMusicActive(d.activeLoops));
  check(
    "lobby_music becomes active while on the Lobby page",
    lobbyMusicActive(lobbyLoops?.activeLoops ?? {}),
    JSON.stringify(lobbyLoops?.activeLoops)
  );

  await dmLobbyPage.goto(`${APP_URL}/account`);
  const afterNavAway = await waitForSoundDebug(dmLobbyPage, (d) => d.activeLoops.lobby_music === undefined);
  check(
    "lobby_music fully stops (absent from activeLoops, not just fading) after navigating away from the Lobby",
    afterNavAway?.activeLoops.lobby_music === undefined,
    JSON.stringify(afterNavAway?.activeLoops)
  );

  await dmLobbyContext.close();

  // ===========================================================================
  // Part 2 — Game Room: calm_music by default, switches to combat_music
  // while combat is active, reverts to calm_music once combat ends — on
  // BOTH the DM's own client (who drives Start/End Combat) and a second,
  // already-connected player (Alice), who never clicks anything.
  // ===========================================================================
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Game music test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // start_combat's own RPC (0038_npc_stat_blocks.sql) requires a live map
  // with at least one token on it ("Set a live map before starting
  // combat" / "There are no tokens on the live map to fight") — a bare
  // campaign with no map isn't enough for the real Start Combat button to
  // succeed.
  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice PC",
    race: "Human",
    class: "Fighter",
    level: 3,
    strength: 16,
    dexterity: 12,
    constitution: 14,
    intelligence: 10,
    wisdom: 10,
    charisma: 8,
    current_hp: 30,
    max_hp: 30,
    armor_class: 15,
    speed: 30,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: [],
  });
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Game music arena",
    grid_width: 10,
    grid_height: 10,
  });
  await admin.from("map_tokens").insert({
    id: crypto.randomUUID(),
    map_id: mapId,
    character_id: aliceCharacterId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  const dmContext = await browser.newContext({ viewport: VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  dmPage.on("pageerror", (err) => pageErrors.push(`[dm] ${err.message}`));

  const aliceContext = await browser.newContext({ viewport: VIEWPORT });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  alicePage.on("pageerror", (err) => pageErrors.push(`[alice] ${err.message}`));

  await dmPage.goto(roomUrl);
  await dmPage.waitForSelector('[data-testid="sound-control"]', { timeout: 60000 });
  await dmPage.waitForSelector('[data-testid="combat-panel"]', { timeout: 30000 });

  await alicePage.goto(roomUrl);
  await alicePage.waitForSelector('[data-testid="sound-control"]', { timeout: 60000 });
  await sleep(500);

  const dmMirrorBeforeCombat = await gameMusicState(dmPage);
  check(
    "game-music-state reports combatActive:false and calm-only BEFORE any combat starts",
    dmMirrorBeforeCombat?.combatActive === false && dmMirrorBeforeCombat?.channels?.calm === true && dmMirrorBeforeCombat?.channels?.combat === false,
    JSON.stringify(dmMirrorBeforeCombat)
  );

  const dmCalmLoops = await waitForSoundDebug(dmPage, (d) => musicLoopsMatch(d.activeLoops, { calm: true, combat: false }));
  check(
    "the DM's own client plays calm_music (and NOT combat_music) by default in the Game Room",
    musicLoopsMatch(dmCalmLoops?.activeLoops ?? {}, { calm: true, combat: false }),
    JSON.stringify(dmCalmLoops?.activeLoops)
  );
  const aliceCalmLoops = await waitForSoundDebug(alicePage, (d) => musicLoopsMatch(d.activeLoops, { calm: true, combat: false }));
  check(
    "a second, already-connected client (Alice, who never clicked anything) ALSO plays calm_music by default",
    musicLoopsMatch(aliceCalmLoops?.activeLoops ?? {}, { calm: true, combat: false }),
    JSON.stringify(aliceCalmLoops?.activeLoops)
  );

  // Start combat as the DM — the real UI action (not a raw admin insert),
  // so this exercises the exact combat-changed broadcast every real DM
  // click already goes through.
  await dmPage.click('[data-testid="start-combat-button"]');
  await dmPage.waitForSelector('[data-testid="end-combat-button"]', { timeout: 15000 });

  const dmMirrorDuringCombat = await gameMusicState(dmPage);
  check(
    "game-music-state reports combatActive:true and combat-only once combat starts",
    dmMirrorDuringCombat?.combatActive === true && dmMirrorDuringCombat?.channels?.calm === false && dmMirrorDuringCombat?.channels?.combat === true,
    JSON.stringify(dmMirrorDuringCombat)
  );

  const dmCombatLoops = await waitForSoundDebug(dmPage, (d) => musicLoopsMatch(d.activeLoops, { calm: false, combat: true }));
  check(
    "the DM's own client switches to combat_music (calm_music fully stops, not just fades) once combat starts",
    musicLoopsMatch(dmCombatLoops?.activeLoops ?? {}, { calm: false, combat: true }),
    JSON.stringify(dmCombatLoops?.activeLoops)
  );
  const aliceCombatLoops = await waitForSoundDebug(alicePage, (d) => musicLoopsMatch(d.activeLoops, { calm: false, combat: true }));
  check(
    "Alice's client — who never clicked Start Combat — ALSO switches to combat_music via the real combat-changed sync",
    musicLoopsMatch(aliceCombatLoops?.activeLoops ?? {}, { calm: false, combat: true }),
    JSON.stringify(aliceCombatLoops?.activeLoops)
  );

  // End combat as the DM.
  await dmPage.click('[data-testid="end-combat-button"]');
  await dmPage.waitForSelector('[data-testid="start-combat-button"]', { timeout: 15000 });

  const dmMirrorAfterCombat = await gameMusicState(dmPage);
  check(
    "game-music-state reverts to combatActive:false and calm-only once combat ends",
    dmMirrorAfterCombat?.combatActive === false && dmMirrorAfterCombat?.channels?.calm === true && dmMirrorAfterCombat?.channels?.combat === false,
    JSON.stringify(dmMirrorAfterCombat)
  );

  const dmRevertedLoops = await waitForSoundDebug(dmPage, (d) => musicLoopsMatch(d.activeLoops, { calm: true, combat: false }));
  check(
    "the DM's own client reverts to calm_music (combat_music fully stops) once combat ends",
    musicLoopsMatch(dmRevertedLoops?.activeLoops ?? {}, { calm: true, combat: false }),
    JSON.stringify(dmRevertedLoops?.activeLoops)
  );
  const aliceRevertedLoops = await waitForSoundDebug(alicePage, (d) => musicLoopsMatch(d.activeLoops, { calm: true, combat: false }));
  check(
    "Alice's client ALSO reverts to calm_music once combat ends",
    musicLoopsMatch(aliceRevertedLoops?.activeLoops ?? {}, { calm: true, combat: false }),
    JSON.stringify(aliceRevertedLoops?.activeLoops)
  );

  check("no uncaught page error occurred on any client during this run", pageErrors.length === 0, pageErrors.join("; "));

  console.log(failures === 0 ? "\nAll game music checks passed." : `\n${failures} check(s) FAILED.`);
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
