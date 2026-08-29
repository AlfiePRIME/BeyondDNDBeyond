#!/usr/bin/env node
// Movable chairs (drag gesture) verification — the player-facing half of the
// movable-chair feature that landed on top of the already-merged data layer
// (src/data-access/seatOffsets.ts, seating.ts's SeatOffset/applySeatOffset/
// getEffectiveSeat). A player can now grab and drag their OWN chair anywhere
// near the table arrangement (GameTableScene.tsx's chairDragSessionRef/
// handleChairPointerDown/the window "pointermove"/"pointerup" pair), and the
// final drop is resolved (clamped to a radius around the table arrangement,
// nudged clear of other chairs/the dice tray/the DM's book) and persisted by
// GameRoom.tsx's handleChairDragEnd, then broadcast to every other connected
// client on the campaign channel's own SEAT_MOVED_EVENT.
//
// An earlier version of this feature made the dragging player's own seated
// camera follow live, mid-gesture. The project owner reported that as an
// actual gameplay complaint ("when moving a chair or dice matt in game it
// still moves the camera... please make this stop whilst moving objects")
// and asked for it to be removed outright — GameTableScene.tsx's
// seatCameraPosition now deliberately reads through getEffectiveSeat/
// seatOffsets (the last PERSISTED offset) rather than the live in-progress
// one, so the camera holds perfectly still for the whole gesture and only
// settles once, after the drop. Check 2 below is this fix's own direct
// regression test.
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
// off the real running app. Before the camera-follow fix, the dragging
// player's own OBSERVED camera drift (chair-drag-state's ownCamera) doubled
// as a proxy for the chair's own world-space displacement (applySeatOffset
// translates both identically). Now that the camera deliberately stays put
// during a drag, that proxy no longer exists — so this script instead reads
// the chair's own live world position directly off GameRoom's
// seat-layout-state debug mirror (`seats[].position`, which — unlike the
// camera — IS still intentionally live-updated during an active drag, per
// that state's own doc comment in GameRoom.tsx). A tiny two-probe
// measurement (nudge the mouse a few pixels right, then a few pixels down,
// reading the resulting world displacement each time) gives a real local
// Jacobian between screen pixels and world meters at the current point,
// which a plain 2x2 solve inverts to aim the very next mouse move at a
// genuine world-space target — re-measured fresh each iteration (a
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
//   2. The dragging player's own seated camera position is sampled
//      CONTINUOUSLY (at every single probe point of a real drag gesture —
//      press through release, including every Newton's-method targeting
//      step, not just a couple of hand-picked checkpoints) and never
//      changes by even a millimeter, while the SAME chair's own world
//      position (seat-layout-state) genuinely does move live, proving this
//      isn't just "nothing happened yet". This is the direct regression
//      test for the camera-follow-during-drag removal (this file's own
//      header comment above) — the opposite of what this check used to
//      assert before that fix.
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
//   6. Dragging toward another connected member's own REAL, currently-live
//      personal dice tray position (read straight off GameRoom's own
//      dice-tray-layout-state mirror — Prompt 8b replaced the single
//      fixed-corner shared tray with one per-member tray computed from
//      THAT member's own live seat angle, so there's no longer a single
//      fixed coordinate worth hand-replaying) lands the final position at
//      least (chair radius + the tray's own real radius) clear of it (the
//      "the dice tray" obstacle case) — and, again, never moves the camera
//      (check 2's own regression, re-proven on a second independent drag).
//   7. Dragging as far across the screen as the viewport allows never lands
//      further than CHAIR_DRAG_CLAMP_RADIUS from the nearest table's own
//      center (the documented clamp radius actually holding) — and, once
//      more, never moves the camera even for this most-extreme drag.
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
//
// Seated-camera-in-front fix (seating.ts's CAMERA_FORWARD_INSET — the
// camera now sits between a player's own chair and the table center,
// looking toward the table, per the project owner's own bug report):
// GameTableScene's onOwnChairProjectedPosition now reports null for a
// player's own chair while in plain seat mode, since it sits outside the
// camera's own forward view by construction (see that constant's own doc
// comment in seating.ts for the full geometric reasoning). Every drag in
// this file now orbits the camera into view first
// (scripts/db/lib/orbitToOwnChair.mjs) — a real consequence of the fix, not
// a workaround for a bug in it.
//
// KNOWN, ROOT-CAUSED, PRE-EXISTING FLAKE — check 6's own tray-obstacle
// case ("the final position does NOT overlap bob's dice tray"): confirmed,
// via a real git-stash A/B comparison (this identical script run three
// times against the pre-camera-fix baseline, unmodified elsewhere, all
// three clean; run repeatedly against the camera fix, this ONE check fails
// reliably) plus direct console instrumentation of GameRoom.tsx's real
// obstacle list at the failure point, to be a genuine PRE-EXISTING race
// between two already-shipped, otherwise-unmodified features:
//   1. A personal dice tray's position (seating.ts's resolveMemberTrayLayout)
//      reactively nudges away from every REAL-TIME chair position, including
//      a chair CURRENTLY MID-DRAG (GameRoom's own seats memo, read live).
//   2. A dragged chair's own final resting spot (resolveChairDrop) is
//      resolved ONCE, on release, by nudging away from a ONE-SHOT SNAPSHOT
//      of every obstacle's CURRENT position — including that same tray,
//      which — if the chair's raw target has converged very close to the
//      tray's own true resting spot — has ALREADY fled from the incoming
//      chair by the time that snapshot is taken.
// The chair is correctly nudged clear of the tray's TRANSIENT, mid-flight
// position — but the moment the chair settles, the tray (no longer being
// approached) relaxes back toward its own true resting spot, which can
// land much closer to the chair's now-locked-in final position than the
// intended safety margin. Confirmed directly: the logged obstacle list at
// the moment of failure has bob's tray at a temporarily-fled position (his
// own current live approach) rather than its resting one. This is a real
// characteristic of the (unmodified) resolveChairDrop/
// resolveMemberTrayLayout interaction — both are individually correct and
// exhaustively unit-tested; there is simply no iteration between the two
// one-shot computations to reach a stable mutual equilibrium. It has always
// been possible to trigger in principle; this script now surfaces it far
// more reliably purely because the camera fix's own orbited viewing angle
// (needed just to find a valid on-screen point to press) gives this
// script's existing Jacobian-based precision targeting a harder-to-linearize
// screen-to-world mapping to work with, so it takes more, slower iterations
// to converge — spending more real wall-clock time with the chair sitting
// very close to the tray, which is exactly the window in which the tray's
// own live-fleeing reaction has time to fire before release. Fixing the
// underlying race would mean redesigning the mutual chair/tray settle logic
// (an iterative "both sides re-check after the other moves" loop) — a
// cross-feature change well beyond this phase's own "chair drag feel +
// seated camera position" scope, so it's left here as a documented,
// understood limitation rather than silently ignored or papered over with
// a loosened assertion.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";
import { orbitOwnChairIntoView } from "./lib/orbitToOwnChair.mjs";

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
//
// The dice tray's own position is deliberately NOT replayed as a fixed
// constant here (an earlier version of this file did — a leftover from
// before Prompt 8b replaced the single fixed-corner shared tray with one
// per-member personal tray computed from THAT member's own live seat angle,
// seating.ts's computeMemberTrayPosition/resolveMemberTrayLayout). A stale
// fixed coordinate silently stopped corresponding to any REAL tray obstacle
// — this file's own Newton's-method targeting got precise enough to expose
// it by landing dead-center on that now-meaningless point with nothing to
// nudge it away. Check 6 below instead reads a real connected member's own
// CURRENT resolved tray position straight off GameRoom's own
// dice-tray-layout-state mirror (diceTrayLayoutState below) — this file's
// own "trust nothing not directly observed" spirit, same as seat-layout-
// state/chair-drag-state.
// ---------------------------------------------------------------------------
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

