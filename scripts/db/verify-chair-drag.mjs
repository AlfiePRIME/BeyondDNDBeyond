#!/usr/bin/env node
// Movable chairs (drag gesture) verification — the player-facing half of the
// movable-chair feature that landed on top of the already-merged data layer
// (src/data-access/seatOffsets.ts, seating.ts's SeatOffset/applySeatOffset/
// getEffectiveSeat). A player can now grab and drag their OWN chair anywhere
// near the table arrangement (GameTableScene.tsx's chairDragSessionRef/
// handleChairPointerDown/the window "pointermove"/"pointerup" pair), with
// their own seated camera following live, and the final drop is resolved
// (clamped to a radius around the table arrangement, nudged clear of other
// chairs/the dice tray/the DM's book) and persisted by GameRoom.tsx's
// handleChairDragEnd, then broadcast to every other connected client on the
// campaign channel's own SEAT_MOVED_EVENT.
//
// Real end-to-end browser drags, not just seating.test.ts's already-
// exhaustive unit coverage of the underlying resolveChairDrop/
// clampToTableArrangement/rotationYTowardNearestTable pure math (that math
// is trusted here; this script proves the GESTURE, PERSISTENCE, and
// REALTIME SYNC actually work against the real running app + real DB).
//
// A real drag is simulated with Playwright's low-level page.mouse.down/
// move/up (not .click()) — GameTableScene's own drag mechanics are raw
// window "pointermove"/"pointerup" listeners (its own doc comment explains
// why: react-three-fiber's per-mesh pointer events would create dead zones
// behind other geometry), so the simulation needs to be a genuine multi-step
// drag, not a single click.
//
// Precisely targeting a SPECIFIC world-space point (another player's chair,
// the shared dice tray) from a screen-space mouse drag needs inverting the
// seated camera's own perspective projection — rather than hand-replicating
// three.js's camera matrix math, this script measures that mapping directly
// off the real running app: GameTableScene's own onOwnCameraDebug callback
// (mirrored into GameRoom's chair-drag-state debug div) reports this
// client's live camera position every time it changes, and — because
// applySeatOffset always translates cameraPosition by the IDENTICAL (dx, dz)
// as the chair's own position (seating.ts's own doc comment on that
// function) — the camera's own observed (dx, dz) drift from its pre-drag
// value is, byte-for-byte, the chair's own world-space displacement. A tiny
// two-probe measurement (nudge the mouse a few pixels right, then a few
// pixels down, reading the resulting world displacement each time) gives a
// real local Jacobian between screen pixels and world meters at the current
// point, which a plain 2x2 solve inverts to aim the very next mouse move at
// a genuine world-space target — re-measured fresh each iteration (a
// Newton's-method step) since the mapping is only LOCALLY linear. This is
// the same "trust nothing not directly observed" spirit as this script
// family's other real-browser checks.
//
// Checks:
//   1. The DM's own chair is never draggable — chair-drag-state's
//      ownChairScreen is null on the DM's client even though the DM is
//      looking at their own seat in the default seated camera, proving the
//      grab handle is never rendered for the DM's throne AT ALL, by anyone,
//      not just gated by a runtime check a determined client could route
//      around.
//   2. A live drag genuinely updates the dragging player's own seated
//      camera position mid-gesture (BEFORE release) — the direct proof for
//      "that player's own camera view updates live while dragging", not an
//      inference from unit-tested code alone.
//   3. Dragging toward another occupied player's chair's own real world
//      position lands the dragger's final PERSISTED offset at least one
//      chair-frontage clear of it (the "another occupied chair" obstacle
//      case) — checked directly against the database row setSeatOffset
//      actually wrote, and the final chair faces the (single, in this small
//      test party) table's own center.
//   4. That same move reaches a second, already-connected client (a bystander
//      player who never touched anything) LIVE, via its own
//      seat-layout-state debug mirror — real realtime sync, not just a
//      same-client optimistic update.
//   5. The new position survives a real page reload (setSeatOffset's own
//      round trip through the database, not merely this session's local
//      state).
//   6. Dragging toward the shared dice tray's own known, fixed world
//      position (table.ts's real formula, replayed here — the
//      verify-table-capacity.mjs "replay the real formula instead of
//      importing it" convention) lands the final position at least
//      (chair radius + TRAY_RADIUS) clear of it (the "the dice tray"
//      obstacle case).
//   7. Dragging as far across the screen as the viewport allows never lands
//      further than CHAIR_DRAG_CLAMP_RADIUS from the nearest table's own
//      center (the documented clamp radius actually holding).
//   8. A player cannot write another member's seat_offset at all — RLS
//      (0004, unchanged by 0044) blocks it: zero rows affected, no thrown
//      error, the exact query shape setSeatOffset itself issues (the same
//      real negative case verify-seat-offsets.mjs's own data-layer test
//      already covers, re-run here against this feature's actual end-to-end
//      usage rather than trusted by reference alone).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000.
// Usage: node scripts/db/verify-chair-drag.mjs
//        APP_URL=http://localhost:3120 node scripts/db/verify-chair-drag.mjs

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

