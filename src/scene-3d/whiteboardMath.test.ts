import { describe, expect, it } from "vitest";
import {
  cellKey,
  gridPointToPixel,
  pixelToCell,
  pixelToGridPoint,
  planeSizeWorldUnits,
  sampleSegmentCells,
  TILE_PX,
  worldToPixel,
} from "./whiteboardMath";
import { mapCellOffsets } from "./MapSurface";

describe("cellKey", () => {
  it("formats a stable, distinct key per coordinate", () => {
    expect(cellKey(0, 0)).toBe("0,0");
    expect(cellKey(3, 5)).toBe("3,5");
    expect(cellKey(3, 5)).not.toBe(cellKey(5, 3));
  });
});

describe("worldToPixel / pixelToCell round trip", () => {
  const cellSize = 1;
  const gridWidth = 5;
  const gridHeight = 4;

  it("maps a cell's own world center to the middle of its pixel tile", () => {
    for (let x = 0; x < gridWidth; x++) {
      for (let y = 0; y < gridHeight; y++) {
        const { offsetX, offsetZ } = mapCellOffsets(gridWidth, gridHeight, cellSize);
        const worldX = x * cellSize - offsetX;
        const worldZ = y * cellSize - offsetZ;
        const { pixelX, pixelY } = worldToPixel(worldX, worldZ, gridWidth, gridHeight, cellSize);
        expect(pixelX).toBeCloseTo(x * TILE_PX + TILE_PX / 2);
        expect(pixelY).toBeCloseTo(y * TILE_PX + TILE_PX / 2);
        expect(pixelToCell(pixelX, pixelY)).toEqual({ x, y });
      }
    }
  });

  it("covers the grid's own full world footprint exactly, edge to edge", () => {
    const { width, height } = planeSizeWorldUnits(gridWidth, gridHeight, cellSize);
    const leftEdgeWorldX = -width / 2;
    const rightEdgeWorldX = width / 2;
    const topEdgeWorldZ = -height / 2;
    const bottomEdgeWorldZ = height / 2;
    expect(worldToPixel(leftEdgeWorldX, topEdgeWorldZ, gridWidth, gridHeight, cellSize)).toEqual({
      pixelX: 0,
      pixelY: 0,
    });
    const bottomRight = worldToPixel(rightEdgeWorldX, bottomEdgeWorldZ, gridWidth, gridHeight, cellSize);
    expect(bottomRight.pixelX).toBeCloseTo(gridWidth * TILE_PX);
    expect(bottomRight.pixelY).toBeCloseTo(gridHeight * TILE_PX);
  });

  it("scales with cellSize the same way MapSurface's own cell rendering does", () => {
    const cellSizeA = 1;
    const cellSizeB = 2.5;
    const { offsetX: offsetXA } = mapCellOffsets(gridWidth, gridHeight, cellSizeA);
    const { offsetX: offsetXB } = mapCellOffsets(gridWidth, gridHeight, cellSizeB);
    // Cell 2's own center, at each scale — both should land on the exact
    // same pixel (pixel space is cellSize-independent by construction).
    const worldXA = 2 * cellSizeA - offsetXA;
    const worldXB = 2 * cellSizeB - offsetXB;
    const a = worldToPixel(worldXA, 0, gridWidth, gridHeight, cellSizeA);
    const b = worldToPixel(worldXB, 0, gridWidth, gridHeight, cellSizeB);
    expect(a.pixelX).toBeCloseTo(b.pixelX);
  });
});

describe("sampleSegmentCells", () => {
  it("returns just the one cell for a stroke's very first point (no prior segment), at zero width", () => {
    const cells = sampleSegmentCells(null, { x: 150, y: 150 }, 0);
    expect(cells).toEqual([pixelToCell(150, 150)]);
  });

  it("includes every distinct cell a fast long segment crosses, not just its endpoints", () => {
    // A segment spanning 5 tiles' worth of pixels in a single tick (a fast
    // drag) — every intermediate cell along the way must appear, since this
    // is what stroke-end crops into per-cell tiles.
    const from = { x: 0, y: TILE_PX / 2 };
    const to = { x: TILE_PX * 5, y: TILE_PX / 2 };
    const cells = sampleSegmentCells(from, to, 4);
    const xs = new Set(cells.map((cell) => cell.x));
    for (let x = 0; x <= 5; x++) expect(xs.has(x)).toBe(true);
  });

  it("de-duplicates — a short segment inside one cell reports that cell once, at zero width", () => {
    const cells = sampleSegmentCells({ x: 10, y: 10 }, { x: 15, y: 12 }, 0);
    expect(cells).toEqual([{ x: 0, y: 0 }]);
  });

  it("includes a neighboring cell the stroke's own WIDTH bleeds into, even though the centerline never enters it", () => {
    // A point sitting just 5px from the x=TILE_PX boundary, with a stroke
    // half-width of 10px — real drawn ink extends 10px either side of this
    // point, crossing into cell x=1 even though the sampled centerline point
    // itself is still in cell x=0. This is the exact real bug a naive
    // single-point-per-sample implementation misses (confirmed against a
    // real Playwright run of the eraser leaving a stray tile behind).
    const point = { x: TILE_PX - 5, y: TILE_PX / 2 };
    const cells = sampleSegmentCells(null, point, 10);
    expect(cells).toContainEqual({ x: 0, y: 0 });
    expect(cells).toContainEqual({ x: 1, y: 0 });
  });

  it("a zero-width sample right at that same boundary point stays in the one cell", () => {
    const point = { x: TILE_PX - 5, y: TILE_PX / 2 };
    const cells = sampleSegmentCells(null, point, 0);
    expect(cells).toEqual([{ x: 0, y: 0 }]);
  });
});

describe("pixelToGridPoint / gridPointToPixel round trip", () => {
  it("is the exact inverse of each other for an arbitrary pixel coordinate", () => {
    const cases = [
      { pixelX: 0, pixelY: 0 },
      { pixelX: TILE_PX, pixelY: TILE_PX * 2 },
      { pixelX: 37.5, pixelY: 210.25 },
    ];
    for (const { pixelX, pixelY } of cases) {
      const { u, v } = pixelToGridPoint(pixelX, pixelY);
      const backToPixel = gridPointToPixel(u, v);
      expect(backToPixel.pixelX).toBeCloseTo(pixelX);
      expect(backToPixel.pixelY).toBeCloseTo(pixelY);
    }
  });

  it("is resolution-independent — a fixed cell-relative fraction stays the same regardless of TILE_PX", () => {
    // Cell 2's own center, expressed in grid-space units, is exactly 2.5 —
    // independent of whatever TILE_PX happens to be, which is the whole
    // point of transmitting live-tier points in this unit rather than raw
    // pixels (docs/design/whiteboard-drawing-layer.md §5.2).
    const point = pixelToGridPoint(2 * TILE_PX + TILE_PX / 2, 0);
    expect(point.u).toBeCloseTo(2.5);
  });
});

describe("planeSizeWorldUnits", () => {
  it("is exactly gridWidth/gridHeight cells at cellSize, matching MapSurface's own footprint", () => {
    expect(planeSizeWorldUnits(6, 4, 1.5)).toEqual({ width: 9, height: 6 });
  });
});
