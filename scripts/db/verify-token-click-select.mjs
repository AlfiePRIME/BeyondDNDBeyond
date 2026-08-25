#!/usr/bin/env node
// Click-select-to-move verification (the prompt that replaces token
// drag-to-move with click-select / highlight-cells / click-to-confirm).
//
// Real signed-in Playwright browsers throughout (three: DM, Alice the
// mover, Bob a bystander) against a live room — the WebGL canvas has no DOM
// to inspect, so every check reads the hidden [data-testid="token-
// selection-state"] render-state mirror GameRoom exposes (the visionDebug/
// tableSurfaceDebug precedent: the mirror IS the rendering decision
// MapSurface executes deterministically) while the actual gestures are
// real mouse clicks on the canvas, discovered by scanning rather than
// computed from camera math (the verify-void-terrain.mjs lesson) — clicks
// are verified against OBSERVED outcomes (the mirror, the DB, and the real
// rules-engine module loaded via vite, the verify-opportunity-attacks.mjs
// lesson) rather than assuming a specific target cell, so the checks hold
// regardless of exactly which cell a given scan happens to land on.
//
// Covers: clicking a movable token selects it and highlights its real
// computeReachableCells set ONLY during that token's own tracked, budgeted
// turn (cross-checked against the real rules-engine function) — and NOT
// otherwise (a DM selecting an off-turn NPC gets no highlight and an
// unconstrained click-to-place, still routed through plain moveMapToken,
// never touching combat_combatants); that highlight and the token's raised
// treatment reach the DM's own client (a poke via TOKEN_SELECTED_EVENT) but
// NEVER a bystanding player's — the core per-viewer requirement; a
// confirmed move through a highlighted cell commits with the exact cost
// accounting and opportunity-attack detection the old drag gesture
// produced; three ways to cancel with nothing written (re-click the
// selected token, Escape, and clicking a cell outside a genuinely fresh
// small highlight); a deliberately staled client (another write shrank the
// real budget behind its back, simulating the race a client-side highlight
// alone can't fully prevent) gets a real Strict-mode rejection reported
// through tokenError with a clean deselect and no desynced position;
// TokenPanel's separate armed-placement flow (place-npc) is unaffected;
// and ruler mode still swallows a token click outright (no selection),
// preserving the same mutual exclusivity the old drag/measure gestures had.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-token-click-select.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { createServer } from "vite";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = "http://localhost:3000";

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
  console.log("dev server not running — starting yarn dev…");
  devServer = spawn("yarn", ["dev"], { cwd: rootDir, stdio: "ignore", detached: true });
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
  const email = `click-select-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Click ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

const selectionState = (page) => readMirror(page, "token-selection-state");

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

/** Polls the selection mirror until `predicate` is true or `timeoutMs`
 * elapses — a broadcast to another client is a network round trip, never
 * instant. Returns the last-read mirror either way, so a timed-out caller
 * still gets a useful detail string. */
async function waitForSelectionState(page, predicate, timeoutMs = 8000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = await selectionState(page);
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await selectionState(page);
  }
  return last;
}

/** Blind grid scan over the canvas — verify-void-terrain.mjs's own
 * `scanClick`, unchanged: no way to compute a WebGL raycast target from
 * camera math, so this discovers a working screen point empirically,
 * center-out. `onMiss` runs after every non-matching click (used to detect
 * and repair a selection this scan accidentally knocked out — e.g. by
 * re-hitting the selected token's own point). */
async function scanGridClick(page, done, opts = {}) {
  const { xFrom = 0.12, xTo = 0.88, yFrom = 0.24, yTo = 0.7, step = 34, settleMs = 160, onMiss } = opts;
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
      if (onMiss) await onMiss(point);
    }
  }
  return null;
}

/** A ring scan around a KNOWN screen point (verify-void-terrain.mjs's own
 * step-11 technique) — for gestures that need to land near a specific
 * already-located token (an adjacent grid cell, or that token's own exact
 * point again) rather than searching the whole canvas blind. */
async function scanRingClick(page, center, done, opts = {}) {
  const { radiusFrom = 14, radiusTo = 220, radiusStep = 18, angleStep = 24, settleMs = 160, onMiss } = opts;
  for (let radius = radiusFrom; radius <= radiusTo; radius += radiusStep) {
    for (let angle = 0; angle < 360; angle += angleStep) {
      const x = center.x + radius * Math.cos((angle * Math.PI) / 180);
      const y = center.y + radius * Math.sin((angle * Math.PI) / 180);
      await page.mouse.click(x, y);
      await sleep(settleMs);
      if (await done({ x, y })) return { x, y };
      if (onMiss) await onMiss({ x, y });
    }
  }
  return null;
}

/** Re-arms a selection this scan may have accidentally knocked out (e.g. by
 * re-hitting the token's own point, which toggles it OFF) — the
 * verify-void-terrain.mjs "re-click the Move button when the hint vanished"
 * lesson, generalized to a mirror-state check instead of a DOM hint. */
function reselectOnMiss(page, tokenId, tokenPoint) {
  return async () => {
    const state = await selectionState(page);
    if (state.selectedTokenId !== tokenId) {
      await page.mouse.click(tokenPoint.x, tokenPoint.y);
      await sleep(200);
    }
  };
}

await ensureDevServer();

// The app's REAL rules-engine modules, loaded through vite the exact same
// way verify-opportunity-attacks.mjs does — every reachable-cells and
// opportunity-attack expectation below is computed with the SAME code the
// Game Room ships, over whatever a real browser click actually landed on,
// not a hand-rolled lookalike.
const vite = await createServer({
  root: rootDir,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
});
const movementRules = await vite.ssrLoadModule("/src/rules-engine/movement.ts");
const oaRules = await vite.ssrLoadModule("/src/rules-engine/opportunityAttacks.ts");

// A flat, all-normal, all-elevation-0 sweep — the map below never paints
// any map_cells rows, so every position defaults to exactly this (the
// app's own DEFAULT_CELL), the same input shape computeReachableCells
// documents (`{position, terrain, elevationSteps}` per real cell).
function denseNormalCells(width, height) {
  const cells = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      cells.push({ position: { x, y }, terrain: "normal", elevationSteps: 0 });
    }
  }
  return cells;
}

function cellKey(x, y) {
  return `${x},${y}`;
}

const GRID = 7; // small enough to keep per-cell screen size workable for scanning, big enough for a meaningful highlighted/unhighlighted split.

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch();

try {
  const campaignId = crypto.randomUUID();
  await admin
    .from("campaigns")
    .insert({ id: campaignId, name: "Click-select test", creator: dm.id, action_economy_strict: true });
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
    name: "Alice Vanguard",
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
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [{ name: "Longsword", quantity: 1, attackKind: "melee", damageNotation: "1d8" }],
    spells: [],
  });

  // A flat GRIDxGRID map — no map_cells rows at all, so every cell defaults
  // to normal/elevation 0 (matching denseNormalCells above exactly).
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Click-select arena",
    grid_width: GRID,
    grid_height: GRID,
  });
  const center = Math.floor(GRID / 2);
  const aliceTokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    {
      id: aliceTokenId,
      map_id: mapId,
      character_id: aliceCharacterId,
      x: center,
      y: center,
      elevation: 0,
      allegiance: "party",
    },
    {
      id: goblinTokenId,
      map_id: mapId,
      npc_name: "Goblin",
      x: center,
      y: center + 1,
      elevation: 0,
      allegiance: "hostile",
    },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // Combat: Alice's PC is the current combatant (highest initiative, index
  // 0); the goblin is seated but never current — exactly "someone else's
  // turn" for every check that selects/moves it.
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  const aliceCombatantId = crypto.randomUUID();
  const goblinCombatantId = crypto.randomUUID();
  await admin.from("combat_combatants").insert([
    { id: aliceCombatantId, encounter_id: encounterId, token_id: aliceTokenId, character_id: aliceCharacterId, initiative: 20 },
    { id: goblinCombatantId, encounter_id: encounterId, token_id: goblinTokenId, npc_name: "Goblin", initiative: 10 },
  ]);

  const tokenRow = async (id) => {
    const { data } = await admin.from("map_tokens").select().eq("id", id).single();
    return data;
  };
  const combatantRow = async (id) => {
    const { data } = await admin.from("combat_combatants").select().eq("id", id).single();
    return data;
  };
  const oaRowsFor = async (moverCombatantId, reactorCombatantId) => {
    const { data } = await admin
      .from("opportunity_attacks")
      .select()
      .eq("mover_combatant_id", moverCombatantId)
      .eq("reactor_combatant_id", reactorCombatantId);
    return data ?? [];
  };

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const aliceRoom = await aliceContext.newPage();
  const bobContext = await browser.newContext();
  await bobContext.addCookies(sessionCookies(bob.session));
  const bobRoom = await bobContext.newPage();

  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
    await page.waitForSelector('[data-testid="combat-panel"]', { timeout: 30000 });
  }
  await Promise.all([loadRoom(dmRoom), loadRoom(aliceRoom), loadRoom(bobRoom)]);
  // Let every room's campaign-channel subscription establish before the
  // first selection broadcast fires (the verify-opportunity-attacks.mjs
  // join-race lesson).
  await sleep(2000);

  check(
    "nobody starts with anything selected",
    (await selectionState(dmRoom)).selectedTokenId === null &&
      (await selectionState(aliceRoom)).selectedTokenId === null &&
      (await selectionState(bobRoom)).selectedTokenId === null
  );

  // ── 1. Off-turn / untracked: the DM selects the goblin (never the
  //    current combatant) — no highlight, no reachable set, and a
  //    confirmed move stays on the plain moveMapToken path (Alice's
  //    combatant's movement_used_feet is untouched). ──
  const goblinPoint = await scanGridClick(dmRoom, async () => (await selectionState(dmRoom)).selectedTokenId === goblinTokenId);
  check("the DM can click-select an off-turn NPC token", goblinPoint !== null);
  const dmGoblinSelected = await selectionState(dmRoom);
  check(
    "an off-turn (untracked) selection shows NO highlight and NO reachable set",
    dmGoblinSelected.reachableCells === null && dmGoblinSelected.highlightedCells === null,
    JSON.stringify(dmGoblinSelected)
  );
  const goblinBefore = await tokenRow(goblinTokenId);
  const aliceUsedBeforeGoblinMove = (await combatantRow(aliceCombatantId)).movement_used_feet;
  const goblinMoved = goblinPoint
    ? await scanRingClick(
        dmRoom,
        goblinPoint,
        async () => {
          const row = await tokenRow(goblinTokenId);
          return row.x !== goblinBefore.x || row.y !== goblinBefore.y;
        },
        { onMiss: reselectOnMiss(dmRoom, goblinTokenId, goblinPoint) }
      )
    : null;
  const goblinAfterMove = await tokenRow(goblinTokenId);
  check(
    "confirming an untracked selection's move actually relocates the token",
    goblinMoved !== null && (goblinAfterMove.x !== goblinBefore.x || goblinAfterMove.y !== goblinBefore.y),
    JSON.stringify({ before: goblinBefore, after: goblinAfterMove })
  );
  check(
    "an untracked move never touches the current combatant's movement_used_feet",
    (await combatantRow(aliceCombatantId)).movement_used_feet === aliceUsedBeforeGoblinMove
  );
  check(
    "confirming a move clears the selection",
    (await selectionState(dmRoom)).selectedTokenId === null
  );

  // ── 2. Tracked/budgeted selection: Alice selects her own token —
  //    highlighted set matches the REAL computeReachableCells, visible to
  //    the DM (via the broadcast) and invisible to Bob throughout. ──
  const alicePoint = await scanGridClick(aliceRoom, async () => (await selectionState(aliceRoom)).selectedTokenId === aliceTokenId);
  check("Alice can click-select her own token", alicePoint !== null);
  const aliceSelected = await selectionState(aliceRoom);
  const goblinNow = await tokenRow(goblinTokenId);
  const expectedReachable = new Set(
    movementRules
      .computeReachableCells({
        origin: { x: center, y: center },
        cells: denseNormalCells(GRID, GRID),
        budgetFeet: 30,
        occupiedCells: [{ x: goblinNow.x, y: goblinNow.y }],
      })
      .map((p) => cellKey(p.x, p.y))
  );
  check(
    "the tracked/budgeted highlight matches the real computeReachableCells exactly",
    aliceSelected.reachableCells !== null &&
      aliceSelected.reachableCells.length === expectedReachable.size &&
      aliceSelected.reachableCells.every((key) => expectedReachable.has(key)),
    JSON.stringify({ got: aliceSelected.reachableCells?.length, want: expectedReachable.size })
  );

  const dmSeesAlice = await waitForSelectionState(
    dmRoom,
    (state) => state.visibleSelections?.[aliceTokenId] === alice.id
  );
  check(
    "the DM's client learns of Alice's selection (the poke) and renders her exact highlight",
    dmSeesAlice.visibleSelections?.[aliceTokenId] === alice.id &&
      Array.isArray(dmSeesAlice.highlightedCells) &&
      dmSeesAlice.highlightedCells.length === expectedReachable.size,
    JSON.stringify(dmSeesAlice)
  );
  const bobDuringAliceSelection = await selectionState(bobRoom);
  check(
    "a bystanding player (Bob) sees NOTHING of Alice's selection — no visible selection, no highlight",
    Object.keys(bobDuringAliceSelection.visibleSelections ?? {}).length === 0 &&
      bobDuringAliceSelection.highlightedCells === null,
    JSON.stringify(bobDuringAliceSelection)
  );
  // A second read after a beat, in case of a delayed leak rather than none
  // at all.
  await sleep(1200);
  const bobStill = await selectionState(bobRoom);
  check(
    "…and still nothing a moment later (no delayed leak)",
    Object.keys(bobStill.visibleSelections ?? {}).length === 0 && bobStill.highlightedCells === null
  );

  // ── 3. Cancel #1: click the selected token again. ──
  await aliceRoom.mouse.click(alicePoint.x, alicePoint.y);
  await sleep(300);
  check(
    "clicking the already-selected token again cancels the selection",
    (await selectionState(aliceRoom)).selectedTokenId === null
  );
  const dmClearedAfterCancel1 = await waitForSelectionState(
    dmRoom,
    (state) => state.visibleSelections?.[aliceTokenId] === undefined
  );
  check(
    "the DM's client learns the selection cleared too",
    dmClearedAfterCancel1.visibleSelections?.[aliceTokenId] === undefined
  );
  const aliceUnmovedAfterCancel1 = await tokenRow(aliceTokenId);
  check(
    "cancelling writes nothing — Alice's token never moved",
    aliceUnmovedAfterCancel1.x === center && aliceUnmovedAfterCancel1.y === center
  );

  // ── 4. Cancel #2: Escape. ──
  await aliceRoom.mouse.click(alicePoint.x, alicePoint.y);
  await sleep(300);
  check("re-selecting for the Escape check works", (await selectionState(aliceRoom)).selectedTokenId === aliceTokenId);
  await aliceRoom.keyboard.press("Escape");
  await sleep(300);
  check("Escape cancels a live selection", (await selectionState(aliceRoom)).selectedTokenId === null);
  const dmClearedAfterEscape = await waitForSelectionState(
    dmRoom,
    (state) => state.visibleSelections?.[aliceTokenId] === undefined
  );
  check("…and the DM's client sees it clear too", dmClearedAfterEscape.visibleSelections?.[aliceTokenId] === undefined);
  const aliceUnmovedAfterEscape = await tokenRow(aliceTokenId);
  check(
    "Escape writes nothing either",
    aliceUnmovedAfterEscape.x === center && aliceUnmovedAfterEscape.y === center
  );

  // ── 5. Confirmed move through a highlighted cell: real cost accounting
  //    and opportunity-attack detection, verified against whatever cell
  //    the browser actually landed on (not a pre-picked target). ──
  await aliceRoom.mouse.click(alicePoint.x, alicePoint.y);
  await sleep(300);
  check("re-selecting for the confirm-move check works", (await selectionState(aliceRoom)).selectedTokenId === aliceTokenId);
  const aliceFrom = { x: center, y: center };
  const moveLanded = await scanGridClick(
    aliceRoom,
    async () => {
      const row = await tokenRow(aliceTokenId);
      return row.x !== aliceFrom.x || row.y !== aliceFrom.y;
    },
    { onMiss: reselectOnMiss(aliceRoom, aliceTokenId, alicePoint) }
  );
  const aliceAfterMove1 = await tokenRow(aliceTokenId);
  const aliceMoved1 = moveLanded !== null && (aliceAfterMove1.x !== aliceFrom.x || aliceAfterMove1.y !== aliceFrom.y);
  check(
    "clicking a highlighted cell actually commits the move",
    aliceMoved1,
    JSON.stringify({ from: aliceFrom, after: aliceAfterMove1 })
  );
  const aliceTo1 = { x: aliceAfterMove1.x, y: aliceAfterMove1.y };
  const expectedCost1 = movementRules.gridDistanceFeet(aliceFrom, aliceTo1);
  const aliceCombatantAfterMove1 = await combatantRow(aliceCombatantId);
  check(
    "the committed move charges exactly the straight-line cost against movement_used_feet",
    aliceCombatantAfterMove1.movement_used_feet === expectedCost1,
    `expected ${expectedCost1}, got ${aliceCombatantAfterMove1.movement_used_feet}`
  );
  const goblinAtMove1 = await tokenRow(goblinTokenId);
  const expectedReactors1 = oaRules.computeOpportunityAttacks({
    moverFrom: aliceFrom,
    moverTo: aliceTo1,
    moverDisengaged: false,
    hostiles: [
      {
        combatantId: goblinCombatantId,
        position: { x: goblinAtMove1.x, y: goblinAtMove1.y },
        reachFeet: oaRules.meleeReachFeet([]),
        reactionUsed: false,
        cannotReact: false,
      },
    ],
  });
  const oaRowsAfterMove1 = await oaRowsFor(aliceCombatantId, goblinCombatantId);
  if (expectedReactors1.includes(goblinCombatantId)) {
    check(
      "the real rules-engine says this move should provoke the goblin, and it did",
      oaRowsAfterMove1.length === 1 && oaRowsAfterMove1[0].status === "pending",
      JSON.stringify(oaRowsAfterMove1)
    );
  } else {
    check(
      "the real rules-engine says this move should NOT provoke the goblin, and it didn't",
      oaRowsAfterMove1.length === 0,
      JSON.stringify(oaRowsAfterMove1)
    );
  }
  check(
    "confirming clears the selection",
    (await selectionState(aliceRoom)).selectedTokenId === null
  );

  // ── 6. Cancel #3: a genuinely fresh, small budget makes most of the
  //    board unhighlighted — clicking one of those cells cancels silently,
  //    nothing written. Admin sets a near-exhausted budget and Alice
  //    RELOADS (so her client's combat state is accurate, not stale — the
  //    stale case is deliberately reserved for the Strict-rejection check
  //    next), leaving only her immediate neighbors reachable. ──
  await admin.from("combat_combatants").update({ movement_used_feet: 25 }).eq("id", aliceCombatantId); // speed 30 - 25 = 5 ft = one cell.
  await loadRoom(aliceRoom);
  const alicePoint2 = await scanGridClick(aliceRoom, async () => (await selectionState(aliceRoom)).selectedTokenId === aliceTokenId);
  check("re-locating Alice's token after reload works", alicePoint2 !== null);
  const aliceSmallBudget = await selectionState(aliceRoom);
  check(
    "a near-exhausted (5 ft) budget highlights only the token's own cell and immediate neighbors",
    aliceSmallBudget.reachableCells !== null && aliceSmallBudget.reachableCells.length <= 9,
    JSON.stringify(aliceSmallBudget.reachableCells)
  );
  const aliceBeforeCancelClick = await tokenRow(aliceTokenId);
  const cancelledOutside = await scanGridClick(
    aliceRoom,
    async () => {
      const state = await selectionState(aliceRoom);
      const row = await tokenRow(aliceTokenId);
      return state.selectedTokenId === null && row.x === aliceBeforeCancelClick.x && row.y === aliceBeforeCancelClick.y;
    },
    { onMiss: reselectOnMiss(aliceRoom, aliceTokenId, alicePoint2) }
  );
  check("a click outside the (now tiny) highlighted set cancels the selection", cancelledOutside !== null);
  const aliceAfterCancelClick = await tokenRow(aliceTokenId);
  check(
    "…and writes nothing",
    aliceAfterCancelClick.x === aliceBeforeCancelClick.x && aliceAfterCancelClick.y === aliceBeforeCancelClick.y
  );
  check("…and shows no error (a silent cancel, not a rejection)", !(await isVisible(aliceRoom, "token-error")));

  // ── 7. Strict-mode server rejection: the DM (bypassing the app, like a
  //    concurrent write from anywhere else) shrinks the REAL remaining
  //    budget to nothing behind Alice's back — her client's own selection
  //    still trusts the now-stale 5 ft it already fetched, so clicking one
  //    of its own (stale) highlighted neighbor cells still gets sent to
  //    the server, which now rejects it for real. Exactly the race a
  //    client-side highlight alone can never fully close, and exactly what
  //    the acceptance criteria calls out handling gracefully. ──
  await admin.from("combat_combatants").update({ movement_used_feet: 29 }).eq("id", aliceCombatantId); // real remaining: 1 ft — nothing is affordable.
  await aliceRoom.mouse.click(alicePoint2.x, alicePoint2.y);
  await sleep(300);
  check(
    "Alice can re-select while her own client is unaware the real budget just shrank",
    (await selectionState(aliceRoom)).selectedTokenId === aliceTokenId
  );
  const aliceBeforeReject = await tokenRow(aliceTokenId);
  const rejected = await scanRingClick(
    aliceRoom,
    alicePoint2,
    async () => isVisible(aliceRoom, "token-error"),
    { radiusFrom: 10, radiusTo: 140, onMiss: reselectOnMiss(aliceRoom, aliceTokenId, alicePoint2) }
  );
  const rejectionMessage = rejected ? await aliceRoom.textContent('[data-testid="token-error"]') : null;
  check(
    "a stale-but-plausible click still reaches the server, which rejects it in Strict mode",
    rejectionMessage !== null && /not enough movement/i.test(rejectionMessage),
    rejectionMessage ?? "no token-error appeared"
  );
  check(
    "the rejection cleanly deselects rather than leaving the gesture in limbo",
    (await selectionState(aliceRoom)).selectedTokenId === null
  );
  const aliceAfterReject = await tokenRow(aliceTokenId);
  check(
    "a rejected move never desyncs the token's displayed position",
    aliceAfterReject.x === aliceBeforeReject.x && aliceAfterReject.y === aliceBeforeReject.y,
    JSON.stringify({ before: aliceBeforeReject, after: aliceAfterReject })
  );
  check(
    "a rejected move's whole transaction rolls back — movement_used_feet is untouched too",
    (await combatantRow(aliceCombatantId)).movement_used_feet === 29
  );

  // ── 8. TokenPanel's separate armed-placement flow is unaffected. ──
  await dmRoom.fill('[data-testid="npc-name-input"]', "Click-Select Skeleton");
  await dmRoom.click('[data-testid="place-npc-button"]');
  let placedSkeleton = null;
  const placed = await scanGridClick(dmRoom, async () => {
    const { data } = await admin.from("map_tokens").select().eq("map_id", mapId).eq("npc_name", "Click-Select Skeleton");
    placedSkeleton = data?.[0] ?? null;
    return placedSkeleton !== null;
  });
  check(
    "the existing armed-placement flow (place-npc) still works unaffected",
    placed !== null && placedSkeleton !== null,
    JSON.stringify(placedSkeleton)
  );

  // ── 9. Ruler mode still swallows a token click outright — the same
  //    mutual exclusivity the old drag/measure gestures had. ──
  const goblinPointForRuler = await scanGridClick(dmRoom, async () => (await selectionState(dmRoom)).selectedTokenId === goblinTokenId);
  check("(sanity) the DM can select the goblin with ruler off", goblinPointForRuler !== null);
  await dmRoom.mouse.click(goblinPointForRuler.x, goblinPointForRuler.y);
  await sleep(250);
  check("(sanity) re-clicking deselects it", (await selectionState(dmRoom)).selectedTokenId === null);
  await dmRoom.click('[data-testid="ruler-toggle"]');
  await sleep(200);
  await dmRoom.mouse.click(goblinPointForRuler.x, goblinPointForRuler.y);
  await sleep(300);
  check(
    "with ruler mode active, clicking that exact same point does NOT select the token",
    (await selectionState(dmRoom)).selectedTokenId === null
  );
  await dmRoom.click('[data-testid="ruler-toggle"]');
} finally {
  await browser.close();
  await vite.close();
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
console.log("\nAll click-select checks passed.");
process.exit(0);
