#!/usr/bin/env node
// Turn camera verification: an automatically-offered better vantage on the
// viewing player's own combat turn — GameTableScene.tsx's turnCameraActive
// prop (rendering) plus GameRoom.tsx's own isMyTurn/turnCameraOffered/
// turnCameraActive gate (whose turn is it, seat vs. orbit mode, an
// in-progress chair drag, an explicit dismiss).
//
// Real end-to-end browser checks against three simultaneously-connected
// clients (a DM plus two players), not just a unit test of the pure
// geometry — this script proves the camera actually moves on the RIGHT
// client, at the RIGHT moment, and never on anyone else's.
//
// Checks:
//   1. Nobody's camera is elevated while an NPC (DM-controlled) combatant is
//      current — isMyTurn is false for every real player and the DM alike.
//   2. Advancing the turn onto a player's OWN combatant (seat mode) elevates
//      ONLY that player's camera to the documented "better view" angle
//      (computeTurnCameraPosition's own formula, replayed here — the
//      verify-table-capacity.mjs/verify-chair-drag.mjs convention of
//      re-deriving the real numbers rather than trusting them by reference)
//      — the other player's and the DM's own camera positions are BYTE-FOR-
//      BYTE unchanged.
//   3. When the turn passes on to someone else, the first player's camera
//      returns to their normal seated view, while the new current player's
//      own camera elevates in turn.
//   4. A player already in orbit mode when their turn starts sees a
//      dismissible offer (not an automatic camera change) — their own
//      camera position stays exactly where it was; accepting the offer
//      (switching to seat mode) then applies the same improved angle.
//   5. Dismissing the offer/active view suppresses it for the rest of THAT
//      turn only — a fresh turn later re-offers/re-applies it.
//   6. If a player's own chair is mid-drag (mouse still down) at the exact
//      moment their turn starts, the improved angle is deferred — no camera
//      change at all — until the drag gesture actually ends.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000.
// Usage: node scripts/db/verify-turn-camera.mjs
//        APP_URL=http://localhost:3120 node scripts/db/verify-turn-camera.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Real geometry constants, replayed (not imported) from
// GameTableScene.tsx/table.ts — see this file's own header comment for why.
// ---------------------------------------------------------------------------
const LEG_HEIGHT = 1.05;
const TABLE_TOP_THICKNESS = 0.35;
const TABLE_SURFACE_Y = LEG_HEIGHT + TABLE_TOP_THICKNESS; // 1.4
const LOOK_TARGET = [0, TABLE_SURFACE_Y, 0];
const TURN_CAMERA_SETBACK_BONUS = 2.2;
const TURN_CAMERA_HEIGHT_BONUS = 2.4;

function computeTurnCameraPosition(seatCameraPosition) {
  const dx = seatCameraPosition[0] - LOOK_TARGET[0];
  const dz = seatCameraPosition[2] - LOOK_TARGET[2];
  const horizontalDistance = Math.hypot(dx, dz);
  if (horizontalDistance < 1e-6) {
    return [seatCameraPosition[0], seatCameraPosition[1] + TURN_CAMERA_HEIGHT_BONUS, seatCameraPosition[2]];
  }
  const scale = (horizontalDistance + TURN_CAMERA_SETBACK_BONUS) / horizontalDistance;
  return [
    LOOK_TARGET[0] + dx * scale,
    seatCameraPosition[1] + TURN_CAMERA_HEIGHT_BONUS,
    LOOK_TARGET[2] + dz * scale,
  ];
}

function closeVec(a, b, tol = 0.08) {
  return a && b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;
}

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
  const email = `turncamera-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `TurnCamera ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

/** GameRoom's own hidden mirror of this feature's whole gate — see
 * GameRoom.tsx's own turn-camera-state doc comment. */
async function turnCameraState(page) {
  const text = await page.textContent('[data-testid="turn-camera-state"]');
  return JSON.parse(text);
}

/** GameRoom's own hidden mirror of this client's own seated camera
 * position/draggable-chair screen projection (movable-chair drag feature,
 * reused unmodified here). */
async function chairDragState(page) {
  const text = await page.textContent('[data-testid="chair-drag-state"]');
  return JSON.parse(text);
}

async function waitForOwnChairScreen(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await chairDragState(page);
    if (last?.ownChairScreen) return last;
    await sleep(150);
  }
  throw new Error(`chair-drag-state never reported an own chair screen position — last: ${JSON.stringify(last)}`);
}

