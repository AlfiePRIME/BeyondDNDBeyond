import { describe, expect, it } from "vitest";
import {
  applyTool,
  buildDenseCells,
  cellKey,
  DEFAULT_CELL,
  MAX_ELEVATION,
  MIN_PIT_ELEVATION_STEPS,
  overlayFromRows,
  parseCellKey,
  rowsForSave,
  type CellState,
} from "./cellGrid";

describe("applyTool", () => {
  it("raise increments elevation one step at a time", () => {
    const raised = applyTool(DEFAULT_CELL, "raise", "normal", "bright", "default");
    expect(raised.elevation).toBe(1);
    expect(applyTool(raised, "raise", "normal", "bright", "default").elevation).toBe(2);
  });

  it("raise clamps at MAX_ELEVATION and returns the same reference", () => {
    const atMax: CellState = {
      elevation: MAX_ELEVATION,
      terrain: "normal",
      light: "bright",
      ground: "default",
      waterFlow: null,
    };
    expect(applyTool(atMax, "raise", "normal", "bright", "default")).toBe(atMax);
  });

  it("lower decrements and clamps at ground level", () => {
    const raised: CellState = {
      elevation: 2,
      terrain: "normal",
      light: "bright",
      ground: "default",
      waterFlow: null,
    };
    expect(applyTool(raised, "lower", "normal", "bright", "default").elevation).toBe(1);
    expect(applyTool(DEFAULT_CELL, "lower", "normal", "bright", "default")).toBe(DEFAULT_CELL);
  });

  it("terrain paints the brush value without touching elevation, light, or ground", () => {
    const raised: CellState = {
      elevation: 3,
      terrain: "normal",
      light: "bright",
      ground: "grass",
      waterFlow: null,
    };
    const painted = applyTool(raised, "terrain", "difficult", "bright", "grass");
    expect(painted).toEqual({
      elevation: 3,
      terrain: "difficult",
      light: "bright",
      ground: "grass",
      waterFlow: null,
    });
  });

  it("terrain is a no-op (same reference) when the brush matches", () => {
    const difficult: CellState = {
      elevation: 0,
      terrain: "difficult",
      light: "bright",
      ground: "default",
      waterFlow: null,
    };
    expect(applyTool(difficult, "terrain", "difficult", "bright", "default")).toBe(difficult);
  });

  it("light paints the light brush without touching terrain, elevation, or ground", () => {
    const raised: CellState = {
      elevation: 3,
      terrain: "difficult",
      light: "bright",
      ground: "rock",
      waterFlow: null,
    };
    const painted = applyTool(raised, "light", "normal", "dark", "rock");
    expect(painted).toEqual({
      elevation: 3,
      terrain: "difficult",
      light: "dark",
      ground: "rock",
      waterFlow: null,
    });
  });

  it("light is a no-op (same reference) when the brush matches", () => {
    const dim: CellState = {
      elevation: 0,
      terrain: "normal",
      light: "dim",
      ground: "default",
      waterFlow: null,
    };
    expect(applyTool(dim, "light", "normal", "dim", "default")).toBe(dim);
  });

  // Ground (the post-roadmap ground-types addition) mirrors light exactly:
  // its own independent brush, touching nothing else on the cell — in
  // particular never terrain, the confirmed "painting forest doesn't force
  // difficult terrain" requirement.
  it("ground paints the ground brush without touching terrain, elevation, or light", () => {
    const raised: CellState = {
      elevation: 4,
      terrain: "difficult",
      light: "dim",
      ground: "default",
      waterFlow: null,
    };
    const painted = applyTool(raised, "ground", "normal", "dim", "forest");
    expect(painted).toEqual({
      elevation: 4,
      terrain: "difficult",
      light: "dim",
      ground: "forest",
      waterFlow: null,
    });
  });

  it("ground is a no-op (same reference) when the brush matches", () => {
    const grassy: CellState = {
      elevation: 0,
      terrain: "normal",
      light: "bright",
      ground: "grass",
      waterFlow: null,
    };
    expect(applyTool(grassy, "ground", "normal", "bright", "grass")).toBe(grassy);
  });

  it("painting terrain difficult never changes an already-painted ground type, and vice versa", () => {
    const forest: CellState = {
      elevation: 0,
      terrain: "normal",
      light: "bright",
      ground: "forest",
      waterFlow: null,
    };
    const stillForest = applyTool(forest, "terrain", "difficult", "bright", "forest");
    expect(stillForest.ground).toBe("forest");
    expect(stillForest.terrain).toBe("difficult");

    const difficult: CellState = {
      elevation: 0,
      terrain: "difficult",
      light: "bright",
      ground: "default",
      waterFlow: null,
    };
    const stillDifficult = applyTool(difficult, "ground", "normal", "bright", "grass");
    expect(stillDifficult.terrain).toBe("difficult");
    expect(stillDifficult.ground).toBe("grass");
  });

  // Water (the water-terrain addition): the one ground brush that carries a
  // second value (the flow direction) along with it in the same click —
  // the pit tool's own "one click authors two related fields" precedent,
  // reused for a purely cosmetic pair instead of a mechanical one.
  describe("water", () => {
    it("painting the water brush sets ground to water and stamps the given flow direction", () => {
      const painted = applyTool(DEFAULT_CELL, "ground", "normal", "bright", "water", "east");
      expect(painted).toEqual({
        elevation: 0,
        terrain: "normal",
        light: "bright",
        ground: "water",
        waterFlow: "east",
      });
    });

    it("defaults the flow direction to south when the caller omits the sixth argument", () => {
      const painted = applyTool(DEFAULT_CELL, "ground", "normal", "bright", "water");
      expect(painted.waterFlow).toBe("south");
    });

    it("re-painting an already-water cell with a DIFFERENT flow direction updates it (not a no-op)", () => {
      const water: CellState = {
        elevation: 0,
        terrain: "normal",
        light: "bright",
        ground: "water",
        waterFlow: "north",
      };
      const repainted = applyTool(water, "ground", "normal", "bright", "water", "west");
      expect(repainted).not.toBe(water);
      expect(repainted.waterFlow).toBe("west");
      expect(repainted.ground).toBe("water");
    });

    it("re-painting an already-water cell with the SAME flow direction is a no-op (same reference)", () => {
      const water: CellState = {
        elevation: 0,
        terrain: "normal",
        light: "bright",
        ground: "water",
        waterFlow: "north",
      };
      expect(applyTool(water, "ground", "normal", "bright", "water", "north")).toBe(water);
    });

    it("painting a DIFFERENT ground brush over a water cell clears its flow direction back to null", () => {
      const water: CellState = {
        elevation: 2,
        terrain: "difficult",
        light: "bright",
        ground: "water",
        waterFlow: "east",
      };
      const grassed = applyTool(water, "ground", "normal", "bright", "grass");
      expect(grassed).toEqual({
        elevation: 2,
        terrain: "difficult",
        light: "bright",
        ground: "grass",
        waterFlow: null,
      });
    });

    it("painting terrain (difficult) over a water cell never touches its ground or flow direction", () => {
      const water: CellState = {
        elevation: 0,
        terrain: "normal",
        light: "bright",
        ground: "water",
        waterFlow: "south",
      };
      const painted = applyTool(water, "terrain", "difficult", "bright", "water", "south");
      expect(painted.ground).toBe("water");
      expect(painted.waterFlow).toBe("south");
      expect(painted.terrain).toBe("difficult");
    });
  });

  // Pits and falling (docs/design/pits-and-falling.md §8): the "pit" tool
  // deepens AND marks the terrain in one click, permitted into negative
  // elevation down to MIN_PIT_ELEVATION_STEPS — separate from raise/lower's
  // untouched floor-at-0 clamp above.
  describe("pit", () => {
    it("marks the terrain pit and drops elevation by one step from a flat start", () => {
      const dug = applyTool(DEFAULT_CELL, "pit", "normal", "bright", "default");
      expect(dug).toEqual({
        elevation: -1,
        terrain: "pit",
        light: "bright",
        ground: "default",
        waterFlow: null,
      });
    });

    it("keeps decrementing (and re-marking pit) on repeated application", () => {
      let cell = DEFAULT_CELL;
      for (let i = 0; i < 3; i++) cell = applyTool(cell, "pit", "normal", "bright", "default");
      expect(cell).toEqual({
        elevation: -3,
        terrain: "pit",
        light: "bright",
        ground: "default",
        waterFlow: null,
      });
    });

    it("digs downward from a raised plateau too, unaffected by MAX_ELEVATION", () => {
      const plateau: CellState = {
        elevation: MAX_ELEVATION,
        terrain: "normal",
        light: "bright",
        ground: "default",
        waterFlow: null,
      };
      const dug = applyTool(plateau, "pit", "normal", "bright", "default");
      expect(dug).toEqual({
        elevation: MAX_ELEVATION - 1,
        terrain: "pit",
        light: "bright",
        ground: "default",
        waterFlow: null,
      });
    });

    it("floors at MIN_PIT_ELEVATION_STEPS and returns the same reference", () => {
      const atFloor: CellState = {
        elevation: MIN_PIT_ELEVATION_STEPS,
        terrain: "pit",
        light: "bright",
        ground: "default",
        waterFlow: null,
      };
      expect(applyTool(atFloor, "pit", "normal", "bright", "default")).toBe(atFloor);
    });

    it("the brush argument is ignored — pit is the sculpt tool's own concern, not the terrain brush's", () => {
      const dug = applyTool(DEFAULT_CELL, "pit", "difficult", "bright", "default");
      expect(dug.terrain).toBe("pit");
    });
  });

  // Un-pitting via the ordinary terrain brush resets elevation back to 0 —
  // otherwise a repainted cell would be stuck at a negative elevation with
  // a non-pit terrain, the exact "hole through the ground plane" state this
  // module's negative-elevation guard exists to prevent.
  describe("un-pitting through the terrain brush", () => {
    it("resets elevation to 0 when painting a negative-elevation pit to another terrain", () => {
      const pit: CellState = {
        elevation: -4,
        terrain: "pit",
        light: "bright",
        ground: "default",
        waterFlow: null,
      };
      expect(applyTool(pit, "terrain", "normal", "bright", "default")).toEqual({
        elevation: 0,
        terrain: "normal",
        light: "bright",
        ground: "default",
        waterFlow: null,
      });
    });

    it("leaves elevation untouched when repainting a pit to pit (still negative)", () => {
      const pit: CellState = {
        elevation: -4,
        terrain: "pit",
        light: "bright",
        ground: "default",
        waterFlow: null,
      };
      // Same terrain value is already a no-op per the existing guard above,
      // so exercise the reset guard's OWN terrain !== "pit" condition via a
      // brush that is technically "pit" again — nothing changes.
      expect(applyTool(pit, "terrain", "pit", "bright", "default")).toBe(pit);
    });

    it("does not disturb a non-negative pit's elevation when un-pitting", () => {
      const shallow: CellState = {
        elevation: 0,
        terrain: "pit",
        light: "bright",
        ground: "default",
        waterFlow: null,
      };
      expect(applyTool(shallow, "terrain", "difficult", "bright", "default")).toEqual({
        elevation: 0,
        terrain: "difficult",
        light: "bright",
        ground: "default",
        waterFlow: null,
      });
    });
  });
});

