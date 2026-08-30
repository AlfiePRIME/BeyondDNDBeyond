import { describe, expect, it } from "vitest";
import { computeTableMapMetrics } from "./mapFit";
import { COMBINED_TABLE_VISIBLE_TOP } from "./table";

/**
 * THIRD investigation of this exact area (2026-08-30) — see mapFit.ts's own
 * doc comment on computeTableMapMetrics for the full history. The prior two
 * attempts both grew the table's own footprint past COMBINED_TABLE_VISIBLE_TOP
 * on large/lopsided grids (computeTableFootprint, paired with
 * GameTableScene's synthetic TableExtension slab) — both removed per the
 * project owner's explicit call ("remove the brown box it places, and make
 * the 3d map fit to the 3d table models that are there"). These tests assert
 * the map NEVER exceeds the table's real, fixed, already-rendered surface —
 * no exceptions for large grids; a smaller cellSize on an extreme grid is the
 * accepted tradeoff now, not a case to special-case around.
 */
describe("computeTableMapMetrics", () => {
  it("fits any grid inside the table's real, fixed visible surface — even large/lopsided ones", () => {
    for (const [w, h] of [
      [5, 5],
      [20, 20],
      [40, 10],
      [10, 40],
      [15, 30],
      [20, 40],
      [24, 11],
      [40, 40],
      [100, 100],
    ] as const) {
      const { cellSize } = computeTableMapMetrics(w, h);
      expect(cellSize * w).toBeLessThan(COMBINED_TABLE_VISIBLE_TOP.width);
      expect(cellSize * h).toBeLessThan(COMBINED_TABLE_VISIBLE_TOP.depth);
      // Never negative/zero — even an extreme grid still gets SOME real,
      // positive cellSize (just a small one), never clamped to nothing.
      expect(cellSize).toBeGreaterThan(0);
    }
  });

  it("uses a uniform cell size set by the tighter axis", () => {
    const wide = computeTableMapMetrics(40, 5);
    const tall = computeTableMapMetrics(5, 40);
    expect(wide.cellSize * 40).toBeLessThan(COMBINED_TABLE_VISIBLE_TOP.width);
    expect(tall.cellSize * 40).toBeLessThan(COMBINED_TABLE_VISIBLE_TOP.depth);
    // A 10x10 square grid binds on the depth axis — COMBINED_TABLE_VISIBLE_TOP
    // is wider than it is deep, so depth is the tighter constraint.
    const square = computeTableMapMetrics(10, 10);
    expect(square.cellSize * 10).toBeCloseTo(COMBINED_TABLE_VISIBLE_TOP.depth - 0.6, 5);
  });

  it("a large/lopsided grid gets a smaller cellSize than a small one — an honest tradeoff, not a bug, now that the table itself never grows to compensate", () => {
    const small = computeTableMapMetrics(5, 5);
    const large = computeTableMapMetrics(20, 40);
    expect(large.cellSize).toBeLessThan(small.cellSize);
    // Still strictly positive and still fits — see the "fits any grid" test
    // above for the actual overflow guarantee.
    expect(large.cellSize).toBeGreaterThan(0);
  });

  it("keeps editor-proportional step height even on dense grids (no minimum floor)", () => {
    const dense = computeTableMapMetrics(30, 30);
    expect(dense.elevationStepHeight).toBeCloseTo(dense.cellSize * 0.35, 5);
  });

  it("keeps editor-proportional step height when the map is small enough", () => {
    const sparse = computeTableMapMetrics(5, 5);
    expect(sparse.elevationStepHeight).toBeCloseTo(sparse.cellSize * 0.35, 5);
  });
});
