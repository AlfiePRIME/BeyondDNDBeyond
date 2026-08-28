#!/usr/bin/env node
// Per-viewer map transitions verification — the "a map transition should
// only change the map for the player who went through it, not the whole
// party" prompt. Before this, campaigns.live_map was a single shared "the
// table's current map" value: crossing a map_transitions link (stairs,
// ladders, portals — DM-authored today) always ended in GameRoom's
// handleSwitchMap, forcing EVERY connected client (every player, and the
// DM's own screen) onto the destination map, whole party or not.
//
// Now: a player's own effective "current map" is derived from wherever
// their own character's token actually is (ownTokenMapId in GameRoom.tsx),
// independent of campaigns.live_map (which becomes just the campaign-wide
// SHARED DEFAULT a token-less member still follows). The DM's own view
// (dmSelectedMapId) is independently, locally selectable — a NEW
// handlePreviewMap action that writes nothing and broadcasts nothing.
//
// Real, simultaneously-connected Playwright browsers throughout (a DM plus
// two players, Alice and Bob) against the real running app and the real
// local Supabase stack — WebGL has no DOM to inspect, so every "which map
// is this client actually rendering" check reads GameRoom's own hidden
// [data-testid="map-view-state"]/[data-testid="live-map-name"] mirrors,
// while the actual map-transition GESTURE (click-select Alice's own token,
// click the transition cell, the DM confirms the resulting modal) is a
// genuine mouse-driven browser interaction, found by blind-scanning the
// canvas — the verify-token-click-select.mjs/verify-void-terrain.mjs
// technique — never assumed. Every map here is deliberately built as a
// "void everywhere except the one intended path" funnel so a blind click
// can never accidentally land on the wrong cell and desync the script's
// own idea of where a token is from the token's own real, current position.
//
// Checks:
//   1. Baseline (nobody has ever split up): all three clients start on the
//      same map, campaigns.live_map matches, and the RLS extension (0046)
//      doesn't yet grant either player read access to a second map neither
//      of them has a token on.
//   2. A real click-select-and-move onto a transition cell, confirmed by
//      the DM as "just this token", moves ONLY that player's own token —
//      campaigns.live_map is untouched, the moving player's OWN view
//      follows to the destination, and neither the bystander player's nor
//      the DM's OWN current view changes AT ALL (checked immediately and
//      again after a delay, ruling out a delayed leak) — the core
//      requirement.
//   3. The DM's own map-picker "live maps" indicator (livePlayerMapIds)
//      updates to reflect wherever the party's tokens now actually are.
//   4. The DM can independently preview the destination map (the NEW
//      handlePreviewMap action) without moving either player's own view,
//      and without touching the campaign's own shared default map; TokenPanel
//      (real DOM, not WebGL) shows the moved token appearing on whichever
//      map the DM is currently viewing and disappearing once they leave it.
//   5. RLS (0046): a player can read a map iff it's the shared default OR
//      their own character's token is on it — never merely because some
//      OTHER player's token is there.
//   6. Pushing the campaign's shared default map (the DM's PRE-EXISTING
//      "push to party" action) still moves a token-less bystander's view
//      live — reproducing today's exact single-shared-map behavior — but
//      does NOT override a player who has already diverged onto their own
//      token's map.
//   7. A SECOND transition crossed while a combat encounter is active
//      (Alice is the current, tracked combatant) moves only her token and
//      her own view, leaves the shared encounter's turn/round state
//      byte-for-byte identical on every client, and — the acceptance
//      criterion's own wording — does not disrupt the DM's own current
//      view either.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000.
// Usage: node scripts/db/verify-per-viewer-map.mjs
//        APP_URL=http://localhost:3120 node scripts/db/verify-per-viewer-map.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

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
  const email = `per-viewer-map-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Viewer ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

const mapViewState = (page) => readMirror(page, "map-view-state");

async function domTokenPresent(page, tokenId) {
  return page.locator(`[data-testid="token-${tokenId}"]`).count().then((n) => n > 0);
}

/** Polls a mapViewState field until `predicate` is true or `timeoutMs`
 * elapses — a broadcast/reactive-effect round trip is never instant.
 * Returns the last-read state either way, so a timed-out caller still gets
 * a useful detail string. */
async function waitForMapView(page, predicate, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = await mapViewState(page);
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await mapViewState(page);
  }
  return last;
}

/** Blind grid scan over the canvas — verify-void-terrain.mjs's own
 * `scanClick`/verify-token-click-select.mjs's `scanGridClick`, unchanged:
 * no way to compute a WebGL raycast target from camera math, so this
 * discovers a working screen point empirically, center-out. */
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

async function tokenRow(id) {
  const { data } = await admin.from("map_tokens").select().eq("id", id).single();
  return data;
}

async function campaignRow(id) {
  const { data } = await admin.from("campaigns").select().eq("id", id).single();
  return data;
}

/**
 * Selects `tokenId` on `page` (blind scan) then confirms a move onto
 * `(targetX, targetY)` (a second blind scan, checked against the real DB
 * row) — every map this is used against is built as a void-everywhere-
 * except-the-one-intended-path funnel (this file's own header comment), so
 * ANY successful non-self click is guaranteed to BE the intended target —
 * no risk of a stray click landing on some OTHER valid destination and
 * silently desyncing this function's assumptions from the token's real
 * position.
 */
async function selectAndMoveTokenOnce(page, tokenId, targetX, targetY) {
  const selectPoint = await scanGridClick(
    page,
    async () => (await readMirror(page, "token-selection-state")).selectedTokenId === tokenId
  );
  if (!selectPoint) return false;
  const movePoint = await scanGridClick(page, async () => {
    const row = await tokenRow(tokenId);
    return row.x === targetX && row.y === targetY;
  });
  return movePoint !== null;
}

/**
 * selectAndMoveTokenOnce, retried a few times — a blind scan over a live
 * WebGL scene can miss on any given pass (an in-flight camera/seat
 * settle, a GLTF model still loading, a click landing on a screen-anchored
 * panel instead of the canvas underneath it) with nothing PERSISTED by a
 * failed attempt (the map's own void-everywhere-except-the-path funnel
 * means the only two things a stray click can ever do are select/deselect
 * Alice's own token or move it to the one intended cell — never desync it
 * onto some wrong cell), so a retry is always safe and never masks a real
 * product bug: a genuine regression here would fail every attempt, not
 * just some.
 */
async function selectAndMoveToken(page, tokenId, targetX, targetY, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    if (await selectAndMoveTokenOnce(page, tokenId, targetX, targetY)) return true;
    // A miss can leave the token selected (about to retry the move-scan
    // fresh) or not — either is fine, the next attempt's own select-scan
    // handles both (clicking an already-selected token again just cancels
    // and re-selects it moments later).
    await sleep(500);
  }
  return false;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Per-viewer map test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice Wayfarer",
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
  // Bob deliberately gets NO map_token anywhere — a token-less member, who
  // (both before AND after this prompt) simply follows the campaign's own
  // shared default map live. Not placing him at all is what makes his own
  // "own view never changes" checks below a genuine test of that fallback,
  // not just a token that happens not to move.
  const bobCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: bobCharacterId,
    campaign_id: campaignId,
    owner_id: bob.id,
    name: "Bob Steadfast",
    race: "Dwarf",
    class: "Fighter",
    level: 3,
    strength: 16,
    dexterity: 10,
    constitution: 14,
    intelligence: 8,
    wisdom: 10,
    charisma: 10,
    current_hp: 28,
    max_hp: 28,
    armor_class: 16,
    speed: 25,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  // Map A ("Tavern"): a void-everywhere-except-the-path 3x3 funnel — (1,1)
  // is Alice's start, (2,1) is the transition's own origin cell, every
  // other cell is void. This guarantees a blind click that isn't Alice's
  // own token can only ever land on the ONE cell that matters.
  const mapAId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: mapAId, campaign_id: campaignId, name: "Tavern", grid_width: 3, grid_height: 3 });
  const voidCellsFor = (mapId, keep) => {
    const rows = [];
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        if (keep.some(([kx, ky]) => kx === x && ky === y)) continue;
        rows.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "void" });
      }
    }
    return rows;
  };
  await admin.from("map_cells").insert(voidCellsFor(mapAId, [[1, 1], [2, 1]]));

  // Map B ("Cellar"): the destination of transition #1, ALSO its own
  // funnel for transition #2 — (1,1) is the entry cell from A, (1,2) is
  // the second transition's own origin cell, everything else void.
  const mapBId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: mapBId, campaign_id: campaignId, name: "Cellar", grid_width: 3, grid_height: 3 });
  await admin.from("map_cells").insert(voidCellsFor(mapBId, [[1, 1], [1, 2]]));

  // Map C ("Loft"): the destination of transition #2 — no clicking ever
  // happens here, so its geometry doesn't matter; also doubles as the
  // "push the party's shared default somewhere neither player is" target
  // later on.
  const mapCId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: mapCId, campaign_id: campaignId, name: "Loft", grid_width: 3, grid_height: 3 });

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
    { from_map_id: mapBId, from_x: 1, from_y: 2, to_map_id: mapCId, to_x: 0, to_y: 0 },
  ]);

  await admin.from("campaigns").update({ live_map: mapAId }).eq("id", campaignId);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const aliceRoom = await aliceContext.newPage();
  const bobContext = await browser.newContext();
  await bobContext.addCookies(sessionCookies(bob.session));
  const bobRoom = await bobContext.newPage();

  async function loadRoomWaits(page) {
    await page.waitForSelector('[data-testid="map-view-state"]', { state: "attached", timeout: 60000 });
    await page.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 30000 });
  }
  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await loadRoomWaits(page);
  }
  await Promise.all([loadRoom(dmRoom), loadRoom(aliceRoom), loadRoom(bobRoom)]);
  // Let every room's campaign-channel subscription establish before the
  // first broadcast fires (the verify-opportunity-attacks.mjs join-race
  // lesson) AND let the 3D scene itself settle (seat camera, chair/table/
  // token GLTF models) before the first blind canvas scan below — a freshly
  // mounted Canvas can still be mid-load for a beat after its own test-id
  // mirrors have already attached.
  await sleep(3500);

  // ── 1. Baseline: nobody has ever split up. ──
  const dmBaseline = await mapViewState(dmRoom);
  const aliceBaseline = await mapViewState(aliceRoom);
  const bobBaseline = await mapViewState(bobRoom);
  check(
    "all three clients start on the same map (the shared default, untouched)",
    dmBaseline.viewingMapId === mapAId && aliceBaseline.viewingMapId === mapAId && bobBaseline.viewingMapId === mapAId,
    JSON.stringify({ dmBaseline, aliceBaseline, bobBaseline })
  );
  check(
    "campaigns.live_map matches what every client started on",
    dmBaseline.campaignDefaultMapId === mapAId &&
      aliceBaseline.campaignDefaultMapId === mapAId &&
      bobBaseline.campaignDefaultMapId === mapAId
  );
  check("Alice's own effective map is derived from her own token", aliceBaseline.ownTokenMapId === mapAId);
  check("Bob has no token anywhere — his own effective map is null (he just follows the default)", bobBaseline.ownTokenMapId === null);
  check(
    "the DM's own map-picker 'live' indicator shows only the map with an actual PC token on it",
    dmBaseline.livePlayerMapIds.length === 1 && dmBaseline.livePlayerMapIds[0] === mapAId,
    JSON.stringify(dmBaseline.livePlayerMapIds)
  );

  // ── RLS pre-check (0046): neither player can read Map B yet — it's
  //    neither the shared default nor does either of them have a token
  //    there. ──
  const { data: bobReadsBBefore } = await bob.client.from("campaign_maps").select().eq("id", mapBId).maybeSingle();
  const { data: aliceReadsBBefore } = await alice.client.from("campaign_maps").select().eq("id", mapBId).maybeSingle();
  check("Bob cannot read Map B before anyone has a token there (RLS)", bobReadsBBefore === null);
  check("Alice cannot read Map B before SHE has a token there either (RLS)", aliceReadsBBefore === null);

  // ── 2. A real click-select-and-move onto the transition cell, confirmed
  //    by the DM as "just this token". ──
  const moved1 = await selectAndMoveToken(aliceRoom, aliceTokenId, 2, 1);
  check("Alice can click-select and move her own token onto the transition cell", moved1);

  await dmRoom.waitForSelector('[data-testid="transition-offer-modal"]', { timeout: 15000 });
  check("the DM's client shows a transition offer after Alice's real move", true);
  await dmRoom.click('[data-testid="transition-move-token"]');

  const finalAliceToken1 = await (async () => {
    const deadline = Date.now() + 15000;
    let row = await tokenRow(aliceTokenId);
    while ((row.map_id !== mapBId || row.x !== 1 || row.y !== 1) && Date.now() < deadline) {
      await sleep(300);
      row = await tokenRow(aliceTokenId);
    }
    return row;
  })();
  check(
    "confirming 'just this token' actually moved Alice's token to the destination map/cell",
    finalAliceToken1.map_id === mapBId && finalAliceToken1.x === 1 && finalAliceToken1.y === 1,
    JSON.stringify(finalAliceToken1)
  );

  const campaignAfterSolo1 = await campaignRow(campaignId);
  check(
    "a SOLO transition never touches campaigns.live_map",
    campaignAfterSolo1.live_map === mapAId,
    JSON.stringify(campaignAfterSolo1)
  );

  const aliceAfterSolo1 = await waitForMapView(aliceRoom, (state) => state.viewingMapId === mapBId);
  check("Alice's OWN view follows her own token to the destination map", aliceAfterSolo1.viewingMapId === mapBId, JSON.stringify(aliceAfterSolo1));

  const bobAfterSolo1 = await mapViewState(bobRoom);
  check("Bob's view is COMPLETELY unaffected by Alice's solo transition", bobAfterSolo1.viewingMapId === mapAId, JSON.stringify(bobAfterSolo1));
  const dmAfterSolo1 = await mapViewState(dmRoom);
  check(
    "the DM's OWN current view is COMPLETELY unaffected by a solo transition",
    dmAfterSolo1.viewingMapId === mapAId,
    JSON.stringify(dmAfterSolo1)
  );
  // A second read after a beat, ruling out a delayed leak rather than none
  // at all (the verify-token-click-select.mjs convention).
  await sleep(1500);
  const bobAfterSolo1Later = await mapViewState(bobRoom);
  const dmAfterSolo1Later = await mapViewState(dmRoom);
  check(
    "…and still unaffected a moment later, for both Bob and the DM",
    bobAfterSolo1Later.viewingMapId === mapAId && dmAfterSolo1Later.viewingMapId === mapAId,
    JSON.stringify({ bobAfterSolo1Later, dmAfterSolo1Later })
  );

  // ── 3. The DM's own "which maps are live" indicator follows the party's
  //    ACTUAL current token positions. ──
  const dmLiveMapsAfterSolo1 = await waitForMapView(dmRoom, (state) => state.livePlayerMapIds.length === 1 && state.livePlayerMapIds[0] === mapBId);
  check(
    "the DM's map-picker 'live' indicator now shows the destination map, not the source",
    dmLiveMapsAfterSolo1.livePlayerMapIds.length === 1 && dmLiveMapsAfterSolo1.livePlayerMapIds[0] === mapBId,
    JSON.stringify(dmLiveMapsAfterSolo1.livePlayerMapIds)
  );

  // ── 4. The DM independently previews the destination — no DB write, no
  //    broadcast, nobody else's view changes. TokenPanel (real DOM) proves
  //    the moved token appears/disappears with the DM's own view. ──
  check("Alice's token is NOT shown in the DM's TokenPanel while still viewing the source map", !(await domTokenPresent(dmRoom, aliceTokenId)));
  await dmRoom.click(`[data-testid="view-map-${mapBId}"]`);
  const dmPreviewB = await waitForMapView(dmRoom, (state) => state.viewingMapId === mapBId);
  check("the DM's own view switches to the destination map via the NEW preview action", dmPreviewB.viewingMapId === mapBId, JSON.stringify(dmPreviewB));
  check("Alice's token NOW appears in the DM's TokenPanel, having followed the DM's own preview", await domTokenPresent(dmRoom, aliceTokenId));
  await sleep(1200);
  const aliceDuringDmPreview = await mapViewState(aliceRoom);
  const bobDuringDmPreview = await mapViewState(bobRoom);
  check(
    "the DM's own preview changes NEITHER player's view",
    aliceDuringDmPreview.viewingMapId === mapBId && bobDuringDmPreview.viewingMapId === mapAId,
    JSON.stringify({ aliceDuringDmPreview, bobDuringDmPreview })
  );
  const campaignDuringDmPreview = await campaignRow(campaignId);
  check("the DM's own preview never touches the campaign's shared default map", campaignDuringDmPreview.live_map === mapAId);

  await dmRoom.click(`[data-testid="view-map-${mapAId}"]`);
  const dmPreviewA = await waitForMapView(dmRoom, (state) => state.viewingMapId === mapAId);
  check("the DM can freely preview back to the source map", dmPreviewA.viewingMapId === mapAId);
  check("Alice's token no longer shows in the DM's TokenPanel now that they've left her map", !(await domTokenPresent(dmRoom, aliceTokenId)));

  // ── 5. RLS re-check: Alice's own token grants HER read access to Map B;
  //    it grants Bob nothing (a map is readable per-viewer, not per-any-
  //    party-member's-token). ──
  const { data: bobReadsBAfter } = await bob.client.from("campaign_maps").select().eq("id", mapBId).maybeSingle();
  const { data: aliceReadsBAfter } = await alice.client.from("campaign_maps").select().eq("id", mapBId).maybeSingle();
  check("Bob STILL cannot read Map B, even though Alice is now there (not HIS own token)", bobReadsBAfter === null);
  check("Alice CAN now read Map B — her own token is there", aliceReadsBAfter?.id === mapBId);

  // ── 6. Pushing the campaign's shared default (the PRE-EXISTING action)
  //    still moves a token-less bystander live — today's exact behavior —
  //    but does NOT override a player who has already diverged. ──
  await dmRoom.click(`[data-testid="pick-map-${mapCId}"]`);
  const bobFollowsPush = await waitForMapView(bobRoom, (state) => state.viewingMapId === mapCId);
  check("pushing the shared default moves a token-less bystander's view live, exactly like before this prompt", bobFollowsPush.viewingMapId === mapCId, JSON.stringify(bobFollowsPush));
  await sleep(1000);
  const aliceAfterPush = await mapViewState(aliceRoom);
  check(
    "…but does NOT override a player who has already diverged onto their own token's map",
    aliceAfterPush.viewingMapId === mapBId,
    JSON.stringify(aliceAfterPush)
  );
  const dmAfterPush = await mapViewState(dmRoom);
  check("the pushing DM's own view follows their own push, exactly like before this prompt", dmAfterPush.viewingMapId === mapCId);
  const campaignAfterPush = await campaignRow(campaignId);
  check("the push actually wrote campaigns.live_map", campaignAfterPush.live_map === mapCId);

  // ── 7. A transition crossed WHILE COMBAT IS ACTIVE disrupts neither the
  //    other viewers' current view NOR the shared combat state itself. ──
  //
  // Created directly via admin (no realtime broadcast of its own — the app
  // only pokes COMBAT_EVENT from its own startCombat() action), so the
  // three ALREADY-OPEN clients need a reload to notice it via SSR's own
  // initialCombat read, the exact "admin writes directly, a client only
  // sees it after reload" shape verify-chair-drag.mjs's own reset-between-
  // drags step already uses.
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  const aliceCombatantId = crypto.randomUUID();
  await admin
    .from("combat_combatants")
    .insert({ id: aliceCombatantId, encounter_id: encounterId, token_id: aliceTokenId, character_id: aliceCharacterId, initiative: 20 });

  await Promise.all([dmRoom.reload(), aliceRoom.reload(), bobRoom.reload()]);
  await Promise.all([dmRoom, aliceRoom, bobRoom].map((page) => loadRoomWaits(page)));
  await sleep(1000);

  // A reload is a genuinely fresh session — the DM's own local-only preview
  // (dmSelectedMapId) is never persisted, by design, so it resets to the
  // campaign's current shared default (Map C, after the push above) on
  // reload exactly like a brand new join would. Re-preview Map B (where
  // Alice now stands) before the mid-combat crossing below.
  const dmAfterReload = await mapViewState(dmRoom);
  check("a reload resets the DM's own preview back to the current shared default, as a fresh join would", dmAfterReload.viewingMapId === mapCId);
  await dmRoom.click(`[data-testid="view-map-${mapBId}"]`);
  await waitForMapView(dmRoom, (state) => state.viewingMapId === mapBId);

  for (const page of [dmRoom, aliceRoom, bobRoom]) {
    await page.waitForSelector('[data-testid="combat-round"]', { timeout: 20000 });
  }
  // combat-round/current-turn-indicator are plain rendered text (Round N /
  // "X's turn"), not JSON debug mirrors like map-view-state — read with
  // plain textContent, not readMirror's JSON.parse.
  async function combatSnapshot(page) {
    return {
      round: await page.textContent('[data-testid="combat-round"]'),
      turn: await page.textContent('[data-testid="current-turn-indicator"]'),
    };
  }
  const combatBeforeTransition2 = {
    dm: await combatSnapshot(dmRoom),
    alice: await combatSnapshot(aliceRoom),
    bob: await combatSnapshot(bobRoom),
  };
  check(
    "the shared combat encounter is visible identically on every client, regardless of which map each is on",
    (await dmRoom.locator(`[data-testid="combatant-row-${aliceCombatantId}"]`).count()) > 0 &&
      (await aliceRoom.locator(`[data-testid="combatant-row-${aliceCombatantId}"]`).count()) > 0 &&
      (await bobRoom.locator(`[data-testid="combatant-row-${aliceCombatantId}"]`).count()) > 0
  );

  const moved2 = await selectAndMoveToken(aliceRoom, aliceTokenId, 1, 2);
  check("Alice can click-select and move her own token onto the SECOND transition cell mid-combat", moved2);

  await dmRoom.waitForSelector('[data-testid="transition-offer-modal"]', { timeout: 15000 });
  await dmRoom.click('[data-testid="transition-move-token"]');

  const finalAliceToken2 = await (async () => {
    const deadline = Date.now() + 15000;
    let row = await tokenRow(aliceTokenId);
    while ((row.map_id !== mapCId || row.x !== 0 || row.y !== 0) && Date.now() < deadline) {
      await sleep(300);
      row = await tokenRow(aliceTokenId);
    }
    return row;
  })();
  check(
    "the mid-combat solo transition actually moved Alice's token",
    finalAliceToken2.map_id === mapCId && finalAliceToken2.x === 0 && finalAliceToken2.y === 0,
    JSON.stringify(finalAliceToken2)
  );

  const campaignAfterSolo2 = await campaignRow(campaignId);
  check("the mid-combat solo transition never touches campaigns.live_map either", campaignAfterSolo2.live_map === mapCId);

  const aliceAfterSolo2 = await waitForMapView(aliceRoom, (state) => state.viewingMapId === mapCId);
  check("Alice's own view follows her own token again, mid-combat", aliceAfterSolo2.viewingMapId === mapCId);

  const dmAfterSolo2 = await mapViewState(dmRoom);
  check(
    "the DM's OWN current view is not disrupted by a transition crossed mid-combat",
    dmAfterSolo2.viewingMapId === mapBId,
    JSON.stringify(dmAfterSolo2)
  );

  const combatAfterTransition2 = {
    dm: await combatSnapshot(dmRoom),
    alice: await combatSnapshot(aliceRoom),
    bob: await combatSnapshot(bobRoom),
  };
  check(
    "the shared combat encounter's own state is byte-for-byte unchanged by the transition, on every client",
    JSON.stringify(combatBeforeTransition2) === JSON.stringify(combatAfterTransition2),
    JSON.stringify({ before: combatBeforeTransition2, after: combatAfterTransition2 })
  );
  // Bob's own characters RLS never included Alice's PC row (a player only
  // ever reads their own), so his own combatantLabel fallback ("Party
  // member") is the CORRECT shared-but-anonymized rendering for him — not
  // a bug, and not something this transition should change either way.
  check(
    "the current-turn indicator still shows Alice's own combatant as current — by name for the DM/Alice, anonymized for Bob exactly as before",
    (await dmRoom.textContent('[data-testid="current-turn-indicator"]')).includes("Alice") &&
      (await aliceRoom.textContent('[data-testid="current-turn-indicator"]')).includes("Alice") &&
      (await bobRoom.textContent('[data-testid="current-turn-indicator"]')).includes("Party member")
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
console.log("\nAll per-viewer map transition checks passed.");
process.exit(0);
