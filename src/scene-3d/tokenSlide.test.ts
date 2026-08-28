import { describe, expect, it } from "vitest";
import {
  TOKEN_SLIDE_SECONDS,
  positionAlongRoute,
  shortestAngleLerp,
  tokenSlideProgress,
  tokenSlideRoute,
} from "./tokenSlide";

describe("tokenSlideProgress", () => {
  it("starts at 0", () => {
    expect(tokenSlideProgress(0)).toBe(0);
  });

  it("reaches 1 exactly at the fixed duration", () => {
    expect(tokenSlideProgress(TOKEN_SLIDE_SECONDS)).toBe(1);
  });

  it("clamps to 1 well past the fixed duration", () => {
    expect(tokenSlideProgress(TOKEN_SLIDE_SECONDS * 5)).toBe(1);
  });

  it("clamps to 0 for negative elapsed time", () => {
    expect(tokenSlideProgress(-1)).toBe(0);
  });

  it("is monotonically non-decreasing across the duration", () => {
    let previous = -Infinity;
    for (let i = 0; i <= 10; i++) {
      const value = tokenSlideProgress((TOKEN_SLIDE_SECONDS * i) / 10);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("eases — the midpoint in time lands exactly at the midpoint of progress (symmetric ease-in-out)", () => {
    expect(tokenSlideProgress(TOKEN_SLIDE_SECONDS / 2)).toBeCloseTo(0.5, 10);
  });
});

describe("tokenSlideRoute", () => {
  it("returns a single-point route when the token doesn't move at all", () => {
    const route = tokenSlideRoute({ x: 2, y: 2 }, { x: 2, y: 2 });
    expect(route.waypoints).toEqual([{ x: 2, y: 2 }]);
  });

  it("prefixes straightCellPath's own route with the origin", () => {
    const route = tokenSlideRoute({ x: 1, y: 1 }, { x: 4, y: 1 });
    expect(route.waypoints).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
    ]);
  });

  it("follows the diagonal-then-straight route, not a raw straight-line cut across the grid", () => {
    const route = tokenSlideRoute({ x: 0, y: 0 }, { x: 4, y: 2 });
    // straightCellPath({x:0,y:0}, {x:4,y:2}) diagonals for 2 steps then goes
    // straight — a naive world-space lerp would instead put every
    // intermediate point on the single line y = x/2, which never visits
    // (2, 2).
    expect(route.waypoints).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
    ]);
  });

  it("handles an interrupted slide starting from a fractional on-screen position without looping or throwing", () => {
    // A second move begins while the token is still mid-flight between
    // (0,0) and (2,0) — its visual position is fractional, not a real cell.
    expect(() => tokenSlideRoute({ x: 0.5, y: 0 }, { x: 4, y: 0 })).not.toThrow();
    const route = tokenSlideRoute({ x: 0.5, y: 0 }, { x: 4, y: 0 });
    expect(route.waypoints[0]).toEqual({ x: 0.5, y: 0 });
    expect(route.waypoints[route.waypoints.length - 1]).toEqual({ x: 4, y: 0 });
  });

  it("still ends exactly at the real target even when the fractional start rounds onto it", () => {
    // Interrupted right next to the target: nearestCell rounds straight to
    // `to`, so straightCellPath(nearestCell, to) comes back empty — the
    // route must still keep `to` as its last waypoint rather than freezing
    // at the fractional start.
    const route = tokenSlideRoute({ x: 3.9, y: 0 }, { x: 4, y: 0 });
    expect(route.waypoints).toEqual([
      { x: 3.9, y: 0 },
      { x: 4, y: 0 },
    ]);
  });
});

describe("positionAlongRoute", () => {
  it("stays at the single point of a no-move route regardless of t", () => {
    const route = tokenSlideRoute({ x: 2, y: 2 }, { x: 2, y: 2 });
    expect(positionAlongRoute(route, 0)).toEqual({ x: 2, y: 2 });
    expect(positionAlongRoute(route, 0.5)).toEqual({ x: 2, y: 2 });
    expect(positionAlongRoute(route, 1)).toEqual({ x: 2, y: 2 });
  });

  it("starts exactly at the origin and ends exactly at the target", () => {
    const route = tokenSlideRoute({ x: 1, y: 1 }, { x: 4, y: 1 });
    expect(positionAlongRoute(route, 0)).toEqual({ x: 1, y: 1 });
    expect(positionAlongRoute(route, 1)).toEqual({ x: 4, y: 1 });
  });

  it("spends equal progress per cell, matching movement.ts's flat per-cell cost", () => {
    // 3 segments (1,1)->(2,1)->(3,1)->(4,1): halfway through progress lands
    // halfway through the middle segment.
    const route = tokenSlideRoute({ x: 1, y: 1 }, { x: 4, y: 1 });
    expect(positionAlongRoute(route, 0.5)).toEqual({ x: 2.5, y: 1 });
  });

  it("visits the diagonal corner a raw straight-line lerp would skip", () => {
    const route = tokenSlideRoute({ x: 0, y: 0 }, { x: 4, y: 2 });
    // 4 segments; t=0.25 lands exactly on the first waypoint after the
    // origin, i.e. the diagonal step (1,1) — a plain lerp from (0,0) to
    // (4,2) at t=0.25 would instead give (1, 0.5).
    expect(positionAlongRoute(route, 0.25)).toEqual({ x: 1, y: 1 });
  });

  it("clamps out-of-range t to the route's endpoints", () => {
    const route = tokenSlideRoute({ x: 0, y: 0 }, { x: 2, y: 0 });
    expect(positionAlongRoute(route, -1)).toEqual({ x: 0, y: 0 });
    expect(positionAlongRoute(route, 2)).toEqual({ x: 2, y: 0 });
  });
});

describe("shortestAngleLerp", () => {
  it("starts exactly at `from` and ends exactly at `to`", () => {
    expect(shortestAngleLerp(0, Math.PI / 2, 0)).toBeCloseTo(0, 10);
    expect(shortestAngleLerp(0, Math.PI / 2, 1)).toBeCloseTo(Math.PI / 2, 10);
  });

  it("plain lerp for a small delta with no wraparound involved", () => {
    expect(shortestAngleLerp(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 10);
  });

  it("takes the short way from 270° back to 0° (a +90° turn, not -270°)", () => {
    const from = (270 * Math.PI) / 180;
    const to = 0;
    const halfway = shortestAngleLerp(from, to, 0.5);
    // The short way from 270° to 360°(=0°) passes through 315° — NOT
    // through 180°/90°, which a naive `from + (to - from) * t` would do.
    expect(halfway).toBeCloseTo((315 * Math.PI) / 180, 10);
  });

  it("takes the short way from 0° to 270° (a -90° turn, not +270°)", () => {
    const from = 0;
    const to = (270 * Math.PI) / 180;
    const halfway = shortestAngleLerp(from, to, 0.5);
    expect(halfway).toBeCloseTo((-45 * Math.PI) / 180, 10);
  });

  it("is a no-op when from and to already match", () => {
    const angle = (123 * Math.PI) / 180;
    expect(shortestAngleLerp(angle, angle, 0.5)).toBeCloseTo(angle, 10);
  });
});