describe("sparse grid reconstruction", () => {
  it("overlays stored rows onto defaults for every other cell", () => {
    const overlay = overlayFromRows([
      {
        map_id: "m",
        x: 1,
        y: 2,
        elevation: 3,
        terrain_type: "difficult",
        light_level: "dim",
        ground_type: "rock",
        water_flow_direction: null,
      },
    ]);
    const dense = buildDenseCells(3, 3, overlay);

    expect(dense).toHaveLength(9);
    expect(dense.find((cell) => cell.x === 1 && cell.y === 2)).toEqual({
      x: 1,
      y: 2,
      elevation: 3,
      terrain: "difficult",
      ground: "rock",
    });
    for (const cell of dense) {
      if (cell.x === 1 && cell.y === 2) continue;
      expect(cell.elevation).toBe(0);
      expect(cell.terrain).toBe("normal");
      expect(cell.ground).toBeUndefined();
    }
  });

  it("carries light only when asked (the editor's authoring tint)", () => {
    const overlay = overlayFromRows([
      {
        map_id: "m",
        x: 0,
        y: 0,
        elevation: 0,
        terrain_type: "normal",
        light_level: "dark",
        ground_type: "default",
        water_flow_direction: null,
      },
    ]);

    // The game table's call shape: no light on any cell.
    for (const cell of buildDenseCells(2, 1, overlay)) expect(cell.light).toBeUndefined();

    // The editor's call shape: painted light comes through, defaults are bright.
    const withLight = buildDenseCells(2, 1, overlay, undefined, true);
    expect(withLight.find((cell) => cell.x === 0)?.light).toBe("dark");
    expect(withLight.find((cell) => cell.x === 1)?.light).toBe("bright");
  });

  // Ground type is real appearance on BOTH surfaces (unlike light, which is
  // an editor-only authoring tint) — it must come through unconditionally,
  // with no includeLight-style opt-in flag.
  it("carries ground type unconditionally — real appearance on every surface, not an authoring-only tint", () => {
    const overlay = overlayFromRows([
      {
        map_id: "m",
        x: 0,
        y: 0,
        elevation: 0,
        terrain_type: "normal",
        light_level: "bright",
        ground_type: "swamp",
        water_flow_direction: null,
      },
    ]);

    // The game table's call shape (includeLight omitted) still carries ground.
    const denseForTable = buildDenseCells(2, 1, overlay);
    expect(denseForTable.find((cell) => cell.x === 0)?.ground).toBe("swamp");
    // A plain, never-painted cell carries no ground field at all — the
    // exact object shape a pre-ground-types map always produced.
    expect(denseForTable.find((cell) => cell.x === 1)?.ground).toBeUndefined();

    // The editor's call shape carries it too, alongside light.
    const denseForEditor = buildDenseCells(2, 1, overlay, undefined, true);
    expect(denseForEditor.find((cell) => cell.x === 0)?.ground).toBe("swamp");
  });

  // Water flow direction (the water-terrain addition): carried unconditionally
  // like ground itself, but gated on BOTH ground === "water" AND a real
  // direction being set — neither alone is enough.
  it("carries water flow direction only when ground is water AND a direction is authored", () => {
    const overlay = overlayFromRows([
      {
        map_id: "m",
        x: 0,
        y: 0,
        elevation: 0,
        terrain_type: "normal",
        light_level: "bright",
        ground_type: "water",
        water_flow_direction: "east",
      },
      {
        map_id: "m",
        x: 1,
        y: 0,
        elevation: 0,
        terrain_type: "normal",
        light_level: "bright",
        ground_type: "water",
        water_flow_direction: null,
      },
    ]);
    const dense = buildDenseCells(2, 1, overlay);

    expect(dense.find((cell) => cell.x === 0)).toEqual({
      x: 0,
      y: 0,
      elevation: 0,
      terrain: "normal",
      ground: "water",
      waterFlowDirection: "east",
    });
    // Water with no authored direction carries a ground of "water" but no
    // waterFlowDirection key at all — a legitimate "water, no arrow drawn"
    // state, not an error.
    const noDirection = dense.find((cell) => cell.x === 1);
    expect(noDirection?.ground).toBe("water");
    expect(noDirection).not.toHaveProperty("waterFlowDirection");
  });

  it("round-trips keys", () => {
    expect(parseCellKey(cellKey(7, 19))).toEqual({ x: 7, y: 19 });
  });

  it("preview cells override the overlay and carry the preview flag", () => {
    const overlay = overlayFromRows([
      {
        map_id: "m",
        x: 0,
        y: 0,
        elevation: 5,
        terrain_type: "difficult",
        light_level: "bright",
        ground_type: "default",
        water_flow_direction: null,
      },
    ]);
    const preview = new Map<string, CellState>([
      [
        cellKey(0, 0),
        { elevation: 1, terrain: "normal", light: "bright", ground: "default", waterFlow: null },
      ],
      [
        cellKey(1, 0),
        { elevation: 2, terrain: "difficult", light: "bright", ground: "path", waterFlow: null },
      ],
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
      ground: "path",
      preview: true,
    });
    const untouched = dense.find((cell) => cell.x === 0 && cell.y === 1);
    expect(untouched).toEqual({ x: 0, y: 1, elevation: 0, terrain: "normal" });
  });
});

