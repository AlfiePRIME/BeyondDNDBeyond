#!/usr/bin/env node
// A live-reported bug: a custom uploaded 3D token model (a rigged .glb)
// sometimes freezes visually after its first move — the model stays
// rendered at its old position while the token's health-bar/selection-disc
// overlay correctly shows the new position, and a full page reload fixes it
// (confirming a pure client-side rendering desync, not a data bug). FOUR
// separate automated Playwright investigations (verify-pawn-move-click-
// select.mjs, verify-token-rotation.mjs, verify-pawn-model-transform-
// repeat.mjs, verify-pawn-model-repeated-move.mjs) have all failed to
// reproduce it. This is deliberately NOT a fifth reproduction attempt — it
// verifies the DM-only, opt-in LIVE CAPTURE TOOL (TokenModelDebugOverlay.tsx)
// built so the project owner can catch the bad state themselves, live, the
// next time it happens during a real session:
//
//   1. Off by default, and DM-only — a player's DOM never even contains the
//      toggle (not just CSS-hidden).
//   2. Turning it on shows a live per-token readout: the token's logical/DB
//      position (map_tokens.x/y/elevation/rotation) next to the model's own
//      ACTUAL rendered world position (the same onTokenModelWorldDebug
//      mechanism the four investigations above already built and verified),
//      plus a computed position delta.
//   3. That readout keeps updating as the token actually moves — checked by
//      moving the token via the real click-select-to-move gesture and
//      confirming the overlay's own numbers track it, landing back near
//      zero delta once settled (this is itself a real regression check:
//      the overlay's own math has to agree with reality in the ordinary,
//      non-buggy case, or it would be useless as a capture tool).
//   4. Turning it off removes the panel cleanly (and stops mirroring rows).
//
// Needs the shared Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, explicit, isolated port if it isn't already serving.
// Usage: node scripts/db/verify-token-model-debug-overlay.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default, explicit port, confirmed free before use (and
// grepped against every other verify-*.mjs script's own PORT constant at
// authoring time) — this machine runs many concurrent agent worktrees, each
// potentially squatting on common ports with their OWN checkout's dev
// server. Port 3000 is the REAL production server and must never be used.
const APP_PORT = Number(process.env.TOKEN_MODEL_DEBUG_OVERLAY_APP_PORT ?? 4923);
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
// doesn't just miss, it can silently DELETE the token under test. Collapsing
// every panel removes every such target before a single click is thrown.
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
  const email = `token-model-debug-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `ModelDebug ${label}`,
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

async function tokenRow(id) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

/** Same as tokenRow, but throws loudly if the row is gone — a scan click
 * landing on a stray destructive control deletes the row outright rather
 * than just missing, which otherwise surfaces as an opaque null-deref many
 * lines later. */
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
 * `scanGridClick`, copied verbatim (this project's established idiom: no way
 * to compute a WebGL raycast target from camera math, so this discovers a
 * working screen point empirically, center-out). */
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
 * already-selected token toggles it OFF), tries the last-known screen point
 * second (cheap), and falls back to a full re-scan last. */
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

const UPLOAD_SOURCE_PATH = join(rootDir, "public", "assets", "presets", "witch.glb");

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const campaignId = crypto.randomUUID();

try {
  // ═══════════════════════════════════════════════════════════════════
  // Seed: one campaign (DM + a plain player member), a flat GRIDxGRID map,
  // and a real PC with a REAL uploaded custom pawn model — the same seeding
  // shape verify-pawn-model-transform-repeat.mjs already established.
  // ═══════════════════════════════════════════════════════════════════
  await admin.from("campaigns").insert({ id: campaignId, name: "Token model debug overlay", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  const characterId = crypto.randomUUID();
  const { error: characterError } = await admin.from("characters").insert({
    id: characterId,
    campaign_id: campaignId,
    owner_id: dm.id,
    name: "Model Debug Overlay PC",
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

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Model debug overlay arena",
    grid_width: 9,
    grid_height: 9,
  });
  const modeledTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: modeledTokenId, map_id: mapId, character_id: characterId, x: 4, y: 4, elevation: 0, allegiance: "party" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // ═══════════════════════════════════════════════════════════════════
  // Player client FIRST — checked before the DM ever touches the toggle,
  // so this can never accidentally pass just because the DM's own session
  // happened to leave the overlay off.
  // ═══════════════════════════════════════════════════════════════════
  const playerContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await playerContext.addCookies(sessionCookies(player.session));
  const playerRoom = await playerContext.newPage();
  playerRoom.on("pageerror", (err) => console.error("  [player page error]", err.message));
  await playerRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await playerRoom.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
  await playerRoom.waitForSelector("canvas", { timeout: 30000 });
  await sleep(1500);

  console.log("\n── Phase 1: a PLAYER's client never sees the overlay at all ──");
  await playerRoom.screenshot({ path: join(SCRATCH_DIR, "token-model-debug-player-view.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "token-model-debug-player-view.png")}`);
  check(
    "a player's DOM has NO model-debug toggle at all (not just hidden/disabled)",
    (await playerRoom.locator('[data-testid="token-model-debug-toggle"]').count()) === 0
  );
  check(
    "a player's DOM has NO model-debug panel",
    (await playerRoom.locator('[data-testid="token-model-debug-panel"]').count()) === 0
  );
  check(
    "a player's DOM has NO model-debug hidden-state mirror either — the component renders nothing at all for a non-DM viewer",
    (await playerRoom.locator('[data-testid="token-model-debug-state"]').count()) === 0
  );

  // ═══════════════════════════════════════════════════════════════════
  // DM client.
  // ═══════════════════════════════════════════════════════════════════
  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  dmRoom.on("pageerror", (err) => console.error("  [dm page error]", err.message));
  await dmRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmRoom.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
  await dmRoom.waitForSelector("canvas", { timeout: 30000 });
  await sleep(1500);

  console.log("\n── Phase 2: DM sees the toggle, OFF by default ──");
  const toggle = dmRoom.locator('[data-testid="token-model-debug-toggle"]');
  check("the DM's DOM has the model-debug toggle", (await toggle.count()) === 1);
  check("the toggle is not pressed (overlay off) on first load", (await toggle.getAttribute("aria-pressed")) === "false");
  check(
    "the panel is NOT rendered while off",
    (await dmRoom.locator('[data-testid="token-model-debug-panel"]').count()) === 0
  );
  const stateOff = await readMirror(dmRoom, "token-model-debug-state");
  check("the hidden mirror confirms enabled:false before any click", stateOff.enabled === false, stateOff);
  check("the hidden mirror carries no rows while off", Array.isArray(stateOff.rows) && stateOff.rows.length === 0, stateOff);
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "token-model-debug-dm-before-toggle.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "token-model-debug-dm-before-toggle.png")}`);

  console.log("\n── Phase 3: turning it on shows a live, accurate readout ──");
  await toggle.click();
  await sleep(300);
  check("the toggle now reads pressed (overlay on)", (await toggle.getAttribute("aria-pressed")) === "true");
  check(
    "the panel is now rendered",
    (await dmRoom.locator('[data-testid="token-model-debug-panel"]').count()) === 1
  );

  const rowAfterEnable = await pollUntil(async () => {
    const state = await readMirror(dmRoom, "token-model-debug-state");
    const row = state.rows?.find((candidate) => candidate.id === modeledTokenId);
    return row?.model ? row : null;
  });
  check(
    "the overlay reports a live model-world reading for the modeled token once enabled",
    rowAfterEnable !== null,
    rowAfterEnable
  );
  check(
    "the overlay's own reported DB position matches the real map_tokens row",
    rowAfterEnable?.db?.x === 4 && rowAfterEnable?.db?.y === 4,
    rowAfterEnable?.db
  );
  check(
    "REGRESSION CHECK: the overlay's own delta reads near-zero in the normal (non-buggy) case — its numbers are trustworthy",
    typeof rowAfterEnable?.deltaCells === "number" && rowAfterEnable.deltaCells < 0.05,
    rowAfterEnable?.deltaCells
  );
  check("the overlay does not flag a mismatch when nothing is actually wrong", rowAfterEnable?.mismatch === false, rowAfterEnable);
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "token-model-debug-dm-enabled.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "token-model-debug-dm-enabled.png")}`);

  console.log("\n── Phase 4: the readout stays live as the token actually moves ──");
  const before = await requireTokenRow(modeledTokenId, "before move");
  const selectedAt = await ensureSelected(dmRoom, modeledTokenId, null);
  check("the modeled token can be click-selected", selectedAt !== null);
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
  const after = await requireTokenRow(modeledTokenId, "after move");
  check(
    "the click on a destination cell actually relocated the modeled token in the DB",
    destination !== null && (after.x !== before.x || after.y !== before.y),
    { before, after }
  );

  await sleep(1000); // well past TOKEN_SLIDE_SECONDS (0.32s) — fully settled

  const rowAfterMove = await pollUntil(async () => {
    const state = await readMirror(dmRoom, "token-model-debug-state");
    const row = state.rows?.find((candidate) => candidate.id === modeledTokenId);
    return row?.db?.x === after.x && row?.db?.y === after.y ? row : null;
  });
  check(
    "the LIVE overlay's own DB-position field tracked the move (updated without a page reload)",
    rowAfterMove !== null,
    rowAfterMove
  );
  check(
    "the LIVE overlay's model-world reading caught up to the new cell too (near-zero delta once settled)",
    typeof rowAfterMove?.deltaCells === "number" && rowAfterMove.deltaCells < 0.05 && rowAfterMove?.mismatch === false,
    rowAfterMove
  );
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "token-model-debug-dm-after-move.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "token-model-debug-dm-after-move.png")}`);

  console.log("\n── Phase 5: turning it off removes the overlay cleanly ──");
  await toggle.click();
  await sleep(300);
  check("the toggle now reads unpressed again", (await toggle.getAttribute("aria-pressed")) === "false");
  check(
    "the panel is gone from the DOM",
    (await dmRoom.locator('[data-testid="token-model-debug-panel"]').count()) === 0
  );
  const stateAfterDisable = await readMirror(dmRoom, "token-model-debug-state");
  check(
    "the hidden mirror confirms enabled:false and carries no rows after turning it off",
    stateAfterDisable.enabled === false && Array.isArray(stateAfterDisable.rows) && stateAfterDisable.rows.length === 0,
    stateAfterDisable
  );
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "token-model-debug-dm-after-disable.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "token-model-debug-dm-after-disable.png")}`);

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
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
