import { describe, expect, it } from "vitest";
import {
  STAIRS_SLOPE_RADIANS,
  STAIRS_TILT_PITCH_RADIANS,
  crossingSurfaceHeight,
} from "./crossingSurface";

describe("crossingSurfaceHeight", () => {
  it("is 0 for no crossing structure (undefined) — every cell/token/object before this feature", () => {
    expect(crossingSurfaceHeight(undefined)).toBe(0);
  });

  it("is 0 for null — the same 'no crossing structure' case", () => {
    expect(crossingSurfaceHeight(null)).toBe(0);
  });

  it("is positive for a bridge — the deck sits above the model's own base (the hanging support posts)", () => {
    expect(crossingSurfaceHeight("bridge")).toBeGreaterThan(0);
  });

  it("is positive for stairs — the top tread sits above the model's own base", () => {
    expect(crossingSurfaceHeight("stairs")).toBeGreaterThan(0);
  });

  it("stairs sit meaningfully higher than a bridge — a full flight of steps vs. a single deck plank", () => {
    expect(crossingSurfaceHeight("stairs")).toBeGreaterThan(crossingSurfaceHeight("bridge"));
  });

  it("stays comfortably within one cell's own footprint (fit to PLACED_OBJECT_SIZE < 1)", () => {
    expect(crossingSurfaceHeight("bridge")).toBeLessThan(1);
    expect(crossingSurfaceHeight("stairs")).toBeLessThan(1);
  });
});

describe("STAIRS_SLOPE_RADIANS", () => {
  it("matches the real generator geometry's constant rise/run (atan2(0.22, 0.3))", () => {
    expect(STAIRS_SLOPE_RADIANS).toBeCloseTo(Math.atan2(0.22, 0.3), 10);
  });

  it("is a real, substantial incline — not near-flat, not near-vertical", () => {
    const degrees = (STAIRS_SLOPE_RADIANS * 180) / Math.PI;
    expect(degrees).toBeGreaterThan(20);
    expect(degrees).toBeLessThan(60);
  });
});

describe("STAIRS_TILT_PITCH_RADIANS", () => {
  it("is the NEGATIVE of the slope angle — tips the uphill (+Z) direction up, not down", () => {
    expect(STAIRS_TILT_PITCH_RADIANS).toBeCloseTo(-STAIRS_SLOPE_RADIANS, 10);
  });
});
