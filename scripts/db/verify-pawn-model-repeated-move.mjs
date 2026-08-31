#!/usr/bin/env node
// Re-opened a FOURTH time: the project owner gave a precise, fresh repro on
// PRODUCTION for a real character ("Robin URMum", campaign "The OfEngers"):
// "its the first move, the model spawns, then does not move from then" —
// i.e. the model renders correctly at spawn, the FIRST move after that
// works or doesn't matter, but move #2 onward never visually applies, while
// (per the owner's own screenshot) the disc/HP-bar/selection-ring overlay
// DOES keep updating live. Critically, "yes a refresh moves the model to
// the correct place" — so map_tokens.x/y is always correct; this is a pure
// client-side rendering desync, not a persistence bug.
//
// Three prior passes, read in full before writing this one, each closed a
// real gap but still found zero reproduction:
//
//   1. scripts/db/verify-pawn-model-transform-repeat.mjs (82567ed) — moved a
//      MODEL-backed token twice in a row and rotated it twice in a row,
//      reading the model's own real world transform (onModelWorldDebug/
//      modelWorldRef) after each step — 26/26 passing. But its uploaded
//      "custom" model was `public/assets/presets/witch.glb`, which (per
//      that script's own follow-up inspection) has ZERO skin data — totally
//      unrigged, unlike Robin's real pawn. And it only ever checked ONE
//      connected client (the mover's own local/optimistic-apply path).
//   2. scripts/db/verify-pawn-model-real-rig-long-session.mjs (01c6e68) —
//      closed both those gaps: downloaded Robin's ACTUAL uploaded pawn.glb
//      (a genuinely rigged, 448-node Rigify-style skeleton — PosedClone's
//      resolved-skeleton/AnimationMixer branch, never exercised on a MOVING
//      token before that script), and checked BOTH the mover's own client
//      AND a second, independently-connected client receiving the move
//      purely via the TOKEN_EVENT realtime broadcast. It drove FOUR
//      click-select-to-move gestures in the same session — so it did
//      technically re-check the model's world transform after a second,
//      third, and fourth move — but ALWAYS with an unrelated realtime event
//      (a chat message or an HP tick) interleaved between moves, and a
//      ~1.2s settle sleep on top of that. Still 0 reproduction, but it never
//      isolated the EXACT reported shape: two click-to-move gestures fired
//      back-to-back, with NOTHING else happening in between, checking
//      specifically whether the SECOND move (not the fourth, not the first)
//      is what gets stuck. That's the one remaining untested permutation of
//      "does the model actually track a second consecutive move."
//
// This script isolates exactly that: places Robin's real rigged model as an
// ordinary player's own PC pawn, opens both a DM client and that player's
// own client against the same live room, drives move #1 then IMMEDIATELY
// move #2 (no unrelated realtime traffic between them, just the minimum
// settle time past TOKEN_SLIDE_SECONDS), and checks the model's own real
// rendered world transform on BOTH clients after EACH move — with an
// explicit check that the model's world position after move #2 differs from
// after move #1 (the literal shape of "stuck at wherever it was after move
// #1"). It then also reloads BOTH clients after the stuck-or-not state and
// confirms the model renders at the correct (already-correct-in-DB)
// position post-reload — directly testing the owner's own reported
// diagnostic ("a refresh moves the model to the correct place") so the
// persistence layer is explicitly ruled in or out either way.
//
// Needs the real dev server (starts `yarn dev` itself if the target port
// isn't already serving, on an explicit, isolated, non-3000 port) and the
// real shared Supabase instance this project's .env points at.
// Usage: node scripts/db/verify-pawn-model-repeated-move.mjs

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { createServer } from "vite";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, explicit, non-default port — never 3000 (that's the real, live
// production server on this host) — cross-checked against every other
// verify-*.mjs script's own `_APP_PORT ?? <n>` constant at authoring time
// (nothing else in this directory uses 4939), and against the attack-
// weapon-spell-picker WIP script's own PORT (6531), which may be running
// concurrently in this same worktree.
const APP_PORT = Number(process.env.PAWN_MODEL_REPEATED_MOVE_APP_PORT ?? 4939);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

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

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

// mapFit.ts's module graph reaches MapSurface.tsx -> @/audio ->
// @/data-access/supabase-browser, whose top-level requireEnv() reads
// process.env directly — same fix every prior script in this family needed.
Object.assign(process.env, env);

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
    failures++;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`, { cache: "no-store" }).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on :${APP_PORT} — starting this worktree's own…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${APP_PORT} within 150s`);
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

