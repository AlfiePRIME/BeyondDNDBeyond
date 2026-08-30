#!/usr/bin/env node
// Re-opened investigation: the project owner's report is specifically that
// "custom token models do not move after the map first loads, only the
// disc under them does, they also do not rotate." Two prior passes
// (ddccfa0, then the press-R-to-rotate feature itself) each found no
// reproduction, but neither closes the gap this script targets:
//
//   1. ddccfa0 (scripts/db/verify-pawn-move-click-select.mjs) moved a
//      modeled token via the real click-select gesture exactly ONCE per
//      phase — the report's own wording ("after the map first loads")
//      suggests the FIRST placement/move might render fine while a
//      SUBSEQUENT move is what actually desyncs. That script also predates
//      press-R-to-rotate entirely (git log: ddccfa0 is an ancestor of
//      3089321, the commit that wrapped the model/disc branches in a new
//      `rotationDeg` group) — so its "structurally identical" finding was
//      never re-confirmed against the CURRENT shape of TokenMarker's JSX.
//   2. scripts/db/verify-token-rotation.mjs (3089321) covers rotation, but
//      greps clean for `modelUrl`/`character_pawns`/`.glb` — it only ever
//      exercises a plain disc-fallback pawn. Rotation has NEVER been
//      verified against a model-backed token at all.
//   3. Every existing debug mirror (token-transform-state) reports the
//      useTokenSlide-driven group's OWN pose math — the exact thing that
//      hook itself just computed and wrote. It can't catch a desync
//      SPECIFIC to the model branch (a detached child, a stale cached
//      matrix, an R3F reconciliation quirk between the model's own node
//      and the slideRef/rotationDeg groups it's nested in) — proving that
//      requires reading the model's own node's real getWorldPosition/
//      getWorldQuaternion out of the live three.js scene graph, which is
//      what this investigation adds (TokenMarker's new onModelWorldDebug,
//      mirrored to data-testid="token-model-world-state").
//
// This script closes all three gaps at once: places a real uploaded .glb
// pawn model, then drives the real click-select-to-move gesture TWICE in
// sequence (not just once) and presses R TWICE in sequence, checking the
// MODEL's own actual rendered world transform (not just the hitbox/disc's)
// after every single step, with real screenshots before/after each one.
//
// Needs the shared Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, explicit, isolated port if it isn't already serving.
// Usage: node scripts/db/verify-pawn-model-transform-repeat.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { createServer } from "vite";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default, explicit port, confirmed free before use (this
// machine runs many concurrent agent worktrees, each potentially squatting
// on common ports with their OWN checkout's dev server) — grepped against
// every other verify-*.mjs script's own PORT constant at authoring time.
const APP_PORT = Number(process.env.PAWN_MODEL_TRANSFORM_REPEAT_APP_PORT ?? 4917);
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
// process.env directly — verify-crossing-structure-height.mjs's own
// documented fix for the exact "Missing NEXT_PUBLIC_SUPABASE_URL" throw
// vite's programmatically-created server otherwise hits.
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

