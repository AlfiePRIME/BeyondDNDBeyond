#!/usr/bin/env node
// Chair/tray drag feel + seated-camera-in-front fix — two related bug
// reports, both traced to the same drag-gesture/camera code in
// GameTableScene.tsx/seating.ts:
//
//   (a) "Dragging a chair or a personal dice tray moves so fast and
//       weirdly you can't see where it will end up." Root cause: a plain
//       floor-plane raycast (near the horizon, wildly non-linear for a
//       perspective camera) fed straight into the chair's own rendered
//       position on every single pointermove, with zero visual feedback
//       about where the drop would land. Fixed with two independent,
//       additive changes:
//         1. A translucent ghost/preview ring (GameTableScene's
//            ChairDragGhost) rendered at the RAW, unsmoothed drag target
//            for the whole gesture.
//         2. The dragged chair's own RENDERED position now eases toward
//            that same raw target via per-frame exponential smoothing
//            (TableSeat's `smoothed` prop, CHAIR_DRAG_RENDER_SMOOTHING_TAU)
//            instead of snapping to it every pointermove — decoupled
//            entirely from the raw target, which keeps updating at full
//            precision underneath for collision math/the final commit. The
//            committed drop is always the precise raw target; the smoothed
//            RENDER resnaps to it exactly the instant the gesture ends.
//       A personal dice tray has no separate drag gesture of its own at
//       all (confirmed by inspection — DiceTumble.tsx/PlacedObject.tsx wire
//       up no pointer handlers; a member's own tray position is a pure
//       derived value, seating.ts's computeMemberTrayPosition, that simply
//       rides along with whichever chair it's anchored to) — so "dragging a
//       chair" is the one real gesture behind both halves of this bug
//       report.
//
//   (b) "The seated camera looks from BEHIND the chair; it should look
//       from IN FRONT of the chair/avatar, toward the table." Fixed in
//       seating.ts: seatAtAngle's cameraPosition formula now SUBTRACTS
//       CAMERA_FORWARD_INSET from a seat's own radial distance from center
//       instead of adding a setback, putting the camera between the chair
//       and the table center. See that constant's own doc comment for the
//       full screenshot-driven numeric iteration.
//
// A REAL, verified, unavoidable consequence of (b) that this script's own
// setup has to work around: the seated camera now looks AWAY from a
// player's own chair (it sits on the opposite side of the camera from
// LOOK_TARGET), so grabbing it for real requires orbiting the camera first
// — see scripts/db/lib/orbitToOwnChair.mjs's own doc comment for the full
// reasoning and mechanics. The DRAG MECHANICS themselves are completely
// unaffected by camera mode; only finding a real on-screen point to press
// down on needs the orbit step.
//
// Checks:
//   1. Dragging a chair produces a real, visible ghost/preview mesh for the
//      whole gesture (chair-drag-state's own dragGhost mirror — WebGL has
//      no DOM of its own for a script to otherwise confirm a mesh actually
//      exists in the scene graph) that tracks the RAW drag target exactly
//      (matches seat-layout-state's own live seats[].position for the
//      dragged seat, at several points during the gesture) — not some
//      smoothed or stale approximation of it.
//   2. The dragged chair's own RENDERED position (chair-drag-state's
//      ownChairRender) measurably LAGS behind that same raw target
//      immediately after an abrupt jump mid-drag (proving real smoothing,
//      not an instant snap) — then, the INSTANT the gesture is released
//      (before any further mouse movement, deliberately caught mid-lag so
//      this isn't just "it eventually catches up"), lands EXACTLY on the
//      precise final target, matching seat-layout-state's own committed
//      position byte-for-byte.
//   3. The seated camera's real, computed world position
//      (chair-drag-state's own ownCamera) is now genuinely CLOSER to the
//      table's own center than the chair's own default position is — the
//      direct, numeric proof of the "in front of the chair" fix — checked
//      immediately on page load, no drag or orbiting involved.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000.
// Usage: node scripts/db/verify-chair-camera-and-drag-feel.mjs
//        APP_URL=http://localhost:3120 node scripts/db/verify-chair-camera-and-drag-feel.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";
import { orbitOwnChairIntoView, readChairDragState } from "./lib/orbitToOwnChair.mjs";

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