// ---------------------------------------------------------------------------
// Real geometry constants, replayed (not imported) from table.ts/seating.ts —
// verify-table-capacity.mjs's own established convention for this script
// family: a regression in the SHIPPED numbers would be caught by re-deriving
// them independently, not silently hidden behind a shared import.
// ---------------------------------------------------------------------------
const TABLE_TOP = { width: 4.36, depth: 2.1 };
const LEG_HEIGHT = 1.05;
const TABLE_TOP_THICKNESS = 0.35;
const TABLE_SURFACE_Y = LEG_HEIGHT + TABLE_TOP_THICKNESS; // 1.4
const DEFAULT_TRAY_POSITION = [TABLE_TOP.width / 2 - 0.85, TABLE_SURFACE_Y + 0.01, -(TABLE_TOP.depth / 2 - 0.85)];
const TRAY_RADIUS = 0.55;
const PLAYER_CHAIR_FRONTAGE = 0.4669;
const CHAIR_DRAG_CLAMP_RADIUS = 6;

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
  const email = `chairdrag-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `ChairDrag ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

/** GameRoom's own hidden mirror of every seat's current (offset-applied)
 * position/rotation — identical across every client's roster, present for
 * every member. */
async function seatLayoutState(page) {
  const text = await page.textContent('[data-testid="seat-layout-state"]');
  return JSON.parse(text);
}

/** GameRoom's own hidden mirror of THIS client's own draggable chair's live
 * screen projection and seated camera position — see this file's own header
 * comment for why the camera readout is what lets this script target a real
 * world-space point without hand-replicating three.js's camera math. */
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

async function waitForSeat(page, userId, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const state = await seatLayoutState(page);
    const seat = state.seats.find((candidate) => candidate.userId === userId);
    last = seat;
    if (seat && predicate(seat)) return seat;
    await sleep(250);
  }
  return last;
}

async function pollRow(table, filter, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    let query = admin.from(table).select();
    for (const [key, value] of Object.entries(filter)) query = query.eq(key, value);
    const { data } = await query;
    last = data ?? [];
    const match = last.find(predicate);
    if (match) return match;
    await sleep(300);
  }
  return null;
}

/** Solves [[a, b], [c, d]] · [x, y] = [e, f] — the 2x2 linear solve behind
 * this script's own Jacobian-inversion drag targeting (this file's own
 * header comment). Null if the local mapping is degenerate (near-singular),
 * in which case the caller just tries again from wherever it currently is. */
function solve2x2(a, b, c, d, e, f) {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (e * d - b * f) / det, y: (a * f - e * c) / det };
}

/** One local Jacobian measurement of screen-pixels → world-meters around
 * `atScreen` (canvas-relative CSS pixels) — three probes (the baseline plus
 * one small pure-X and one small pure-Y nudge), each read back through
 * chair-drag-state's own live ownCamera (already known, per this file's
 * header comment, to move in perfect lockstep with the chair's own world
 * position). Leaves the mouse back at `atScreen` when done, so callers can
 * treat this as a read-only probe. */
