#!/usr/bin/env node
// Investigation: the project owner reports "the custom model for character
// doesn't move when the pawn is moved". A prior research pass reproduced
// nothing via the Tokens panel's MOVE button (a completely different UI
// entry point — TokenPanel's armed "move" kind, handleCellClick,
// moveMapToken) and confirmed the rendering chain (TokenMarker's
// <group ref={slideRef}>, useTokenSlide) is structurally identical for a
// modeled token and a plain disc token. That pass never tried the ACTUAL
// gesture the owner uses: MapPlan P12's click-select-the-token, then
// click-the-destination-cell-to-confirm flow (handleTokenSelect /
// handleSelectedTokenCellClick / commitTokenMove in GameRoom.tsx) — this
// script does exactly that, with REAL Playwright mouse clicks on the REAL
// 3D canvas (scanGridClick, verify-token-click-select.mjs's own established
// precedent — no way to compute a WebGL raycast target from camera math),
// on a REAL character with a REAL uploaded custom pawn model (mirrors
// verify-pawn-customization.mjs's own seeding: a real .glb uploaded to the
// character-pawns storage bucket, character_pawns.pawn_model_ref set to
// point at it), compared side-by-side against a plain disc NPC token on the
// SAME map through the IDENTICAL gesture.
//
// Verified two ways per move, not just "the DB row changed":
//   1. The DB row actually relocated (map_tokens.x/y).
//   2. The token's own ACTUAL rendered transform (the hidden
//      token-transform-state mirror, extended by this investigation to
//      report gridX/gridY — see useTokenSlide.ts's onSettled doc comment)
//      settles at the NEW cell, not left at the old one — a structural
//      proof that the group useTokenSlide imperatively writes onto every
//      frame really did move, not just that the React props changed.
// Also checked: the model is still resolved and actually loaded (a genuine
// measured bounding box, token-model-state's own `measured` field) AFTER
// the move — ruling out "the model quietly unmounted/disappeared" as a
// distinct failure mode from "the model didn't move".
//
// A second phase repeats the same click-select-then-click-cell gesture with
// the modeled token as the CURRENT TRACKED COMBATANT (a real
// combat_combatants row, current_turn_index pointed at it) — the one code
// path unique to this gesture that the Tokens-panel MOVE button never
// exercises at all (reachableCellSetForToken / computeReachableCells),
// since the task's own investigation asked whether that computation reads
// a stale copy of the token list specifically for a modeled token.
//
// Needs the shared Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, explicit, isolated port if it isn't already serving.
// Usage: node scripts/db/verify-pawn-move-click-select.mjs

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
// on common ports with their OWN checkout's dev server).
const APP_PORT = Number(process.env.PAWN_MOVE_CLICK_SELECT_APP_PORT ?? 4791);
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