async function healthOk() {
  return fetch(`${APP_URL}/api/health`)
    .then((res) => res.ok)
    .catch(() => false);
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
  const email = `chairfeel-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `ChairFeel ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

/** GameRoom's own hidden mirror of every seat's current (offset-applied,
 * RAW/unsmoothed) position/rotation — see GameRoom.tsx's own doc comment on
 * this mirror: intentionally still updated live on every "pointermove" tick
 * of an active drag, unlike the camera. This is the "raw target" every
 * other measurement in this script gets compared against. */
async function seatLayoutState(page) {
  const text = await page.textContent('[data-testid="seat-layout-state"]');
  return JSON.parse(text);
}

/** GameRoom's own hidden mirror used by verify-turn-camera.mjs/
 * verify-chair-drag.mjs — read here purely for its `chairDragging` field,
 * the one authoritative "is a real drag session actually active RIGHT NOW"
 * signal. */
async function turnCameraState(page) {
  const text = await page.textContent('[data-testid="turn-camera-state"]');
  return JSON.parse(text);
}

/** Presses down on the chair at `screenPoint` (canvas-relative CSS pixels)
 * and confirms a REAL drag session actually started (turnCameraState's own
 * chairDragging) before returning — verify-chair-drag.mjs's own precedent,
 * with the same small deterministic pixel-spiral retry (a projected point
 * from an orbited, non-seated camera angle can land within a pixel or two
 * of the real hit box's own edge rather than dead-center inside it). */
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
    // Re-read the live projection every attempt (rather than trusting the
    // one static `screenPoint` passed in) — the chair's own on-screen
    // position is only ever meaningful as of the LATEST rendered frame, and
    // this guards against any drift between when the caller first measured
    // it and when a later retry actually presses.
    const fresh = await readChairDragState(page);
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
    await page.mouse.up();
    await sleep(60);
  }
  throw new Error(`chair drag never actually started after ${maxAttempts} press attempts near ${JSON.stringify(screenPoint)}`);
}