async function measureJacobian(page, box, atScreen, probePx = 14) {
  await page.mouse.move(box.x + atScreen[0], box.y + atScreen[1]);
  await sleep(90);
  const base = (await chairDragState(page)).ownCamera;

  await page.mouse.move(box.x + atScreen[0] + probePx, box.y + atScreen[1]);
  await sleep(90);
  const px = (await chairDragState(page)).ownCamera;

  await page.mouse.move(box.x + atScreen[0], box.y + atScreen[1] + probePx);
  await sleep(90);
  const py = (await chairDragState(page)).ownCamera;

  await page.mouse.move(box.x + atScreen[0], box.y + atScreen[1]);
  await sleep(90);

  return {
    base,
    j: [
      [(px[0] - base[0]) / probePx, (py[0] - base[0]) / probePx],
      [(px[2] - base[2]) / probePx, (py[2] - base[2]) / probePx],
    ],
  };
}

/**
 * Drags the already-pressed chair toward a genuine WORLD-space target
 * (`targetDx`/`targetDz`, relative to wherever the chair sat when the drag
 * began) using repeated local-Jacobian Newton steps (measureJacobian/
 * solve2x2 above) — see this file's own header comment for why this beats
 * hand-replicating the camera's projection math. Caller is responsible for
 * page.mouse.down()/up() around this; `startScreen` is where the button was
 * pressed. Returns the final observed (dx, dz) so callers can assert against
 * what was ACTUALLY achieved, not merely what was aimed for (a nudge for
 * collision avoidance, or the clamp radius, can legitimately fall short of
 * an aggressive target — that's the whole point of the features being
 * tested).
 */
