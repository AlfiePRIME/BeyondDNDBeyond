import { describe, expect, it } from "vitest";
import {
  BRIDGE_URL,
  STAIRS_HALF_SLOPE_RADIANS,
  STAIRS_HALF_TILT_PITCH_RADIANS,
  STAIRS_HALF_URL,
  STAIRS_SLOPE_RADIANS,
  STAIRS_TILT_PITCH_RADIANS,
  STAIRS_URL,
  crossingSurfaceHeight,
  crossingTiltPitchRadians,
  isStairsPresetUrl,
} from "./crossingSurface";

describe("crossingSurfaceHeight", () => {
  it("is 0 for no crossing structure (undefined) — every cell/token/object before this feature", () => {
    expect(crossingSurfaceHeight(undefined)).toBe(0);
  });

  it("is 0 for null — the same 'no crossing structure' case", () => {
    expect(crossingSurfaceHeight(null)).toBe(0);
  });

  it("is 0 for an unrecognized url — never assumes a preset it doesn't know", () => {
    expect(crossingSurfaceHeight("/assets/presets/chest.glb")).toBe(0);
  });

  it("is positive for a bridge — the deck sits above the model's own base (the hanging support posts)", () => {
    expect(crossingSurfaceHeight(BRIDGE_URL)).toBeGreaterThan(0);
  });

  it("is positive for the full-height stairs — the top tread sits above the model's own base", () => {
    expect(crossingSurfaceHeight(STAIRS_URL)).toBeGreaterThan(0);
  });

  it("is positive for the half-height stairs — same reasoning as the full-height flight", () => {
    expect(crossingSurfaceHeight(STAIRS_HALF_URL)).toBeGreaterThan(0);
  });

  it("full-height stairs sit meaningfully higher than a bridge — a full flight of steps vs. a single deck plank", () => {
    expect(crossingSurfaceHeight(STAIRS_URL)).toBeGreaterThan(crossingSurfaceHeight(BRIDGE_URL));
  });

  it("full-height stairs sit higher than half-height stairs — a real, measured consequence of climbing 2 terrain levels vs. 1", () => {
    expect(crossingSurfaceHeight(STAIRS_URL)).toBeGreaterThan(crossingSurfaceHeight(STAIRS_HALF_URL));
  });

  it("half-height stairs still sit meaningfully above the bare floor (real, positive) even though — a real, measured surprise, not a bug — the bridge deck's own fit-scaled height happens to be slightly TALLER than the half flight's top step", () => {
    // Real measurement, not an assumption: the bridge is width-constrained
    // to a LARGER fit-scale factor (0.92/1.04) than its own raw deck height
    // (0.48 above the posts' base) would suggest at a glance, landing just
    // above the half flight's own fit-scaled top (0.44 raw * 0.92 scale).
    // Both are still comfortably positive and within one cell (see the
    // "stays comfortably within one cell's own footprint" case below).
    expect(crossingSurfaceHeight(STAIRS_HALF_URL)).toBeGreaterThan(0);
    expect(crossingSurfaceHeight(STAIRS_HALF_URL)).toBeCloseTo(crossingSurfaceHeight(BRIDGE_URL), 1);
  });

  it("stays comfortably within one cell's own footprint (fit to PLACED_OBJECT_SIZE < 1)", () => {
    expect(crossingSurfaceHeight(BRIDGE_URL)).toBeLessThan(1);
    expect(crossingSurfaceHeight(STAIRS_URL)).toBeLessThan(1);
    expect(crossingSurfaceHeight(STAIRS_HALF_URL)).toBeLessThan(1);
  });

  it("half-height stairs surface height is roughly (not exactly, different fit-scale factor) half the full-height flight's", () => {
    // The half flight is width-constrained (maxDim 1) rather than
    // depth-constrained (maxDim 1.2) like the full flight — a real,
    // measured consequence of halving the step count, not an assumption —
    // so its own fit-scale factor is LARGER (less shrinkage), meaning its
    // real surface height is a bit MORE than exactly half the full
    // flight's, not precisely half.
    const half = crossingSurfaceHeight(STAIRS_HALF_URL);
    const full = crossingSurfaceHeight(STAIRS_URL);
    expect(half).toBeGreaterThan(full * 0.5);
    expect(half).toBeLessThan(full * 0.7);
  });
});

