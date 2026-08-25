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
    const raised = applyTool(DEFAULT_CELL, "raise", "normal", "bright");
    expect(raised.elevation).toBe(1);
    expect(applyTool(raised, "raise", "normal", "bright").elevation).toBe(2);
  });

  it("raise clamps at MAX_ELEVATION and returns the same reference", () => {
    const atMax: CellState = { elevation: MAX_ELEVATION, terrain: "normal", light: "bright" };
    expect(applyTool(atMax, "raise", "normal", "bright")).toBe(atMax);
  });

  it("lower decrements and clamps at ground level", () => {
    const raised: CellState = { elevation: 2, terrain: "normal", light: "bright" };
    expect(applyTool(raised, "lower", "normal", "bright").elevation).toBe(1);
    expect(applyTool(DEFAULT_CELL, "lower", "normal", "bright")).toBe(DEFAULT_CELL);
  });

  it("terrain paints the brush value without touching elevation", () => {
    const raised: CellState = { elevation: 3, terrain: "normal", light: "bright" };
    const painted = applyTool(raised, "terrain", "difficult", "bright");
    expect(painted).toEqual({ elevation: 3, terrain: "difficult", light: "bright" });
  });

  it("terrain is a no-op (same reference) when the brush matches", () => {
    const difficult: CellState = { elevation: 0, terrain: "difficult", light: "bright" };
    expect(applyTool(difficult, "terrain", "difficult", "bright")).toBe(difficult);
  });

  it("light paints the light brush without touching terrain or elevation", () => {
    const raised: CellState = { elevation: 3, terrain: "difficult", light: "bright" };
    const painted = applyTool(raised, "light", "normal", "dark");
    expect(painted).toEqual({ elevation: 3, terrain: "difficult", light: "dark" });
  });

  it("light is a no-op (same reference) when the brush matches", () => {
    const dim: CellState = { elevation: 0, terrain: "normal", light: "dim" };
    expect(applyTool(dim, "light", "normal", "dim")).toBe(dim);
  });
});

describe("sparse grid reconstruction", () => {
  it("overlays stored rows onto defaults for every other cell", () => {
    const overlay = overlayFromRows([
      { map_id: "m", x: 1, y: 2, elevation: 3, terrain_type: "difficult", light_level: "dim" },
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

  it("carries light only when asked (the editor's authoring tint)", () => {
    const overlay = overlayFromRows([
      { map_id: "m", x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "dark" },
    ]);

    // The game table's call shape: no light on any cell.
    for (const cell of buildDenseCells(2, 1, overlay)) expect(cell.light).toBeUndefined();

    // The editor's call shape: painted light comes through, defaults are bright.
    const withLight = buildDenseCells(2, 1, overlay, undefined, true);
    expect(withLight.find((cell) => cell.x === 0)?.light).toBe("dark");
    expect(withLight.find((cell) => cell.x === 1)?.light).toBe("bright");
  });

  it("round-trips keys", () => {
    expect(parseCellKey(cellKey(7, 19))).toEqual({ x: 7, y: 19 });
  });

  it("preview cells override the overlay and carry the preview flag", () => {
    const overlay = overlayFromRows([
      { map_id: "m", x: 0, y: 0, elevation: 5, terrain_type: "difficult", light_level: "bright" },
    ]);
    const preview = new Map<string, CellState>([
      [cellKey(0, 0), { elevation: 1, terrain: "normal", light: "bright" }],
      [cellKey(1, 0), { elevation: 2, terrain: "difficult", light: "bright" }],
    ]);
    const dense = buildDenseCells(2, 2, overlay, preview);

    expect(dense.find((cell) => cell.x === 0 && cell.y === 0)).toEqual({
      x: 0,
      y: 0,
      elevation: 1,
      terrain: "normal",
      preview: true,
    });
    expect(dense.find((cell) => cell.x === 1 && cell.y === 0)).toEqual({
      x: 1,
      y: 0,
      elevation: 2,
      terrain: "difficult",
      preview: true,
    });
    const untouched = dense.find((cell) => cell.x === 0 && cell.y === 1);
    expect(untouched).toEqual({ x: 0, y: 1, elevation: 0, terrain: "normal" });
  });
});

describe("rowsForSave", () => {
  it("emits one row per dirty cell, including cells edited back to default", () => {
    const overlay = new Map<string, CellState>([
      [cellKey(0, 0), { elevation: 2, terrain: "normal", light: "bright" }],
      [cellKey(4, 5), { elevation: 0, terrain: "difficult", light: "dim" }],
      [cellKey(9, 9), { elevation: 0, terrain: "normal", light: "bright" }],
    ]);
    const rows = rowsForSave("map-1", overlay, new Set([cellKey(0, 0), cellKey(4, 5), cellKey(9, 9)]));

    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual({
      map_id: "map-1",
      x: 0,
      y: 0,
      elevation: 2,
      terrain_type: "normal",
      light_level: "bright",
    });
    expect(rows).toContainEqual({
      map_id: "map-1",
      x: 4,
      y: 5,
      elevation: 0,
      terrain_type: "difficult",
      light_level: "dim",
    });
    expect(rows).toContainEqual({
      map_id: "map-1",
      x: 9,
      y: 9,
      elevation: 0,
      terrain_type: "normal",
      light_level: "bright",
    });
  });

  it("ignores untouched overlay cells", () => {
    const overlay = new Map<string, CellState>([
      [cellKey(0, 0), { elevation: 5, terrain: "normal", light: "bright" }],
    ]);
    expect(rowsForSave("map-1", overlay, new Set())).toEqual([]);
  });
});
