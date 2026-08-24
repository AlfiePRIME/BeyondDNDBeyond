import { describe, expect, it } from "vitest";
import { cellMovementCost, gridDistanceFeet } from "./movement";

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
});

describe("gridDistanceFeet", () => {
  it("treats diagonal movement as a flat 5 ft per cell, same as orthogonal", () => {
    const orthogonal = gridDistanceFeet({ x: 0, y: 0 }, { x: 3, y: 0 });
    const diagonal = gridDistanceFeet({ x: 0, y: 0 }, { x: 3, y: 3 });
    expect(orthogonal).toBe(15);
    expect(diagonal).toBe(15);
  });
});