/** GameRoom's own hidden mirror of every CONNECTED member's own resolved,
 * live personal dice tray position (Prompt 8b) — verify-per-member-dice-
 * trays.mjs's own established mirror, reused here instead of replaying
 * computeMemberTrayPosition/resolveMemberTrayLayout's own math by hand, so
 * check 6 below always targets a REAL, currently-live obstacle exactly as
 * the app itself computes it right now (see the "dice tray obstacle"
 * constants note above for why a hand-replayed constant stopped working).
 * `radius` is the real, current PERSONAL_TRAY_RADIUS every tray shares. */
async function diceTrayLayoutState(page) {
  const text = await page.textContent('[data-testid="dice-tray-layout-state"]');
  return JSON.parse(text);
}

/** GameRoom's own hidden mirror of THIS client's own draggable chair's live
 * screen projection and seated camera position. Post camera-follow-removal,
 * `ownCamera` is expected to stay CONSTANT for the entire duration of a
 * drag — see probeState/allClose below, this file's own regression test for
 * exactly that. */
async function chairDragState(page) {
  const text = await page.textContent('[data-testid="chair-drag-state"]');
  return JSON.parse(text);
}

/** GameRoom's own hidden mirror used by verify-turn-camera.mjs — read here
 * purely for its `chairDragging` field (GameTableScene's onChairDraggingChange,
 * mirrored straight through), the one authoritative "is a real drag session
 * actually active RIGHT NOW" signal, used by pressChairAndConfirmDragging
 * below. */
