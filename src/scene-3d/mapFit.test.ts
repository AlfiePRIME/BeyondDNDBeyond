import { describe, expect, it } from "vitest";
import { computeTableFootprint, computeTableMapMetrics } from "./mapFit";
import { seatEllipseSemiAxes } from "./seating";
import { COMBINED_TABLE_TOP, COMBINED_TABLE_VISIBLE_TOP, TABLE_TOP } from "./table";

/**
 * computeTableFootprint deliberately does NOT scale the seated camera along
 * with the table (see mapFit.ts's own doc comment on computeTableFootprint
 * for the full reasoning) — a real, checkable numeric argument, not just an
 * assertion: the seated camera's radial distance from center is a pure
 * function of PARTY SEATING (seating.ts's seatAtAngle, driven only by
 * COMBINED_TABLE_TOP — the party's own table — never by a live map's grid
 * size). If this function instead grew that SAME COMBINED_TABLE_TOP object
 * (and therefore the camera radius derived from it) by some factor k to fit
 * a bigger grid, cellSize would grow by k and the camera distance would grow
 * by (very nearly) k too — leaving a cell's on-screen angular size, and
 * therefore how "big" the map actually reads to a seated player, completely
 * UNCHANGED. Growing a SEPARATE, camera-independent footprint (this
 * function's own return value, fed only into mapFit's cellSize/table-slab
 * geometry) instead means cellSize grows while the camera never moves — a
 * real, verifiable improvement in on-screen size instead of a no-op zoom.
 *
 * These tests assert against COMBINED_TABLE_VISIBLE_TOP, NOT
 * COMBINED_TABLE_TOP — a real regression (2026-08-30) shipped from
 * computeTableFootprint being fit against the latter (the wider, leg-
 * clearance footprint) instead: the grid rendered ~6% past the table's real
 * visible edge on any map that filled most of the footprint. Only the
 * seat-clearance CAP (the "never grows past where a chair could be" test
 * below) still legitimately uses the wider COMBINED_TABLE_TOP, matching
 * mapFit.ts's own real seatEllipseSemiAxes(COMBINED_TABLE_TOP) call — a
 * chair's own clearance really is a leg-stance question, not a visible-top
 * one.
 */
describe("computeTableFootprint", () => {
  it("never shrinks below COMBINED_TABLE_VISIBLE_TOP, for any grid size", () => {
    for (const [w, h] of [
      [1, 1],
      [5, 5],
      [20, 20],
      [40, 10],
      [10, 40],
      [15, 30],
      [100, 100],
    ] as const) {
      const footprint = computeTableFootprint(w, h);
      expect(footprint.width).toBeGreaterThanOrEqual(COMBINED_TABLE_VISIBLE_TOP.width - 1e-9);
      expect(footprint.depth).toBeGreaterThanOrEqual(COMBINED_TABLE_VISIBLE_TOP.depth - 1e-9);
    }
  });

  it("leaves an already-comfortable grid at exactly COMBINED_TABLE_VISIBLE_TOP (no regression for typical maps)", () => {
    // A small map was already comfortably width-bound under the OLD
    // single-table fit (TABLE_TOP), so growing the depth axis to
    // COMBINED_TABLE_VISIBLE_TOP's own combined depth changes nothing about
    // which axis binds or what cellSize comes out — this grid's own natural
    // fit against COMBINED_TABLE_VISIBLE_TOP already clears
    // MIN_LEGIBLE_CELL_SIZE.
    const footprint = computeTableFootprint(5, 5);
    expect(footprint).toEqual({ width: COMBINED_TABLE_VISIBLE_TOP.width, depth: COMBINED_TABLE_VISIBLE_TOP.depth });
  });

  it("grows past COMBINED_TABLE_VISIBLE_TOP for a large/lopsided grid", () => {
    const small = computeTableFootprint(5, 5);
    const large = computeTableFootprint(20, 40);
    expect(large.width).toBeGreaterThanOrEqual(small.width);
    expect(large.depth).toBeGreaterThan(small.depth);
  });

  it("never grows past where a seated chair could actually be", () => {
    const { semiX, semiZ } = seatEllipseSemiAxes(COMBINED_TABLE_TOP);
    for (const [w, h] of [
      [40, 40],
      [20, 40],
      [40, 20],
      [200, 200],
    ] as const) {
      const footprint = computeTableFootprint(w, h);
      expect(footprint.width / 2).toBeLessThan(semiX);
      expect(footprint.depth / 2).toBeLessThan(semiZ);
    }
  });
});

describe("computeTableMapMetrics", () => {
  it("fits any grid inside its own computed table footprint", () => {
    for (const [w, h] of [
      [5, 5],
      [20, 20],
      [40, 10],
      [10, 40],
      [15, 30],
    ] as const) {
      const { cellSize } = computeTableMapMetrics(w, h);
      const footprint = computeTableFootprint(w, h);
      expect(cellSize * w).toBeLessThan(footprint.width);
      expect(cellSize * h).toBeLessThan(footprint.depth);
    }
  });

  it("uses a uniform cell size set by the tighter axis", () => {
    const wide = computeTableMapMetrics(40, 5);
    const tall = computeTableMapMetrics(5, 40);
    expect(wide.cellSize * 40).toBeLessThan(computeTableFootprint(40, 5).width);
    expect(tall.cellSize * 40).toBeLessThan(computeTableFootprint(5, 40).depth);
    // The depth axis is the tighter one for a square footprint request, at
    // exactly COMBINED_TABLE_VISIBLE_TOP (this grid is already comfortable
    // there, so the footprint doesn't grow any further).
    const square = computeTableMapMetrics(10, 10);
    expect(square.cellSize * 10).toBeCloseTo(COMBINED_TABLE_VISIBLE_TOP.depth - 0.6, 5);
  });

  it("a large map gets a meaningfully bigger cellSize than the old single-table fit ever could", () => {
    // The exact formula computeTableMapMetrics used before this bug fix —
    // fit directly against the single (un-doubled) TABLE_TOP, with no
    // footprint growth at all. Recomputed here (not imported — it no longer
    // exists) purely as the "before" baseline for this regression check.
    const oldCellSize = (gridWidth: number, gridHeight: number) =>
      Math.min((TABLE_TOP.width - 0.6) / gridWidth, (TABLE_TOP.depth - 0.6) / gridHeight);

    for (const [w, h] of [
      [20, 40],
      [40, 20],
      [40, 40],
    ] as const) {
      const before = oldCellSize(w, h);
      const { cellSize: after } = computeTableMapMetrics(w, h);
      // At least 1.5x — the real improvement varies by orientation (a
      // 40-wide/20-deep grid was already less catastrophic under the old
      // fit than a 20-wide/40-deep one, and TABLE_GROWTH_SEAT_CLEARANCE caps
      // every orientation's growth at the same real ellipse, not a uniform
      // multiple), but every one of these cases is a real, substantial win,
      // not a rounding-error-sized one.
      expect(after).toBeGreaterThan(before * 1.5);
    }
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
