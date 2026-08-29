// Shared helper for scripts/db/verify-chair-drag.mjs and
// scripts/db/verify-chair-camera-and-drag-feel.mjs — both need a REAL,
// on-screen, clickable point for the current viewer's own draggable chair
// before they can simulate a press-drag-release gesture on it.
//
// Real, verified consequence of the seated-camera fix (seating.ts's
// CAMERA_FORWARD_INSET — the camera now sits BETWEEN a player's own chair
// and the table center, "in front of" it, looking toward the table): the
// chair is now on the OPPOSITE side of the camera from LOOK_TARGET, so it
// falls completely outside the seated camera's own forward view. Confirmed
// directly against a live running app (not assumed): GameTableScene's own
// onOwnChairProjectedPosition (this file's own readOwnChairScreen, via
// GameRoom's "chair-drag-state" mirror) reports null in plain seat mode for
// a real player's own chair now, where it used to report a real on-screen
// point under the old, since-fixed behind-the-chair camera.
//
// Switching to orbit/"Free camera" mode ALONE is not enough either — also
// confirmed directly, not assumed: GameTableScene's <PerspectiveCamera>
// mounts at the exact same seated position/orientation regardless of
// cameraMode (only OrbitControls' own user-driven rotation ever moves it
// away from there), so a fresh switch to orbit mode still starts the camera
// looking exactly where it did in seat mode — same forward hemisphere, same
// null projection. The camera has to actually be ORBITED (a real drag on
// the canvas) before the chair, sitting behind the original view, rotates
// into frame.
export const CAMERA_MODE_TOGGLE_TESTID = "camera-mode-toggle";

/** GameRoom's own hidden mirror of THIS client's own draggable chair's live
 * screen projection — see GameTableSceneProps.onOwnChairProjectedPosition's
 * own doc comment. Exported so callers needing other fields (ownCamera,
 * ownChairRender, dragGhost, error) can read the exact same mirror without
 * a second helper. */
export async function readChairDragState(page) {
  const text = await page.textContent('[data-testid="chair-drag-state"]');
  return JSON.parse(text);
}

async function isOrbitMode(page) {
  const label = await page.getByTestId(CAMERA_MODE_TOGGLE_TESTID).textContent();
  return Boolean(label?.includes("Return to seat"));
}

/**
 * Switches to orbit mode (if not already there) and orbits the camera —
 * via a real, incrementally-extended horizontal mouse drag on the canvas,
 * the only thing that actually moves an orbit camera — until this client's
 * own draggable chair (GameRoom's chair-drag-state.ownChairScreen) reports
 * a real point comfortably inside the canvas viewport (a `margin`-px buffer
 * from every edge, not just technically non-null — a point one pixel
 * inside the canvas edge is too fragile a target for a real subsequent
 * press). The drag always starts from a fixed point in the canvas's
 * upper-left quadrant, deliberately clear of every default-positioned
 * floating panel (dice tray/chat/dice-roller/handouts/live-map all default
 * to the center and right side — confirmed against a real screenshot), so
 * the very first mousedown always actually lands on the canvas/WebGL
 * surface rather than being swallowed by a DOM panel on top of it.
 *
 * Purely azimuthal (horizontal-only) dragging: three.js's own OrbitControls
 * rotates the camera around LOOK_TARGET on a fixed-radius sphere as the
 * mouse moves, so sweeping all the way around (up to `maxDragPx`, well over
 * a full 360° rotation's worth of pixels for any reasonable canvas height)
 * is guaranteed to eventually sweep the chair — which sits on the exact
 * opposite side of camera from LOOK_TARGET at the start — into view,
 * without ever needing to also change the vertical (polar) tilt.
 *
 * Returns the final chair-drag-state once a comfortably in-bounds point is
 * found; throws if `maxDragPx` is exhausted first.
 */