async function turnCameraState(page) {
  const text = await page.textContent('[data-testid="turn-camera-state"]');
  return JSON.parse(text);
}

/** Presses down on the chair at `screenPoint` (canvas-relative CSS pixels,
 * e.g. ownChairScreen) and confirms a REAL drag session actually started
 * (turnCameraState's own chairDragging) before returning. A pointer-down
 * landing even a pixel or two outside the chair's own small raycast hit
 * area silently does nothing — GameTableScene's handleChairPointerDown
 * never fires, chairDragSessionRef never gets set — and every subsequent
 * mouse move this file's own Jacobian targeting performs would then be
 * measuring and "aiming" at nothing, surfacing many steps later as a
 * confusing "no offset ever persisted" failure with no obvious cause.
 * Retries the press up to `maxAttempts` times before giving up loudly — each
 * retry nudges the point by a few pixels in a small deterministic spiral
 * (not the exact same spot again), since the seated-camera fix now often
 * means `screenPoint` comes from an orbited, non-seated camera angle
 * (orbitToOwnChair.mjs) where a projected point can land within a pixel or
 * two of the real hit box's own screen-space edge rather than dead-center
 * inside it. */
async function pressChairAndConfirmDragging(page, canvasBox, screenPoint, maxAttempts = 20) {
  const spiral = [
    [0, 0],
    [6, 0],
    [-6, 0],
    [0, 6],
    [0, -6],
    [6, 6],
    [-6, 6],
    [6, -6],
    [-6, -6],
    [14, 0],
    [-14, 0],
    [0, 14],
    [0, -14],
    [14, 14],
    [-14, -14],
    [14, -14],
    [-14, 14],
    [24, 0],
    [-24, 0],
    [0, 24],
  ];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Re-read the live projection every attempt (rather than trusting only
    // the one static `screenPoint` passed in) — the chair's own on-screen
    // position is only ever meaningful as of the LATEST rendered frame,
    // guarding against any drift between when the caller first measured it
    // and when a later retry actually presses.
    const fresh = await chairDragState(page);
    const base = fresh.ownChairScreen ?? screenPoint;
    const [dx, dy] = spiral[attempt % spiral.length];
    await page.mouse.move(canvasBox.x + base[0] + dx, canvasBox.y + base[1] + dy);
    await page.mouse.down();
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const state = await turnCameraState(page);
      if (state.chairDragging) return;
      await sleep(40);
    }
    // Missed — release and try again, nudged slightly.
    await page.mouse.up();
    await sleep(60);
  }
  throw new Error(`chair drag never actually started after ${maxAttempts} press attempts near ${JSON.stringify(screenPoint)}`);
}

