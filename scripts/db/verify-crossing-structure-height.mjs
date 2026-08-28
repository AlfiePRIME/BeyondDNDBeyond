#!/usr/bin/env node
// Bridges and stairs surface-height + stairs tilt (a post-roadmap addition
// on top of 0053_crossing_structures.sql's map_objects.crossing_type):
// verifies the fix for "a token standing on a bridge/stairs cell renders at
// the underlying terrain's raw elevation, embedded in/at-the-foot of the
// model instead of on its visible walkable surface" — see
// src/scene-3d/crossingSurface.ts's own top-of-file doc comment for the full
// root-cause writeup and the "computed constant, not a DB column" design
// choice.
//
// Real signed-in Playwright browser throughout (a single DM client is
// sufficient — nothing under test is per-viewer-masked, the exact
// verify-bridges-and-stairs.mjs precedent this script otherwise mirrors),
// driving the REAL Game Room. Covers:
//   1. Real-measurement cross-check: re-loads the ACTUAL generated
//      public/assets/presets/{bridge,stairs}.glb through three.js's
//      GLTFLoader + the SAME Box3/fit-scale math PlacedObject.tsx applies at
//      render time, and confirms crossingSurface.ts's own hardcoded
//      constants still match that real geometry — catches a future
//      regeneration of either preset with different proportions silently
//      going stale (crossingSurface.ts's own doc comment promises this).
//   2. A token standing on a BRIDGE renders ABOVE the raw cell floor by
//      exactly the bridge deck's own real measured surface height, and does
//      NOT tilt (pitch/yaw both 0) — read from the token's own ACTUAL
//      rendered transform (MapSurfaceProps.onTokenTransformDebug), not just
//      the props that were fed in.
//   3. A token standing on STAIRS renders above the raw cell floor by the
//      stairs' own real measured surface height. Tilt itself is gated on
//      having a real model (a player-reported regression: a mathematically
//      correct ~36° lean on a featureless disc/pin, which has no body/limbs
//      to read as "leaning while climbing", visually looked like the pawn
//      had face-planted into the stairs) — a PLAIN token (no model) gets the
//      height offset only, never tilts; a MODELED token (an NPC's own posed
//      mesh, or a player's uploaded custom model) tilts by the flight's own
//      real incline angle, yawed to match that stairs object's own
//      placement rotation (checked at rotation 0, 90, AND 180 — proves the
//      yaw genuinely tracks the object, not a hardcoded direction).
//   4. Regression: a token on ordinary elevated terrain with NO crossing
//      structure renders at EXACTLY today's height (raw elevation only, no
//      offset) with no tilt — MapPlan P5's raise/lower feature unregressed.
//   5. A token on flat ground with no crossing structure and no elevation
//      change is completely unaffected (topY = baseHeight exactly, no
//      tilt).
//   6. A real move (click-select-to-move) from plain ground onto a stairs
//      cell — screenshots the in-flight moment and the settled result, and
//      confirms the FINAL settled tilt is correct (the smooth blend itself
//      is unit-tested in tokenSlide.test.ts's shortestAngleLerp/lerp
//      coverage; this proves the same useTokenSlide clock that already
//      drives topY without popping is the SAME one driving tilt).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its dedicated port isn't already serving.
// Usage: node scripts/db/verify-crossing-structure-height.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { createServer } from "vite";
import path from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port — this machine runs several concurrent agent
// worktrees, each potentially squatting on the common ports with their OWN
// checkout's dev server (verify-pits-and-falling.mjs's own reasoning).
const APP_PORT = Number(process.env.CROSSING_HEIGHT_APP_PORT ?? 49333);
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

// mapFit.ts's module graph now reaches MapSurface.tsx -> @/audio ->
// @/data-access/supabase-browser (the Sound Effects work's SP1/SP3 additions
// — soundManager.ts's own resolveSoundUrl override check), whose top-level
// requireEnv() reads process.env directly rather than this script's own
// local `env` object above. Vite's programmatically-created server below
// does NOT load .env into process.env itself (that's Next.js's own CLI
// behavior, not something a bare `createServer()` call gets for free), so
// without this, vite.ssrLoadModule below throws "Missing
// NEXT_PUBLIC_SUPABASE_URL" the instant it evaluates MapSurface.tsx.
Object.assign(process.env, env);

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

/** Awaits a Supabase query builder and throws loudly on `.error` — a bare
 * `await admin.from(...).insert(...)` silently swallows a constraint
 * violation (this script's own first real bug: one bad row in a batch
 * insert failed the WHOLE batch with no visible error, leaving "no tokens
 * on the table" a mystery until this wrapper was added). Every admin write
 * below goes through this. */
async function must(queryBuilderPromise, label) {
  const { data, error } = await queryBuilderPromise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}