describe("STAIRS_SLOPE_RADIANS (full-height flight)", () => {
  it("matches the real generator geometry's constant rise/run (atan2(0.22, 0.3))", () => {
    expect(STAIRS_SLOPE_RADIANS).toBeCloseTo(Math.atan2(0.22, 0.3), 10);
  });

  it("is a real, substantial incline — not near-flat, not near-vertical", () => {
    const degrees = (STAIRS_SLOPE_RADIANS * 180) / Math.PI;
    expect(degrees).toBeGreaterThan(20);
    expect(degrees).toBeLessThan(60);
  });
});

describe("STAIRS_TILT_PITCH_RADIANS (full-height flight)", () => {
  it("is the NEGATIVE of the slope angle — tips the uphill (+Z) direction up, not down", () => {
    expect(STAIRS_TILT_PITCH_RADIANS).toBeCloseTo(-STAIRS_SLOPE_RADIANS, 10);
  });
});

describe("STAIRS_HALF_SLOPE_RADIANS (half-height flight)", () => {
  it("matches the real generator geometry's constant rise/run (atan2(0.22, 0.3)) — the SAME per-step ratio as the full flight, by design", () => {
    expect(STAIRS_HALF_SLOPE_RADIANS).toBeCloseTo(Math.atan2(0.22, 0.3), 10);
  });

  it("is a real, substantial incline — not near-flat, not near-vertical", () => {
    const degrees = (STAIRS_HALF_SLOPE_RADIANS * 180) / Math.PI;
    expect(degrees).toBeGreaterThan(20);
    expect(degrees).toBeLessThan(60);
  });

  it("happens to equal the full flight's own slope angle exactly — a measured consequence of reusing the same rise/run per step, not assumed", () => {
    expect(STAIRS_HALF_SLOPE_RADIANS).toBeCloseTo(STAIRS_SLOPE_RADIANS, 10);
  });
});

describe("STAIRS_HALF_TILT_PITCH_RADIANS", () => {
  it("is the NEGATIVE of the half flight's own slope angle", () => {
    expect(STAIRS_HALF_TILT_PITCH_RADIANS).toBeCloseTo(-STAIRS_HALF_SLOPE_RADIANS, 10);
  });
});

describe("crossingTiltPitchRadians", () => {
  it("is 0 for no crossing structure (null/undefined)", () => {
    expect(crossingTiltPitchRadians(null)).toBe(0);
    expect(crossingTiltPitchRadians(undefined)).toBe(0);
  });

  it("is 0 for a bridge — a bridge deck is flat, never tilts", () => {
    expect(crossingTiltPitchRadians(BRIDGE_URL)).toBe(0);
  });

  it("is 0 for an unrecognized url", () => {
    expect(crossingTiltPitchRadians("/assets/presets/chest.glb")).toBe(0);
  });

  it("resolves the full-height flight's own tilt for the full-height stairs url", () => {
    expect(crossingTiltPitchRadians(STAIRS_URL)).toBe(STAIRS_TILT_PITCH_RADIANS);
  });

  it("resolves the half-height flight's own tilt for the half-height stairs url — never reuses the full-height constant by accident", () => {
    expect(crossingTiltPitchRadians(STAIRS_HALF_URL)).toBe(STAIRS_HALF_TILT_PITCH_RADIANS);
  });
});

describe("isStairsPresetUrl", () => {
  it("is true for both stairs presets", () => {
    expect(isStairsPresetUrl(STAIRS_URL)).toBe(true);
    expect(isStairsPresetUrl(STAIRS_HALF_URL)).toBe(true);
  });

  it("is false for the bridge, null/undefined, or an unrecognized url", () => {
    expect(isStairsPresetUrl(BRIDGE_URL)).toBe(false);
    expect(isStairsPresetUrl(null)).toBe(false);
    expect(isStairsPresetUrl(undefined)).toBe(false);
    expect(isStairsPresetUrl("/assets/presets/chest.glb")).toBe(false);
  });
});