const COLLAPSED_PANEL_LAYOUT = Object.fromEntries(
  [
    "map",
    "tokens",
    "combat",
    "opportunityAttack",
    "quickActions",
    "diceLog",
    "handout",
    "diceTray",
    "hp",
    "liveObjects",
    "chatLog",
  ].map((id) => [id, { collapsed: true, x: 0, y: 0 }])
);

async function makeTestUser(label) {
  const email = `pawn-repeat-move-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `PawnRepeatMove ${label}`,
    ui_preferences: { panelLayout: COLLAPSED_PANEL_LAYOUT },
  });
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
const modelState = (page) => readMirror(page, "token-model-state");
const modelWorldState = (page) => readMirror(page, "token-model-world-state");

async function tokenRow(id) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}
async function requireTokenRow(id, label) {
  const row = await tokenRow(id);
  if (!row) throw new Error(`${label}: map_tokens row ${id} is GONE (likely deleted by a stray scan click) — aborting`);
  return row;
}

async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

async function scanGridClick(page, done, opts = {}) {
  const { xFrom = 0.12, xTo = 0.88, yFrom = 0.24, yTo = 0.7, step = 30, settleMs = 350, onMiss, exclude = [] } = opts;
  let box = await page.locator("canvas").boundingBox();
  const viewport = page.viewportSize();
  const minSize = viewport ? Math.min(viewport.width, viewport.height) * 0.5 : 400;
  for (let i = 0; i < 20 && (!box || box.width < minSize || box.height < minSize); i++) {
    await sleep(200);
    box = await page.locator("canvas").boundingBox();
  }
  if (!box) throw new Error("no canvas on the page");
  for (const [offset, settle] of [
    [0, settleMs],
    [step / 2, settleMs * 1.4],
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
      if (exclude.some((e) => Math.hypot(e.x - point.x, e.y - point.y) < (e.radius ?? 20))) continue;
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) return point;
      if (onMiss) await onMiss(point);
    }
  }
  return null;
}

async function ensureSelected(page, tokenId, knownPoint) {
  const state = await selectionState(page);
  if (state.selectedTokenId === tokenId) return knownPoint ?? null;
  if (knownPoint) {
    await page.mouse.click(knownPoint.x, knownPoint.y);
    await sleep(300);
    if ((await selectionState(page)).selectedTokenId === tokenId) return knownPoint;
  }
  return scanGridClick(page, async () => (await selectionState(page)).selectedTokenId === tokenId);
}

function closeTo(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

// Robin URMum's REAL pawn.glb — byte-for-byte the same file reported stuck
// in real play (character id d3040bec-7f36-4fa1-bcf1-0811b10a41f5). Same
// download/cache mechanism as verify-pawn-model-real-rig-long-session.mjs,
// reused verbatim rather than re-invented: a real skinned + 448-node-rigged
// model, downloaded live from the real character-pawns bucket every run (no
// manual pre-staged copy), cached locally only to skip a redundant re-fetch
// within one debugging session.
const REAL_RIG_CHARACTER_ID = "d3040bec-7f36-4fa1-bcf1-0811b10a41f5";
const REAL_RIG_STORAGE_PATH = `${REAL_RIG_CHARACTER_ID}/pawn.glb`;
const REAL_RIG_CACHE_PATH = join(SCRATCH_DIR, "robin-pawn.glb");
if (!existsSync(REAL_RIG_CACHE_PATH)) {
  console.log(`Downloading the real rigged pawn model from character-pawns/${REAL_RIG_STORAGE_PATH}…`);
  const { data: realRigBlob, error: realRigError } = await admin.storage
    .from("character-pawns")
    .download(REAL_RIG_STORAGE_PATH);
  if (realRigError) {
    console.error(
      `Could not download the real rigged pawn model (character-pawns/${REAL_RIG_STORAGE_PATH}): ${realRigError.message}. ` +
        "This script depends on that specific real character's own uploaded model still existing at that path — " +
        "if it's been deleted or replaced, this investigation's own premise (testing the EXACT reported model) no longer holds."
    );
    process.exit(1);
  }
  writeFileSync(REAL_RIG_CACHE_PATH, Buffer.from(await realRigBlob.arrayBuffer()));
}
const REAL_RIG_PATH = REAL_RIG_CACHE_PATH;

await ensureDevServer();

// The app's REAL mapFit.ts/MapSurface.tsx modules, loaded through vite —
// computeTableMapMetrics/mapCellOffsets are the SAME functions
// GameTableScene actually renders the live table with, so "expected" world
// positions below are derived from the real fit math, never a hand-
// re-derived duplicate that could silently drift out of sync.
const vite = await createServer({
  root: rootDir,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  resolve: { alias: { "@": join(rootDir, "src") } },
});
const mapFitModule = await vite.ssrLoadModule("/src/scene-3d/mapFit.ts");
const mapSurfaceModule = await vite.ssrLoadModule("/src/scene-3d/MapSurface.tsx");
const { computeTableMapMetrics } = mapFitModule;
const { mapCellOffsets } = mapSurfaceModule;

const GRID = 9;
const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const campaignId = crypto.randomUUID();
const pageErrors = { dm: [], player: [] };

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Pawn repeated move", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  // The character belongs to the PLAYER (not the DM) — matching the real
  // report exactly: a player's own PC, not the DM's.
  const characterId = crypto.randomUUID();
  const { error: characterError } = await admin.from("characters").insert({
    id: characterId,
    campaign_id: campaignId,
    owner_id: player.id,
    name: "Repeated-Move Modeled PC",
    race: "Dragonborn",
    class: "Rogue",
    level: 3,
    strength: 10,
    dexterity: 16,
    constitution: 15,
    intelligence: 14,
    wisdom: 12,
    charisma: 13,
    current_hp: 24,
    max_hp: 24,
    armor_class: 14,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });
  if (characterError) throw new Error(`seeding the PC: ${characterError.message}`);

  const uploadBytes = readFileSync(REAL_RIG_PATH);
  const pawnModelPath = `${characterId}/pawn.glb`;
  const { error: uploadError } = await admin.storage
    .from("character-pawns")
    .upload(pawnModelPath, uploadBytes, { contentType: "model/gltf-binary", upsert: true });
  if (uploadError) throw new Error(`uploading the real pawn model: ${uploadError.message}`);
  const { error: pawnRowError } = await admin
    .from("character_pawns")
    .update({ pawn_model_ref: pawnModelPath })
    .eq("character_id", characterId);
  if (pawnRowError) throw new Error(`setting pawn_model_ref: ${pawnRowError.message}`);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Repeated-move arena",
    grid_width: GRID,
    grid_height: GRID,
  });
  const center = Math.floor(GRID / 2);
  const modeledTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: modeledTokenId, map_id: mapId, character_id: characterId, x: center, y: center, elevation: 0, allegiance: "party" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const metrics = computeTableMapMetrics(GRID, GRID);
  const offsets = mapCellOffsets(GRID, GRID, metrics.cellSize);
  const expectedWorld = (gridX, gridY) => ({
    x: gridX * metrics.cellSize - offsets.offsetX,
    z: gridY * metrics.cellSize - offsets.offsetZ,
  });

  // ── Two independently-connected clients, watching the SAME live room. ──
  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  dmRoom.on("pageerror", (err) => {
    pageErrors.dm.push(err.message);
    console.error("  [dm page error]", err.message);
  });

  const playerContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await playerContext.addCookies(sessionCookies(player.session));
  const playerRoom = await playerContext.newPage();
  playerRoom.on("pageerror", (err) => {
    pageErrors.player.push(err.message);
    console.error("  [player page error]", err.message);
  });

  await Promise.all([
    dmRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`),
    playerRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`),
  ]);
  await Promise.all([
    dmRoom.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 }),
    playerRoom.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 }),
  ]);
  await Promise.all([
    dmRoom.waitForSelector("canvas", { timeout: 30000 }),
    playerRoom.waitForSelector("canvas", { timeout: 30000 }),
  ]);
  await sleep(2000);

  // ── Baseline on BOTH clients: the REAL rigged model actually resolved and
  // genuinely rendered (a real measured bounding box) before any move. ──
  async function checkBaseline(label, page) {
    const initialModelState = await pollUntil(async () => {
      const state = await modelState(page);
      return typeof state.modelUrlByTokenId[modeledTokenId] === "string" ? state : null;
    });
    check(
      `[${label}] the real-rig PC token resolves the real uploaded custom model on initial load`,
      typeof initialModelState?.modelUrlByTokenId[modeledTokenId] === "string",
      initialModelState?.modelUrlByTokenId
    );
    const initialMeasured = await pollUntil(
      async () => {
        const state = await modelState(page);
        return state.measured?.[modeledTokenId]?.maxDim > 0 ? state : null;
      },
      { timeoutMs: 20000 }
    );
    check(
      `[${label}] the real-rig model ACTUALLY loaded and rendered (not swallowed into the error-boundary placeholder)`,
      Boolean(initialMeasured?.measured?.[modeledTokenId]?.maxDim > 0),
      initialMeasured?.measured
    );
    const spawnCell = await requireTokenRow(modeledTokenId, `${label}: spawn`);
    const spawnExpected = expectedWorld(spawnCell.x, spawnCell.y);
    const initialModelWorld = await pollUntil(async () => {
      const state = await modelWorldState(page);
      const entry = state[modeledTokenId];
      if (!entry) return null;
      return closeTo(entry.x, spawnExpected.x, 0.01) && closeTo(entry.z, spawnExpected.z, 0.01) ? entry : null;
    });
    check(
      `[${label}] the model's own world-transform mirror reports the token at its SPAWN cell before any move`,
      initialModelWorld !== null,
      { expected: spawnExpected, lastSeen: await modelWorldState(page).then((s) => s[modeledTokenId]) }
    );
  }
  await checkBaseline("dm", dmRoom);
  await checkBaseline("player", playerRoom);

  let playerKnownPoint = null;
  const seenModelWorldByMove = { dm: {}, player: {} };

  /** One full click-select-to-move gesture, driven from the PLAYER's own
   * client (matching the real report: a player's own PC) — confirms BOTH
   * the mover's own client (local, optimistic path) AND the DM's
   * independently-connected client (pure TOKEN_EVENT broadcast receive
   * path) show the model's own real rendered world position at the new
   * cell afterward. Records each client's seen world transform into
   * seenModelWorldByMove so the caller can directly compare move #1 vs
   * move #2 (the exact "stuck after the first move" shape). */
  async function performMove(label) {
    const before = await requireTokenRow(modeledTokenId, `${label}: before`);
    await playerRoom.screenshot({ path: join(SCRATCH_DIR, `repeat-move-${label}-player-before.png`) });

    const selectedAt = await ensureSelected(playerRoom, modeledTokenId, playerKnownPoint);
    check(`${label}: the modeled token can be click-selected (player)`, selectedAt !== null);

    const destination = selectedAt
      ? await scanGridClick(
          playerRoom,
          async () => {
            const row = await tokenRow(modeledTokenId);
            return row.x !== before.x || row.y !== before.y;
          },
          {
            exclude: [{ ...selectedAt, radius: 16 }],
            onMiss: async () => {
              if ((await selectionState(playerRoom)).selectedTokenId !== modeledTokenId) {
                await playerRoom.mouse.click(selectedAt.x, selectedAt.y);
                await sleep(300);
              }
            },
          }
        )
      : null;

    const after = await requireTokenRow(modeledTokenId, `${label}: after`);
    check(
      `${label}: confirming the click on a destination cell actually relocates the modeled token in the DB`,
      destination !== null && (after.x !== before.x || after.y !== before.y),
      { before, after }
    );
    playerKnownPoint = destination;

    // Just past TOKEN_SLIDE_SECONDS (0.32s) on both clients — deliberately
    // NOT interleaved with any unrelated realtime traffic (no chat message,
    // no HP tick) between moves, unlike verify-pawn-model-real-rig-long-
    // session.mjs's own 4-move sequence — isolating whether an unrelated
    // realtime event happening to land between moves was ever masking a
    // genuine back-to-back-move desync.
    await sleep(1200);
    await dmRoom.screenshot({ path: join(SCRATCH_DIR, `repeat-move-${label}-dm-after.png`) });
    await playerRoom.screenshot({ path: join(SCRATCH_DIR, `repeat-move-${label}-player-after.png`) });

    const expected = expectedWorld(after.x, after.y);
    for (const [clientKey, clientLabel, page] of [
      ["player", "player (local/optimistic)", playerRoom],
      ["dm", "DM (remote/broadcast)", dmRoom],
    ]) {
      const modelWorld = await pollUntil(async () => {
        const state = await modelWorldState(page);
        const entry = state[modeledTokenId];
        if (!entry) return null;
        return closeTo(entry.x, expected.x, 0.01) && closeTo(entry.z, expected.z, 0.01) ? entry : null;
      });
      check(
        `${label} [${clientLabel}]: THE STRUCTURAL PROOF — the real-rig MODEL's own rendered world position matches the new cell (not stuck at a prior move's position)`,
        modelWorld !== null,
        { expected, lastSeen: await modelWorldState(page).then((s) => s[modeledTokenId]) }
      );
      if (modelWorld) seenModelWorldByMove[clientKey][label] = modelWorld;
      const modelStateAfter = await modelState(page);
      check(
        `${label} [${clientLabel}]: the model is still resolved and loaded (not vanished/unmounted) after the move`,
        typeof modelStateAfter.modelUrlByTokenId[modeledTokenId] === "string" &&
          Boolean(modelStateAfter.measured?.[modeledTokenId]?.maxDim > 0),
        { modelUrl: modelStateAfter.modelUrlByTokenId[modeledTokenId], measured: modelStateAfter.measured?.[modeledTokenId] }
      );
    }

    return { row: after };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Move #1, then move #2 IMMEDIATELY after — the exact reported shape:
  // "the model spawns, then does not move from then [after the first
  // move]." Nothing else happens between these two calls.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Move #1 ──");
  const move1 = await performMove("move1");

  console.log("\n── Move #2 (immediately after move #1, no interleaved traffic) ──");
  const move2 = await performMove("move2");

  check(
    "move #1 and move #2 landed on genuinely DIFFERENT cells (a real second move happened, not a no-op)",
    move1.row.x !== move2.row.x || move1.row.y !== move2.row.y,
    { move1: move1.row, move2: move2.row }
  );

  for (const clientKey of ["player", "dm"]) {
    const w1 = seenModelWorldByMove[clientKey].move1;
    const w2 = seenModelWorldByMove[clientKey].move2;
    if (!w1 || !w2) continue;
    check(
      `[${clientKey}] THE EXACT REPORTED-BUG CHECK — the model's own real world position after move #2 actually DIFFERS from after move #1 (i.e. it is NOT stuck at wherever it landed after the first move)`,
      !closeTo(w1.x, w2.x, 0.01) || !closeTo(w1.z, w2.z, 0.01),
      { afterMove1: w1, afterMove2: w2 }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // The owner's own diagnostic: "yes a refresh moves the model to the
  // correct place." Reload BOTH clients now (whatever state move #2 left
  // them in) and confirm the model re-renders at the CORRECT, already-
  // correct-in-DB position — this either confirms the persistence layer
  // was never the problem (a pure client-side render desync), or, if this
  // somehow also fails, means the bug is deeper than the reported symptom.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Reload check: does a fresh page load show the model at the correct (DB) position? ──");
  const dbRowBeforeReload = await requireTokenRow(modeledTokenId, "before reload");
  const expectedAfterReload = expectedWorld(dbRowBeforeReload.x, dbRowBeforeReload.y);

  await Promise.all([dmRoom.reload(), playerRoom.reload()]);
  await Promise.all([
    dmRoom.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 }),
    playerRoom.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 }),
  ]);
  await Promise.all([
    dmRoom.waitForSelector("canvas", { timeout: 30000 }),
    playerRoom.waitForSelector("canvas", { timeout: 30000 }),
  ]);
  await sleep(2000);

  for (const [clientLabel, page] of [["dm", dmRoom], ["player", playerRoom]]) {
    const measuredAfterReload = await pollUntil(
      async () => {
        const state = await modelState(page);
        return state.measured?.[modeledTokenId]?.maxDim > 0 ? state : null;
      },
      { timeoutMs: 20000 }
    );
    check(
      `[${clientLabel}] after reload: the real-rig model loaded again (not swallowed into the placeholder)`,
      Boolean(measuredAfterReload?.measured?.[modeledTokenId]?.maxDim > 0),
      measuredAfterReload?.measured
    );
    const modelWorldAfterReload = await pollUntil(async () => {
      const state = await modelWorldState(page);
      const entry = state[modeledTokenId];
      if (!entry) return null;
      return closeTo(entry.x, expectedAfterReload.x, 0.01) && closeTo(entry.z, expectedAfterReload.z, 0.01) ? entry : null;
    });
    check(
      `[${clientLabel}] after reload: the model renders at the CORRECT, already-correct-in-DB position (confirms this is a pure render desync, not a persistence bug — matching the owner's own reported diagnostic)`,
      modelWorldAfterReload !== null,
      { expected: expectedAfterReload, lastSeen: await modelWorldState(page).then((s) => s[modeledTokenId]) }
    );
  }
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "repeat-move-after-reload-dm.png") });
  await playerRoom.screenshot({ path: join(SCRATCH_DIR, "repeat-move-after-reload-player.png") });

  check("no uncaught page errors on the DM client across the whole session", pageErrors.dm.length === 0, pageErrors.dm);
  check(
    "no uncaught page errors on the player client across the whole session",
    pageErrors.player.length === 0,
    pageErrors.player
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
} catch (err) {
  console.error("\nUnexpected error:", err);
  failures++;
} finally {
  try {
    await admin.from("campaigns").delete().eq("id", campaignId);
  } catch {
    // best-effort cleanup only
  }
  await admin.auth.admin.deleteUser(dm.id).catch(() => {});
  await admin.auth.admin.deleteUser(player.id).catch(() => {});
  await browser.close().catch(() => {});
  await vite.close().catch(() => {});
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
