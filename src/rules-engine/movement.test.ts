import { describe, expect, it } from "vitest";
import {
  cellMovementCost,
  gridCellDistance,
  gridDistanceFeet,
  pathMovementCost,
  straightCellPath,
} from "./movement";

describe("cellMovementCost", () => {
  it("costs a flat 5 ft to enter a normal, level cell", () => {
    expect(cellMovementCost({ terrain: "normal", elevationDeltaFeet: 0 })).toBe(5);
  });

  it("costs extra for an elevation change alone", () => {
    const normalCost = cellMovementCost({ terrain: "normal", elevationDeltaFeet: 0 });
    const climbCost = cellMovementCost({ terrain: "normal", elevationDeltaFeet: 5 });
    expect(climbCost).toBeGreaterThan(normalCost);
    expect(climbCost).toBe(15); // 5 ft base + (5 ft climbed x2)
  });

  it("costs double for difficult terrain alone", () => {
    expect(cellMovementCost({ terrain: "difficult", elevationDeltaFeet: 0 })).toBe(10);
  });

  it("stacks difficult terrain and an elevation change in the same move", () => {
    const stacked = cellMovementCost({ terrain: "difficult", elevationDeltaFeet: 5 });
    const terrainOnly = cellMovementCost({ terrain: "difficult", elevationDeltaFeet: 0 });
    const climbOnly = cellMovementCost({ terrain: "normal", elevationDeltaFeet: 5 });
    expect(stacked).toBe(20); // 10 ft (difficult) + 10 ft (climb 5 ft x2)
    expect(stacked).toBeGreaterThan(terrainOnly);
    expect(stacked).toBeGreaterThan(climbOnly);
  });

  it("does not add climb cost when descending or staying level", () => {
    expect(cellMovementCost({ terrain: "normal", elevationDeltaFeet: -5 })).toBe(5);
  });

  it("costs Infinity to enter a void cell — impassable, not merely expensive", () => {
    expect(cellMovementCost({ terrain: "void", elevationDeltaFeet: 0 })).toBe(Infinity);
  });

  it("costs Infinity for a void cell regardless of the elevation delta", () => {
    expect(cellMovementCost({ terrain: "void", elevationDeltaFeet: 25 })).toBe(Infinity);
    expect(cellMovementCost({ terrain: "void", elevationDeltaFeet: -25 })).toBe(Infinity);
  });
});

describe("gridDistanceFeet", () => {
  it("treats diagonal movement as a flat 5 ft per cell, same as orthogonal", () => {
    const orthogonal = gridDistanceFeet({ x: 0, y: 0 }, { x: 3, y: 0 });
    const diagonal = gridDistanceFeet({ x: 0, y: 0 }, { x: 3, y: 3 });
    expect(orthogonal).toBe(15);
    expect(diagonal).toBe(15);
  });
});

describe("straightCellPath", () => {
  it("returns an empty path when origin and target are the same cell", () => {
    expect(straightCellPath({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([]);
  });

  it("walks straight lines and excludes the origin", () => {
    expect(straightCellPath({ x: 1, y: 1 }, { x: 4, y: 1 })).toEqual([
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
    ]);
  });

  it("steps diagonally first, matching gridCellDistance in length", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 4, y: 2 };
    const path = straightCellPath(from, to);
    expect(path).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
    ]);
    expect(path).toHaveLength(gridCellDistance(from, to));
  });

  it("handles negative directions", () => {
    expect(straightCellPath({ x: 3, y: 3 }, { x: 1, y: 2 })).toEqual([
      { x: 2, y: 2 },
      { x: 1, y: 2 },
    ]);
  });
});

describe("pathMovementCost", () => {
  const normal = (elevationSteps: number) => ({ terrain: "normal" as const, elevationSteps });
  const difficult = (elevationSteps: number) => ({ terrain: "difficult" as const, elevationSteps });
  const voidCell = (elevationSteps: number) => ({ terrain: "void" as const, elevationSteps });

  it("costs 5 ft per cell over normal level ground", () => {
    expect(pathMovementCost(0, [normal(0), normal(0), normal(0)])).toBe(15);
  });

  it("charges a climb on the cell-to-cell delta, once per ascent", () => {
    // Up one 5 ft step (5 + 10), then along the plateau (5), then down (5).
    expect(pathMovementCost(0, [normal(1), normal(1), normal(0)])).toBe(25);
  });

  it("stacks difficult terrain with a climb in the same entered cell", () => {
    // 10 ft difficult + 10 ft for the 5 ft climb.
    expect(pathMovementCost(0, [difficult(1)])).toBe(20);
  });

  it("sums mixed terrain, climbs, and descents across a path", () => {
    // normal level (5) + difficult climb (10 + 10) + normal descent (5).
    expect(pathMovementCost(0, [normal(0), difficult(1), normal(0)])).toBe(30);
  });

  it("charges nothing for an empty path", () => {
    expect(pathMovementCost(3, [])).toBe(0);
  });

  it("sums to Infinity when any entered cell is void, wherever it falls in the path", () => {
    expect(pathMovementCost(0, [voidCell(0)])).toBe(Infinity);
    expect(pathMovementCost(0, [normal(0), voidCell(0), normal(0)])).toBe(Infinity);
    expect(pathMovementCost(0, [normal(0), difficult(1), voidCell(2)])).toBe(Infinity);
  });

  it("stays Infinity even when the path descends after the void cell", () => {
    // Descending past a void cell can never 'refund' the impassable cost.
    expect(pathMovementCost(5, [voidCell(5), normal(0)])).toBe(Infinity);
  });
});