// verify-crossing-structure-height.mjs/verify-pawn-move-click-select.mjs's
// own established lesson: DraggablePanel's floating panels default-anchor
// OVER parts of the 3D canvas, and TokenPanel's own "Remove" button (a real
// destructive action) sits inside the Tokens panel's default bottom-left
// anchor — a blind scanGridClick that clicks there instead of the canvas
// doesn't just miss, it can silently DELETE the token under test.
// Collapsing every panel removes every such target before a single click is
// ever thrown at the canvas.
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
  const email = `pawn-model-xform-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `PawnXform ${label}`,
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
const transformState = (page) => readMirror(page, "token-transform-state");
const modelWorldState = (page) => readMirror(page, "token-model-world-state");
const rotationState = (page) => readMirror(page, "token-rotation-state");

async function tokenRow(id) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

/** Same as tokenRow, but throws loudly with a clear diagnostic if the row is
 * gone — a scan click landing on a stray "Remove" button (or any other
 * destructive UI) deletes the row outright rather than just missing, which
 * otherwise surfaces as an opaque "Cannot read properties of null" many
 * lines later. Used everywhere a caller is about to dereference the result. */
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

/** Blind grid scan over the canvas — verify-token-click-select.mjs's own
 * `scanGridClick`, copied (with slightly more generous settle time: this
 * script talks to a HOSTED Supabase instance, not a local docker stack, so
 * a click's DB write can take longer to land than the original's tuning
 * assumed). No way to compute a WebGL raycast target from camera math, so
 * this discovers a working screen point empirically, center-out. */
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

/** Ensures `tokenId` is the current selection — checks first (re-clicking an
 * ALREADY-selected token's own point toggles it OFF, verify-token-rotation.
 * mjs's own established gotcha), tries the last-known screen point second
 * (cheap), and falls back to a full re-scan last — needed because a token's
 * screen position goes stale the moment it moves. */
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

function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}
function closeDeg(a, b, tolerance = 1.5) {
  const diff = Math.abs(normalizeDeg(a) - normalizeDeg(b));
  return Math.min(diff, 360 - diff) <= tolerance;
}
function closeTo(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

const UPLOAD_SOURCE_PATH = join(rootDir, "public", "assets", "presets", "witch.glb");

await ensureDevServer();

// The app's REAL mapFit.ts/MapSurface.tsx modules, loaded through vite the
// exact way verify-crossing-structure-height.mjs/verify-standable-objects.mjs
// already do — computeTableMapMetrics/mapCellOffsets are the SAME functions
// GameTableScene actually renders the live table with, so the "expected"
// world position below is derived from the real fit math, not a hand-
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
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const campaignId = crypto.randomUUID();

try {
  // ═══════════════════════════════════════════════════════════════════
  // Seed: one campaign (DM only, owning the PC the modeled token belongs
  // to — verify-pawn-move-click-select.mjs's own precedent, so a single
  // browser context can drive the whole click-select-move-rotate flow), a
  // flat GRIDxGRID map, and a real PC with a REAL uploaded custom pawn
  // model.
  // ═══════════════════════════════════════════════════════════════════
  await admin.from("campaigns").insert({ id: campaignId, name: "Pawn model transform repeat", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const characterId = crypto.randomUUID();
  const { error: characterError } = await admin.from("characters").insert({
    id: characterId,
    campaign_id: campaignId,
    owner_id: dm.id,
    name: "Repeat-Move Modeled PC",
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
    inventory: [],
    spells: [],
  });
  if (characterError) throw new Error(`seeding the PC: ${characterError.message}`);

  // Real .glb upload to the real character-pawns storage bucket, via the
  // admin/service-role client directly (never a blind UI click-scan) —
  // mirrors verify-pawn-move-click-select.mjs's own seeding exactly.
  const uploadBytes = readFileSync(UPLOAD_SOURCE_PATH);
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
  const { data: pawnRowCheck } = await admin
    .from("character_pawns")
    .select("pawn_model_ref")
    .eq("character_id", characterId)
    .single();
  check(
    "seed sanity: character_pawns.pawn_model_ref is set to the real uploaded .glb before the room ever loads",
    pawnRowCheck?.pawn_model_ref === pawnModelPath,
    pawnRowCheck
  );

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Pawn model transform arena",
    grid_width: GRID,
    grid_height: GRID,
  });
  const center = Math.floor(GRID / 2);
  const modeledTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: modeledTokenId, map_id: mapId, character_id: characterId, x: center, y: center, elevation: 0, allegiance: "party" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // The SAME real fit math GameTableScene renders the live table with —
  // used below to compute the model's own EXPECTED world x/z for each
  // grid cell it lands on, independent of anything TokenMarker/useTokenSlide
  // itself reports.
  const metrics = computeTableMapMetrics(GRID, GRID);
  const offsets = mapCellOffsets(GRID, GRID, metrics.cellSize);
  const expectedWorld = (gridX, gridY) => ({
    x: gridX * metrics.cellSize - offsets.offsetX,
    z: gridY * metrics.cellSize - offsets.offsetZ,
  });

  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  dmRoom.on("pageerror", (err) => console.error("  [page error]", err.message));

  await dmRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmRoom.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
  await dmRoom.waitForSelector("canvas", { timeout: 30000 });
  await sleep(1500);

  // ── Baseline: the model actually resolved and loaded before any move. ──
  const initialModelState = await pollUntil(async () => {
    const state = await modelState(dmRoom);
    return typeof state.modelUrlByTokenId[modeledTokenId] === "string" ? state : null;
  });
  check(
    "the modeled PC token resolves the real uploaded custom model on initial load",
    typeof initialModelState?.modelUrlByTokenId[modeledTokenId] === "string",
    initialModelState?.modelUrlByTokenId
  );
  const initialMeasured = await pollUntil(async () => {
    const state = await modelState(dmRoom);
    return state.measured?.[modeledTokenId]?.maxDim > 0 ? state : null;
  });
  check(
    "the modeled PC token's model ACTUALLY loaded in the real scene before any move (a genuine measured bounding box)",
    Boolean(initialMeasured?.measured?.[modeledTokenId]?.maxDim > 0),
    initialMeasured?.measured
  );

  // The model's own world transform mirror should already report an entry
  // for this token by now too — TokenMarker's rotationDeg effect reports it
  // once on mount, independent of useTokenSlide ever settling.
  const initialModelWorld = await pollUntil(async () => (await modelWorldState(dmRoom))[modeledTokenId] ?? null);
  check(
    "the model's own world-transform mirror reports an entry for the modeled token before any move",
    initialModelWorld !== null,
    initialModelWorld
  );

  const seenModelWorldByMove = [];

  /** Runs one full click-select-to-move gesture and returns the resulting
   * { tokenRow, transform, modelWorld } — used twice below, back to back,
   * to prove a SECOND move (not just the first) also lands correctly. */
  async function performMove(label, knownPoint) {
    const before = await requireTokenRow(modeledTokenId, `${label}: before`);
    await dmRoom.screenshot({ path: join(SCRATCH_DIR, `pawn-model-xform-${label}-before.png`) });
    console.log(`screenshot: ${join(SCRATCH_DIR, `pawn-model-xform-${label}-before.png`)}`);

    const selectedAt = await ensureSelected(dmRoom, modeledTokenId, knownPoint);
    check(`${label}: the modeled token can be click-selected`, selectedAt !== null);

    const destination = selectedAt
      ? await scanGridClick(
          dmRoom,
          async () => {
            const row = await tokenRow(modeledTokenId);
            return row.x !== before.x || row.y !== before.y;
          },
          {
            exclude: [{ ...selectedAt, radius: 16 }],
            onMiss: async () => {
              if ((await selectionState(dmRoom)).selectedTokenId !== modeledTokenId) {
                await dmRoom.mouse.click(selectedAt.x, selectedAt.y);
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

    await sleep(1000); // well past TOKEN_SLIDE_SECONDS (0.32s) — fully settled
    await dmRoom.screenshot({ path: join(SCRATCH_DIR, `pawn-model-xform-${label}-after.png`) });
    console.log(`screenshot: ${join(SCRATCH_DIR, `pawn-model-xform-${label}-after.png`)}`);

    const transform = await pollUntil(async () => {
      const state = await transformState(dmRoom);
      const entry = state[modeledTokenId];
      if (!entry) return null;
      return Math.round(entry.gridX) === after.x && Math.round(entry.gridY) === after.y ? entry : null;
    });
    check(
      `${label}: the outer group's own transform (token-transform-state) settles at the NEW cell`,
      transform !== null,
      { expected: { x: after.x, y: after.y }, lastSeen: await transformState(dmRoom).then((s) => s[modeledTokenId]) }
    );

    const expected = expectedWorld(after.x, after.y);
    const modelWorld = await pollUntil(async () => {
      const state = await modelWorldState(dmRoom);
      const entry = state[modeledTokenId];
      if (!entry) return null;
      return closeTo(entry.x, expected.x, 0.01) && closeTo(entry.z, expected.z, 0.01) ? entry : null;
    });
    check(
      `${label}: THE STRUCTURAL PROOF — the MODEL's own real rendered world position (not the outer group's, the model's own node) matches the new cell`,
      modelWorld !== null,
      { expected, lastSeen: await modelWorldState(dmRoom).then((s) => s[modeledTokenId]) }
    );

    const modelStateAfter = await modelState(dmRoom);
    check(
      `${label}: the model is still resolved and loaded (not vanished/unmounted) after the move`,
      typeof modelStateAfter.modelUrlByTokenId[modeledTokenId] === "string" &&
        Boolean(modelStateAfter.measured?.[modeledTokenId]?.maxDim > 0),
      { modelUrl: modelStateAfter.modelUrlByTokenId[modeledTokenId], measured: modelStateAfter.measured?.[modeledTokenId] }
    );

    if (modelWorld) seenModelWorldByMove.push({ label, world: modelWorld, gridX: after.x, gridY: after.y });
    return { row: after, point: destination };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1 — move #1: the real click-select-to-move gesture.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 1: modeled token, move #1 (click-select-to-move) ──");
  const move1 = await performMove("move1", null);

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2 — move #2, immediately after, in the SAME session (no reload):
  // the report's own wording ("after the map first loads") implies the
  // FIRST move might render fine while a SUBSEQUENT one desyncs — this is
  // the check that actually closes that specific gap.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 2: modeled token, move #2 (same session, right after move #1) ──");
  const move2 = await performMove("move2", move1.point);

  check(
    "move #1 and move #2 landed on genuinely DIFFERENT cells (a real second move happened, not a no-op)",
    move1.row.x !== move2.row.x || move1.row.y !== move2.row.y,
    { move1: move1.row, move2: move2.row }
  );
  if (seenModelWorldByMove.length === 2) {
    const [w1, w2] = seenModelWorldByMove;
    check(
      "the model's own real world x/z position actually DIFFERS between move #1 and move #2 (the model itself moved both times, not just the first)",
      !closeTo(w1.world.x, w2.world.x, 0.01) || !closeTo(w1.world.z, w2.world.z, 0.01),
      { move1: w1.world, move2: w2.world }
    );
    check(
      "the model's own real world Y (elevation) stayed constant across both moves (same map elevation, no vertical drift)",
      closeTo(w1.world.y, w2.world.y, 0.01),
      { move1: w1.world.y, move2: w2.world.y }
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 3 & 4 — press R TWICE in sequence, checking the MODEL's own real
  // rendered yaw (not just map_tokens.rotation) after EACH press.
  // ═══════════════════════════════════════════════════════════════════
  async function performRotate(label, knownPoint) {
    const before = await requireTokenRow(modeledTokenId, `${label}: before`);
    const selectedAt = await ensureSelected(dmRoom, modeledTokenId, knownPoint);
    check(`${label}: the modeled token can be click-selected for rotation`, selectedAt !== null);

    await dmRoom.screenshot({ path: join(SCRATCH_DIR, `pawn-model-xform-${label}-before.png`) });
    console.log(`screenshot: ${join(SCRATCH_DIR, `pawn-model-xform-${label}-before.png`)}`);

    await dmRoom.keyboard.press("r");
    await sleep(1000);

    const after = await requireTokenRow(modeledTokenId, `${label}: after`);
    const expectedRotation = ((before.rotation ?? 0) + 90) % 360;
    check(
      `${label}: pressing R rotates the persisted map_tokens.rotation by exactly 90`,
      after.rotation === expectedRotation,
      { before: before.rotation, after: after.rotation }
    );
    check(`${label}: the rotate did not move the token`, after.x === before.x && after.y === before.y);

    const rotState = await pollUntil(async () => {
      const state = await rotationState(dmRoom);
      return state[modeledTokenId] === after.rotation ? state : null;
    });
    check(
      `${label}: this client's own token-rotation-state mirror reflects the new rotation`,
      rotState !== null,
      { expected: after.rotation, lastSeen: (await rotationState(dmRoom))[modeledTokenId] }
    );

    const modelWorld = await pollUntil(async () => {
      const state = await modelWorldState(dmRoom);
      const entry = state[modeledTokenId];
      if (!entry) return null;
      return closeDeg(entry.yawDeg, after.rotation) ? entry : null;
    });
    check(
      `${label}: THE STRUCTURAL PROOF — the MODEL's own real rendered yaw (not the outer group's) matches the new rotation`,
      modelWorld !== null,
      { expectedRotationDeg: after.rotation, lastSeen: await modelWorldState(dmRoom).then((s) => s[modeledTokenId]) }
    );

    await dmRoom.screenshot({ path: join(SCRATCH_DIR, `pawn-model-xform-${label}-after.png`) });
    console.log(`screenshot: ${join(SCRATCH_DIR, `pawn-model-xform-${label}-after.png`)}`);

    return { row: after, point: selectedAt, modelWorld };
  }

  const rotationBeforeAnyPress = (await requireTokenRow(modeledTokenId, "before rotate1")).rotation ?? 0;

  console.log("\n── Phase 3: modeled token, rotate #1 (press R once) ──");
  const rotate1 = await performRotate("rotate1", move2.point);

  console.log("\n── Phase 4: modeled token, rotate #2 (press R again, same session) ──");
  const rotate2 = await performRotate("rotate2", rotate1.point);

  if (rotate1.modelWorld && rotate2.modelWorld) {
    check(
      "the model's own real rendered yaw actually CHANGED between rotate #1 and rotate #2 (the model itself rotated both times, not just the first)",
      !closeDeg(rotate1.modelWorld.yawDeg, rotate2.modelWorld.yawDeg),
      { rotate1: rotate1.modelWorld.yawDeg, rotate2: rotate2.modelWorld.yawDeg }
    );
  }
  check(
    "two presses in sequence land exactly 180 degrees on from the original value (not wrapped early, not stuck repeating the first press)",
    rotate2.row.rotation === (rotationBeforeAnyPress + 180) % 360,
    { original: rotationBeforeAnyPress, afterTwoPresses: rotate2.row.rotation }
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