function closeTo(a, b, eps, label, detail) {
  check(label, Math.abs(a - b) < eps, detail ?? `a=${a} b=${b} eps=${eps}`);
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
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

// verify-bridges-and-stairs.mjs's own collapsed-panel-layout fix: keeps the
// small test map's cells clickable for the one real move this script makes.
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  map: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `crossing-height-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await must(
    admin.from("profiles").insert({
      id: data.user.id,
      display_name: `Crossing Height ${label}`,
      ui_preferences: { panelLayout: COLLAPSED_PANEL_LAYOUT },
    }),
    `inserting profile for ${label}`
  );
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function isCanvasPoint(page, point) {
  return page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS",
    [point.x, point.y]
  );
}

/** Blind center-out scan over the canvas (verify-pits-and-falling.mjs's own
 * `scanClick`, copied verbatim — no way to compute a WebGL raycast target
 * from camera math, so this discovers a working screen point empirically). */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.25, xTo = 0.75, yFrom = 0.3, yTo = 0.75, step = 16, settleMs = 110, exclude = [], onMiss, label = "" } = opts;
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
      if (exclude.some((e) => Math.hypot(e.x - point.x, e.y - point.y) < (e.radius ?? 20))) continue;
      if (!(await isCanvasPoint(page, point))) continue;
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) {
        console.log(`  scanClick${label ? ` (${label})` : ""}: found`);
        return point;
      }
      if (onMiss) await onMiss(point);
    }
  }
  console.log(`  scanClick${label ? ` (${label})` : ""}: exhausted every candidate point — not found`);
  return null;
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

async function pollUntil(fn, { timeoutMs = 10000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

async function tokenRow(id) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

/** Voids every cell in a WxH grid except the ones in `keep` — the
 * verify-bridges-and-stairs.mjs precedent for making a blind click
 * deterministic. */
async function voidExcept(dmClient, mapId, width, height, keep) {
  const keepKeys = new Set(keep.map(({ x, y }) => `${x},${y}`));
  const rows = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (keepKeys.has(`${x},${y}`)) continue;
      rows.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "void", light_level: "bright" });
    }
  }
  const { error } = await admin.from("map_cells").upsert(rows, { onConflict: "map_id,x,y" });
  if (error) throw error;
}

async function upsertCells(rows) {
  const { error } = await admin.from("map_cells").upsert(
    rows.map((row) => ({ ground_type: "default", water_flow_direction: null, ...row })),
    { onConflict: "map_id,x,y" }
  );
  if (error) throw new Error(`upserting map_cells failed: ${error.message}`);
}

await ensureDevServer();

// ════════════════════════════════════════════════════════════════════
// Phase 0 — real-measurement cross-check: crossingSurface.ts's own
// hardcoded constants against a FRESH load of the actual generated .glb
// files, through the exact Box3/fit-scale math PlacedObject.tsx applies at
// render time — catches a future regeneration of either preset silently
// going stale.
// ════════════════════════════════════════════════════════════════════
const PLACED_OBJECT_SIZE = 0.92; // src/scene-3d/PlacedObject.tsx's own constant

function measureGlb(buffer) {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, "", (gltf) => {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      resolve({ box, size, maxDim, scale: PLACED_OBJECT_SIZE / maxDim });
    }, reject);
  });
}

const bridgeMeasured = await measureGlb(readFileSync(join(rootDir, "public", "assets", "presets", "bridge.glb")));
const stairsMeasured = await measureGlb(readFileSync(join(rootDir, "public", "assets", "presets", "stairs.glb")));
// Second stairs preset ("Stairs (Half)", 0082_stairs_half_preset.sql) —
// climbs exactly 1 terrain level (half of the existing "Stairs" preset's 2
// terrain levels), completely additive: the existing stairs.glb/bridge.glb
// files and their own measurements above are UNCHANGED by this.
const stairsHalfMeasured = await measureGlb(
  readFileSync(join(rootDir, "public", "assets", "presets", "stairs-half.glb"))
);

// The app's REAL crossingSurface.ts module, loaded through vite exactly the
// way verify-bridges-and-stairs.mjs loads movement.ts — the structural
// checks below run the SAME crossingSurfaceHeight/crossingTiltPitchRadians
// the Game Room actually renders with, not a hand-rolled lookalike.
const vite = await createServer({
  root: rootDir,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  // mapFit.ts/MapSurface.tsx's own module graph reaches tokenSlide.ts's
  // `@/rules-engine` import — same tsconfig.json "paths" alias vitest.config.ts
  // already resolves for the real test suite.
  resolve: { alias: { "@": path.resolve(rootDir, "src") } },
});
const crossingSurfaceModule = await vite.ssrLoadModule("/src/scene-3d/crossingSurface.ts");
const mapFitModule = await vite.ssrLoadModule("/src/scene-3d/mapFit.ts");
const { BRIDGE_URL, STAIRS_URL, STAIRS_HALF_URL } = crossingSurfaceModule;

// Bridge: the deck plank mesh's own top face (raw y=0.13, buildBridge()'s
// `BoxGeometry(0.92, 0.06, 0.7)` centered at y=0.1), rebased against the
// model's own real measured minimum (the hanging support posts' bottom),
// scaled by the model's own real measured fit factor.
const bridgeExpected = (0.13 - bridgeMeasured.box.min.y) * bridgeMeasured.scale;
closeTo(
  crossingSurfaceModule.crossingSurfaceHeight(BRIDGE_URL),
  bridgeExpected,
  1e-6,
  "crossingSurface.ts's bridge surface height matches a FRESH measurement of the real bridge.glb"
);

// Stairs (full-height, unchanged): the whole model's own real measured top
// (the tallest tread), scaled by the model's own real measured fit factor.
const stairsExpected = stairsMeasured.box.max.y * stairsMeasured.scale;
closeTo(
  crossingSurfaceModule.crossingSurfaceHeight(STAIRS_URL),
  stairsExpected,
  1e-6,
  "crossingSurface.ts's full-height stairs surface height matches a FRESH measurement of the real stairs.glb"
);

// Stairs (Half), new: the SAME "whole model's own real measured top" shape,
// against the NEW stairs-half.glb — this is the exact real-measurement
// cross-check this task's own acceptance criteria calls for: measure the
// new preset's own real generated GLB geometry, don't assume it from the
// generator's formula alone.
const stairsHalfExpected = stairsHalfMeasured.box.max.y * stairsHalfMeasured.scale;
closeTo(
  crossingSurfaceModule.crossingSurfaceHeight(STAIRS_HALF_URL),
  stairsHalfExpected,
  1e-6,
  "crossingSurface.ts's half-height stairs surface height matches a FRESH measurement of the real stairs-half.glb"
);
check(
  "the half-height stairs preset really is width-constrained (maxDim 1), not depth-constrained like the full flight (maxDim 1.2) — a real measured consequence of halving the step count",
  Math.abs(stairsHalfMeasured.maxDim - 1) < 1e-3 && stairsHalfMeasured.maxDim < stairsMeasured.maxDim
);
check(
  "the half-height stairs preset's own real top height is roughly half the full-height flight's raw top (before fit-scaling) — 1 terrain level vs. 2",
  Math.abs(stairsHalfMeasured.box.max.y * 2 - stairsMeasured.box.max.y) < 1e-3
);

check(
  "crossingSurfaceHeight(null) and (undefined) are both exactly 0 — no crossing structure changes nothing",
  crossingSurfaceModule.crossingSurfaceHeight(null) === 0 && crossingSurfaceModule.crossingSurfaceHeight(undefined) === 0
);

check(
  "the full-height stairs incline is a real, substantial angle (not near-flat, not near-vertical)",
  (() => {
    const deg = (crossingSurfaceModule.STAIRS_SLOPE_RADIANS * 180) / Math.PI;
    return deg > 20 && deg < 60;
  })()
);
check(
  "the half-height stairs incline is ALSO a real, substantial angle, independently measured (not assumed equal to the full flight's)",
  (() => {
    const deg = (crossingSurfaceModule.STAIRS_HALF_SLOPE_RADIANS * 180) / Math.PI;
    return deg > 20 && deg < 60;
  })()
);
check(
  "crossingTiltPitchRadians resolves each stairs preset's own real tilt, and 0 for a bridge/unknown url",
  crossingSurfaceModule.crossingTiltPitchRadians(STAIRS_URL) === crossingSurfaceModule.STAIRS_TILT_PITCH_RADIANS &&
    crossingSurfaceModule.crossingTiltPitchRadians(STAIRS_HALF_URL) ===
      crossingSurfaceModule.STAIRS_HALF_TILT_PITCH_RADIANS &&
    crossingSurfaceModule.crossingTiltPitchRadians(BRIDGE_URL) === 0 &&
    crossingSurfaceModule.crossingTiltPitchRadians(null) === 0
);
check(
  "isStairsPresetUrl is true for both stairs presets, false for the bridge",
  crossingSurfaceModule.isStairsPresetUrl(STAIRS_URL) &&
    crossingSurfaceModule.isStairsPresetUrl(STAIRS_HALF_URL) &&
    !crossingSurfaceModule.isStairsPresetUrl(BRIDGE_URL)
);

/**
 * Root-cause verification for the reported "pawn orientation flipped 180 on
 * stairs" bug: computes, via the REAL three.js Euler/quaternion math (the
 * exact `group.rotation.set(pitch, yaw, 0)` useTokenSlide.ts applies), where
 * a directional model's own authored "front" (local +Z — generate-monster-
 * presets.mjs's buildGoblin() puts its eyes/blade there) ends up in WORLD
 * space after a token's real, BROWSER-REPORTED pitch/yaw, and compares it
 * against where the SAME stairs object's own real, rotated uphill end
 * (also local +Z, buildStairs()/buildStairsHalf()'s own rise direction)
 * ends up — using the object's own REAL stored `rotation`, not an assumed
 * value. A positive dot product means the token's own front-facing
 * direction points toward the SAME side as the stairs' real uphill end
 * (correct); non-positive would mean it faces backward (the reported bug).
 */
function facesUphill(pitchDeg, yawDeg, objectRotationDeg) {
  const tokenGroup = new THREE.Object3D();
  tokenGroup.rotation.set((pitchDeg * Math.PI) / 180, (yawDeg * Math.PI) / 180, 0);
  tokenGroup.updateMatrixWorld();
  const faceDir = new THREE.Vector3(0, 0, 1).applyQuaternion(tokenGroup.quaternion);

  const stairsGroup = new THREE.Object3D();
  stairsGroup.rotation.set(0, (objectRotationDeg * Math.PI) / 180, 0);
  stairsGroup.updateMatrixWorld();
  const uphillDir = new THREE.Vector3(0, 0, 1).applyQuaternion(stairsGroup.quaternion);

  const dot = faceDir.x * uphillDir.x + faceDir.z * uphillDir.z; // horizontal (XZ) component only
  return { dot, faces: dot > 0 };
}

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await must(
    admin.from("campaigns").insert({
      id: campaignId,
      name: "Crossing structure height test",
      creator: dm.id,
      action_economy_strict: false,
    }),
    "inserting campaign"
  );
  await must(
    admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]),
    "inserting campaign_members"
  );

  const ariaId = crypto.randomUUID();
  await must(
    admin.from("characters").insert({
    id: ariaId,
    campaign_id: campaignId,
    owner_id: dm.id,
    name: "Aria Spanwell",
    race: "Human",
    class: "Adventurer",
    level: 1,
    strength: 10,
    dexterity: 14,
    constitution: 14,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 100,
    max_hp: 100,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
    }),
    "inserting character"
  );

  const { data: presetAssets } = await admin
    .from("asset_library")
    .select("id, name")
    .eq("source_type", "preset")
    .in("name", ["Bridge", "Stairs", "Stairs (Half)"]);
  const bridgeAssetId = presetAssets?.find((a) => a.name === "Bridge")?.id;
  const stairsAssetId = presetAssets?.find((a) => a.name === "Stairs")?.id;
  const stairsHalfAssetId = presetAssets?.find((a) => a.name === "Stairs (Half)")?.id;
  check(
    "the Bridge, Stairs, AND (new, additive) Stairs (Half) preset assets all exist",
    Boolean(bridgeAssetId) && Boolean(stairsAssetId) && Boolean(stairsHalfAssetId),
    JSON.stringify(presetAssets)
  );

  // Pawn-orientation investigation: a directional, template-linked NPC
  // model (generate-monster-presets.mjs's buildGoblin() — eyes/blade both
  // authored at local +Z) to check REAL facing, not just tilt magnitude —
  // the existing tokenB/tokenE below (plain npc_name, no model) prove
  // height/tilt magnitude/yaw-tracks-rotation but can never visually reveal
  // a facing bug (a flat disc has no front).
  const { data: goblinTemplate } = await admin
    .from("monster_templates")
    .select("id, name, max_hp, armor_class, passive_perception, attacks, default_allegiance")
    .eq("name", "Goblin")
    .single();
  check("the Goblin monster template exists (Weather & Enemies C5's own seed)", Boolean(goblinTemplate));

  async function makeGoblinStatBlock(name) {
    const { data, error } = await admin
      .from("monster_stat_blocks")
      .insert({
        campaign_id: campaignId,
        template_id: goblinTemplate.id,
        name,
        max_hp: goblinTemplate.max_hp,
        armor_class: goblinTemplate.armor_class,
        passive_perception: goblinTemplate.passive_perception,
        attacks: goblinTemplate.attacks,
        default_allegiance: goblinTemplate.default_allegiance,
      })
      .select()
      .single();
    if (error) throw new Error(`inserting Goblin stat block ${name}: ${error.message}`);
    return data;
  }

  const ROOM_VIEWPORT = { width: 1920, height: 1080 };
  const dmContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));

  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — static layout covering every acceptance scenario at once:
  //   (0,0) flat, no crossing, no elevation      → token D (fully unaffected)
  //   (1,0) elevation 2, NO crossing object       → token C (regression: raw elevation only)
  //   (2,0) elevation 0, Bridge (rotation 0)       → token A (height offset, NO tilt)
  //   (3,0) elevation 2, Stairs (rotation 0)       → token B (height offset + tilt, yaw 0)
  //   (3,1) elevation 2, Stairs (rotation 90)      → token E (same tilt magnitude, yaw 90)
  //   (4,0) elevation 1, Stairs (Half) (rotation 0)  → token F (NEW preset, own height + tilt, yaw 0)
  //   (4,1) elevation 1, Stairs (Half) (rotation 90) → token G (NEW preset, same tilt magnitude, yaw 90)
  //   (5,0) elevation 2, Stairs (rotation 0)       → token H (Goblin-linked: REAL facing check)
  //   (5,1) elevation 2, Stairs (rotation 90)      → token I (Goblin-linked: REAL facing check)
  //   (6,0) elevation 2, Stairs (rotation 180)     → token L (Goblin-linked: REAL facing check)
  //   (7,0) elevation 1, Stairs (Half) (rotation 0)  → token J (Goblin-linked: REAL facing check, NEW preset)
  //   (7,1) elevation 1, Stairs (Half) (rotation 90) → token K (Goblin-linked: REAL facing check, NEW preset)
  // ════════════════════════════════════════════════════════════════════
  const gridWidth = 8;
  const gridHeight = 2;
  const mapId = crypto.randomUUID();
  await must(
    admin.from("campaign_maps").insert({
      id: mapId,
      campaign_id: campaignId,
      name: "Crossing structure height — static layout",
      grid_width: gridWidth,
      grid_height: gridHeight,
    }),
    "inserting static-layout map"
  );
  await upsertCells([
    { map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 1, y: 0, elevation: 2, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 2, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 3, y: 0, elevation: 2, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 3, y: 1, elevation: 2, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 4, y: 0, elevation: 1, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 4, y: 1, elevation: 1, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 5, y: 0, elevation: 2, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 5, y: 1, elevation: 2, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 6, y: 0, elevation: 2, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 7, y: 0, elevation: 1, terrain_type: "normal", light_level: "bright" },
    { map_id: mapId, x: 7, y: 1, elevation: 1, terrain_type: "normal", light_level: "bright" },
  ]);
  await voidExcept(dm.client, mapId, gridWidth, gridHeight, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 3, y: 0 },
    { x: 3, y: 1 },
    { x: 4, y: 0 },
    { x: 4, y: 1 },
    { x: 5, y: 0 },
    { x: 5, y: 1 },
    { x: 6, y: 0 },
    { x: 7, y: 0 },
    { x: 7, y: 1 },
  ]);
  await must(
    admin.from("map_objects").insert([
      { map_id: mapId, asset_id: bridgeAssetId, x: 2, y: 0, elevation: 0, rotation: 0, crossing_type: "bridge" },
      { map_id: mapId, asset_id: stairsAssetId, x: 3, y: 0, elevation: 2, rotation: 0, crossing_type: "stairs" },
      { map_id: mapId, asset_id: stairsAssetId, x: 3, y: 1, elevation: 2, rotation: 90, crossing_type: "stairs" },
      // NEW preset ("Stairs (Half)"): tagged crossing_type 'stairs' too —
      // see MapEditor.tsx's crossingTypeForAsset own comment for why
      // movement rules don't distinguish the two stairs presets.
      { map_id: mapId, asset_id: stairsHalfAssetId, x: 4, y: 0, elevation: 1, rotation: 0, crossing_type: "stairs" },
      { map_id: mapId, asset_id: stairsHalfAssetId, x: 4, y: 1, elevation: 1, rotation: 90, crossing_type: "stairs" },
      // Separate cells (from tokenB/tokenE above) for the Goblin-linked
      // facing checks, so the existing plain-npc height/tilt regression
      // checks above are never touched by this addition.
      { map_id: mapId, asset_id: stairsAssetId, x: 5, y: 0, elevation: 2, rotation: 0, crossing_type: "stairs" },
      { map_id: mapId, asset_id: stairsAssetId, x: 5, y: 1, elevation: 2, rotation: 90, crossing_type: "stairs" },
      { map_id: mapId, asset_id: stairsAssetId, x: 6, y: 0, elevation: 2, rotation: 180, crossing_type: "stairs" },
      { map_id: mapId, asset_id: stairsHalfAssetId, x: 7, y: 0, elevation: 1, rotation: 0, crossing_type: "stairs" },
      { map_id: mapId, asset_id: stairsHalfAssetId, x: 7, y: 1, elevation: 1, rotation: 90, crossing_type: "stairs" },
    ]),
    "inserting bridge/stairs/stairs-half map_objects"
  );
  const tokenD = crypto.randomUUID(); // flat, unaffected
  const tokenC = crypto.randomUUID(); // ordinary elevated, no crossing (regression)
  const tokenA = crypto.randomUUID(); // bridge
  const tokenB = crypto.randomUUID(); // stairs, rotation 0
  const tokenE = crypto.randomUUID(); // stairs, rotation 90
  const tokenF = crypto.randomUUID(); // stairs (half), rotation 0 — NEW preset
  const tokenG = crypto.randomUUID(); // stairs (half), rotation 90 — NEW preset
  const tokenH = crypto.randomUUID(); // stairs (full), rotation 0 — Goblin-linked facing check
  const tokenI = crypto.randomUUID(); // stairs (full), rotation 90 — Goblin-linked facing check
  const tokenL = crypto.randomUUID(); // stairs (full), rotation 180 — Goblin-linked facing check
  const tokenJ = crypto.randomUUID(); // stairs (half), rotation 0 — Goblin-linked facing check, NEW preset
  const tokenK = crypto.randomUUID(); // stairs (half), rotation 90 — Goblin-linked facing check, NEW preset

  const sbH = await makeGoblinStatBlock("Goblin (facing check, full stairs rot 0)");
  const sbI = await makeGoblinStatBlock("Goblin (facing check, full stairs rot 90)");
  const sbL = await makeGoblinStatBlock("Goblin (facing check, full stairs rot 180)");
  const sbJ = await makeGoblinStatBlock("Goblin (facing check, half stairs rot 0)");
  const sbK = await makeGoblinStatBlock("Goblin (facing check, half stairs rot 90)");

  {
    // map_tokens_pc_xor_npc (0019_map_tokens.sql): a token is a PC
    // (character_id set, npc_name null) or an NPC (character_id null,
    // npc_name set) — never neither. `.throwOnError()` so a violation here
    // fails loudly instead of silently inserting zero rows (a single bad
    // row fails the WHOLE batch, which is exactly what happened the first
    // time this script ran without it).
    const { error } = await admin.from("map_tokens").insert([
      { id: tokenD, map_id: mapId, character_id: ariaId, x: 0, y: 0, elevation: 0, allegiance: "party" },
      { id: tokenC, map_id: mapId, npc_name: "Control (elevated, no crossing)", x: 1, y: 0, elevation: 2, allegiance: "neutral" },
      { id: tokenA, map_id: mapId, npc_name: "Bridge token", x: 2, y: 0, elevation: 0, allegiance: "neutral" },
      { id: tokenB, map_id: mapId, npc_name: "Stairs token (rotation 0)", x: 3, y: 0, elevation: 2, allegiance: "hostile" },
      { id: tokenE, map_id: mapId, npc_name: "Stairs token (rotation 90)", x: 3, y: 1, elevation: 2, allegiance: "hostile" },
      { id: tokenF, map_id: mapId, npc_name: "Stairs (Half) token (rotation 0)", x: 4, y: 0, elevation: 1, allegiance: "hostile" },
      { id: tokenG, map_id: mapId, npc_name: "Stairs (Half) token (rotation 90)", x: 4, y: 1, elevation: 1, allegiance: "hostile" },
      { id: tokenH, map_id: mapId, npc_name: sbH.name, monster_stat_block_id: sbH.id, x: 5, y: 0, elevation: 2, allegiance: "hostile" },
      { id: tokenI, map_id: mapId, npc_name: sbI.name, monster_stat_block_id: sbI.id, x: 5, y: 1, elevation: 2, allegiance: "hostile" },
      { id: tokenL, map_id: mapId, npc_name: sbL.name, monster_stat_block_id: sbL.id, x: 6, y: 0, elevation: 2, allegiance: "hostile" },
      { id: tokenJ, map_id: mapId, npc_name: sbJ.name, monster_stat_block_id: sbJ.id, x: 7, y: 0, elevation: 1, allegiance: "hostile" },
      { id: tokenK, map_id: mapId, npc_name: sbK.name, monster_stat_block_id: sbK.id, x: 7, y: 1, elevation: 1, allegiance: "hostile" },
    ]);
    if (error) throw new Error(`inserting map_tokens failed: ${error.message}`);
  }
  await must(
    admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId),
    "updating live_map to static-layout map"
  );

  const dmRoom = await dmContext.newPage();
  dmRoom.on("console", (msg) => {
    if (msg.type() === "error") console.error("  [page console error]", msg.text());
  });
  dmRoom.on("pageerror", (err) => console.error("  [page error]", err.message));
  await loadRoom(dmRoom);
  // Real, deterministic settle wait (TOKEN_SLIDE_SECONDS is 0.32s; every
  // token here mounts already at its target with no move in flight, so
  // this is generous headroom, not a fragile race) — every mirror read
  // below is still a synchronous check against the DOM once this resolves,
  // not a background poll reporting "done" on its own.
  await sleep(1500);

  let lastSeenState = null;
  const allTokenIds = [tokenD, tokenC, tokenA, tokenB, tokenE, tokenF, tokenG, tokenH, tokenI, tokenL, tokenJ, tokenK];
  const transformState = await pollUntil(
    async () => {
      const state = await readMirror(dmRoom, "token-transform-state");
      lastSeenState = state;
      return allTokenIds.every((id) => id in state) ? state : null;
    },
    { timeoutMs: 15000 }
  );
  check(
    "every token's transform is reported by the debug mirror",
    transformState !== null,
    `one or more tokens never settled/reported — last seen: ${JSON.stringify(lastSeenState)}`
  );
  if (!transformState) {
    await dmRoom.screenshot({ path: join(SCRATCH_DIR, "crossing-height-DEBUG-no-transform.png") });
    console.log(`DEBUG screenshot: ${join(SCRATCH_DIR, "crossing-height-DEBUG-no-transform.png")}`);
    const surfaceState = await readMirror(dmRoom, "table-surface-state").catch((e) => `error: ${e.message}`);
    console.log("table-surface-state:", JSON.stringify(surfaceState));
    const tokenSelState = await readMirror(dmRoom, "token-selection-state").catch((e) => `error: ${e.message}`);
    console.log("token-selection-state:", JSON.stringify(tokenSelState));
    console.log(`\n${failures} CHECK(S) FAILED (debug run)`);
    process.exitCode = 1;
    await vite.close();
    await browser.close();
    if (devServer) devServer.kill();
    process.exit(1);
  }

  const metrics = mapFitModule.computeTableMapMetrics(gridWidth, gridHeight);
  const baseHeight0 = metrics.baseHeight;
  const step1 = metrics.baseHeight + 1 * metrics.elevationStepHeight;
  const step2 = metrics.baseHeight + 2 * metrics.elevationStepHeight;
  const bridgeSurface = crossingSurfaceModule.crossingSurfaceHeight(BRIDGE_URL) * metrics.cellSize;
  const stairsSurface = crossingSurfaceModule.crossingSurfaceHeight(STAIRS_URL) * metrics.cellSize;
  const stairsHalfSurface = crossingSurfaceModule.crossingSurfaceHeight(STAIRS_HALF_URL) * metrics.cellSize;
  const stairsTiltDeg = Math.abs((crossingSurfaceModule.STAIRS_TILT_PITCH_RADIANS * 180) / Math.PI);
  const stairsHalfTiltDeg = Math.abs((crossingSurfaceModule.STAIRS_HALF_TILT_PITCH_RADIANS * 180) / Math.PI);

  const TOPY_EPS = 1e-3;
  const ANGLE_EPS = 0.5; // degrees

  // Scenario D — flat ground, no crossing, no elevation: fully unaffected.
  closeTo(transformState[tokenD].topY, baseHeight0, TOPY_EPS, "flat/no-crossing token renders at exactly baseHeight");
  closeTo(transformState[tokenD].pitchDeg, 0, ANGLE_EPS, "flat/no-crossing token has no pitch");
  closeTo(transformState[tokenD].yawDeg, 0, ANGLE_EPS, "flat/no-crossing token has no yaw");

  // Scenario C — ordinary elevated terrain, NO crossing structure: exactly
  // today's raw-elevation height, zero regression for MapPlan P5.
  closeTo(
    transformState[tokenC].topY,
    step2,
    TOPY_EPS,
    "ordinary elevated terrain (no crossing structure) renders at EXACTLY raw elevation height — no offset, unregressed"
  );
  closeTo(transformState[tokenC].pitchDeg, 0, ANGLE_EPS, "ordinary elevated terrain: no tilt");

  // Scenario A — bridge: height offset present, NEVER tilts.
  closeTo(
    transformState[tokenA].topY,
    baseHeight0 + bridgeSurface,
    TOPY_EPS,
    `bridge token should render at baseHeight + bridge surface height (expected ${baseHeight0 + bridgeSurface}, got ${transformState[tokenA].topY})`
  );
  check(
    "a token on a bridge renders ABOVE the raw cell floor (on top of the model, not inside it)",
    transformState[tokenA].topY > baseHeight0 + TOPY_EPS
  );
  closeTo(transformState[tokenA].pitchDeg, 0, ANGLE_EPS, "a token on a BRIDGE does not tilt (pitch)");
  closeTo(transformState[tokenA].yawDeg, 0, ANGLE_EPS, "a token on a BRIDGE does not tilt (yaw)");

  // Scenario B — stairs, rotation 0, PLAIN token (no model — npc_name only):
  // height offset still applies, but NEVER tilts. Real player-reported
  // regression: a mathematically correct ~36° lean on a featureless
  // disc/pin (no body/limbs to read as "leaning while climbing") looked
  // like the pawn had face-planted into the stairs, confirmed against this
  // exact deployed build via this very mirror. Fixed by gating tilt on
  // having a real model at all — only a modeled token (see tokenH/I/L/J/K
  // below) keeps the true incline.
  closeTo(
    transformState[tokenB].topY,
    step2 + stairsSurface,
    TOPY_EPS,
    `stairs token should render at raw-elevation height + stairs surface height (expected ${step2 + stairsSurface}, got ${transformState[tokenB].topY})`
  );
  check(
    "a token on stairs renders ABOVE the raw cell floor (on top of the model, not inside it)",
    transformState[tokenB].topY > step2 + TOPY_EPS
  );
  closeTo(
    transformState[tokenB].pitchDeg,
    0,
    ANGLE_EPS,
    `a PLAIN (no-model) token on STAIRS never tilts — height offset only (got pitchDeg ${transformState[tokenB].pitchDeg}°)`
  );
  closeTo(transformState[tokenB].yawDeg, 0, ANGLE_EPS, "a PLAIN (no-model) token on STAIRS has no yaw either");

  // Scenario E — stairs, rotation 90, PLAIN token: same "never tilts" rule
  // regardless of the object's own placement rotation.
  closeTo(
    transformState[tokenE].pitchDeg,
    0,
    ANGLE_EPS,
    "a PLAIN (no-model) token on STAIRS (rotation 90°) still never tilts"
  );
  closeTo(transformState[tokenE].yawDeg, 0, ANGLE_EPS, "a PLAIN (no-model) token on STAIRS (rotation 90°) has no yaw either");

  // ────────────────────────────────────────────────────────────────────
  // Scenarios F/G — the "Stairs (Half)" preset, PLAIN tokens: its OWN real
  // surface height still applies (preset-aware, never accidentally reusing
  // the full-height stairs' own constant) — tilt is still never applied to
  // a plain token, same rule as B/E above.
  // ────────────────────────────────────────────────────────────────────
  closeTo(
    transformState[tokenF].topY,
    step1 + stairsHalfSurface,
    TOPY_EPS,
    `Stairs (Half) token should render at raw-elevation height + ITS OWN real surface height (expected ${step1 + stairsHalfSurface}, got ${transformState[tokenF].topY})`
  );
  check(
    "a token on Stairs (Half) renders ABOVE the raw cell floor (on top of the model, not inside it)",
    transformState[tokenF].topY > step1 + TOPY_EPS
  );
  check(
    "Stairs (Half)'s own real surface height differs from the full-height stairs' — proves the lookup is preset-aware, not a single hardcoded stairs constant",
    Math.abs(stairsHalfSurface - stairsSurface) > 1e-6
  );
  closeTo(
    transformState[tokenF].pitchDeg,
    0,
    ANGLE_EPS,
    `a PLAIN (no-model) token on Stairs (Half) never tilts either (got pitchDeg ${transformState[tokenF].pitchDeg}°)`
  );
  closeTo(transformState[tokenF].yawDeg, 0, ANGLE_EPS, "a PLAIN (no-model) token on Stairs (Half) has no yaw either");
  closeTo(
    transformState[tokenG].pitchDeg,
    0,
    ANGLE_EPS,
    "a PLAIN (no-model) token on Stairs (Half) (rotation 90°) still never tilts"
  );
  closeTo(transformState[tokenG].yawDeg, 0, ANGLE_EPS, "a PLAIN (no-model) token on Stairs (Half) (rotation 90°) has no yaw either");

  // ────────────────────────────────────────────────────────────────────
  // Root-cause verification for the reported "pawn orientation flipped 180
  // on stairs" bug: a REAL directional (Goblin-templated) token's OWN
  // real, browser-reported pitch/yaw, checked against the stairs object's
  // OWN real stored rotation — for both stairs presets, at rotations
  // 0/90/180. A positive dot product (facesUphill) means the token's own
  // authored front (local +Z, buildGoblin()'s eyes/blade) points toward
  // the SAME side as the stairs' own real, rotated uphill end — i.e. it
  // climbs facing forward/upward, not backward.
  //
  // Also the other half of the plain-token-never-tilts fix above (B/E/F/G):
  // a token WITH a real model (this Goblin) still gets the true incline
  // magnitude — the gate is "has a model", not "is stairs vs not".
  // ────────────────────────────────────────────────────────────────────
  for (const [label, tokenId, objectRotationDeg, expectedTiltDeg] of [
    ["full-height stairs, rotation 0", tokenH, 0, stairsTiltDeg],
    ["full-height stairs, rotation 90", tokenI, 90, stairsTiltDeg],
    ["full-height stairs, rotation 180", tokenL, 180, stairsTiltDeg],
    ["half-height stairs, rotation 0", tokenJ, 0, stairsHalfTiltDeg],
    ["half-height stairs, rotation 90", tokenK, 90, stairsHalfTiltDeg],
  ]) {
    const { pitchDeg, yawDeg } = transformState[tokenId];
    const { dot, faces } = facesUphill(pitchDeg, yawDeg, objectRotationDeg);
    check(
      `a directional (Goblin) token on ${label} faces UP the stairs (toward the object's own real rotated uphill end), not backward — dot=${dot.toFixed(3)}`,
      faces,
      JSON.stringify({ pitchDeg, yawDeg, objectRotationDeg, dot })
    );
    closeTo(
      Math.abs(pitchDeg),
      expectedTiltDeg,
      ANGLE_EPS,
      `a MODELED (Goblin) token on ${label} keeps the true incline tilt magnitude — unlike a plain disc/pin, it has real geometry to convincingly occupy the pose`
    );
  }

  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "crossing-height-static-layout.png"), fullPage: false });
  console.log(`screenshot: ${join(SCRATCH_DIR, "crossing-height-static-layout.png")}`);

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — a real move (click-select-to-move) from plain ground onto a
  // stairs cell: screenshots the in-flight moment and the settled result.
  // ════════════════════════════════════════════════════════════════════
  const moveMapId = crypto.randomUUID();
  await must(
    admin.from("campaign_maps").insert({
      id: moveMapId,
      campaign_id: campaignId,
      name: "Crossing structure height — move transition",
      grid_width: 3,
      grid_height: 3,
    }),
    "inserting move-transition map"
  );
  await upsertCells([
    { map_id: moveMapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" },
    { map_id: moveMapId, x: 1, y: 0, elevation: 2, terrain_type: "normal", light_level: "bright" },
  ]);
  await voidExcept(dm.client, moveMapId, 3, 3, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  await must(
    admin.from("map_objects").insert({
      map_id: moveMapId,
      asset_id: stairsAssetId,
      x: 1,
      y: 0,
      elevation: 2,
      rotation: 0,
      crossing_type: "stairs",
    }),
    "inserting move-transition stairs object"
  );
  const moveTokenId = crypto.randomUUID();
  await must(
    admin.from("map_tokens").insert({
      id: moveTokenId,
      map_id: moveMapId,
      character_id: ariaId,
      x: 0,
      y: 0,
      elevation: 0,
      allegiance: "party",
    }),
    "inserting move-transition token"
  );
  await must(
    admin.from("campaigns").update({ live_map: moveMapId }).eq("id", campaignId),
    "updating live_map to move-transition map"
  );
  await dmRoom.reload();
  await dmRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await sleep(800);

  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "crossing-height-before-move.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "crossing-height-before-move.png")}`);

  const selectionState = () => readMirror(dmRoom, "token-selection-state");
  const tokenPoint = await scanClick(
    dmRoom,
    async () => (await selectionState()).selectedTokenId === moveTokenId,
    { label: "select move token" }
  );
  check("the move-transition token can be click-selected", tokenPoint !== null);
  const destPoint = await scanClick(
    dmRoom,
    async () => {
      const row = await tokenRow(moveTokenId);
      return row.x === 1 && row.y === 0;
    },
    { label: "confirm move onto stairs cell", exclude: tokenPoint ? [{ ...tokenPoint, radius: 14 }] : [] }
  );
  check("the token can be moved onto the stairs cell", destPoint !== null);
  // No sleep before this screenshot: TOKEN_SLIDE_SECONDS is 0.32s, so
  // capturing immediately after the confirming click has a real chance of
  // landing mid-tween — a visual "smoothly transitioning, not popped"
  // sample, not a numeric guarantee (the lerp math itself is what
  // tokenSlide.test.ts's shortestAngleLerp/plain-lerp coverage proves).
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "crossing-height-mid-move.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "crossing-height-mid-move.png")}`);

  await sleep(1000); // well past TOKEN_SLIDE_SECONDS — fully settled
  const afterMoveTransform = await pollUntil(async () => {
    const state = await readMirror(dmRoom, "token-transform-state");
    return moveTokenId in state ? state[moveTokenId] : null;
  });
  check("the moved token's settled transform is reported", afterMoveTransform !== null);
  if (afterMoveTransform) {
    // This map is a DIFFERENT size (3×3) than Phase 1's (4×2) — mapFit.ts's
    // computeTableMapMetrics fits cellSize to whichever grid axis is
    // tighter against the table's fixed footprint, so baseHeight/
    // elevationStepHeight/cellSize all genuinely differ here. Re-deriving
    // the expectation from THIS map's own metrics (not reusing Phase 1's
    // `step2`/`stairsSurface`) is what actually matches what the Game Room
    // renders for this specific map.
    const moveMetrics = mapFitModule.computeTableMapMetrics(3, 3);
    const moveStep2 = moveMetrics.baseHeight + 2 * moveMetrics.elevationStepHeight;
    const moveStairsSurface = crossingSurfaceModule.crossingSurfaceHeight(STAIRS_URL) * moveMetrics.cellSize;
    closeTo(
      afterMoveTransform.topY,
      moveStep2 + moveStairsSurface,
      TOPY_EPS,
      `after a REAL move onto stairs, the token settles at raw-elevation height + stairs surface height (expected ${moveStep2 + moveStairsSurface}, got ${afterMoveTransform.topY})`
    );
    closeTo(
      afterMoveTransform.pitchDeg,
      0,
      ANGLE_EPS,
      "after a REAL move onto stairs, this PLAIN (no-model) PC token settles with the height offset only — no tilt"
    );
  }

  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "crossing-height-after-move.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "crossing-height-after-move.png")}`);

  // ════════════════════════════════════════════════════════════════════
  // Phase 3 — the REAL gap found while root-causing "pawn orientation
  // flipped 180 on stairs": a token's own model never applied its stored
  // model_orientation forward_offset_deg correction at all (unlike a
  // PLACED object's model, which already does — ObjectMarker's own
  // forwardOffsetDeg prop). Concrete, reproducible scenario: a DM overrides
  // a monster template with a custom-uploaded asset (Weather & Enemies C7)
  // that went through the SAME orientation-correction upload flow any
  // other custom asset does. Proves the fix end-to-end: with a REAL,
  // non-zero stored correction for a template-override asset, the SAME
  // model_orientation-consuming debug mirror (verify-model-orientation.mjs's
  // own [data-testid="model-orientation-state"] precedent, extended to
  // tokens by this fix) reports the corrected value actually reaching this
  // token's own render — not just the DB row existing.
  //
  // A FRESH, uniquely-named physical .glb (a copy of goblin.glb's own
  // bytes, not the shared production file) is used so this test's own
  // model_orientation row can never affect any other campaign's real
  // Goblin tokens on this shared dev Supabase stack — model_orientation is
  // keyed globally by model url, not scoped per campaign/asset row.
  // ════════════════════════════════════════════════════════════════════
  let testAssetId = null;
  let testOverrideCampaignId = null;
  let testStoragePath = null;
  try {
    testOverrideCampaignId = crypto.randomUUID();
    await must(
      admin.from("campaigns").insert({
        id: testOverrideCampaignId,
        name: "Orientation-fix override test",
        creator: dm.id,
        action_economy_strict: false,
      }),
      "inserting orientation-fix override campaign"
    );
    await must(
      admin.from("campaign_members").insert({ campaign_id: testOverrideCampaignId, user_id: dm.id, role: "dm" }),
      "inserting orientation-fix override campaign_members"
    );

    // A REAL upload to the map-assets bucket (uploadMapAssetFile's own
    // "{campaignId}/{uuid}.glb" path convention) — goblin.glb's own real
    // bytes, so the token's model actually loads and renders in the
    // screenshot below, not just a placeholder — proving the fix visually,
    // not only via the debug mirror.
    testStoragePath = `${testOverrideCampaignId}/${crypto.randomUUID()}.glb`;
    const goblinBytes = readFileSync(join(rootDir, "public", "assets", "presets", "goblin.glb"));
    const { error: uploadError } = await admin.storage
      .from("map-assets")
      .upload(testStoragePath, goblinBytes, { contentType: "model/gltf-binary" });
    if (uploadError) throw new Error(`uploading orientation-fix test model: ${uploadError.message}`);

    // asset_library_scope_matches_source (0014_maps.sql): a 'custom' row
    // MUST carry a campaign_id — mirrors createCustomAsset's own real
    // insert shape, scoped to the test campaign above. model_ref is the
    // STABLE storage object path (uploadMapAssetFile's own return value),
    // never the ephemeral signed url.
    const { data: testAsset, error: testAssetError } = await admin
      .from("asset_library")
      .insert({
        name: "Orientation-fix test Goblin (not a real preset)",
        source_type: "custom",
        campaign_id: testOverrideCampaignId,
        model_ref: testStoragePath,
      })
      .select()
      .single();
    if (testAssetError) throw new Error(`inserting orientation-fix test asset: ${testAssetError.message}`);
    testAssetId = testAsset.id;

    await must(
      admin.from("model_orientation").upsert({ model_url: testStoragePath, forward_offset_deg: 180 }),
      "storing a real forward_offset_deg for the orientation-fix test asset"
    );

    // Weather & Enemies C7 (0075_monster_template_overrides.sql): a
    // campaign-specific override pointing the Goblin template at the
    // custom test asset above — mirrors setMonsterTemplateOverride's own
    // insert shape (data-access/monsterTemplateOverrides.ts).
    await must(
      admin.from("campaign_monster_template_overrides").insert({
        campaign_id: testOverrideCampaignId,
        monster_template_id: goblinTemplate.id,
        custom_asset_id: testAssetId,
      }),
      "inserting the Goblin template override"
    );

    const overrideMapId = crypto.randomUUID();
    await admin
      .from("campaign_maps")
      .insert({ id: overrideMapId, campaign_id: testOverrideCampaignId, name: "Orientation fix", grid_width: 2, grid_height: 1 });
    await upsertCells([{ map_id: overrideMapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "bright" }]);
    await voidExcept(dm.client, overrideMapId, 2, 1, [{ x: 0, y: 0 }]);
    const overrideStatBlock = await (async () => {
      const { data, error } = await admin
        .from("monster_stat_blocks")
        .insert({
          campaign_id: testOverrideCampaignId,
          template_id: goblinTemplate.id,
          name: "Overridden Goblin",
          max_hp: goblinTemplate.max_hp,
          armor_class: goblinTemplate.armor_class,
          passive_perception: goblinTemplate.passive_perception,
          attacks: goblinTemplate.attacks,
          default_allegiance: goblinTemplate.default_allegiance,
        })
        .select()
        .single();
      if (error) throw new Error(`inserting override stat block: ${error.message}`);
      return data;
    })();
    const overrideTokenId = crypto.randomUUID();
    await must(
      admin.from("map_tokens").insert({
        id: overrideTokenId,
        map_id: overrideMapId,
        npc_name: overrideStatBlock.name,
        monster_stat_block_id: overrideStatBlock.id,
        x: 0,
        y: 0,
        elevation: 0,
        allegiance: overrideStatBlock.default_allegiance,
      }),
      "inserting the overridden-Goblin token"
    );
    await must(
      admin.from("campaigns").update({ live_map: overrideMapId }).eq("id", testOverrideCampaignId),
      "updating live_map to the orientation-fix override map"
    );

    const overrideContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await overrideContext.addCookies(sessionCookies(dm.session));
    const overridePage = await overrideContext.newPage();
    overridePage.on("pageerror", (err) => console.error("  [page error]", err.message));
    await overridePage.goto(`${APP_URL}/campaigns/${testOverrideCampaignId}/room`);
    await overridePage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
    await sleep(1500);

    const orientationDebug = await pollUntil(
      async () => {
        const text = await overridePage.textContent('[data-testid="model-orientation-state"]').catch(() => null);
        if (!text) return null;
        const parsed = JSON.parse(text);
        return overrideTokenId in (parsed.tokens ?? {}) ? parsed : null;
      },
      { timeoutMs: 10000 }
    );
    check(
      "the model-orientation debug mirror reports this token at all",
      orientationDebug !== null,
      JSON.stringify(orientationDebug)
    );
    if (orientationDebug) {
      check(
        "a monster-template override's own stored forward_offset_deg (180°) now reaches the TOKEN's own render — the exact gap found while root-causing the reported orientation bug, fixed: this used to always report 0 for every token, no matter what was stored",
        orientationDebug.tokens[overrideTokenId] === 180,
        JSON.stringify(orientationDebug.tokens)
      );
    }
    await overridePage.screenshot({ path: join(SCRATCH_DIR, "crossing-height-orientation-fix.png") });
    console.log(`screenshot: ${join(SCRATCH_DIR, "crossing-height-orientation-fix.png")}`);
    await overrideContext.close();
  } finally {
    // Cleanup — this shared dev Supabase stack runs many concurrent
    // worktrees. Deleting the campaign CASCADEs the custom asset, the
    // template override, the map, and the token (asset_library.campaign_id
    // and campaign_monster_template_overrides.campaign_id are both ON
    // DELETE CASCADE), so the explicit asset_library delete below is only
    // a belt-and-suspenders no-op if that campaign insert itself failed
    // partway through. A stray global model_orientation row for a fake
    // (uuid-suffixed) path is harmless either way (no other real asset
    // ever resolves to it), but tidied up anyway, along with the real
    // storage object uploaded above.
    if (testOverrideCampaignId) await admin.from("campaigns").delete().eq("id", testOverrideCampaignId);
    if (testAssetId) await admin.from("asset_library").delete().eq("id", testAssetId);
    if (testStoragePath) {
      await admin.from("model_orientation").delete().eq("model_url", testStoragePath);
      await admin.storage.from("map-assets").remove([testStoragePath]);
    }
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await vite.close();
  await browser.close();
  if (devServer) devServer.kill();
}
