import { describe, expect, it } from "vitest";
import {
  canShareCell,
  isSurfaceHostUrl,
  isSurfacePropUrl,
  SURFACE_LIFT_HEIGHT,
  SURFACE_PROP_SCALE,
  surfaceStackLift,
  surfaceStackScale,
} from "./surfaceStack";

describe("isSurfaceHostUrl", () => {
  it("is true for Table/Bar Counter/Bar Corner", () => {
    expect(isSurfaceHostUrl("/assets/presets/table.glb")).toBe(true);
    expect(isSurfaceHostUrl("/assets/presets/bar-counter.glb")).toBe(true);
    expect(isSurfaceHostUrl("/assets/presets/bar-corner.glb")).toBe(true);
  });

  it("is false for a small prop, an unrelated preset, null, or undefined", () => {
    expect(isSurfaceHostUrl("/assets/presets/glass.glb")).toBe(false);
    expect(isSurfaceHostUrl("/assets/presets/chest.glb")).toBe(false);
    expect(isSurfaceHostUrl(null)).toBe(false);
    expect(isSurfaceHostUrl(undefined)).toBe(false);
  });
});

describe("isSurfacePropUrl", () => {
  it("is true for Glass/Beer Pump/Food Plate", () => {
    expect(isSurfacePropUrl("/assets/presets/glass.glb")).toBe(true);
    expect(isSurfacePropUrl("/assets/presets/beer-pump.glb")).toBe(true);
    expect(isSurfacePropUrl("/assets/presets/food-plate.glb")).toBe(true);
  });

  it("is false for a host, an unrelated preset, null, or undefined", () => {
    expect(isSurfacePropUrl("/assets/presets/table.glb")).toBe(false);
    expect(isSurfacePropUrl("/assets/presets/chest.glb")).toBe(false);
    expect(isSurfacePropUrl(null)).toBe(false);
    expect(isSurfacePropUrl(undefined)).toBe(false);
  });
});

describe("canShareCell", () => {
  it("is true for a (host, prop) pair in either order", () => {
    expect(canShareCell("/assets/presets/table.glb", "/assets/presets/glass.glb")).toBe(true);
    expect(canShareCell("/assets/presets/glass.glb", "/assets/presets/table.glb")).toBe(true);
    expect(canShareCell("/assets/presets/bar-counter.glb", "/assets/presets/beer-pump.glb")).toBe(true);
    expect(canShareCell("/assets/presets/bar-corner.glb", "/assets/presets/food-plate.glb")).toBe(true);
  });

  it("is false for two hosts, two props, or an unrelated pair", () => {
    expect(canShareCell("/assets/presets/table.glb", "/assets/presets/bar-counter.glb")).toBe(false);
    expect(canShareCell("/assets/presets/glass.glb", "/assets/presets/beer-pump.glb")).toBe(false);
    expect(canShareCell("/assets/presets/table.glb", "/assets/presets/chest.glb")).toBe(false);
  });

  it("is false whenever either side is null/undefined (no candidate asset selected, or an empty cell)", () => {
    expect(canShareCell("/assets/presets/table.glb", null)).toBe(false);
    expect(canShareCell(null, "/assets/presets/glass.glb")).toBe(false);
    expect(canShareCell(undefined, undefined)).toBe(false);
  });
});

describe("surfaceStackLift / surfaceStackScale", () => {
  it("add/scale by 0/1 (no change) for no host — every object before this feature, and every non-stacked object", () => {
    expect(surfaceStackLift(undefined)).toBe(0);
    expect(surfaceStackLift(null)).toBe(0);
    expect(surfaceStackScale(undefined)).toBe(1);
    expect(surfaceStackScale(null)).toBe(1);
  });

  it("lifts and shrinks a prop genuinely sharing a cell with a host", () => {
    expect(surfaceStackLift("/assets/presets/table.glb")).toBe(SURFACE_LIFT_HEIGHT);
    expect(surfaceStackScale("/assets/presets/table.glb")).toBe(SURFACE_PROP_SCALE);
  });

  it("the lift is positive and the scale genuinely shrinks (not just a no-op or a growth)", () => {
    expect(SURFACE_LIFT_HEIGHT).toBeGreaterThan(0);
    expect(SURFACE_PROP_SCALE).toBeGreaterThan(0);
    expect(SURFACE_PROP_SCALE).toBeLessThan(1);
  });
});
