#!/usr/bin/env node
// Re-opened AGAIN: the project owner tested live play immediately after
// 82567ed ("Investigate token model move/rotate bug: not reproduced, close
// coverage gap" — scripts/db/verify-pawn-model-transform-repeat.mjs, 26/26
// passing) shipped, and reported the SAME symptom still happening for a
// REAL character's REAL uploaded pawn model ("Robin URMum", Dragonborn
// Rogue) — the disc/hitbox moves, the model does not.
//
// Two concrete, confirmed gaps in that prior investigation's own coverage,
// found by directly reading its script before writing this one:
//
//   1. It uploads `public/assets/presets/witch.glb` as the "custom" model.
//      Inspected directly (see this repo's own glTF JSON chunk): witch.glb
//      has ZERO skins — completely unrigged, exactly like every other
//      built-in preset (PropModel.tsx's own doc comment: "every current
//      preset in this repo, none of which are rigged"). Robin URMum's REAL
//      pawn.glb (downloaded directly from the live character-pawns bucket
//      and inspected the same way for this investigation) is a genuinely
//      RIGGED, SKINNED model — a Sketchfab-sourced humanoid with a complex
//      448-node Rigify-style skeleton (DEF-/MCH-/ORG-/VIS- bone families,
//      IK+FK duplicate chains) utterly unlike this repo's own small,
//      clean test fixtures (RiggedFigure.glb: 22 nodes: RiggedSimple.glb: 5
//      nodes). That means PosedClone's ENTIRE "resolved skeleton" branch
//      (resolvePoseBones/buildPoseClip/useAnimations, pose.ts) — a
//      genuinely different render path than the plain <Clone> branch an
//      unrigged model takes — has NEVER been exercised on a MOVING,
//      model-backed TOKEN by any existing script. verify-posed-rendering.mjs
//      covers posing itself (statically) but never moves the token
//      afterward; verify-pawn-model-transform-repeat.mjs covers moving but
//      never uses a rigged model. Nothing in this repo intersects both.
//   2. It drives everything through ONE browser context (the DM's own),
//      checking the model's own world transform only on the SAME client
//      that made the move — the local, optimistic-apply path. It never
//      confirms a SECOND, independently-connected client's own model node
//      (receiving the move purely via the TOKEN_EVENT realtime broadcast)
//      updates correctly, and it never interleaves genuinely unrelated
//      realtime traffic (a chat message, an HP change) between moves the
//      way a real, hours-long live session actually does.
//
// This script closes both at once: uploads Robin's ACTUAL downloaded
// pawn.glb (byte-for-byte, from /tmp scratch — never touches the real
// production character/campaign/token rows, all of this runs against a
// fresh, isolated, ephemeral campaign+character+token, torn down in
// `finally`) as an ordinary PLAYER's own PC pawn model (not the DM's, unlike
// the prior script — matching how a real player owns their own pawn), opens
// BOTH a DM client and that player's own client against the SAME live room,
// and drives FOUR real click-select-to-move gestures plus a rotation,
// interleaving an unrelated chat message and an unrelated HP change between
// moves — checking the model's own real rendered world transform via
// TokenMarker's onModelWorldDebug mirror on BOTH clients after every step.
//
// Needs the real dev server (starts `yarn dev` itself if the target port
// isn't already serving) and the real shared Supabase instance this
// project's .env points at.
// Usage: node scripts/db/verify-pawn-model-real-rig-long-session.mjs

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { createServer } from "vite";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.PAWN_MODEL_REAL_RIG_APP_PORT ?? 4931);
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
  const email = `pawn-real-rig-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `PawnRealRig ${label}`,
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
const rotationState = (page) => readMirror(page, "token-rotation-state");

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

// Robin URMum's REAL pawn.glb — byte-for-byte the same file reported
// failing to move in real play (character id
// d3040bec-7f36-4fa1-bcf1-0811b10a41f5). Confirmed (via a direct glTF
// JSON-chunk inspection) to carry a real skin + a 448-node rig, unlike
// every model any prior verify script has ever moved — a genuinely
// different render path (PosedClone's resolved-skeleton branch) than this
// repo's own small, clean test fixtures.
//
// Downloaded live from the real character-pawns storage bucket EVERY run
// (not a manually pre-staged local file) — this script must stay
// re-runnable by anyone/anytime the same way every other verify-*.mjs
// script in this house style is, with no separate manual step. Cached at
// SCRATCH_DIR only so repeated runs within one debugging session skip a
// redundant network fetch; deleting the cache file just means the next run
// re-downloads it. If the real row/object is ever deleted or replaced,
// this fails loudly with a clear message rather than silently reusing a
// stale cached copy of a DIFFERENT model.
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
  await admin.from("campaigns").insert({ id: campaignId, name: "Pawn real-rig long session", creator: dm.id });
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
    name: "Real-Rig Modeled PC",
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
    name: "Real-rig transform arena",
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

  // ── Baseline on BOTH clients: the REAL rigged model actually resolved
  // and genuinely rendered (a real measured bounding box) — not silently
  // swallowed by PropErrorBoundary into the translucent-crate placeholder,
  // which resolvePoseBones/buildPoseClip choking on this unusual 448-node
  // rig could plausibly cause (PlaceholderProp never calls onMeasureDebug,
  // so a stuck-undefined `measured` entry is exactly what that failure mode
  // would look like here). ──
  for (const [label, page] of [["dm", dmRoom], ["player", playerRoom]]) {
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
    const initialModelWorld = await pollUntil(async () => (await modelWorldState(page))[modeledTokenId] ?? null);
    check(
      `[${label}] the model's own world-transform mirror reports an entry for the real-rig token before any move`,
      initialModelWorld !== null,
      initialModelWorld
    );
  }

  // Tracks the player's own last-known screen point for the token (moves
  // between steps, so each helper re-derives it).
  let playerKnownPoint = null;

  /** Drives the move from the PLAYER's own client (the real report: a
   * player's own PC), then confirms BOTH the mover's own client (local,
   * optimistic path) AND the DM's independently-connected client (pure
   * TOKEN_EVENT broadcast receive path) show the model's own real rendered
   * world position at the new cell. */
  async function performMove(label) {
    const before = await requireTokenRow(modeledTokenId, `${label}: before`);
    await playerRoom.screenshot({ path: join(SCRATCH_DIR, `real-rig-${label}-player-before.png`) });

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

    await sleep(1200); // well past TOKEN_SLIDE_SECONDS, fully settled on both clients
    await dmRoom.screenshot({ path: join(SCRATCH_DIR, `real-rig-${label}-dm-after.png`) });
    await playerRoom.screenshot({ path: join(SCRATCH_DIR, `real-rig-${label}-player-after.png`) });

    const expected = expectedWorld(after.x, after.y);
    for (const [clientLabel, page] of [["player (local/optimistic)", playerRoom], ["DM (remote/broadcast)", dmRoom]]) {
      const modelWorld = await pollUntil(async () => {
        const state = await modelWorldState(page);
        const entry = state[modeledTokenId];
        if (!entry) return null;
        return closeTo(entry.x, expected.x, 0.01) && closeTo(entry.z, expected.z, 0.01) ? entry : null;
      });
      check(
        `${label} [${clientLabel}]: THE STRUCTURAL PROOF — the real-rig MODEL's own rendered world position matches the new cell`,
        modelWorld !== null,
        { expected, lastSeen: await modelWorldState(page).then((s) => s[modeledTokenId]) }
      );
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

  console.log("\n── Move #1 ──");
  await performMove("move1");

  console.log("\n── Unrelated realtime noise: a chat message (neither client touches the token) ──");
  const { error: chatError } = await admin
    .from("chat_messages")
    .insert({ campaign_id: campaignId, sender_user_id: dm.id, body: "anybody home?" });
  if (chatError) console.error("  (chat insert failed, continuing anyway)", chatError.message);
  await sleep(800);

  console.log("\n── Move #2 (right after unrelated chat traffic) ──");
  await performMove("move2");

  console.log("\n── Unrelated realtime noise: an HP change on the SAME character (touches character_pawns' own owner, not the token) ──");
  const { error: hpError } = await admin.from("characters").update({ current_hp: 18 }).eq("id", characterId);
  if (hpError) console.error("  (HP update failed, continuing anyway)", hpError.message);
  await sleep(800);

  console.log("\n── Move #3 (right after an unrelated HP change) ──");
  await performMove("move3");

  console.log("\n── More unrelated noise: a second chat message + a second HP tick ──");
  await admin.from("chat_messages").insert({ campaign_id: campaignId, sender_user_id: player.id, body: "yeah still here" });
  await admin.from("characters").update({ current_hp: 20 }).eq("id", characterId);
  await sleep(800);

  console.log("\n── Move #4 (a longer session: fourth move, well after mount, with real interleaved traffic throughout) ──");
  await performMove("move4");

  // ── Rotation, on the player's own client, checked on both. ──
  console.log("\n── Rotate (press R once, real-rig model) ──");
  const beforeRotate = await requireTokenRow(modeledTokenId, "before rotate");
  const selectedAt = await ensureSelected(playerRoom, modeledTokenId, playerKnownPoint);
  check("rotate: the modeled token can be click-selected for rotation", selectedAt !== null);
  await playerRoom.keyboard.press("r");
  await sleep(1200);
  const afterRotate = await requireTokenRow(modeledTokenId, "after rotate");
  const expectedRotation = ((beforeRotate.rotation ?? 0) + 90) % 360;
  check(
    "rotate: pressing R rotates the persisted map_tokens.rotation by exactly 90",
    afterRotate.rotation === expectedRotation,
    { before: beforeRotate.rotation, after: afterRotate.rotation }
  );
  for (const [clientLabel, page] of [["player (local)", playerRoom], ["DM (broadcast)", dmRoom]]) {
    const rotState = await pollUntil(async () => {
      const state = await rotationState(page);
      return state[modeledTokenId] === afterRotate.rotation ? state : null;
    });
    check(`rotate [${clientLabel}]: this client's own token-rotation-state mirror reflects the new rotation`, rotState !== null, {
      expected: afterRotate.rotation,
      lastSeen: (await rotationState(page))[modeledTokenId],
    });
    const modelWorld = await pollUntil(async () => {
      const state = await modelWorldState(page);
      const entry = state[modeledTokenId];
      if (!entry) return null;
      return closeDeg(entry.yawDeg, afterRotate.rotation) ? entry : null;
    });
    check(
      `rotate [${clientLabel}]: THE STRUCTURAL PROOF — the real-rig model's own rendered yaw matches the new rotation`,
      modelWorld !== null,
      { expectedRotationDeg: afterRotate.rotation, lastSeen: await modelWorldState(page).then((s) => s[modeledTokenId]) }
    );
  }

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
