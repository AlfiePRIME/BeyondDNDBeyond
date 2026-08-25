import { describe, expect, it } from "vitest";
import { buildGridOverlayPositions } from "./gridOverlay";
import { EDITOR_MAP_METRICS, type MapSurfaceCell } from "./MapSurface";

const cells: MapSurfaceCell[] = [
  { x: 0, y: 0, elevation: 0, terrain: "normal" },
  { x: 1, y: 0, elevation: 3, terrain: "difficult" },
];

describe("buildGridOverlayPositions", () => {
  it("emits 4 edges (8 points) per cell", () => {
    const positions = buildGridOverlayPositions(cells, EDITOR_MAP_METRICS, 2, 1);
    expect(positions.length).toBe(cells.length * 8 * 3);
  });

  it("rides each cell's own elevation", () => {
    const positions = buildGridOverlayPositions(cells, EDITOR_MAP_METRICS, 2, 1);
    const yOfCell = (index: number) => positions[index * 24 + 1];
    const flatY = yOfCell(0);
    const raisedY = yOfCell(1);
    expect(raisedY - flatY).toBeCloseTo(3 * EDITOR_MAP_METRICS.elevationStepHeight);
    expect(flatY).toBeGreaterThan(EDITOR_MAP_METRICS.baseHeight);
  });

  it("centers the outline lattice on the grid like the cell blocks", () => {
    const positions = buildGridOverlayPositions(cells, EDITOR_MAP_METRICS, 2, 1);
    const xs = [...positions].filter((_, index) => index % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(-Math.max(...xs));
  });

  it("emits no outline for a void cell — the overlay follows the floor exactly", () => {
    const withVoid: MapSurfaceCell[] = [...cells, { x: 2, y: 0, elevation: 0, terrain: "void" }];
    const positions = buildGridOverlayPositions(withVoid, EDITOR_MAP_METRICS, 3, 1);
    // Same buffer as the two floored cells alone: the void cell contributes
    // zero edges rather than an outline over nothing.
    expect(positions.length).toBe(cells.length * 8 * 3);
    // And no vertex lands in the void cell's x range (its center sits at
    // +1 cell from the grid middle; the floored cells' outlines end before it).
    const xs = [...positions].filter((_, index) => index % 3 === 0);
    const voidCenterX = 2 * EDITOR_MAP_METRICS.cellSize - ((3 - 1) / 2) * EDITOR_MAP_METRICS.cellSize;
    const half = (EDITOR_MAP_METRICS.cellSize * (1 - 0.08)) / 2;
    expect(Math.max(...xs)).toBeLessThan(voidCenterX - half + 0.001);
  });
});
