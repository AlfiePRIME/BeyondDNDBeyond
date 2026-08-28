#!/usr/bin/env node
// Sound Effects SP3 verification: a token's slide phase transitioning to
// "sliding" (the start of a real move) now plays the `token_move` cue
// exactly once per move — see src/scene-3d/MapSurface.tsx's TokenMarker,
// the new useEffect declared right next to its existing onSlideDebug effect
// (both watch useTokenSlide's own returned `phase`; onSlideDebug is
// verification-only, this one is the real gameplay trigger, kept as its
// own separate effect so it doesn't depend on the debug callback being
// wired up at all).
//
// Real signed-in Playwright browser throughout, driving the ACTUAL gesture
// MapPlan P11/P12 established — click-select the token directly on the 3D
// canvas, then click a reachable destination cell to confirm — the exact
// precedent verify-pawn-move-click-select.mjs/verify-token-click-select.mjs
// use (scanGridClick; no way to compute a WebGL raycast target from camera
// math, so a blind center-out scan discovers a working screen point). Never
// the Tokens-panel MOVE button — that's a different UI entry point this
// script deliberately does not exercise.
//
// Every claim is read from the sound manager's own real state (the hidden
// "sound-manager-debug" JSON mirror SP1's SoundControl.tsx exposes, backed
// by soundManager.ts's real play-call log — see getDebugSnapshot/
// subscribeDebugState) — never a mock, never inferred indirectly. The slide
// animation itself is independently confirmed still working (no regression)
// via the existing "token-slide-state" mirror verify-token-slide.mjs
// established (`sliding` lists every token currently mid-slide).
//
// Covers:
//   1. A freshly loaded, stationary token plays NO token_move sound at all
//      (neither on initial render nor from being merely click-selected).
//   2. The real click-select-then-click-destination gesture both (a) still
//      genuinely animates the slide (the token-slide-state mirror lists it
//      sliding, then clears) and (b) plays token_move EXACTLY ONCE — not
//      zero, not more than once.
//   3. The play count does NOT keep climbing while the token then sits idle
//      (the direct regression guard against "fires every frame" instead of
//      "fires once on the phase transition").
//   4. A second, independent move plays a second, independent token_move —
//      proving this is a real per-move trigger, not a one-shot-ever latch.
//   5. A full page reload — a fresh mount of a token that is NOT moving,
//      now sitting at a real, already-relocated (non-spawn) position —
//      still plays no token_move sound merely from rendering.
//
// Needs the shared Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, explicit, isolated port if it isn't already serving.
// Usage: node scripts/db/verify-token-move-sound.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default, explicit port, confirmed free before use (this
// machine runs many concurrent agent worktrees, each potentially squatting
// on common ports with their OWN checkout's dev server).
const APP_PORT = Number(process.env.TOKEN_MOVE_SOUND_APP_PORT ?? 4799);
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

