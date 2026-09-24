import { describe, expect, it } from "vitest";
import { cellsOnLine } from "./gridLine";

describe("cellsOnLine", () => {
  it("returns just the cell for a zero-length line", () => {
    expect(cellsOnLine({ x: 2, y: 3 }, { x: 2, y: 3 })).toEqual([{ x: 2, y: 3 }]);
  });

  it("walks a horizontal line in either direction", () => {
    expect(cellsOnLine({ x: 0, y: 1 }, { x: 3, y: 1 })).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ]);
    expect(cellsOnLine({ x: 3, y: 1 }, { x: 1, y: 1 })).toEqual([
      { x: 3, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it("walks a diagonal one cell per step", () => {
    expect(cellsOnLine({ x: 0, y: 0 }, { x: 2, y: -2 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: -1 },
      { x: 2, y: -2 },
    ]);
  });

  it("covers a shallow line with no gaps and ends exactly on the target", () => {
    const cells = cellsOnLine({ x: 0, y: 0 }, { x: 5, y: 2 });
    expect(cells[0]).toEqual({ x: 0, y: 0 });
    expect(cells[cells.length - 1]).toEqual({ x: 5, y: 2 });
    expect(cells).toHaveLength(6);
    for (let i = 1; i < cells.length; i++) {
      expect(Math.abs(cells[i].x - cells[i - 1].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(cells[i].y - cells[i - 1].y)).toBeLessThanOrEqual(1);
    }
  });
});