/** One combined read of this client's dragged (or default) chair's LIVE
 * world position (seat-layout-state's `seats[].position` — unlike the now-
 * static camera, intentionally still updated on every "pointermove" tick of
 * an active drag, GameRoom.tsx's own `seats` memo read through
 * liveSeatOffsets, that memo's own doc comment) ALONGSIDE this same
 * client's own seated camera position (chair-drag-state's `ownCamera`).
 * Two sequential (never concurrent — a background poller issuing its own
 * independent Playwright commands against the same page WHILE the Newton's-
 * method loop below is also issuing mouse moves races the drag's own
 * pointer events and corrupts its timing) textContent reads, bundled into
 * one probe so every single Jacobian measurement point below doubles as a
 * camera sample for free — the literal "samples camera position throughout
 * a real drag gesture" the camera-follow-removal acceptance criterion asks
 * for, denser than any fixed-interval poll could be without racing the
 * drag's own mouse events. Camera ROTATION is deliberately not sampled
 * separately: this scene's seated camera always `lookAt`s the same fixed
 * LOOK_TARGET (GameTableScene.tsx), so its orientation is a pure function
 * of its position and nothing else changes it during a chair drag
 * (look-around is a keyboard gesture this script never touches) — proving
 * position is constant is equivalent to proving rotation is too. */
async function probeState(page, userId) {
  const seatState = await seatLayoutState(page);
  const camState = await chairDragState(page);
  const seat = seatState.seats.find((candidate) => candidate.userId === userId);
  return { position: seat ? seat.position : null, ownCamera: camState.ownCamera ?? null };
}

/** True iff every sample in `samples` is within `tol` meters of `baseline`
 * on every axis — the camera-never-moves assertion, applied to a whole
 * series of samples at once rather than one-off points. */
function allClose(samples, baseline, tol = 1e-4) {
  return samples.every(
    (s) =>
      Math.abs(s[0] - baseline[0]) <= tol &&
      Math.abs(s[1] - baseline[1]) <= tol &&
      Math.abs(s[2] - baseline[2]) <= tol
  );
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
 * probeState's own live seat world position for `userId` (see probeState's
 * own doc comment for why that — not the now-static camera — is the right
 * observable for TARGETING). Leaves the mouse back at `atScreen` when done,
 * so callers can treat this as a read-only probe. Every probeState call
 * also returns `ownCamera`, collected here into `cameraSamples` — free
 * camera-never-moved coverage at every single measurement point, not just
 * this function's own primary job. */
async function measureJacobian(page, box, atScreen, userId, probePx = 14) {
  await page.mouse.move(box.x + atScreen[0], box.y + atScreen[1]);
  await sleep(90);
  const base = await probeState(page, userId);

  await page.mouse.move(box.x + atScreen[0] + probePx, box.y + atScreen[1]);
  await sleep(90);
  const px = await probeState(page, userId);

  await page.mouse.move(box.x + atScreen[0], box.y + atScreen[1] + probePx);
  await sleep(90);
  const py = await probeState(page, userId);

  await page.mouse.move(box.x + atScreen[0], box.y + atScreen[1]);
  await sleep(90);
  const back = await probeState(page, userId);

  return {
    base: base.position,
    cameraSamples: [base.ownCamera, px.ownCamera, py.ownCamera, back.ownCamera],
    j: [
      [(px.position[0] - base.position[0]) / probePx, (py.position[0] - base.position[0]) / probePx],
      [(px.position[2] - base.position[2]) / probePx, (py.position[2] - base.position[2]) / probePx],
    ],
  };
}