// verify-crossing-structure-height.mjs/verify-bridges-and-stairs.mjs's own
// established lesson: DraggablePanel's floating panels (Tokens/Combat/Map/
// etc.) default-anchor OVER parts of the 3D canvas, and TokenPanel's own
// "Remove" button (a real destructive action) sits inside the Tokens
// panel's default bottom-left anchor — a blind scanGridClick that clicks
// there instead of the canvas doesn't just miss, it can silently DELETE the
// token under test (this script's own first real run hit exactly that: the
// modeled token vanished from map_tokens mid-scan). Collapsing EVERY panel
// (not just the historical precedent's subset) removes every such target
// before a single click is ever thrown at the canvas.
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
  const email = `pawn-move-click-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `PawnMove ${label}`,
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
  // Bounds match verify-token-click-select.mjs's own tuning exactly — narrow
  // enough to stay clear of the collapsed-panel cluster docked at (0,0) and
  // any top-bar chrome, even though every panel is collapsed (see
  // COLLAPSED_PANEL_LAYOUT's own doc comment for why that alone isn't
  // treated as sufficient — belt and suspenders).
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

/** Re-arms a selection this scan may have accidentally knocked out (e.g. by
 * re-hitting the token's own point, which toggles it OFF) — the
 * verify-token-click-select.mjs precedent. */
function reselectOnMiss(page, tokenId, tokenPoint) {
  return async () => {
    const state = await selectionState(page);
    if (state.selectedTokenId !== tokenId) {
      await page.mouse.click(tokenPoint.x, tokenPoint.y);
      await sleep(300);
    }
  };
}

const UPLOAD_SOURCE_PATH = join(rootDir, "public", "assets", "presets", "witch.glb");

await ensureDevServer();

// The app's REAL rules-engine module, loaded through vite the exact same
// way verify-token-click-select.mjs/verify-crossing-structure-height.mjs do
// — the reachable-cells expectation in Phase 3 is computed with the SAME
// code the Game Room ships. movement.ts is a leaf module (no imports of its
// own), so unlike those two precedents this script needs no `@/*` alias
// resolution.
const vite = await createServer({
  root: rootDir,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
});
const movementRules = await vite.ssrLoadModule("/src/rules-engine/movement.ts");

function denseNormalCells(width, height) {
  const cells = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) cells.push({ position: { x, y }, terrain: "normal", elevationSteps: 0 });
  }
  return cells;
}
function cellKey(x, y) {
  return `${x},${y}`;
}

const GRID = 7;
const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const campaignId = crypto.randomUUID();

try {
  // ═══════════════════════════════════════════════════════════════════
  // Seed: one campaign (DM only — the DM also owns the PC used for the
  // modeled token, so a single browser context can drive both the
  // click-select gesture and the DM-only reachable-cell combat check
  // without a second account), a flat GRIDxGRID map (no map_cells rows —
  // every cell defaults to normal/elevation 0, the verify-token-click-
  // select.mjs precedent), a real PC with a REAL uploaded custom pawn
  // model, and a plain NPC (disc) token as the direct comparison baseline.
  // ═══════════════════════════════════════════════════════════════════
  await admin.from("campaigns").insert({ id: campaignId, name: "Pawn move click-select repro", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const characterId = crypto.randomUUID();
  const { error: characterError } = await admin.from("characters").insert({
    id: characterId,
    campaign_id: campaignId,
    owner_id: dm.id,
    name: "Modeled Pawn PC",
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
  // admin/service-role client directly — never a blind UI click-scan (this
  // project's own established lesson) — then character_pawns.pawn_model_ref
  // pointed at it, mirroring verify-pawn-customization.mjs's own seeding of
  // "a real character with a real uploaded custom pawn model".
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
    name: "Pawn move click-select arena",
    grid_width: GRID,
    grid_height: GRID,
  });
  const center = Math.floor(GRID / 2);
  const modeledTokenId = crypto.randomUUID();
  const discTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: modeledTokenId, map_id: mapId, character_id: characterId, x: center - 2, y: center, elevation: 0, allegiance: "party" },
    { id: discTokenId, map_id: mapId, npc_name: "Plain Disc Bystander", x: center + 2, y: center, elevation: 0, allegiance: "neutral" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  dmRoom.on("pageerror", (err) => console.error("  [page error]", err.message));

  async function loadRoom() {
    await dmRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await dmRoom.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
    await dmRoom.waitForSelector("canvas", { timeout: 30000 });
  }
  await loadRoom();
  await sleep(1500);

  const initialModelState = await pollUntil(async () => {
    const state = await modelState(dmRoom);
    return typeof state.modelUrlByTokenId[modeledTokenId] === "string" ? state : null;
  });
  check(
    "the modeled PC token resolves the real uploaded custom model on initial load (not null, not the disc)",
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
  check(
    "the comparison NPC token has no model — the plain disc, as intended",
    initialModelState?.modelUrlByTokenId[discTokenId] === null,
    initialModelState?.modelUrlByTokenId
  );

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1 — THE REAL GESTURE, no combat: click-select the MODELED token
  // on the actual 3D canvas, then click a destination cell to confirm.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 1: modeled token, click-select-to-move (no combat) ──");
  const modeledBefore1 = await tokenRow(modeledTokenId);
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "pawn-move-modeled-before.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "pawn-move-modeled-before.png")}`);

  const modeledPoint1 = await scanGridClick(dmRoom, async () => (await selectionState(dmRoom)).selectedTokenId === modeledTokenId);
  check("the modeled token can be click-selected on the real canvas", modeledPoint1 !== null);

  const modeledMoved1 = modeledPoint1
    ? await scanGridClick(
        dmRoom,
        async () => {
          const row = await tokenRow(modeledTokenId);
          return row.x !== modeledBefore1.x || row.y !== modeledBefore1.y;
        },
        { exclude: [{ ...modeledPoint1, radius: 16 }], onMiss: reselectOnMiss(dmRoom, modeledTokenId, modeledPoint1) }
      )
    : null;
  const modeledAfter1 = await requireTokenRow(modeledTokenId, "after Phase 1 modeled-token move");
  check(
    "confirming the click on a destination cell actually relocates the modeled token in the DB",
    modeledMoved1 !== null && (modeledAfter1.x !== modeledBefore1.x || modeledAfter1.y !== modeledBefore1.y),
    { before: modeledBefore1, after: modeledAfter1 }
  );

  await sleep(1000); // well past TOKEN_SLIDE_SECONDS (0.32s) — fully settled
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "pawn-move-modeled-after.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "pawn-move-modeled-after.png")}`);

  const modeledTransform1 = await pollUntil(async () => {
    const state = await transformState(dmRoom);
    const entry = state[modeledTokenId];
    if (!entry) return null;
    return Math.round(entry.gridX) === modeledAfter1.x && Math.round(entry.gridY) === modeledAfter1.y ? entry : null;
  });
  check(
    "THE STRUCTURAL PROOF: the modeled token's own ACTUAL rendered transform (not just the DB row) settles at the NEW cell",
    modeledTransform1 !== null,
    { expected: { x: modeledAfter1.x, y: modeledAfter1.y }, lastSeen: await transformState(dmRoom).then((s) => s[modeledTokenId]) }
  );

  const modelStateAfter1 = await modelState(dmRoom);
  check(
    "the model is still resolved (not vanished/unmounted) after the move",
    typeof modelStateAfter1.modelUrlByTokenId[modeledTokenId] === "string",
    modelStateAfter1.modelUrlByTokenId
  );
  check(
    "the model is still ACTUALLY loaded (measured bounding box) after the move",
    Boolean(modelStateAfter1.measured?.[modeledTokenId]?.maxDim > 0),
    modelStateAfter1.measured
  );

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2 — the SAME exact gesture on the plain disc token, on the SAME
  // map — the direct comparison baseline.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 2: plain disc token, click-select-to-move (no combat) — comparison baseline ──");
  const discBefore1 = await tokenRow(discTokenId);
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "pawn-move-disc-before.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "pawn-move-disc-before.png")}`);

  const discPoint1 = await scanGridClick(dmRoom, async () => (await selectionState(dmRoom)).selectedTokenId === discTokenId);
  check("the plain disc token can be click-selected on the real canvas", discPoint1 !== null);

  const discMoved1 = discPoint1
    ? await scanGridClick(
        dmRoom,
        async () => {
          const row = await tokenRow(discTokenId);
          return row.x !== discBefore1.x || row.y !== discBefore1.y;
        },
        { exclude: [{ ...discPoint1, radius: 16 }], onMiss: reselectOnMiss(dmRoom, discTokenId, discPoint1) }
      )
    : null;
  const discAfter1 = await requireTokenRow(discTokenId, "after Phase 2 disc-token move");
  check(
    "confirming the click on a destination cell actually relocates the disc token in the DB",
    discMoved1 !== null && (discAfter1.x !== discBefore1.x || discAfter1.y !== discBefore1.y),
    { before: discBefore1, after: discAfter1 }
  );

  await sleep(1000);
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "pawn-move-disc-after.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "pawn-move-disc-after.png")}`);

  const discTransform1 = await pollUntil(async () => {
    const state = await transformState(dmRoom);
    const entry = state[discTokenId];
    if (!entry) return null;
    return Math.round(entry.gridX) === discAfter1.x && Math.round(entry.gridY) === discAfter1.y ? entry : null;
  });
  check(
    "the disc token's own ACTUAL rendered transform settles at the NEW cell (comparison baseline)",
    discTransform1 !== null,
    { expected: { x: discAfter1.x, y: discAfter1.y }, lastSeen: await transformState(dmRoom).then((s) => s[discTokenId]) }
  );
  check(
    "regression guard: the disc token never gained a model from being moved",
    (await modelState(dmRoom)).modelUrlByTokenId[discTokenId] === null
  );

  // ═══════════════════════════════════════════════════════════════════
  // Phase 3 — the modeled token as the CURRENT TRACKED COMBATANT: the one
  // code path this gesture exercises that the Tokens-panel MOVE button
  // never touches at all (reachableCellSetForToken / computeReachableCells)
  // — checks whether that computation (or the highlighted-cell click-
  // confirm gating built on top of it) reads a stale copy of the token
  // list specifically for a modeled token.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 3: modeled token as the current tracked combatant (reachable-cell highlight path) ──");
  await admin.from("campaigns").update({ action_economy_strict: true }).eq("id", campaignId);
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  const modeledCombatantId = crypto.randomUUID();
  await admin.from("combat_combatants").insert([
    { id: modeledCombatantId, encounter_id: encounterId, token_id: modeledTokenId, character_id: characterId, initiative: 20 },
  ]);
  await loadRoom();
  await sleep(1500);

  const modeledBefore2 = await tokenRow(modeledTokenId);
  const modeledPoint2 = await scanGridClick(dmRoom, async () => (await selectionState(dmRoom)).selectedTokenId === modeledTokenId);
  check("(tracked turn) the modeled token can still be click-selected", modeledPoint2 !== null);
  const modeledSelected2 = await selectionState(dmRoom);
  const expectedReachable = new Set(
    movementRules
      .computeReachableCells({
        origin: { x: modeledBefore2.x, y: modeledBefore2.y },
        cells: denseNormalCells(GRID, GRID),
        budgetFeet: 30,
        occupiedCells: [{ x: discAfter1.x, y: discAfter1.y }],
      })
      .map((p) => cellKey(p.x, p.y))
  );
  check(
    "the tracked/budgeted highlight for the MODELED token matches the real computeReachableCells exactly (not a stale token list)",
    modeledSelected2.reachableCells !== null &&
      modeledSelected2.reachableCells.length === expectedReachable.size &&
      modeledSelected2.reachableCells.every((key) => expectedReachable.has(key)),
    { got: modeledSelected2.reachableCells?.length, want: expectedReachable.size }
  );

  const modeledMoved2 = modeledPoint2
    ? await scanGridClick(
        dmRoom,
        async () => {
          const row = await tokenRow(modeledTokenId);
          return row.x !== modeledBefore2.x || row.y !== modeledBefore2.y;
        },
        { exclude: [{ ...modeledPoint2, radius: 16 }], onMiss: reselectOnMiss(dmRoom, modeledTokenId, modeledPoint2) }
      )
    : null;
  const modeledAfter2 = await requireTokenRow(modeledTokenId, "after Phase 3 tracked modeled-token move");
  check(
    "confirming a move through the reachable-cell highlight actually relocates the modeled token",
    modeledMoved2 !== null && (modeledAfter2.x !== modeledBefore2.x || modeledAfter2.y !== modeledBefore2.y),
    { before: modeledBefore2, after: modeledAfter2 }
  );

  await sleep(1000);
  const modeledTransform2 = await pollUntil(async () => {
    const state = await transformState(dmRoom);
    const entry = state[modeledTokenId];
    if (!entry) return null;
    return Math.round(entry.gridX) === modeledAfter2.x && Math.round(entry.gridY) === modeledAfter2.y ? entry : null;
  });
  check(
    "the modeled token's ACTUAL rendered transform settles at the new cell after a TRACKED move too",
    modeledTransform2 !== null,
    { expected: { x: modeledAfter2.x, y: modeledAfter2.y }, lastSeen: await transformState(dmRoom).then((s) => s[modeledTokenId]) }
  );
  const modelStateAfter2 = await modelState(dmRoom);
  check(
    "the model is still resolved and loaded after a TRACKED move",
    typeof modelStateAfter2.modelUrlByTokenId[modeledTokenId] === "string" &&
      Boolean(modelStateAfter2.measured?.[modeledTokenId]?.maxDim > 0),
    { modelUrl: modelStateAfter2.modelUrlByTokenId[modeledTokenId], measured: modelStateAfter2.measured?.[modeledTokenId] }
  );
  const combatantAfter2 = await admin.from("combat_combatants").select().eq("id", modeledCombatantId).single();
  const expectedCost = movementRules.gridDistanceFeet(
    { x: modeledBefore2.x, y: modeledBefore2.y },
    { x: modeledAfter2.x, y: modeledAfter2.y }
  );
  check(
    "the tracked move charged exactly the straight-line cost against movement_used_feet",
    combatantAfter2.data?.movement_used_feet === expectedCost,
    { expected: expectedCost, got: combatantAfter2.data?.movement_used_feet }
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