export async function orbitOwnChairIntoView(page, canvasBox, options = {}) {
  const stepPx = options.stepPx ?? 40;
  const maxDragPx = options.maxDragPx ?? 2000;
  const margin = options.margin ?? 15;
  const dragX = canvasBox.x + Math.min(300, canvasBox.width / 4);
  const dragY = canvasBox.y + Math.min(250, canvasBox.height / 4);

  if (!(await isOrbitMode(page))) {
    await page.getByTestId(CAMERA_MODE_TOGGLE_TESTID).click();
  }

  let state = await readChairDragState(page);
  const inBounds = (point) =>
    point &&
    point[0] >= margin &&
    point[0] <= canvasBox.width - margin &&
    point[1] >= margin &&
    point[1] <= canvasBox.height - margin;
  if (inBounds(state.ownChairScreen)) return state;

  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  let landedAt = null;
  try {
    for (let dragged = stepPx; dragged <= maxDragPx; dragged += stepPx) {
      await page.mouse.move(dragX + dragged, dragY, { steps: 1 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = await readChairDragState(page);
      if (inBounds(state.ownChairScreen)) {
        landedAt = dragX + dragged;
        break;
      }
    }
  } finally {
    await page.mouse.up();
  }
  if (landedAt === null) {
    throw new Error(
      `orbited up to ${maxDragPx}px without ever bringing the own chair comfortably into view — last state: ${JSON.stringify(state)}`
    );
  }

  // Purely azimuthal orbiting (above) always leaves the camera at its
  // ORIGINAL seated pitch — a downward tilt tuned for looking ACROSS the
  // table from a seat, not for looking most of the way back around the
  // room at a chair. That leaves the chair sitting right up near the top
  // edge of the frame (empirically confirmed: ~15-50px from a 900px-tall
  // canvas) — technically "in bounds", but bad for two real reasons: (1) a
  // fragile press target this close to an edge, and (2) screen-to-world
  // raycasting is at its most non-linear right at the edge of a frustum
  // (this whole feature's own root cause — see the "Chair/tray drag feel"
  // block comment in GameTableScene.tsx), which made a caller's own
  // SEPARATE precision Jacobian-based targeting (dragTowardWorldOffset,
  // verify-chair-drag.mjs) measurably unstable in practice. A short
  // VERTICAL drag afterward (from the same landing spot) adjusts the
  // camera's polar angle to pull the chair down toward vertical center
  // instead, without disturbing the azimuthal angle that already brought it
  // into view (OrbitControls treats horizontal and vertical drag as
  // independent spherical-coordinate axes).
  //
  // A single CONTINUOUS drag session sweeping both directions (three.js's
  // own OrbitControls tracks rotation as a running total of DELTAS between
  // consecutive mousemove events, not an absolute mouse position, so moving
  // the cursor back down through a Y coordinate it already visited earlier
  // in this same drag correctly restores that exact same rotation — no
  // separate "reset" gesture needed, and no risk of returning stale
  // coordinates from a few steps back, since the very last move before
  // mouseup is always whichever candidate turned out best). Recorded here
  // is the SIGNED vertical offset (from the landing spot) of the best
  // candidate seen, then replayed as the final move before releasing.
  const acceptableBand = [canvasBox.height * 0.2, canvasBox.height * 0.8];
  const inBand = (s) => inBounds(s.ownChairScreen) && s.ownChairScreen[1] >= acceptableBand[0] && s.ownChairScreen[1] <= acceptableBand[1];
  if (inBand(state)) return state;

  const probePx = 40;
  const maxSteps = 15;
  let bestOffset = 0;
  let bestDistance = Math.abs(state.ownChairScreen[1] - (acceptableBand[0] + acceptableBand[1]) / 2);
  let foundBand = false;

  await page.mouse.move(landedAt, dragY);
  await page.mouse.down();
  try {
    outer: for (const direction of [1, -1]) {
      for (let step = 1; step <= maxSteps; step++) {
        const offset = direction * step * probePx;
        await page.mouse.move(landedAt, dragY + offset, { steps: 1 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const candidate = await readChairDragState(page);
        if (!inBounds(candidate.ownChairScreen)) break; // this direction ran off-frustum — stop it
        if (inBand(candidate)) {
          bestOffset = offset;
          foundBand = true;
          break outer;
        }
        const distance = Math.abs(candidate.ownChairScreen[1] - (acceptableBand[0] + acceptableBand[1]) / 2);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestOffset = offset;
        }
      }
      // Between directions: return the cursor to the landing spot (offset
      // 0) before sweeping the other way, so each direction's own step
      // count means the same thing.
      await page.mouse.move(landedAt, dragY, { steps: 1 });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!foundBand) {
      // Never reached the comfortable band either way — replay whichever
      // offset came closest, so the final live position (and the state
      // read below) is at least the best of what was actually tried,
      // rather than wherever the sweep happened to stop.
      await page.mouse.move(landedAt, dragY + bestOffset, { steps: 1 });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await page.mouse.up();
  }

  // One more real adjustment: zoom OUT (a real mouse wheel scroll — the
  // only thing that changes an OrbitControls camera's own DISTANCE from
  // LOOK_TARGET, as opposed to the angle-only dragging above). Orbiting
  // alone leaves the camera at its original seated distance from center
  // (~2-3 units) — comfortable for viewing the NEARBY tabletop a seat was
  // tuned for, but the chair, now on the far side of the room, ends up
  // FAR from a camera still that close, which is exactly the near-horizon,
  // wildly-non-linear regime this whole feature's own root cause is about
  // (floorPointFromClientXY's own doc comment in GameTableScene.tsx).
  // Confirmed directly (not assumed): a caller doing PRECISE Jacobian-based
  // targeting from an un-zoomed orbit view (verify-chair-drag.mjs's own
  // dragTowardWorldOffset) measurably underperformed at that close range.
  // Zooming out to a much larger, still comfortably-inside-maxDistance
  // radius (GameTableScene's own OrbitControls maxDistance={26}) makes the
  // whole visible table+chair arrangement subtend a smaller fraction of the
  // frustum, which is a strictly BETTER-conditioned regime for a local
  // screen-to-world Jacobian estimate (less curvature over the same pixel
  // neighborhood) — the same reasoning a photographer stepping back with a
  // longer lens reduces perspective distortion.
  const zoomStepDelta = 60;
  let lastGood = await readChairDragState(page);
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, zoomStepDelta);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const zoomed = await readChairDragState(page);
    if (!inBounds(zoomed.ownChairScreen)) {
      // Zoomed past the point where the chair stays in frame (a real, if
      // unlikely, possibility depending on FOV/geometry) — scroll back by
      // the same delta (wheel deltas accumulate exactly like drag deltas,
      // so this exactly undoes the last step) and stop zooming further.
      await page.mouse.wheel(0, -zoomStepDelta);
      await new Promise((resolve) => setTimeout(resolve, 20));
      lastGood = await readChairDragState(page);
      break;
    }
    lastGood = zoomed;
  }
  return lastGood;
}
