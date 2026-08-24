import { describe, expect, it } from "vitest";
import { computeTableMapMetrics } from "./mapFit";
import { TABLE_TOP } from "./table";

describe("computeTableMapMetrics", () => {
  it("fits any grid inside the tabletop footprint", () => {
    for (const [w, h] of [
      [5, 5],
      [20, 20],
      [40, 10],
      [10, 40],
      [15, 30],
    ] as const) {
      const { cellSize } = computeTableMapMetrics(w, h);
      expect(cellSize * w).toBeLessThan(TABLE_TOP.width);
      expect(cellSize * h).toBeLessThan(TABLE_TOP.depth);
    }
  });

  it("uses a uniform cell size set by the tighter axis", () => {
    const wide = computeTableMapMetrics(40, 5);
    const tall = computeTableMapMetrics(5, 40);
    expect(wide.cellSize * 40).toBeLessThan(TABLE_TOP.width);
    expect(tall.cellSize * 40).toBeLessThan(TABLE_TOP.depth);
    // The depth axis is the tighter one for a square footprint request.
    const square = computeTableMapMetrics(10, 10);
    expect(square.cellSize * 10).toBeCloseTo(TABLE_TOP.depth - 0.6, 5);
  });

  it("clamps the elevation step so dense grids keep legible terracing", () => {
    const dense = computeTableMapMetrics(30, 30);
    expect(dense.elevationStepHeight).toBeGreaterThanOrEqual(0.09);
    expect(dense.elevationStepHeight).toBeGreaterThan(dense.cellSize * 0.35 - 1e-9);
  });

  it("keeps editor-proportional step height when the map is small enough", () => {
    const sparse = computeTableMapMetrics(5, 5);
    expect(sparse.elevationStepHeight).toBeCloseTo(sparse.cellSize * 0.35, 5);
  });
});