/**
 * Drags the already-pressed chair toward a genuine WORLD-space target
 * (`target.dx`/`target.dz`, relative to `defaultPosition` — that seat's own
 * computed default, unaffected by the drag) using repeated local-Jacobian
 * Newton steps (measureJacobian/solve2x2 above) — see this file's own
 * header comment for why this beats hand-replicating the camera's
 * projection math. Caller is responsible for page.mouse.down()/up() around
 * this; `startScreen` is where the button was pressed. Returns the final
 * observed (dx, dz) so callers can assert against what was ACTUALLY
 * achieved, not merely what was aimed for (a nudge for collision avoidance,
 * or the clamp radius, can legitimately fall short of an aggressive target
 * — that's the whole point of the features being tested) — plus every
 * camera sample collected along the way (`cameraSamples`, see
 * measureJacobian's own doc comment), so callers get dense "throughout the
 * whole gesture" camera coverage for free.
 */
async function dragTowardWorldOffset(page, box, startScreen, userId, defaultPosition, target, opts = {}) {
  const maxIterations = opts.maxIterations ?? 5;
  const tolerance = opts.tolerance ?? 0.12;
  let screenPoint = [...startScreen];
  let lastPos = defaultPosition;
  const cameraSamples = [];
  for (let i = 0; i < maxIterations; i++) {
    const { base, j, cameraSamples: stepSamples } = await measureJacobian(page, box, screenPoint, userId);
    cameraSamples.push(...stepSamples);
    lastPos = base;
    const curDx = base[0] - defaultPosition[0];
    const curDz = base[2] - defaultPosition[2];
    const errDx = target.dx - curDx;
    const errDz = target.dz - curDz;
    if (Math.hypot(errDx, errDz) < tolerance) break;
    const step = solve2x2(j[0][0], j[0][1], j[1][0], j[1][1], errDx, errDz);
    if (!step) break;
    screenPoint = [screenPoint[0] + step.x, screenPoint[1] + step.y];
    await page.mouse.move(box.x + screenPoint[0], box.y + screenPoint[1]);
    await sleep(120);
    const after = await probeState(page, userId);
    lastPos = after.position;
    cameraSamples.push(after.ownCamera);
  }
  return { dx: lastPos[0] - defaultPosition[0], dz: lastPos[2] - defaultPosition[2], cameraSamples };
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

  // -- Alice's own chair IS draggable. -- Orbit the camera into view first —
  //    see orbitToOwnChair.mjs's own doc comment for why the seated-camera
  //    fix (the camera now sits IN FRONT of a player's own chair, per the
  //    project owner's bug report) means the chair is no longer visible (or
  //    clickable) from plain seat mode anymore, and a plain camera-mode
  //    SWITCH alone doesn't move the camera either — orbit mode starts at
  //    the exact same seated vantage point until actually dragged.
  const aliceCanvasBox = await alicePage.locator("canvas").boundingBox();
  if (!aliceCanvasBox) throw new Error("no canvas on alice's page");
  let aliceChair = await orbitOwnChairIntoView(alicePage, aliceCanvasBox);
  check("alice's own client reports a draggable chair (ownChairScreen non-null)", aliceChair.ownChairScreen !== null);

  // -- 2 & 3. A real drag: press, start continuously sampling the camera for
  //    the camera-never-moves regression check, nudge (checked live,
  //    mid-gesture, that the CHAIR's own world position genuinely moves —
  //    proving the drag itself is real, even though the camera must not
  //    follow it anymore), then Newton-solve the rest of the way toward
  //    BOB's own real world position (the "another occupied chair" obstacle
  //    case), then release. --
  const startScreen = aliceChair.ownChairScreen;
  await pressChairAndConfirmDragging(alicePage, aliceCanvasBox, startScreen);
  await sleep(150);
  const camAtPress = (await chairDragState(alicePage)).ownCamera;

  // A small, deliberately crude nudge — no precision targeting needed here,
  // only "did the CHAIR'S OWN WORLD POSITION move at all, before release".
  await alicePage.mouse.move(aliceCanvasBox.x + startScreen[0] + 60, aliceCanvasBox.y + startScreen[1] + 25);
  await sleep(200);
  const probeMidDrag = await probeState(alicePage, alice.id);
  const chairMovedLive =
    Math.hypot(probeMidDrag.position[0] - aliceDefault.position[0], probeMidDrag.position[2] - aliceDefault.position[2]) >
    0.02;
  check(
    "the dragged chair's own world position genuinely updates DURING the drag, before release (proving the drag itself is real)",
    chairMovedLive,
    JSON.stringify({ aliceDefault: aliceDefault.position, worldMidDrag: probeMidDrag.position })
  );

  const targetTowardBob = { dx: bobDefault.position[0] - aliceDefault.position[0], dz: bobDefault.position[2] - aliceDefault.position[2] };
  const achievedTowardBob = await dragTowardWorldOffset(
    alicePage,
    aliceCanvasBox,
    [startScreen[0] + 60, startScreen[1] + 25],
    alice.id,
    aliceDefault.position,
    targetTowardBob
  );
  const camBeforeRelease = (await chairDragState(alicePage)).ownCamera;
  await alicePage.mouse.up();

  const allCameraSamples = [camAtPress, probeMidDrag.ownCamera, ...achievedTowardBob.cameraSamples, camBeforeRelease];
  check(
    "the dragging player's own seated camera position never moves, at ANY of the many points sampled throughout the whole drag gesture (press through release) — even though the chair itself just moved substantially",
    allCameraSamples.length >= 3 && allClose(allCameraSamples, camAtPress),
    JSON.stringify({ camAtPress, sampleCount: allCameraSamples.length, distinctSamples: [...new Set(allCameraSamples.map((s) => JSON.stringify(s)))] })
  );

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
  const aliceCanvasBox2 = await alicePage.locator("canvas").boundingBox();
  if (!aliceCanvasBox2) throw new Error("no canvas on alice's page after reload");
  aliceChair = await orbitOwnChairIntoView(alicePage, aliceCanvasBox2); // a reload resets cameraMode to plain seat mode

  // -- 6. Dragging toward another connected member's own REAL, currently-
  //    live personal dice tray position lands clear of it (the "the dice
  //    tray" obstacle case — targeting BOB's own tray specifically: a
  //    member's OWN tray is deliberately excluded from THEIR OWN obstacle
  //    list, GameRoom.tsx's own handleChairDragEnd, so this has to be
  //    someone ELSE's to actually exercise the nudge-away behavior) — also
  //    re-proves the camera-never-moves regression on a SECOND, independent
  //    drag (this one targeting the dice tray specifically, the other
  //    object named in the original bug report). Bob never touches
  //    anything of his own during this whole script, so his tray sits at
  //    its one resolved spot the entire time — a stable, real target. --
  const trayLayoutBeforeDrag = await diceTrayLayoutState(alicePage);
  const bobTrayBefore = trayLayoutBeforeDrag.trays.find((t) => t.userId === bob.id);
  if (!bobTrayBefore) throw new Error(`bob has no resolved personal tray — ${JSON.stringify(trayLayoutBeforeDrag)}`);
  const trayRadius = trayLayoutBeforeDrag.radius;
  const targetTowardTray = {
    dx: bobTrayBefore.position[0] - aliceDefault.position[0],
    dz: bobTrayBefore.position[2] - aliceDefault.position[2],
  };
  await pressChairAndConfirmDragging(alicePage, aliceCanvasBox2, aliceChair.ownChairScreen);
  await sleep(150);
  const camAtPressTrayDrag = (await chairDragState(alicePage)).ownCamera;
  const trayDragResult = await dragTowardWorldOffset(
    alicePage,
    aliceCanvasBox2,
    aliceChair.ownChairScreen,
    alice.id,
    aliceDefault.position,
    targetTowardTray,
    { maxIterations: 6, tolerance: 0.15 }
  );
  await alicePage.mouse.up();
  check(
    "dragging alice's chair toward the dice tray ALSO never moves the camera, throughout that whole gesture",
    trayDragResult.cameraSamples.length > 0 &&
      allClose([camAtPressTrayDrag, ...trayDragResult.cameraSamples], camAtPressTrayDrag),
    JSON.stringify({ camAtPressTrayDrag, sampleCount: trayDragResult.cameraSamples.length })
  );

  const aliceRowAfterTrayDrag = await pollRow(
    "campaign_members",
    { campaign_id: campaignId, user_id: alice.id },
    (row) => row.seat_offset !== null
  );
  const aliceFinalAfterTray = {
    x: aliceDefault.position[0] + aliceRowAfterTrayDrag.seat_offset.dx,
    z: aliceDefault.position[2] + aliceRowAfterTrayDrag.seat_offset.dz,
  };
  const distanceFromTray = Math.hypot(
    aliceFinalAfterTray.x - bobTrayBefore.position[0],
    aliceFinalAfterTray.z - bobTrayBefore.position[2]
  );
  check(
    "the aimed drag actually landed alice's chair meaningfully closer to bob's dice tray than her own starting spot",
    Math.hypot(aliceFinalAfterTray.x - aliceDefault.position[0], aliceFinalAfterTray.z - aliceDefault.position[2]) >
      Math.hypot(targetTowardTray.dx, targetTowardTray.dz) - 1.5,
    JSON.stringify({ aliceFinalAfterTray, aliceDefault, bobTray: bobTrayBefore.position })
  );
  check(
    "the final position does NOT overlap bob's dice tray — nudged clear of it",
    distanceFromTray >= PLAYER_CHAIR_FRONTAGE / 2 + trayRadius - 0.02,
    JSON.stringify({ distanceFromTray, required: PLAYER_CHAIR_FRONTAGE / 2 + trayRadius })
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
  const aliceCanvasBox3 = await alicePage.locator("canvas").boundingBox();
  if (!aliceCanvasBox3) throw new Error("no canvas on alice's page after second reload");
  aliceChair = await orbitOwnChairIntoView(alicePage, aliceCanvasBox3); // a reload resets cameraMode to plain seat mode

  // -- 7. Dragging as far across the screen as the viewport allows never
  //    lands further than CHAIR_DRAG_CLAMP_RADIUS from the table. No
  //    precision targeting needed — a raw, crude drag toward a viewport
  //    corner is exactly the "as far as the gesture can physically reach"
  //    case the clamp exists for. --
  const viewport = alicePage.viewportSize() ?? { width: 1280, height: 720 };
  await pressChairAndConfirmDragging(alicePage, aliceCanvasBox3, aliceChair.ownChairScreen);
  await sleep(150);
  const camAtPressClampDrag = (await chairDragState(alicePage)).ownCamera;

  // Broken into several incremental moves (rather than one single
  // steps:12 move) purely so the camera can be sampled BETWEEN them —
  // sequential reads, never a concurrent background poller racing this
  // gesture's own mouse events (see probeState's own doc comment on why
  // that matters) — giving genuine "throughout the gesture" coverage for
  // this most-extreme drag too, not just a before/after checkpoint.
  const clampTargetX = aliceCanvasBox3.x + Math.min(viewport.width - 10, aliceCanvasBox3.width - 10);
  const clampTargetY = aliceCanvasBox3.y + 10;
  const clampOriginX = aliceCanvasBox3.x + aliceChair.ownChairScreen[0];
  const clampOriginY = aliceCanvasBox3.y + aliceChair.ownChairScreen[1];
  const cameraSamplesClampDrag = [];
  const CLAMP_DRAG_STEPS = 6;
  for (let i = 1; i <= CLAMP_DRAG_STEPS; i++) {
    const t = i / CLAMP_DRAG_STEPS;
    await alicePage.mouse.move(clampOriginX + (clampTargetX - clampOriginX) * t, clampOriginY + (clampTargetY - clampOriginY) * t, {
      steps: 3,
    });
    await sleep(60);
    cameraSamplesClampDrag.push((await chairDragState(alicePage)).ownCamera);
  }
  await sleep(200);
  await alicePage.mouse.up();
  check(
    "even the most extreme drag (all the way to a viewport corner) never moves the camera",
    cameraSamplesClampDrag.length > 0 && allClose([camAtPressClampDrag, ...cameraSamplesClampDrag], camAtPressClampDrag),
    JSON.stringify({ camAtPressClampDrag, sampleCount: cameraSamplesClampDrag.length })
  );

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
