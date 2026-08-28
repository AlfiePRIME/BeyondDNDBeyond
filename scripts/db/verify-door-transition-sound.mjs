#!/usr/bin/env node
// Sound Effects SP4 verification: the door_transition sound key (src/audio's
// SOUND_KEYS.DOOR_TRANSITION) actually plays at the moment a pawn's
// cross-map transition is executed/confirmed (GameRoom.tsx's
// handleConfirmTransition) — on the confirming DM's OWN client (played
// directly, since a realtime publish never echoes to its own sender) AND
// independently on a separate connected player's client (the crossing
// token's own owner), via the new DOOR_TRANSITION_EVENT broadcast every
// connected client subscribes to.
//
// Real, simultaneously-connected Playwright browsers throughout (a DM plus
// Alice) against the real running app and the real local Supabase stack —
// the actual map-transition GESTURE (click-select Alice's own token,
// click the transition cell, the DM confirms the resulting modal) is a
// genuine mouse-driven browser interaction, found by blind-scanning the
// canvas — the verify-per-viewer-map.mjs technique, reused here almost
// verbatim (same void-everywhere-except-the-path funnel map shape, same
// selectAndMoveToken helper) since this is the exact same confirm gesture,
// just observed for its NEW sound side effect rather than its map-follows-
// per-viewer behavior. Whether a sound actually played is read from each
// client's own real sound manager state — the hidden "sound-manager-debug"
// JSON mirror (SoundControl.tsx), this project's established
// visionDebug/tableSurfaceDebug convention applied to the Web Audio graph,
// which — like a WebGL canvas — has no DOM of its own to inspect directly.
//
// Checks:
//   1. A real DM-confirmed solo transition ("just this token") moves Alice's
//      token onto the destination map (the pre-existing transition flow
//      itself, unregressed: the map loads correctly, the token lands on the
//      right destination cell, and Alice's own view follows there).
//   2. The confirming DM's OWN client logs a door_transition play-log entry
//      pointing at the real /sounds/door_transition.mp3 file.
//   3. Alice's own (separate, connected) client — the token's owner, who
//      never clicked "confirm" — ALSO logs a door_transition play-log entry,
//      proving the sound reaches every observing client, not just whoever
//      confirmed it.
//   4. Exactly one door_transition entry lands on each client for this one
//      confirm gesture (no double-fire).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its own port isn't already serving.
// Usage: node scripts/db/verify-door-transition-sound.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port — this machine runs several concurrent agent
// worktrees, each potentially squatting on common ports with their OWN
// checkout's dev server (verify-item-containers.mjs's own precedent). Never
// rely on APP_URL's usual localhost:3000 default, which risks being this
// project's live production server rather than a fresh build of THIS
// worktree's own changes.
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 48937);
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
  console.log(`dev server not running on :${APP_PORT} — starting this worktree's own…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
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
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `door-transition-sound-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Door Transition ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

/** Reads and JSON.parses a hidden debug-mirror div's text content — the
 * visionDebug/tableSurfaceDebug convention (GameRoom.tsx) this project uses
 * wherever real state has no DOM of its own to inspect. */
async function readTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}

const readSoundDebug = (page) => readTestId(page, "sound-manager-debug");
const mapViewState = (page) => readTestId(page, "map-view-state");

/** Polls `readSoundDebug` until `predicate` is true or `timeoutMs` elapses —
 * verify-sound-infra.mjs's own helper, unchanged: a broadcast round trip is
 * never instant. */
async function waitForSoundDebug(page, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readSoundDebug(page);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  return last;
}

async function tokenRow(id) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", id).single();
  if (error) throw error;
  return data;
}

/** Blind grid scan over the canvas — verify-per-viewer-map.mjs's own
 * `scanGridClick`, unchanged: no way to compute a WebGL raycast target from
 * camera math, so this discovers a working screen point empirically,
 * center-out. */
async function scanGridClick(page, done, opts = {}) {
  const { xFrom = 0.12, xTo = 0.88, yFrom = 0.24, yTo = 0.7, step = 30, settleMs = 180 } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const [offset, settle] of [
    [0, settleMs],
    [step / 2, settleMs * 1.5],
  ]) {
    const points = [];
    for (let y = box.y + box.height * yFrom + offset; y <= box.y + box.height * yTo; y += step) {
      for (let x = box.x + box.width * xFrom + offset; x <= box.x + box.width * xTo; x += step) {
        points.push({ x, y });
      }
    }
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.5;
    points.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
    for (const point of points) {
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) return point;
    }
  }
  return null;
}