/** True iff every coordinate of `a` and `b` is within `tol` of each other. */
function closeXZ(a, b, tol) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Chair camera and drag feel test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const aliceContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  await sleep(1500); // let avatars/models finish their first real frames

  // -----------------------------------------------------------------------
  // Check 3: the seated camera sits IN FRONT of the chair — closer to the
  // table's own center — not behind it. Read immediately, in plain seat
  // mode, no drag or orbiting needed: chair-drag-state's ownCamera always
  // reports the theoretical SEATED camera position (GameTableScene's own
  // computed `cameraPosition` variable), independent of whatever the
  // ACTUAL live camera is currently doing under orbit controls.
  // -----------------------------------------------------------------------
  const initialLayout = await seatLayoutState(alicePage);
  const aliceDefault = initialLayout.seats.find((s) => s.userId === alice.id);
  check(
    "alice's party fits entirely on the head square (tableIndex -1, table center at world origin)",
    aliceDefault?.tableIndex === -1,
    JSON.stringify(aliceDefault)
  );
  const initialChairState = await readChairDragState(alicePage);
  const chairDistanceFromCenter = Math.hypot(aliceDefault.position[0], aliceDefault.position[2]);
  const cameraDistanceFromCenter = Math.hypot(initialChairState.ownCamera[0], initialChairState.ownCamera[2]);
  check(
    "the seated camera's real computed world position is closer to the table center than the chair's own position (camera now sits IN FRONT of the chair, not behind it)",
    cameraDistanceFromCenter < chairDistanceFromCenter,
    JSON.stringify({ chairDistanceFromCenter, cameraDistanceFromCenter, ownCamera: initialChairState.ownCamera, chairPosition: aliceDefault.position })
  );
  check(
    "the camera sits at a real, positive height above the floor",
    initialChairState.ownCamera[1] > 0,
    JSON.stringify(initialChairState.ownCamera)
  );

  // -----------------------------------------------------------------------
  // Checks 1 & 2: ghost mesh + render smoothing, via a real drag. Orbiting
  // is required first — see orbitToOwnChair.mjs's own doc comment for why
  // the camera-in-front fix makes a player's own chair invisible from plain
  // seat mode now.
  // -----------------------------------------------------------------------
  const aliceCanvasBox = await alicePage.locator("canvas").boundingBox();
  if (!aliceCanvasBox) throw new Error("no canvas on alice's page");
  const aliceChair = await orbitOwnChairIntoView(alicePage, aliceCanvasBox);
  check("alice's own client reports a draggable chair once orbited into view (ownChairScreen non-null)", aliceChair.ownChairScreen !== null);

  await pressChairAndConfirmDragging(alicePage, aliceCanvasBox, aliceChair.ownChairScreen);

  // Before any movement: the ghost should already exist (mounted the
  // instant a drag session starts) and sit exactly on the chair's own
  // (unchanged-so-far) raw position.
  await sleep(120);
  const seatAtPress = (await seatLayoutState(alicePage)).seats.find((s) => s.userId === alice.id);
  const stateAtPress = await readChairDragState(alicePage);
  check(
    "a visible ghost/preview mesh exists the moment the drag starts",
    stateAtPress.dragGhost !== null,
    JSON.stringify(stateAtPress)
  );
  check(
    "the ghost's own position matches the raw (unsmoothed) seat position at press time",
    stateAtPress.dragGhost && closeXZ(stateAtPress.dragGhost, seatAtPress.position, 0.01),
    JSON.stringify({ dragGhost: stateAtPress.dragGhost, rawPosition: seatAtPress.position })
  );

  // One deliberate, ABRUPT single-step jump (not a smooth multi-step
  // move) — floorPointFromClientXY's own near-horizon non-linearity means
  // even a modest pixel offset produces a real, measurable world-space
  // jump; a single jump (rather than several small ones) makes the
  // "render lags behind raw target" gap as large and unambiguous as
  // possible to observe immediately afterward.
  const jumpX = aliceCanvasBox.x + aliceChair.ownChairScreen[0] + 90;
  const jumpY = aliceCanvasBox.y + aliceChair.ownChairScreen[1] + 50;
  await alicePage.mouse.move(jumpX, jumpY, { steps: 1 });

  // Sample IMMEDIATELY (well under one smoothing time constant) — the ghost
  // should already reflect the NEW raw target exactly (it never smooths),
  // while the chair's own rendered position should still measurably lag
  // behind it (real smoothing in progress, not an instant snap).
  await sleep(30);
  const seatMidDrag = (await seatLayoutState(alicePage)).seats.find((s) => s.userId === alice.id);
  const stateMidDrag = await readChairDragState(alicePage);
  check(
    "mid-drag: the ghost mesh still tracks the RAW target exactly, right after an abrupt jump",
    stateMidDrag.dragGhost && closeXZ(stateMidDrag.dragGhost, seatMidDrag.position, 0.01),
    JSON.stringify({ dragGhost: stateMidDrag.dragGhost, rawPosition: seatMidDrag.position })
  );
  const rawJumpDistance = Math.hypot(seatMidDrag.position[0] - seatAtPress.position[0], seatMidDrag.position[2] - seatAtPress.position[2]);
  check(
    "the abrupt jump actually moved the raw target a real, meaningful distance (the smoothing check below needs a genuine gap to observe)",
    rawJumpDistance > 0.3,
    JSON.stringify({ rawJumpDistance, before: seatAtPress.position, after: seatMidDrag.position })
  );
  const renderLagDistance =
    stateMidDrag.ownChairRender && seatMidDrag.position
      ? Math.hypot(stateMidDrag.ownChairRender[0] - seatMidDrag.position[0], stateMidDrag.ownChairRender[2] - seatMidDrag.position[2])
      : null;
  check(
    "mid-drag: the chair's own RENDERED position visibly lags/smooths behind the raw target immediately after the jump (not an instant snap)",
    renderLagDistance !== null && renderLagDistance > 0.1,
    JSON.stringify({ renderLagDistance, ownChairRender: stateMidDrag.ownChairRender, rawTarget: seatMidDrag.position })
  );

  // Release immediately — deliberately BEFORE the smoothing has had time to
  // converge, so the very next check is a real proof of "resnaps exactly on
  // release", not just "it eventually catches up given enough time".
  await alicePage.mouse.up();

  // Poll briefly for the post-release resnap — a single rAF tick is enough
  // once `smoothed` flips back to false (TableSeat's own JSX position
  // binding resumes control immediately), a world away from the ~200-300ms
  // a live drag would need to visually converge by smoothing alone.
  const deadline = Date.now() + 1000;
  let finalRawSeat = null;
  let finalRenderState = null;
  let landedExactly = false;
  while (Date.now() < deadline) {
    finalRawSeat = (await seatLayoutState(alicePage)).seats.find((s) => s.userId === alice.id);
    finalRenderState = await readChairDragState(alicePage);
    if (finalRenderState.ownChairRender && closeXZ(finalRenderState.ownChairRender, finalRawSeat.position, 1e-3)) {
      landedExactly = true;
      break;
    }
    await sleep(20);
  }
  check(
    "on release, the chair's own rendered position lands EXACTLY on the precise (unsmoothed) committed target — no lagging tail",
    landedExactly,
    JSON.stringify({ ownChairRender: finalRenderState?.ownChairRender, finalRawPosition: finalRawSeat?.position })
  );
  check(
    "the ghost mesh is gone the instant the gesture ends",
    finalRenderState?.dragGhost === null,
    JSON.stringify(finalRenderState)
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
console.log("\nAll chair camera + drag feel checks passed.");
process.exit(0);
