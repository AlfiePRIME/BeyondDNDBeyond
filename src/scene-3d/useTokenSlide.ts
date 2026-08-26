import { useEffect, useRef, useState, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import type { GridPoint } from "@/rules-engine";
import { positionAlongRoute, tokenSlideProgress, tokenSlideRoute, type TokenSlideRoute } from "./tokenSlide";

/** "sliding" while a token is easing toward its latest target, "settled"
 * once at rest — mirrors DiceAnimationPhase's shape (diceAnimator.ts /
 * useDiceTumble.ts). The animation itself never reads this back; it exists
 * purely so a caller can observe it, the same reason useDiceTumble exposes
 * its own phase — see MapSurfaceProps.onTokenSlideDebug's doc comment for
 * the one real consumer (a verification-only hidden DOM mirror, since a
 * WebGL canvas has no DOM of its own for Playwright to inspect a slide's
 * timing directly). */
export type TokenSlidePhase = "sliding" | "settled";

export interface TokenSlideHandle {
  /** Attach to the token's <group> — position is written onto it
   * imperatively every frame (see the doc comment below), not through React
   * state, so a slide doesn't cost a re-render at 60fps. */
  ref: RefObject<Group | null>;
  phase: TokenSlidePhase;
}

export interface UseTokenSlideParams {
  /** The token's TARGET grid cell — whatever moved it (a completed drag, a
   * DM free-placement, another client's realtime-synced update) already
   * landed on this before the caller ever renders it; this hook only
   * decides how the mesh gets there visually. */
  gridX: number;
  gridY: number;
  /** Already-computed absolute world Y (baseHeight + elevation *
   * elevationStepHeight, from MapSurface's own metrics) — plain linear
   * interpolation, no waypoint sequence of its own, but eased on the exact
   * same clock as the grid-space route so a climb and a cell-crossing move
   * resolve in sync. */
  topY: number;
  cellSize: number;
  offsetX: number;
  offsetZ: number;
}

/**
 * Per-token slide animation — the render-layer generalization every move
 * (today's drag-to-move, the DM's free-placement flows, and another
 * client's realtime-synced update) rides through unmodified, because none
 * of them touch this hook directly: MapSurface just re-renders with new
 * `gridX`/`gridY`/`topY` props whenever ANY of those causes change the
 * token's stored position, and this hook is the only thing that notices.
 *
 * Same imperative-ref-write shape as `useDiceTumble`: position is written
 * onto the attached group every frame via `useFrame`, never through React
 * state, so a slide costs no re-render. The actual interpolation math lives
 * in `tokenSlide.ts`'s pure functions (the `diceAnimator.ts` pure-step
 * seam) — this hook is just the framework glue that runs a clock and feeds
 * it in.
 *
 * A move that starts mid-slide doesn't wait for the first to finish: the
 * effect below re-derives the route from `visualGridRef`/`visualTopYRef` —
 * wherever the token's last useFrame call actually left it on screen, which
 * for an uninterrupted slide is just its last settled cell — and restarts
 * the clock, so the cancel-and-restart is seamless with no snap back to the
 * old target first.
 */
export function useTokenSlide({ gridX, gridY, topY, cellSize, offsetX, offsetZ }: UseTokenSlideParams): TokenSlideHandle {
  const ref = useRef<Group>(null);
  // Starts "settled", not "sliding": the mount case below never actually
  // animates (a freshly-mounted token appears at its own position, it
  // doesn't fly in from the origin), so there's nothing to report as
  // in-motion until the effect below observes a REAL target change.
  const [phase, setPhase] = useState<TokenSlidePhase>("settled");

  // The token's actual on-screen position as of the last useFrame tick —
  // fractional mid-slide, exactly the target once settled. Read (not
  // written) by the effect below, so an interruption restarts from here
  // rather than from the stale target the interrupted slide was headed to.
  const visualGridRef = useRef<GridPoint>({ x: gridX, y: gridY });
  const visualTopYRef = useRef(topY);

  const routeRef = useRef<TokenSlideRoute>({ waypoints: [{ x: gridX, y: gridY }] });
  const fromTopYRef = useRef(topY);
  const toTopYRef = useRef(topY);
  const targetRef = useRef<GridPoint>({ x: gridX, y: gridY });
  const startElapsedRef = useRef<number | null>(null);
  // false at mount (not true): the very first useFrame tick must still run
  // once to WRITE the token's initial position onto the group at all — this
  // hook never sets a JSX `position` prop (see the doc comment above on why
  // that would fight the imperative writes), so skipping that first tick
  // would leave every token sitting at the group's default (0,0,0) forever.
  const settledRef = useRef(false);

  // Fires only when the TARGET actually changes (React's own dependency
  // comparison) — an unrelated re-render (a new conditions array, an HP
  // tick) leaves gridX/gridY/topY identical and this is a no-op, so it
  // never restarts a slide that's already headed the right way.
  useEffect(() => {
    if (targetRef.current.x === gridX && targetRef.current.y === gridY && toTopYRef.current === topY) return;
    routeRef.current = tokenSlideRoute(visualGridRef.current, { x: gridX, y: gridY });
    fromTopYRef.current = visualTopYRef.current;
    toTopYRef.current = topY;
    targetRef.current = { x: gridX, y: gridY };
    startElapsedRef.current = null;
    settledRef.current = false;
    // Reaching here means at least one of grid/topY genuinely differs from
    // the PREVIOUS target (the early return above already ruled out a
    // no-op), which always yields a real, multi-frame animation — never a
    // route that immediately collapses to "trivial" (see the useFrame
    // callback below) — so this is never a false "sliding" blip.
    setPhase("sliding");
  }, [gridX, gridY, topY]);

  useFrame((state) => {
    // Already at rest and nothing pending — skip the arithmetic and the
    // position write entirely rather than re-setting an unchanged value
    // 60 times a second for every idle token on the table.
    if (settledRef.current) return;

    if (startElapsedRef.current === null) startElapsedRef.current = state.clock.elapsedTime;
    const elapsed = state.clock.elapsedTime - startElapsedRef.current;
    const t = tokenSlideProgress(elapsed);

    const gridPos = positionAlongRoute(routeRef.current, t);
    const y = fromTopYRef.current + (toTopYRef.current - fromTopYRef.current) * t;
    visualGridRef.current = gridPos;
    visualTopYRef.current = y;
    // A route with nothing to walk (mount, or a re-render that changed
    // neither the grid cell nor the elevation) is settled the instant it's
    // written once — no need to burn the full duration animating a constant
    // value. A route that only changes elevation (grid unchanged) still has
    // a single-point waypoint list, so this must ALSO require the two topY
    // endpoints to match before short-circuiting, or an elevation-only
    // change (terrain sculpted under a stationary token) would freeze at
    // its old height instead of easing to the new one.
    const trivial = routeRef.current.waypoints.length <= 1 && fromTopYRef.current === toTopYRef.current;
    if (t >= 1 || trivial) {
      settledRef.current = true;
      // One state transition per slide (not per frame) — the useDiceTumble
      // precedent for reporting a phase change out of an imperative useFrame
      // loop without paying a per-frame re-render cost.
      if (phase !== "settled") setPhase("settled");
    }

    const group = ref.current;
    if (group) group.position.set(gridPos.x * cellSize - offsetX, y, gridPos.y * cellSize - offsetZ);
  });

  return { ref, phase };
}