describe("rowsForSave", () => {
  it("emits one row per dirty cell, including cells edited back to default", () => {
    const overlay = new Map<string, CellState>([
      [
        cellKey(0, 0),
        { elevation: 2, terrain: "normal", light: "bright", ground: "grass", waterFlow: null },
      ],
      [
        cellKey(4, 5),
        { elevation: 0, terrain: "difficult", light: "dim", ground: "default", waterFlow: null },
      ],
      [
        cellKey(9, 9),
        { elevation: 0, terrain: "normal", light: "bright", ground: "default", waterFlow: null },
      ],
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
      ground_type: "grass",
      water_flow_direction: null,
    });
    expect(rows).toContainEqual({
      map_id: "map-1",
      x: 4,
      y: 5,
      elevation: 0,
      terrain_type: "difficult",
      light_level: "dim",
      ground_type: "default",
      water_flow_direction: null,
    });
    expect(rows).toContainEqual({
      map_id: "map-1",
      x: 9,
      y: 9,
      elevation: 0,
      terrain_type: "normal",
      light_level: "bright",
      ground_type: "default",
      water_flow_direction: null,
    });
  });

  it("emits a water cell's authored flow direction alongside its ground type", () => {
    const overlay = new Map<string, CellState>([
      [
        cellKey(2, 2),
        { elevation: 0, terrain: "difficult", light: "bright", ground: "water", waterFlow: "west" },
      ],
    ]);
    const rows = rowsForSave("map-1", overlay, new Set([cellKey(2, 2)]));

    expect(rows).toContainEqual({
      map_id: "map-1",
      x: 2,
      y: 2,
      elevation: 0,
      terrain_type: "difficult",
      light_level: "bright",
      ground_type: "water",
      water_flow_direction: "west",
    });
  });

  it("ignores untouched overlay cells", () => {
    const overlay = new Map<string, CellState>([
      [
        cellKey(0, 0),
        { elevation: 5, terrain: "normal", light: "bright", ground: "default", waterFlow: null },
      ],
    ]);
    expect(rowsForSave("map-1", overlay, new Set())).toEqual([]);
  });
});
