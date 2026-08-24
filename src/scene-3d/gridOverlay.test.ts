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
});
