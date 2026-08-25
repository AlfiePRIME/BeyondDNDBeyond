import { straightCellPath, type GridPoint } from "@/rules-engine";

/**
 * Fixed, short slide duration — every token move resolves visually in
 * exactly this long, regardless of how many cells it crosses (a five-cell
 * dash and a one-cell step both take TOKEN_SLIDE_SECONDS), the same
 * fixed-duration convention as the dice tumble's TUMBLE_SECONDS/
 * SETTLE_SECONDS (diceAnimator.ts) rather than a per-distance scale that
 * would make a long move sluggish.
 */
export const TOKEN_SLIDE_SECONDS = 0.32;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Eased [0, 1] fraction of a TOKEN_SLIDE_SECONDS-long slide at
 * `elapsedSeconds` in — clamped at both ends, so a caller can feed in
 * elapsed time from any point (including well past the duration) and get a
 * stable settled value back. Split out from `positionAlongRoute` below so
 * both the grid-space route AND a caller's own linear values (elevation's
 * `topY`, which has no waypoint sequence of its own) share the exact same
 * timing curve — a token climbing while it crosses cells eases both axes
 * together, not out of sync. */
export function tokenSlideProgress(elapsedSeconds: number): number {
  const raw = Math.min(Math.max(elapsedSeconds / TOKEN_SLIDE_SECONDS, 0), 1);
  return easeInOutCubic(raw);
}

export interface TokenSlideRoute {
  /** Waypoints INCLUDING the starting point — `straightCellPath`'s own
   * diagonal-then-straight route (the exact sequence movement.ts prices the
   * move at) prefixed with wherever the slide actually starts, so the whole
   * list can be walked as one plain polyline with no first-segment special
   * case. The first point need not be an on-grid integer cell (see
   * `tokenSlideRoute`'s doc comment on interrupted slides); every point
   * after it is. */
  waypoints: readonly GridPoint[];
}

/**
 * The route a token's slide should visit: `straightCellPath`'s own route
 * from `from` to `to` (movement.ts's diagonal-then-straight rule — the same
 * cell sequence the move was actually costed against), prefixed with
 * `from` itself.
 *
 * `from` is usually an on-grid integer cell (the token's last settled
 * position), in which case this is a straightforward pass-through to
 * `straightCellPath`. But a move that starts while a PREVIOUS slide is
 * still mid-flight must restart from the token's current, possibly
 * fractional, on-screen position — not snap back to the last settled cell
 * first — and `straightCellPath` (built for actual movement-cost cells, and
 * looping on strict integer equality) can't take a fractional endpoint
 * without risking an infinite loop. So `from` is used verbatim as the
 * route's first waypoint, but the COSTED portion of the route is computed
 * from the nearest whole cell to it — a visually negligible sub-cell lerp
 * into the "real" path, never touching movement.ts's actual cost/rules
 * logic (this is a rendering-only reconciliation, not a cost recomputation).
 */
export function tokenSlideRoute(from: GridPoint, to: GridPoint): TokenSlideRoute {
  const nearestCell: GridPoint = { x: Math.round(from.x), y: Math.round(from.y) };
  const rest = straightCellPath(nearestCell, to);
  const waypoints: GridPoint[] = [from, ...rest];
  const last = waypoints[waypoints.length - 1];
  // straightCellPath(nearestCell, to) can come back empty (already at, or
  // rounded onto, `to`) even though `from` itself isn't exactly `to` yet —
  // guarantee the route always actually ends at the real target so an
  // interrupted slide keeps moving instead of freezing short.
  if (last.x !== to.x || last.y !== to.y) waypoints.push(to);
  return { waypoints };
}

/**
 * The interpolated grid-space point along `route` at eased progress `t`
 * (from `tokenSlideProgress`, [0, 1]) — a pure function of (route, t), no
 * time or React involved, mirroring diceAnimator.ts's pure-step seam.
 * Divides the route into equal-duration segments (one per waypoint-to-
 * waypoint step) rather than equal-distance ones: movement.ts already
 * treats every entered cell as costing the same regardless of diagonal or
 * straight, so an even per-cell pace matches that same "every cell counts
 * the same" rule visually.
 */
export function positionAlongRoute(route: TokenSlideRoute, t: number): GridPoint {
  const { waypoints } = route;
  const lastIndex = waypoints.length - 1;
  if (lastIndex <= 0) return waypoints[0] ?? { x: 0, y: 0 };
  const clampedT = Math.min(Math.max(t, 0), 1);
  const scaled = clampedT * lastIndex;
  const index = Math.min(Math.floor(scaled), lastIndex - 1);
  const localT = scaled - index;
  const a = waypoints[index];
  const b = waypoints[index + 1];
  return { x: a.x + (b.x - a.x) * localT, y: a.y + (b.y - a.y) * localT };
}