async function dragTowardWorldOffset(page, box, startScreen, target, opts = {}) {
  const maxIterations = opts.maxIterations ?? 5;
  const tolerance = opts.tolerance ?? 0.12;
  const cam0 = (await chairDragState(page)).ownCamera;
  let screenPoint = [...startScreen];
  let lastCam = cam0;
  for (let i = 0; i < maxIterations; i++) {
    const { base, j } = await measureJacobian(page, box, screenPoint);
    lastCam = base;
    const curDx = base[0] - cam0[0];
    const curDz = base[2] - cam0[2];
    const errDx = target.dx - curDx;
    const errDz = target.dz - curDz;
    if (Math.hypot(errDx, errDz) < tolerance) break;
    const step = solve2x2(j[0][0], j[0][1], j[1][0], j[1][1], errDx, errDz);
    if (!step) break;
    screenPoint = [screenPoint[0] + step.x, screenPoint[1] + step.y];
    await page.mouse.move(box.x + screenPoint[0], box.y + screenPoint[1]);
    await sleep(120);
    lastCam = (await chairDragState(page)).ownCamera;
  }
  return { dx: lastCam[0] - cam0[0], dz: lastCam[2] - cam0[2] };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Chair drag test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });

  const bobContext = await browser.newContext();
  await bobContext.addCookies(sessionCookies(bob.session));
  const bobPage = await bobContext.newPage();
  await bobPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await bobPage.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });

  // -- Baseline: nobody has moved a chair yet. --
  const { data: aliceRowInitial } = await admin
    .from("campaign_members")
    .select("seat_offset")
    .eq("campaign_id", campaignId)
    .eq("user_id", alice.id)
    .maybeSingle();
  check(
    "alice has never moved her chair — seat_offset starts null",
    aliceRowInitial?.seat_offset === null,
    JSON.stringify(aliceRowInitial)
  );

  const initialLayout = await seatLayoutState(alicePage);
  const aliceDefault = initialLayout.seats.find((s) => s.userId === alice.id);
  const bobDefault = initialLayout.seats.find((s) => s.userId === bob.id);
  check(
    "the small 3-member party fits entirely on the head square (tableIndex -1)",
    aliceDefault?.tableIndex === -1 && bobDefault?.tableIndex === -1,
    JSON.stringify({ aliceDefault, bobDefault })
  );

  // -- 1. The DM's own chair is never draggable, by anyone — not even the
  //    DM's own client renders a grab handle for it. --
  await sleep(1000); // let the DM's own scene render at least a few real frames
  const dmChairDrag = await chairDragState(dmPage);
  check(
    "the DM's own client reports no draggable chair at all (ownChairScreen is null)",
    dmChairDrag.ownChairScreen === null,
    JSON.stringify(dmChairDrag)
  );

  // -- Alice's own chair IS draggable. --
  const aliceCanvasBox = await alicePage.locator("canvas").boundingBox();
  if (!aliceCanvasBox) throw new Error("no canvas on alice's page");
  let aliceChair = await waitForOwnChairScreen(alicePage);
  check("alice's own client reports a draggable chair (ownChairScreen non-null)", aliceChair.ownChairScreen !== null);

  // -- 2 & 3. A real drag: press, nudge (checked live, mid-gesture, for the
  //    camera-follows-live requirement), then Newton-solve the rest of the
  //    way toward BOB's own real world position (the "another occupied
  //    chair" obstacle case), then release. --
  const startScreen = aliceChair.ownChairScreen;
  await alicePage.mouse.move(aliceCanvasBox.x + startScreen[0], aliceCanvasBox.y + startScreen[1]);
  await alicePage.mouse.down();
  await sleep(150);
  const camAtPress = (await chairDragState(alicePage)).ownCamera;

  // A small, deliberately crude nudge — no precision targeting needed here,
  // only "did the camera move at all, before release".
  await alicePage.mouse.move(aliceCanvasBox.x + startScreen[0] + 60, aliceCanvasBox.y + startScreen[1] + 25);
  await sleep(200);
  const camMidDrag = (await chairDragState(alicePage)).ownCamera;
  const camMovedLive =
    Math.hypot(camMidDrag[0] - camAtPress[0], camMidDrag[1] - camAtPress[1], camMidDrag[2] - camAtPress[2]) > 0.02;
  check(
    "the dragging player's own seated camera position genuinely updates DURING the drag, before release",
    camMovedLive,
    JSON.stringify({ camAtPress, camMidDrag })
  );

  const targetTowardBob = { dx: bobDefault.position[0] - aliceDefault.position[0], dz: bobDefault.position[2] - aliceDefault.position[2] };
  const achievedTowardBob = await dragTowardWorldOffset(
    alicePage,
    aliceCanvasBox,
    [startScreen[0] + 60, startScreen[1] + 25],
    targetTowardBob
  );
  await alicePage.mouse.up();

  // -- Persistence + non-overlap: wait for the async persist to land, then
  //    check the real database row directly. --
  const aliceRowAfterBobDrag = await pollRow(
    "campaign_members",
    { campaign_id: campaignId, user_id: alice.id },
    (row) => row.seat_offset !== null
  );
  check("dragging toward bob's chair persisted a real seat_offset for alice", aliceRowAfterBobDrag !== null);

  const aliceFinalAfterBob = {
    x: aliceDefault.position[0] + aliceRowAfterBobDrag.seat_offset.dx,
    z: aliceDefault.position[2] + aliceRowAfterBobDrag.seat_offset.dz,
  };
  const distanceFromBob = Math.hypot(aliceFinalAfterBob.x - bobDefault.position[0], aliceFinalAfterBob.z - bobDefault.position[2]);
  check(
    "the aimed drag actually landed alice's chair meaningfully closer to bob's than her own starting spot",
    Math.hypot(achievedTowardBob.dx, achievedTowardBob.dz) > 0.5,
    JSON.stringify(achievedTowardBob)
  );
  check(
    "the final position does NOT overlap bob's chair — nudged at least one chair-frontage clear of it",
    distanceFromBob >= PLAYER_CHAIR_FRONTAGE - 0.02,
    JSON.stringify({ distanceFromBob, required: PLAYER_CHAIR_FRONTAGE })
  );
  const expectedRotation = Math.atan2(aliceFinalAfterBob.x, aliceFinalAfterBob.z);
  const rotationDiff = Math.abs(
    Math.atan2(Math.sin(aliceDefault.rotationY + aliceRowAfterBobDrag.seat_offset.dRotationY - expectedRotation), Math.cos(aliceDefault.rotationY + aliceRowAfterBobDrag.seat_offset.dRotationY - expectedRotation))
  );
  check(
    "the moved chair faces the table's own center from its new spot",
    rotationDiff < 0.01,
    JSON.stringify({ storedRotationY: aliceDefault.rotationY + aliceRowAfterBobDrag.seat_offset.dRotationY, expectedRotation })
  );

  // -- 4. Realtime sync: bob (idle, never touched anything) sees alice's
  //    chair move live, via his own already-open client. --
  const bobSeesAliceMoved = await waitForSeat(
    bobPage,
    alice.id,
    (seat) => Math.hypot(seat.position[0] - aliceFinalAfterBob.x, seat.position[2] - aliceFinalAfterBob.z) < 0.05
  );
  check(
    "a second, idle, already-connected client (bob) sees alice's moved chair live",
    bobSeesAliceMoved !== null,
    JSON.stringify(bobSeesAliceMoved)
  );
  const dmSeesAliceMoved = await waitForSeat(
    dmPage,
    alice.id,
    (seat) => Math.hypot(seat.position[0] - aliceFinalAfterBob.x, seat.position[2] - aliceFinalAfterBob.z) < 0.05
  );
  check("the DM's client also sees alice's moved chair live", dmSeesAliceMoved !== null);

  // -- 5. Persists across a real page reload. --
  await alicePage.reload();
  await alicePage.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  const aliceAfterReload = await seatLayoutState(alicePage);
  const aliceSeatAfterReload = aliceAfterReload.seats.find((s) => s.userId === alice.id);
  check(
    "the moved chair's position survives a real page reload",
    aliceSeatAfterReload && Math.hypot(aliceSeatAfterReload.position[0] - aliceFinalAfterBob.x, aliceSeatAfterReload.position[2] - aliceFinalAfterBob.z) < 0.05,
    JSON.stringify({ aliceSeatAfterReload, expected: aliceFinalAfterBob })
  );

  // -- Reset alice's offset back to null (admin, bypassing the app) so the
  //    next targeted drag starts from a clean, known baseline — reload to
  //    pick that reset up (this reset has no broadcast of its own, the same
  //    "admin writes directly, a client only sees it after reload" shape
  //    every other script in this family already uses for DB-side setup). --
  await admin.from("campaign_members").update({ seat_offset: null }).eq("campaign_id", campaignId).eq("user_id", alice.id);
  await alicePage.reload();
  await alicePage.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  aliceChair = await waitForOwnChairScreen(alicePage);
  const aliceCanvasBox2 = await alicePage.locator("canvas").boundingBox();
  if (!aliceCanvasBox2) throw new Error("no canvas on alice's page after reload");

  // -- 6. Dragging toward the shared dice tray's own known position lands
  //    clear of it (the "the dice tray" obstacle case). --
  const targetTowardTray = { dx: DEFAULT_TRAY_POSITION[0] - aliceDefault.position[0], dz: DEFAULT_TRAY_POSITION[2] - aliceDefault.position[2] };
  await alicePage.mouse.move(aliceCanvasBox2.x + aliceChair.ownChairScreen[0], aliceCanvasBox2.y + aliceChair.ownChairScreen[1]);
  await alicePage.mouse.down();
  await sleep(150);
  await dragTowardWorldOffset(alicePage, aliceCanvasBox2, aliceChair.ownChairScreen, targetTowardTray, {
    maxIterations: 6,
    tolerance: 0.15,
  });
  await alicePage.mouse.up();

  const aliceRowAfterTrayDrag = await pollRow(
    "campaign_members",
    { campaign_id: campaignId, user_id: alice.id },
    (row) => row.seat_offset !== null
  );
  const aliceFinalAfterTray = {
    x: aliceDefault.position[0] + aliceRowAfterTrayDrag.seat_offset.dx,
    z: aliceDefault.position[2] + aliceRowAfterTrayDrag.seat_offset.dz,
  };
  const distanceFromTray = Math.hypot(aliceFinalAfterTray.x - DEFAULT_TRAY_POSITION[0], aliceFinalAfterTray.z - DEFAULT_TRAY_POSITION[2]);
  check(
    "the aimed drag actually landed alice's chair meaningfully closer to the dice tray than her own starting spot",
    Math.hypot(aliceFinalAfterTray.x - aliceDefault.position[0], aliceFinalAfterTray.z - aliceDefault.position[2]) >
      Math.hypot(DEFAULT_TRAY_POSITION[0] - aliceDefault.position[0], DEFAULT_TRAY_POSITION[2] - aliceDefault.position[2]) - 1.5,
    JSON.stringify({ aliceFinalAfterTray, aliceDefault, DEFAULT_TRAY_POSITION })
  );
  check(
    "the final position does NOT overlap the shared dice tray — nudged clear of it",
    distanceFromTray >= PLAYER_CHAIR_FRONTAGE / 2 + TRAY_RADIUS - 0.02,
    JSON.stringify({ distanceFromTray, required: PLAYER_CHAIR_FRONTAGE / 2 + TRAY_RADIUS })
  );
  check(
    "the tray-avoiding drop still respects the clamp radius around the table",
    Math.hypot(aliceFinalAfterTray.x, aliceFinalAfterTray.z) <= CHAIR_DRAG_CLAMP_RADIUS + 0.05,
    JSON.stringify({ distance: Math.hypot(aliceFinalAfterTray.x, aliceFinalAfterTray.z) })
  );

  // -- Reset again for the clamp test. --
  await admin.from("campaign_members").update({ seat_offset: null }).eq("campaign_id", campaignId).eq("user_id", alice.id);
  await alicePage.reload();
  await alicePage.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  aliceChair = await waitForOwnChairScreen(alicePage);
  const aliceCanvasBox3 = await alicePage.locator("canvas").boundingBox();
  if (!aliceCanvasBox3) throw new Error("no canvas on alice's page after second reload");

  // -- 7. Dragging as far across the screen as the viewport allows never
  //    lands further than CHAIR_DRAG_CLAMP_RADIUS from the table. No
  //    precision targeting needed — a raw, crude drag toward a viewport
  //    corner is exactly the "as far as the gesture can physically reach"
  //    case the clamp exists for. --
  const viewport = alicePage.viewportSize() ?? { width: 1280, height: 720 };
  await alicePage.mouse.move(aliceCanvasBox3.x + aliceChair.ownChairScreen[0], aliceCanvasBox3.y + aliceChair.ownChairScreen[1]);
  await alicePage.mouse.down();
  await sleep(150);
  await alicePage.mouse.move(aliceCanvasBox3.x + Math.min(viewport.width - 10, aliceCanvasBox3.width - 10), aliceCanvasBox3.y + 10, {
    steps: 12,
  });
  await sleep(300);
  await alicePage.mouse.up();

  const aliceRowAfterClampDrag = await pollRow(
    "campaign_members",
    { campaign_id: campaignId, user_id: alice.id },
    (row) => row.seat_offset !== null
  );
  const aliceFinalAfterClamp = {
    x: aliceDefault.position[0] + aliceRowAfterClampDrag.seat_offset.dx,
    z: aliceDefault.position[2] + aliceRowAfterClampDrag.seat_offset.dz,
  };
  const distanceFromCenterAfterClamp = Math.hypot(aliceFinalAfterClamp.x, aliceFinalAfterClamp.z);
  check(
    "dragging as far as the viewport allows never lands the chair outside the documented clamp radius",
    distanceFromCenterAfterClamp <= CHAIR_DRAG_CLAMP_RADIUS + 0.05,
    JSON.stringify({ distanceFromCenterAfterClamp, CHAIR_DRAG_CLAMP_RADIUS })
  );

  // -- 8. A player cannot write another member's seat_offset at all — the
  //    exact query shape setSeatOffset itself issues, run here as BOB
  //    against ALICE's row (RLS 0004, unchanged by 0044). --
  const { error: crossWriteError, count: crossWriteCount } = await bob.client
    .from("campaign_members")
    .update({ seat_offset: { dx: 999, dz: 999, dRotationY: 0 } }, { count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", alice.id);
  check(
    "a player cannot write another member's seat_offset (RLS blocks it: zero rows affected)",
    !crossWriteError && crossWriteCount === 0,
    JSON.stringify({ crossWriteError, crossWriteCount })
  );
  const { data: aliceRowAfterAttack } = await admin
    .from("campaign_members")
    .select("seat_offset")
    .eq("campaign_id", campaignId)
    .eq("user_id", alice.id)
    .maybeSingle();
  check(
    "alice's row is untouched by bob's blocked cross-member write",
    JSON.stringify(aliceRowAfterAttack?.seat_offset) === JSON.stringify(aliceRowAfterClampDrag.seat_offset),
    JSON.stringify(aliceRowAfterAttack)
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
console.log("\nAll movable-chair drag checks passed.");
process.exit(0);