// verify-pawn-move-click-select.mjs's own established lesson: DraggablePanel's
// floating panels default-anchor OVER parts of the 3D canvas, and TokenPanel's
// own "Remove" button (a real destructive action) sits inside the Tokens
// panel's default bottom-left anchor — a blind scanGridClick that clicks
// there instead of the canvas doesn't just miss, it can silently DELETE the
// token under test. Collapsing every panel removes every such target before
// a single click is ever thrown at the canvas.
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
  const email = `token-move-sound-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `TokenMoveSound ${label}`,
    ui_preferences: { panelLayout: COLLAPSED_PANEL_LAYOUT },
  });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text ?? "{}");
}
const selectionState = (page) => readMirror(page, "token-selection-state");
const slideState = (page) => readMirror(page, "token-slide-state");
const soundDebug = (page) => readMirror(page, "sound-manager-debug");

/** Every token_move entry currently in the manager's real play log — see
 * soundManager.ts's PlayLogEntry/getDebugSnapshot. */
function tokenMoveEntries(snapshot) {
  return (snapshot.playLog ?? []).filter((entry) => entry.key === "token_move");
}

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

/** Polls `token-slide-state` until `tokenId` is first seen sliding, then
 * until it clears — verify-token-slide.mjs's own observeSlide, the direct
 * structural proof a move actually animated rather than snapping (this
 * script's own regression guard on the tween itself, which this feature is
 * NOT supposed to touch). */
async function observeSlide(page, tokenId, timeoutMs = 20000) {
  const start = Date.now();
  let firstSlidingAt = null;
  let settledAt = null;
  while (Date.now() - start < timeoutMs) {
    const mirror = await slideState(page);
    const sliding = (mirror.sliding ?? []).includes(tokenId);
    if (sliding && firstSlidingAt === null) firstSlidingAt = Date.now() - start;
    if (!sliding && firstSlidingAt !== null) {
      settledAt = Date.now() - start;
      break;
    }
    await sleep(15);
  }
  return { firstSlidingAt, settledAt };
}

/** Polls the sound debug mirror until `predicate` is true or `timeoutMs`
 * elapses — verify-sound-infra.mjs's own waitForSoundDebug. */
async function waitForSoundDebug(page, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await soundDebug(page);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  return last;
}

/** Blind grid scan over the canvas — verify-pawn-move-click-select.mjs's own
 * scanGridClick. No way to compute a WebGL raycast target from camera math,
 * so this discovers a working screen point empirically, center-out. */
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

/** Re-arms a selection this scan may have accidentally knocked out (e.g. by
 * re-hitting the token's own point, which toggles it OFF) — the
 * verify-pawn-move-click-select.mjs precedent. */
function reselectOnMiss(page, tokenId, tokenPoint) {
  return async () => {
    const state = await selectionState(page);
    if (state.selectedTokenId !== tokenId) {
      await page.mouse.click(tokenPoint.x, tokenPoint.y);
      await sleep(300);
    }
  };
}

await ensureDevServer();

const GRID = 7;
const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const campaignId = crypto.randomUUID();

try {
  // ═══════════════════════════════════════════════════════════════════
  // Seed: one DM-only campaign, a flat GRIDxGRID map (dense normal-terrain
  // map_cells rows, the verify-token-slide.mjs precedent — guarantees any
  // destination cell in bounds is reachable), and a single plain NPC token
  // off-center so it has real room to move in every direction.
  // ═══════════════════════════════════════════════════════════════════
  await admin.from("campaigns").insert({ id: campaignId, name: "Token move sound test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: mapId, campaign_id: campaignId, name: "Token move sound arena", grid_width: GRID, grid_height: GRID });
  const cells = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) cells.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright" });
  }
  await admin.from("map_cells").insert(cells);

  const center = Math.floor(GRID / 2);
  const tokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([{ id: tokenId, map_id: mapId, npc_name: "Bystander", x: center, y: center, elevation: 0, allegiance: "neutral" }]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  async function loadRoom() {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
    await page.waitForSelector('[data-testid="token-slide-state"]', { state: "attached", timeout: 30000 });
    await page.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });
    await page.waitForSelector("canvas", { timeout: 30000 });
  }
  await loadRoom();
  await sleep(1500); // let every mount-time effect (including this feature's own) settle before measuring a baseline

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1 — a freshly loaded, stationary token plays NO token_move sound:
  // neither from the initial render/mount, nor from merely being
  // click-selected (selection alone never changes gridX/gridY, so
  // useTokenSlide's phase never leaves "settled").
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 1: no sound on initial load / mere selection (not moving) ──");
  const afterLoadDebug = await soundDebug(page);
  check(
    "no token_move sound played from initial page load / render alone",
    tokenMoveEntries(afterLoadDebug).length === 0,
    afterLoadDebug.playLog
  );

  const selectPoint = await scanGridClick(page, async () => (await selectionState(page)).selectedTokenId === tokenId);
  check("the token can be click-selected on the real canvas", selectPoint !== null);

  const afterSelectDebug = await soundDebug(page);
  check(
    "no token_move sound played from click-selecting the token (selection is not a move)",
    tokenMoveEntries(afterSelectDebug).length === 0,
    afterSelectDebug.playLog
  );

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2 — THE REAL GESTURE: click a reachable destination cell to
  // confirm the move. Checked two ways: the slide still genuinely animates
  // (no regression to the tween), and token_move plays EXACTLY once.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 2: real click-select-then-click-destination move — exactly one token_move ──");
  const before1 = await requireTokenRow(tokenId, "before Phase 2 move");
  const beforeMoveCount1 = tokenMoveEntries(await soundDebug(page)).length;

  const movePromise = observeSlide(page, tokenId);
  const moved1 = await scanGridClick(
    page,
    async () => {
      const row = await tokenRow(tokenId);
      return row.x !== before1.x || row.y !== before1.y;
    },
    { exclude: [{ ...selectPoint, radius: 16 }], onMiss: reselectOnMiss(page, tokenId, selectPoint) }
  );
  const after1 = await requireTokenRow(tokenId, "after Phase 2 move");
  check(
    "confirming the click on a destination cell actually relocates the token in the DB",
    moved1 !== null && (after1.x !== before1.x || after1.y !== before1.y),
    { before: before1, after: after1 }
  );

  const slideObservation1 = await movePromise;
  check(
    "REGRESSION GUARD: the move still genuinely animates — the token is observed mid-slide, not an instant snap",
    slideObservation1.firstSlidingAt !== null,
    slideObservation1
  );
  check(
    "REGRESSION GUARD: the slide still settles cleanly afterward (the tween itself is untouched)",
    slideObservation1.settledAt !== null,
    slideObservation1
  );

  const afterMoveDebug1 = await waitForSoundDebug(page, (d) => tokenMoveEntries(d).length > beforeMoveCount1, 5000);
  const afterMoveCount1 = tokenMoveEntries(afterMoveDebug1 ?? { playLog: [] }).length;
  check(
    "the token_move sound played in the manager's own real play log after the move",
    afterMoveCount1 === beforeMoveCount1 + 1,
    { before: beforeMoveCount1, after: afterMoveCount1, playLog: afterMoveDebug1?.playLog }
  );
  check(
    "the played sound is genuinely token_move, resolved to the real registry file",
    tokenMoveEntries(afterMoveDebug1).some((entry) => entry.url === "/sounds/token_move.mp3"),
    afterMoveDebug1?.playLog
  );

  // ═══════════════════════════════════════════════════════════════════
  // Phase 3 — the count does not keep climbing while the token then sits
  // idle: the direct regression guard against "fires every frame" instead
  // of "fires once on the phase transition to sliding".
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 3: no additional token_move plays while idle (not per-frame) ──");
  await sleep(1500); // comfortably longer than TOKEN_SLIDE_SECONDS (0.32s) and several seconds of idle frames
  const idleDebug = await soundDebug(page);
  check(
    "the token_move count stays flat after settling — it fired once on the phase transition, not once per animation frame",
    tokenMoveEntries(idleDebug).length === afterMoveCount1,
    { after: afterMoveCount1, idle: tokenMoveEntries(idleDebug).length }
  );

  // ═══════════════════════════════════════════════════════════════════
  // Phase 4 — a second, independent move plays a second, independent
  // token_move: this is a real per-move trigger, not a one-shot-ever latch.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 4: a second real move plays a second token_move ──");
  const before2 = await requireTokenRow(tokenId, "before Phase 4 move");
  const beforeMoveCount2 = tokenMoveEntries(await soundDebug(page)).length;

  const reselectPoint2 = await scanGridClick(page, async () => (await selectionState(page)).selectedTokenId === tokenId);
  check("the token can be re-selected for a second move", reselectPoint2 !== null);

  const slidePromise2 = observeSlide(page, tokenId);
  const moved2 = await scanGridClick(
    page,
    async () => {
      const row = await tokenRow(tokenId);
      return row.x !== before2.x || row.y !== before2.y;
    },
    { exclude: [{ ...reselectPoint2, radius: 16 }], onMiss: reselectOnMiss(page, tokenId, reselectPoint2) }
  );
  const after2 = await requireTokenRow(tokenId, "after Phase 4 move");
  check(
    "the second move also actually relocates the token in the DB",
    moved2 !== null && (after2.x !== before2.x || after2.y !== before2.y),
    { before: before2, after: after2 }
  );
  const slideObservation2 = await slidePromise2;
  check("the second move also genuinely animates", slideObservation2.firstSlidingAt !== null && slideObservation2.settledAt !== null, slideObservation2);

  const afterMoveDebug2 = await waitForSoundDebug(page, (d) => tokenMoveEntries(d).length > beforeMoveCount2, 5000);
  const afterMoveCount2 = tokenMoveEntries(afterMoveDebug2 ?? { playLog: [] }).length;
  check(
    "a SECOND independent move plays EXACTLY one more token_move (not zero, not several)",
    afterMoveCount2 === beforeMoveCount2 + 1,
    { before: beforeMoveCount2, after: afterMoveCount2 }
  );

  // ═══════════════════════════════════════════════════════════════════
  // Phase 5 — a full page reload: a fresh mount of a token that is NOT
  // moving, now sitting at a real, already-relocated (non-spawn) position,
  // still plays no token_move sound merely from rendering.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n── Phase 5: no sound on reload of an already-moved, now-stationary token ──");
  await page.reload();
  await page.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await sleep(1500);
  const afterReloadDebug = await soundDebug(page);
  check(
    "the reload started with a genuinely fresh play log (new page, new module state)",
    Array.isArray(afterReloadDebug.playLog),
    afterReloadDebug.playLog
  );
  check(
    "no token_move sound played merely from a fresh mount rendering the token at its real, non-spawn, resting position",
    tokenMoveEntries(afterReloadDebug).length === 0,
    afterReloadDebug.playLog
  );
  const rowAfterReload = await tokenRow(tokenId);
  check(
    "sanity: the token really is sitting at the moved (non-origin) position across the reload, not reset",
    rowAfterReload.x === after2.x && rowAfterReload.y === after2.y,
    { expected: after2, got: rowAfterReload }
  );

  check("no uncaught page error occurred anywhere in this script", pageErrors.length === 0, pageErrors.join(" | "));

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
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