/**
 * Selects `tokenId` on `page` (blind scan) then confirms a move onto
 * `(targetX, targetY)` (a second blind scan, checked against the real DB
 * row) — verify-per-viewer-map.mjs's own `selectAndMoveTokenOnce`/
 * `selectAndMoveToken`, unchanged: the map below is built as a
 * void-everywhere-except-the-one-intended-path funnel, so ANY successful
 * non-self click is guaranteed to BE the intended target.
 */
async function selectAndMoveTokenOnce(page, tokenId, targetX, targetY) {
  const selectPoint = await scanGridClick(
    page,
    async () => (await readTestId(page, "token-selection-state")).selectedTokenId === tokenId
  );
  if (!selectPoint) return false;
  const movePoint = await scanGridClick(page, async () => {
    const row = await tokenRow(tokenId);
    return row.x === targetX && row.y === targetY;
  });
  return movePoint !== null;
}

async function selectAndMoveToken(page, tokenId, targetX, targetY, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    if (await selectAndMoveTokenOnce(page, tokenId, targetX, targetY)) return true;
    await sleep(500);
  }
  return false;
}

const VIEWPORT = { width: 1440, height: 900 };

// verify-sound-infra.mjs's own workaround: a real Web Audio graph can go
// idle on a backgrounded/occluded page even while `.state` still reports
// "running" — needed here too, since this script keeps two browser contexts
// open at once and only one is ever the OS-focused window.
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
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Door transition sound test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice Doorwalker",
    race: "Human",
    class: "Rogue",
    level: 3,
    strength: 10,
    dexterity: 16,
    constitution: 12,
    intelligence: 12,
    wisdom: 10,
    charisma: 10,
    current_hp: 24,
    max_hp: 24,
    armor_class: 14,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  // Map A ("Threshold"): a void-everywhere-except-the-path 3x3 funnel —
  // (1,1) is Alice's start, (2,1) is the transition's own origin cell, every
  // other cell is void — verify-per-viewer-map.mjs's own map shape, so a
  // blind click that isn't Alice's own token can only ever land on the ONE
  // cell that matters.
  const mapAId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: mapAId, campaign_id: campaignId, name: "Threshold", grid_width: 3, grid_height: 3 });
  const voidCellsExcept = (mapId, keep) => {
    const rows = [];
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        if (keep.some(([kx, ky]) => kx === x && ky === y)) continue;
        rows.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "void" });
      }
    }
    return rows;
  };
  await admin.from("map_cells").insert(voidCellsExcept(mapAId, [[1, 1], [2, 1]]));

  // Map B ("Beyond the Door"): the transition's destination — no clicking
  // ever happens here, so its geometry doesn't matter.
  const mapBId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: mapBId, campaign_id: campaignId, name: "Beyond the Door", grid_width: 3, grid_height: 3 });

  const aliceTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: aliceTokenId,
    map_id: mapAId,
    character_id: aliceCharacterId,
    x: 1,
    y: 1,
    elevation: 0,
    allegiance: "party",
  });

  await admin.from("map_transitions").insert([
    { from_map_id: mapAId, from_x: 2, from_y: 1, to_map_id: mapBId, to_x: 1, to_y: 1 },
  ]);

  await admin.from("campaigns").update({ live_map: mapAId }).eq("id", campaignId);

  const dmContext = await browser.newContext({ viewport: VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  const dmPageErrors = [];
  dmRoom.on("pageerror", (err) => dmPageErrors.push(String(err)));

  const aliceContext = await browser.newContext({ viewport: VIEWPORT });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const aliceRoom = await aliceContext.newPage();
  const alicePageErrors = [];
  aliceRoom.on("pageerror", (err) => alicePageErrors.push(String(err)));

  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="map-view-state"]', { state: "attached", timeout: 60000 });
    await page.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 30000 });
    await page.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });
  }
  await Promise.all([loadRoom(dmRoom), loadRoom(aliceRoom)]);
  // Let both rooms' campaign-channel subscriptions establish before the
  // first broadcast fires (the verify-opportunity-attacks.mjs join-race
  // lesson) AND let the 3D scene itself settle before the first blind canvas
  // scan below.
  await sleep(3500);

  // ── Baseline: neither client has played anything yet. ──
  const dmBaselineSound = await readSoundDebug(dmRoom);
  const aliceBaselineSound = await readSoundDebug(aliceRoom);
  check(
    "neither client has a door_transition play-log entry before the transition happens",
    !dmBaselineSound?.playLog.some((entry) => entry.key === "door_transition") &&
      !aliceBaselineSound?.playLog.some((entry) => entry.key === "door_transition"),
    JSON.stringify({ dm: dmBaselineSound?.playLog, alice: aliceBaselineSound?.playLog })
  );

  // ── Alice click-selects and moves her own token onto the transition cell —
  //    a real move, exactly like a player would make it. ──
  const moved = await selectAndMoveToken(aliceRoom, aliceTokenId, 2, 1);
  check("Alice can click-select and move her own token onto the transition cell", moved);

  // ── The DM's client sees the resulting transition offer and confirms
  //    "just this token" — the exact moment the transition is
  //    executed/confirmed (handleConfirmTransition). ──
  await dmRoom.waitForSelector('[data-testid="transition-offer-modal"]', { timeout: 15000 });
  check("the DM's client shows a transition offer after Alice's real move", true);
  await dmRoom.click('[data-testid="transition-move-token"]');

  // ── Regression check: the transition flow itself still works — the token
  //    really lands on the destination map's entry cell. ──
  const finalAliceToken = await (async () => {
    const deadline = Date.now() + 15000;
    let row = await tokenRow(aliceTokenId);
    while ((row.map_id !== mapBId || row.x !== 1 || row.y !== 1) && Date.now() < deadline) {
      await sleep(300);
      row = await tokenRow(aliceTokenId);
    }
    return row;
  })();
  check(
    "the confirmed transition still moves Alice's token onto the destination map's entry cell (no regression)",
    finalAliceToken.map_id === mapBId && finalAliceToken.x === 1 && finalAliceToken.y === 1,
    JSON.stringify(finalAliceToken)
  );

  const aliceViewAfter = await (async () => {
    const deadline = Date.now() + 15000;
    let view = await mapViewState(aliceRoom);
    while (view?.viewingMapId !== mapBId && Date.now() < deadline) {
      await sleep(300);
      view = await mapViewState(aliceRoom);
    }
    return view;
  })();
  check(
    "Alice's own view still follows her token to the destination map (no regression to the per-viewer transition flow)",
    aliceViewAfter?.viewingMapId === mapBId,
    JSON.stringify(aliceViewAfter)
  );

  // ── The actual ask: door_transition plays on the CONFIRMING DM's own
  //    client — played directly in handleConfirmTransition, since a
  //    realtime publish never echoes back to its own sender. ──
  const dmAfterConfirm = await waitForSoundDebug(dmRoom, (d) => d.playLog.some((entry) => entry.key === "door_transition"));
  check(
    "the confirming DM's own client plays door_transition, recorded in its real play log",
    dmAfterConfirm?.playLog.some((entry) => entry.key === "door_transition" && entry.url === "/sounds/door_transition.mp3"),
    JSON.stringify(dmAfterConfirm?.playLog)
  );
  check(
    "door_transition fired exactly once on the DM's client for this one confirm gesture",
    dmAfterConfirm?.playLog.filter((entry) => entry.key === "door_transition").length === 1,
    JSON.stringify(dmAfterConfirm?.playLog)
  );

  // ── The core requirement: door_transition ALSO plays independently on
  //    Alice's own, separate, connected client — the crossing token's own
  //    owner, who never clicked "confirm" herself — via the
  //    DOOR_TRANSITION_EVENT broadcast every connected client subscribes to.
  const aliceAfterConfirm = await waitForSoundDebug(aliceRoom, (d) => d.playLog.some((entry) => entry.key === "door_transition"));
  check(
    "a SEPARATE connected client (Alice, the mover — not whoever confirmed) ALSO plays door_transition, via the real broadcast",
    aliceAfterConfirm?.playLog.some((entry) => entry.key === "door_transition" && entry.url === "/sounds/door_transition.mp3"),
    JSON.stringify(aliceAfterConfirm?.playLog)
  );
  check(
    "door_transition fired exactly once on Alice's client for this one confirm gesture",
    aliceAfterConfirm?.playLog.filter((entry) => entry.key === "door_transition").length === 1,
    JSON.stringify(aliceAfterConfirm?.playLog)
  );

  check("no uncaught page errors occurred on the DM's client", dmPageErrors.length === 0, dmPageErrors.join("\n"));
  check("no uncaught page errors occurred on Alice's client", alicePageErrors.length === 0, alicePageErrors.join("\n"));
} finally {
  await browser.close();
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
