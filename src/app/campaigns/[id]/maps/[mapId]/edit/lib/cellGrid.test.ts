import { describe, expect, it } from "vitest";
import {
  applyTool,
  buildDenseCells,
  cellKey,
  DEFAULT_CELL,
  MAX_ELEVATION,
  overlayFromRows,
  parseCellKey,
  rowsForSave,
  type CellState,
} from "./cellGrid";

describe("applyTool", () => {
  it("raise increments elevation one step at a time", () => {
    const raised = applyTool(DEFAULT_CELL, "raise", "normal");
    expect(raised.elevation).toBe(1);
    expect(applyTool(raised, "raise", "normal").elevation).toBe(2);
  });

  it("raise clamps at MAX_ELEVATION and returns the same reference", () => {
    const atMax: CellState = { elevation: MAX_ELEVATION, terrain: "normal" };
    expect(applyTool(atMax, "raise", "normal")).toBe(atMax);
  });

  it("lower decrements and clamps at ground level", () => {
    const raised: CellState = { elevation: 2, terrain: "normal" };
    expect(applyTool(raised, "lower", "normal").elevation).toBe(1);
    expect(applyTool(DEFAULT_CELL, "lower", "normal")).toBe(DEFAULT_CELL);
  });

  it("terrain paints the brush value without touching elevation", () => {
    const raised: CellState = { elevation: 3, terrain: "normal" };
    const painted = applyTool(raised, "terrain", "difficult");
    expect(painted).toEqual({ elevation: 3, terrain: "difficult" });
  });

  it("terrain is a no-op (same reference) when the brush matches", () => {
    const difficult: CellState = { elevation: 0, terrain: "difficult" };
    expect(applyTool(difficult, "terrain", "difficult")).toBe(difficult);
  });
});

describe("sparse grid reconstruction", () => {
  it("overlays stored rows onto defaults for every other cell", () => {
    const overlay = overlayFromRows([
      { map_id: "m", x: 1, y: 2, elevation: 3, terrain_type: "difficult" },
    ]);
    const dense = buildDenseCells(3, 3, overlay);

    expect(dense).toHaveLength(9);
    expect(dense.find((cell) => cell.x === 1 && cell.y === 2)).toEqual({
      x: 1,
      y: 2,
      elevation: 3,
      terrain: "difficult",
    });
    for (const cell of dense) {
      if (cell.x === 1 && cell.y === 2) continue;
      expect(cell.elevation).toBe(0);
      expect(cell.terrain).toBe("normal");
    }
  });

  it("round-trips keys", () => {
    expect(parseCellKey(cellKey(7, 19))).toEqual({ x: 7, y: 19 });
  });
});

describe("rowsForSave", () => {
  it("emits one row per dirty cell, including cells edited back to default", () => {
    const overlay = new Map<string, CellState>([
      [cellKey(0, 0), { elevation: 2, terrain: "normal" }],
      [cellKey(4, 5), { elevation: 0, terrain: "difficult" }],
      [cellKey(9, 9), { elevation: 0, terrain: "normal" }],
    ]);
    const rows = rowsForSave("map-1", overlay, new Set([cellKey(0, 0), cellKey(4, 5), cellKey(9, 9)]));

    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual({ map_id: "map-1", x: 0, y: 0, elevation: 2, terrain_type: "normal" });
    expect(rows).toContainEqual({ map_id: "map-1", x: 4, y: 5, elevation: 0, terrain_type: "difficult" });
    expect(rows).toContainEqual({ map_id: "map-1", x: 9, y: 9, elevation: 0, terrain_type: "normal" });
  });

  it("ignores untouched overlay cells", () => {
    const overlay = new Map<string, CellState>([[cellKey(0, 0), { elevation: 5, terrain: "normal" }]]);
    expect(rowsForSave("map-1", overlay, new Set())).toEqual([]);
  });
});