/**
 * The draggable-chair test party is now mid-combat, with the room's own
 * floating DraggablePanel windows (dice log, combat panel, etc.) rendered
 * at their default anchors over the canvas — unlike a fresh, idle room,
 * some of that default layout can genuinely land on top of a seat's own
 * projected screen point. CHAIR_DRAG_HIT_BOX (GameTableScene.tsx) is a
 * deliberately generous world-space box specifically so a real player
 * doesn't need pixel-perfect aim, so this searches a small neighborhood
 * around the reported point for one that ACTUALLY resolves (via the DOM's
 * own document.elementFromPoint — the real hit-test the browser itself
 * would use) to the canvas, rather than assuming the exact reported center
 * is always clear of every floating panel.
 */
async function findClearCanvasPoint(page, x, y, maxRadius = 100, step = 12) {
  for (let radius = 0; radius <= maxRadius; radius += step) {
    const offsets =
      radius === 0
        ? [[0, 0]]
        : Array.from({ length: 8 }, (_, i) => {
            const angle = (i / 8) * Math.PI * 2;
            return [Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)];
          });
    for (const [dx, dy] of offsets) {
      const px = x + dx;
      const py = y + dy;
      const tag = await page.evaluate(([qx, qy]) => document.elementFromPoint(qx, qy)?.tagName ?? null, [px, py]);
      if (tag === "CANVAS") return { x: px, y: py };
    }
  }
  return null;
}

/** onOwnCameraDebug only fires once GameTableScene has rendered at least
 * one real frame — three simultaneous WebGL contexts in one headless
 * browser can render their first frame at noticeably different speeds, so
 * this polls rather than trusting a fixed sleep before the very first
 * read. */
async function waitForOwnCamera(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await chairDragState(page)).ownCamera;
    if (Array.isArray(last)) return last;
    await sleep(150);
  }
  throw new Error(`chair-drag-state never reported an own camera position — last: ${JSON.stringify(last)}`);
}

/** Polls a client's own reported camera position (chair-drag-state's
 * ownCamera) until it converges on `target` — rather than a single
 * immediate read right after some OTHER piece of state (turn-camera-state's
 * own `active`/`isMyTurn`/etc, a plain React re-render) flips. The two are
 * genuinely different signals: `active` flips as soon as GameRoom.tsx
 * re-renders, while the camera position it drives only actually reaches the
 * three.js scene (and gets reported back via onOwnCameraDebug) on this
 * page's own NEXT rendered frame — normally under 16ms, but can lag
 * further if this happens to be a backgrounded page for a moment. */
async function waitForCameraClose(page, target, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await chairDragState(page)).ownCamera;
    if (closeVec(last, target)) return last;
    await sleep(150);
  }
  return last;
}

async function waitFor(fn, predicate, timeoutMs = 15000, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await sleep(pollMs);
  }
  return last;
}

/** Polls repeatedly over `durationMs` asserting `predicate` holds on every
 * single sample — used for "stays false/unchanged the whole time a drag is
 * in progress" checks, where a single passing sample proves nothing. */
async function staysTrue(fn, predicate, durationMs, pollMs = 150) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (!predicate(value)) return { ok: false, value };
    await sleep(pollMs);
  }
  return { ok: true, value: await fn() };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
// Three simultaneously-connected clients means at most one page is ever
// the OS-focused window — Chromium throttles requestAnimationFrame (and
// therefore GameTableScene's own useFrame, which is what actually fires
// onOwnCameraDebug) on backgrounded pages unless told not to, which would
// make a background client's camera-position reads lag arbitrarily far
// behind reality. Disabled outright rather than compensated for with
// longer sleeps, since a throttled background tab can pause rendering
// entirely, not just slow it down.
const browser = await chromium.launch({
  args: [
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
  ],
});

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Turn camera test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  const bobCharacterId = crypto.randomUUID();
  const baseCharacter = (id, ownerId, name) => ({
    id,
    campaign_id: campaignId,
    owner_id: ownerId,
    name,
    race: "Human",
    class: "Fighter",
    level: 3,
    strength: 16,
    dexterity: 14,
    constitution: 13,
    intelligence: 10,
    wisdom: 12,
    charisma: 8,
    current_hp: 30,
    max_hp: 30,
    armor_class: 15,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });
  await admin.from("characters").insert([
    baseCharacter(aliceCharacterId, alice.id, "Alice PC"),
    baseCharacter(bobCharacterId, bob.id, "Bob PC"),
  ]);

  // A bare map purely to satisfy map_tokens' FK — never set as the
  // campaign's own live_map; this feature has nothing to do with what's on
  // the table, only whose turn it is.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Turn camera arena",
    grid_width: 20,
    grid_height: 20,
  });
  const goblinTokenId = crypto.randomUUID();
  const aliceTokenId = crypto.randomUUID();
  const bobTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: goblinTokenId, map_id: mapId, npc_name: "Goblin", x: 0, y: 0, elevation: 0, allegiance: "hostile" },
    { id: aliceTokenId, map_id: mapId, character_id: aliceCharacterId, x: 1, y: 0, elevation: 0, allegiance: "party" },
    { id: bobTokenId, map_id: mapId, character_id: bobCharacterId, x: 2, y: 0, elevation: 0, allegiance: "party" },
  ]);

  // Combat seeded directly (start_combat's own seed-from-live-map path is
  // verified elsewhere) — initiative order Goblin 30 (current, DM-only —
  // nobody's own turn), Alice 20, Bob 10.
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  await admin.from("combat_combatants").insert([
    { encounter_id: encounterId, token_id: goblinTokenId, npc_name: "Goblin", initiative: 30 },
    { encounter_id: encounterId, token_id: aliceTokenId, character_id: aliceCharacterId, initiative: 20 },
    { encounter_id: encounterId, token_id: bobTokenId, character_id: bobCharacterId, initiative: 10 },
  ]);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="turn-camera-state"]', { state: "attached", timeout: 30000 });

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="turn-camera-state"]', { state: "attached", timeout: 30000 });

  const bobContext = await browser.newContext();
  await bobContext.addCookies(sessionCookies(bob.session));
  const bobPage = await bobContext.newPage();
  await bobPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await bobPage.waitForSelector('[data-testid="turn-camera-state"]', { state: "attached", timeout: 30000 });

  // Advances the turn through the DM's own REAL browser UI (the
  // "Advance turn" button in CombatPanel) rather than calling the
  // advance_turn RPC directly — the RPC alone only updates the database
  // row; it's the app's own handleAdvanceTurn (refreshCombat + a
  // COMBAT_EVENT broadcast on the campaign channel) that actually reaches
  // every other connected client live, exactly the real path a DM clicking
  // the button in a real session would take. The DM can always advance
  // (isDM), regardless of whose turn it currently is.
  async function advanceTurn() {
    await dmPage.waitForSelector('[data-testid="advance-turn-button"]:not([disabled])', { timeout: 15000 });
    await dmPage.click('[data-testid="advance-turn-button"]');
    await sleep(150);
    await dmPage
      .waitForSelector('[data-testid="advance-turn-button"]:not([disabled])', { timeout: 15000 })
      .catch(() => undefined);
    await sleep(200);
  }

  // -- Baseline: it's the goblin's (DM-controlled) turn — nobody's own. --
  const dmStateBaseline = await turnCameraState(dmPage);
  const aliceStateBaseline = await turnCameraState(alicePage);
  const bobStateBaseline = await turnCameraState(bobPage);
  check(
    "nobody's turn-camera considers itself active while an NPC combatant is current",
    !dmStateBaseline.isMyTurn && !aliceStateBaseline.isMyTurn && !bobStateBaseline.isMyTurn,
    JSON.stringify({ dmStateBaseline, aliceStateBaseline, bobStateBaseline })
  );

  // Polled (not a fixed sleep) — three simultaneous WebGL contexts in one
  // headless browser can render their first real frame at noticeably
  // different speeds, and onOwnCameraDebug only fires once one has.
  const dmCamBaseline = await waitForOwnCamera(dmPage);
  const aliceCamBaseline = await waitForOwnCamera(alicePage);
  const bobCamBaseline = await waitForOwnCamera(bobPage);
  check(
    "every client reports a real seated camera position at baseline",
    Array.isArray(dmCamBaseline) && Array.isArray(aliceCamBaseline) && Array.isArray(bobCamBaseline),
    JSON.stringify({ dmCamBaseline, aliceCamBaseline, bobCamBaseline })
  );

  // ---------------------------------------------------------------------
  // 1. Advancing onto ALICE's own turn (both still in default seat mode)
  //    elevates ONLY her camera — bob's and the DM's stay byte-for-byte
  //    unchanged.
  // ---------------------------------------------------------------------
  await advanceTurn(); // goblin -> alice

  const aliceActive = await waitFor(
    () => turnCameraState(alicePage),
    (s) => s.isMyTurn && s.active,
    15000
  );
  check(
    "advancing onto alice's own combatant makes HER turn-camera state active (seat mode, no drag, not dismissed)",
    aliceActive?.isMyTurn === true && aliceActive?.active === true && aliceActive?.offered === false,
    JSON.stringify(aliceActive)
  );

  const bobStateAfterAliceTurn = await turnCameraState(bobPage);
  const dmStateAfterAliceTurn = await turnCameraState(dmPage);
  check(
    "bob's and the DM's own turn-camera state stay inactive while it's alice's turn",
    !bobStateAfterAliceTurn.isMyTurn && !dmStateAfterAliceTurn.isMyTurn,
    JSON.stringify({ bobStateAfterAliceTurn, dmStateAfterAliceTurn })
  );

  const expectedAliceElevated = computeTurnCameraPosition(aliceCamBaseline);
  const aliceCamElevated = await waitForCameraClose(alicePage, expectedAliceElevated);
  check(
    "alice's own camera moved to the documented improved angle, derived from her real baseline seat",
    closeVec(aliceCamElevated, expectedAliceElevated),
    JSON.stringify({ aliceCamElevated, expectedAliceElevated })
  );

  const bobCamDuringAliceTurn = (await chairDragState(bobPage)).ownCamera;
  const dmCamDuringAliceTurn = (await chairDragState(dmPage)).ownCamera;
  check(
    "bob's own camera position is completely unchanged by alice's turn starting",
    closeVec(bobCamDuringAliceTurn, bobCamBaseline, 0.01),
    JSON.stringify({ bobCamDuringAliceTurn, bobCamBaseline })
  );
  check(
    "the DM's own camera position is completely unchanged by alice's turn starting",
    closeVec(dmCamDuringAliceTurn, dmCamBaseline, 0.01),
    JSON.stringify({ dmCamDuringAliceTurn, dmCamBaseline })
  );

  // ---------------------------------------------------------------------
  // 2. Turn passes to bob: alice's camera returns to normal; bob's own
  //    elevates in turn (his own turn now, not "changed by someone else's").
  // ---------------------------------------------------------------------
  await advanceTurn(); // alice -> bob

  const aliceAfterTurnEnded = await waitFor(
    () => turnCameraState(alicePage),
    (s) => !s.isMyTurn && !s.active,
    15000
  );
  check(
    "alice's turn-camera state deactivates the moment her turn ends",
    aliceAfterTurnEnded?.isMyTurn === false && aliceAfterTurnEnded?.active === false,
    JSON.stringify(aliceAfterTurnEnded)
  );
  const aliceCamRestored = await waitForCameraClose(alicePage, aliceCamBaseline);
  check(
    "alice's own camera returns to her exact normal seated position once her turn ends",
    closeVec(aliceCamRestored, aliceCamBaseline),
    JSON.stringify({ aliceCamRestored, aliceCamBaseline })
  );

  const bobActive = await waitFor(
    () => turnCameraState(bobPage),
    (s) => s.isMyTurn && s.active,
    15000
  );
  check("bob's own turn-camera state activates for his own turn", bobActive?.isMyTurn && bobActive?.active);
  const expectedBobElevated = computeTurnCameraPosition(bobCamBaseline);
  const bobCamElevated = await waitForCameraClose(bobPage, expectedBobElevated);
  check(
    "bob's own camera moved to the documented improved angle on his own turn",
    closeVec(bobCamElevated, expectedBobElevated),
    JSON.stringify({ bobCamElevated, expectedBobElevated })
  );

  // ---------------------------------------------------------------------
  // 3. Orbit mode: a dismissible offer instead of an automatic switch.
  //    Alice switches to orbit NOW (not her turn), then combat wraps back
  //    around to her.
  // ---------------------------------------------------------------------
  await alicePage.click('[data-testid="camera-mode-toggle"]'); // seat -> orbit, not her turn
  await sleep(300);
  const aliceOrbitedEarly = await turnCameraState(alicePage);
  check(
    "switching to orbit mode off-turn has no turn-camera side effects",
    aliceOrbitedEarly.cameraMode === "orbit" && !aliceOrbitedEarly.offered && !aliceOrbitedEarly.active,
    JSON.stringify(aliceOrbitedEarly)
  );

  await advanceTurn(); // bob -> goblin (wraps, round 2)
  await advanceTurn(); // goblin -> alice

  const aliceOffered = await waitFor(
    () => turnCameraState(alicePage),
    (s) => s.isMyTurn && s.offered,
    15000
  );
  check(
    "alice sees a dismissible OFFER (not an automatic switch) since she's in orbit mode on her turn",
    aliceOffered?.isMyTurn === true && aliceOffered?.offered === true && aliceOffered?.active === false,
    JSON.stringify(aliceOffered)
  );
  const aliceCamDuringOffer = await waitForCameraClose(alicePage, aliceCamBaseline);
  check(
    "the orbit-mode offer never touches alice's own camera position on its own",
    closeVec(aliceCamDuringOffer, aliceCamBaseline),
    JSON.stringify({ aliceCamDuringOffer, aliceCamBaseline })
  );
  const offerVisible = await alicePage.isVisible('[data-testid="turn-camera-offer"]');
  check("the offer's own UI chip is actually visible on alice's page", offerVisible);

  // Accepting hands control to the plain seat/orbit toggle — the same
  // isMyTurn/dismissed gate then naturally renders the improved angle.
  await alicePage.click('[data-testid="turn-camera-accept"]');
  const aliceAfterAccept = await waitFor(
    () => turnCameraState(alicePage),
    (s) => s.cameraMode === "seat" && s.active,
    15000
  );
  check(
    "accepting the offer switches to seat mode and applies the improved angle",
    aliceAfterAccept?.cameraMode === "seat" && aliceAfterAccept?.active === true,
    JSON.stringify(aliceAfterAccept)
  );
  const aliceCamAfterAccept = await waitForCameraClose(alicePage, expectedAliceElevated);
  check(
    "the camera position after accepting matches the documented improved angle",
    closeVec(aliceCamAfterAccept, expectedAliceElevated),
    JSON.stringify({ aliceCamAfterAccept, expectedAliceElevated })
  );

  // ---------------------------------------------------------------------
  // 4. Dismissing the active view suppresses it for the REST of this turn
  //    only — a later, fresh turn re-applies it automatically.
  // ---------------------------------------------------------------------
  await alicePage.click('[data-testid="turn-camera-dismiss"]');
  const aliceAfterDismiss = await waitFor(
    () => turnCameraState(alicePage),
    (s) => s.dismissed && !s.active,
    15000
  );
  check(
    "dismissing the active view turns it off for this turn without ending the turn itself",
    aliceAfterDismiss?.isMyTurn === true && aliceAfterDismiss?.active === false && aliceAfterDismiss?.dismissed === true,
    JSON.stringify(aliceAfterDismiss)
  );
  const aliceCamAfterDismiss = await waitForCameraClose(alicePage, aliceCamBaseline);
  check(
    "the dismissed view leaves alice's camera at her normal seated position",
    closeVec(aliceCamAfterDismiss, aliceCamBaseline),
    JSON.stringify({ aliceCamAfterDismiss, aliceCamBaseline })
  );
  const staysDismissed = await staysTrue(
    () => turnCameraState(alicePage),
    (s) => s.active === false,
    1200
  );
  check("the dismissal holds for the remainder of this same turn (doesn't silently re-apply)", staysDismissed.ok);

  await advanceTurn(); // alice -> bob
  await advanceTurn(); // bob -> goblin (wraps)
  await advanceTurn(); // goblin -> alice — a genuinely NEW turn

  const aliceFreshTurn = await waitFor(
    () => turnCameraState(alicePage),
    (s) => s.isMyTurn && s.active,
    15000
  );
  check(
    "a fresh later turn re-applies the improved angle automatically — the dismissal didn't outlive its own turn",
    aliceFreshTurn?.isMyTurn === true && aliceFreshTurn?.active === true && aliceFreshTurn?.dismissed === false,
    JSON.stringify(aliceFreshTurn)
  );

  // ---------------------------------------------------------------------
  // 5. Chair-drag defer: mid-drag at the exact moment the turn starts.
  // ---------------------------------------------------------------------
  await advanceTurn(); // alice -> bob (so alice's NEXT turn is a fresh start we control precisely)
  await advanceTurn(); // bob -> goblin (wraps)

  const aliceOffTurn = await waitFor(() => turnCameraState(alicePage), (s) => !s.isMyTurn, 15000);
  check("alice is off-turn again, ready for the drag-defer scenario", aliceOffTurn?.isMyTurn === false);

  // Bring alice's page to the front before driving her own drag gesture —
  // both so the pointer events land on it deterministically and so its own
  // rendering isn't a backgrounded/throttled tab for the duration of the
  // gesture (see the chromium.launch() args above for the same concern).
  await alicePage.bringToFront();
  // The dice log panel defaults to a bottom-center anchor (DraggablePanel's
  // own DEFAULT_ANCHOR_CLASS) wide/tall enough, now that combat is running,
  // to sit right on top of a seated own-chair's typical screen projection.
  // Collapsing it (a real, user-available control — DraggablePanel's own
  // collapse-toggle) is the same thing a real player would do to get at
  // their own chair if a panel happened to be in the way, rather than a
  // test-only workaround.
  await alicePage.click('[data-testid="collapse-toggle-diceLog"]').catch(() => undefined);
  await sleep(200);
  const aliceChair = await waitForOwnChairScreen(alicePage);
  const aliceCanvasBox = await alicePage.locator("canvas").boundingBox();
  if (!aliceCanvasBox) throw new Error("no canvas on alice's page");

  // The room is now mid-combat, with the usual DraggablePanel windows in
  // their default positions — unlike an idle room, one of those can
  // genuinely sit on top of the exact reported chair point (this is a
  // property of the test's own default panel layout, not the feature under
  // test), so this finds a nearby PAGE-relative point that the DOM's own
  // hit-test confirms actually belongs to the canvas (ownChairScreen itself
  // is canvas-relative — offset by the canvas's own page position first).
  const pageX = aliceCanvasBox.x + aliceChair.ownChairScreen[0];
  const pageY = aliceCanvasBox.y + aliceChair.ownChairScreen[1];
  const clearPoint = await findClearCanvasPoint(alicePage, pageX, pageY);
  if (!clearPoint) {
    throw new Error(
      `could not find a canvas-owned point near alice's own chair (page ${pageX},${pageY}) — likely fully covered by a floating panel`
    );
  }
  await alicePage.mouse.move(clearPoint.x, clearPoint.y);
  await alicePage.mouse.down();

  const draggingBeforeTurn = await waitFor(
    () => turnCameraState(alicePage),
    (s) => s.chairDragging === true,
    8000
  );
  check(
    "alice's own chair-drag is genuinely in progress before her turn starts",
    draggingBeforeTurn?.chairDragging === true && draggingBeforeTurn?.isMyTurn === false,
    JSON.stringify(draggingBeforeTurn)
  );

  await advanceTurn(); // goblin -> alice, WHILE her chair is still mid-drag
  await alicePage.bringToFront();

  // First, wait (bounded) for the turn change to actually reach alice's own
  // client at all — a real WebSocket broadcast round trip, not instant —
  // before asserting anything STAYS a particular way from here on. Without
  // this separate wait, the very first "stays deferred" sample could
  // legitimately still catch isMyTurn=false (the broadcast just hasn't
  // landed yet), which would prove nothing about deferral at all.
  const turnLandedWhileDragging = await waitFor(
    () => turnCameraState(alicePage),
    (s) => s.isMyTurn === true,
    15000
  );
  check(
    "alice's turn genuinely reaches her own client while her chair-drag is still in progress",
    turnLandedWhileDragging?.isMyTurn === true && turnLandedWhileDragging?.chairDragging === true,
    JSON.stringify(turnLandedWhileDragging)
  );

  const staysDeferred = await staysTrue(
    async () => {
      const state = await turnCameraState(alicePage);
      const cam = (await chairDragState(alicePage)).ownCamera;
      return { state, cam };
    },
    ({ state, cam }) =>
      state.isMyTurn === true && state.chairDragging === true && state.active === false && closeVec(cam, aliceCamBaseline),
    1500
  );
  check(
    "the improved angle is deferred (never applied) for as long as the chair drag continues, even once it's her turn",
    staysDeferred.ok,
    JSON.stringify(staysDeferred.value)
  );

  await alicePage.mouse.up();

  const aliceAfterDragEnds = await waitFor(
    () => turnCameraState(alicePage),
    (s) => s.chairDragging === false && s.active === true,
    15000
  );
  check(
    "the improved angle applies immediately once the drag gesture actually ends",
    aliceAfterDragEnds?.chairDragging === false && aliceAfterDragEnds?.active === true,
    JSON.stringify(aliceAfterDragEnds)
  );
  const aliceCamAfterDragEnds = await waitForCameraClose(alicePage, expectedAliceElevated);
  check(
    "the post-drag improved angle matches the documented formula (chair never actually moved, so the baseline is unchanged)",
    closeVec(aliceCamAfterDragEnds, expectedAliceElevated),
    JSON.stringify({ aliceCamAfterDragEnds, expectedAliceElevated })
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
console.log("\nAll turn camera checks passed.");
process.exit(0);
