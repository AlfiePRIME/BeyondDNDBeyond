import { describe, expect, it } from "vitest";
import type { GroundType } from "@/data-access";
import type { MapTemplate } from "./templates";
import {
  classifyWallCell,
  MAP_TEMPLATES,
  PRESET_DOOR,
  PRESET_ROCK,
  PRESET_TABLE,
  PRESET_TORCH,
  PRESET_TREE,
  PRESET_WALL,
  PRESET_WALL_CORNER,
  PRESET_WALL_DOOR,
} from "./templates";

// The exact ids seeded by 0016_asset_library_presets.sql, plus the wall-
// variant presets seeded by their own later migrations (see
// scripts/assets/generate-wall-variants-presets.mjs) — templates may only
// reference these, since they're the assets guaranteed to exist in every
// campaign. PRESET_DOOR (a55e7003) stays seeded/importable (a free-standing
// door remains a legitimate, if no longer template-placed, asset — see
// PRESET_WALL_DOOR's own doc comment in templates.ts) even though no
// template below places it anymore.
const SEEDED_PRESET_IDS = new Set([
  "a55e7001-0000-4000-8000-000000000001",
  "a55e7002-0000-4000-8000-000000000002",
  "a55e7003-0000-4000-8000-000000000003",
  "a55e7004-0000-4000-8000-000000000004",
  "a55e7005-0000-4000-8000-000000000005",
  "a55e7006-0000-4000-8000-000000000006",
  "a55e7007-0000-4000-8000-000000000007",
  "a55e7008-0000-4000-8000-000000000008",
  "a55e7009-0000-4000-8000-000000000009",
  "a55e7010-0000-4000-8000-000000000010",
  "a55e7011-0000-4000-8000-000000000011",
  "a55e7012-0000-4000-8000-000000000012",
]);

function findTemplate(id: string): MapTemplate {
  const template = MAP_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`no template with id ${id}`);
  return template;
}

/** Every cell's ground_type is one of `allowed` (defaulting 'default' in,
 * since an unpainted cell is a legitimate part of any theme). Used to prove
 * each themed template's palette stays "predominantly" its theme rather than
 * wandering into unrelated ground types. */
function usesOnlyGroundTypes(template: MapTemplate, allowed: GroundType[]): boolean {
  const allowedSet = new Set<GroundType>(["default", ...allowed]);
  return template.cells.every((cell) => allowedSet.has(cell.ground_type ?? "default"));
}

describe("MAP_TEMPLATES structural invariants", () => {
  it("includes the three original starter layouts plus 18 new themed templates", () => {
    expect(MAP_TEMPLATES.map((template) => template.id)).toEqual([
      "empty-room",
      "corridor",
      "tavern",
      "forest-clearing",
      "forest-treeline-ambush",
      "forest-hollow",
      "coast-tidal-shallows",
      "coast-sandbar-crossing",
      "coast-cove-inlet",
      "water-river-bend",
      "water-lake-crossing",
      "water-rapids",
      "stone-corridor-junction",
      "stone-cavern-chamber",
      "stone-sunken-vault",
      "swamp-murky-bog",
      "swamp-fetid-mire",
      "swamp-sunken-marsh",
      "town-market-square",
      "town-crossroads-hamlet",
      "town-tradesmans-row",
    ]);
  });

  for (const template of MAP_TEMPLATES) {
    describe(template.id, () => {
      it("keeps every cell inside the grid, with no duplicates", () => {
        const seen = new Set<string>();
        for (const cell of template.cells) {
          expect(cell.x).toBeGreaterThanOrEqual(0);
          expect(cell.x).toBeLessThan(template.gridWidth);
          expect(cell.y).toBeGreaterThanOrEqual(0);
          expect(cell.y).toBeLessThan(template.gridHeight);
          const key = `${cell.x},${cell.y}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      });

      it("keeps every object inside the grid, one per cell, on seeded preset assets", () => {
        const seen = new Set<string>();
        for (const object of template.objects) {
          expect(object.x).toBeGreaterThanOrEqual(0);
          expect(object.x).toBeLessThan(template.gridWidth);
          expect(object.y).toBeGreaterThanOrEqual(0);
          expect(object.y).toBeLessThan(template.gridHeight);
          expect(SEEDED_PRESET_IDS.has(object.asset_id)).toBe(true);
          const key = `${object.x},${object.y}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      });

      it("places every object at its cell's elevation", () => {
        const elevationAt = new Map(
          template.cells.map((cell) => [`${cell.x},${cell.y}`, cell.elevation])
        );
        for (const object of template.objects) {
          expect(object.elevation).toBe(elevationAt.get(`${object.x},${object.y}`) ?? 0);
        }
      });

      it("has sculpted (non-flat) terrain, not a blank grid with a name", () => {
        expect(template.cells.some((cell) => cell.elevation > 0)).toBe(true);
      });
    });
  }

  it("shapes the empty room as a walled perimeter with exactly one door and 4 real corners", () => {
    const room = MAP_TEMPLATES.find((template) => template.id === "empty-room")!;
    const walls = room.objects.filter((object) => object.asset_id === PRESET_WALL);
    const corners = room.objects.filter((object) => object.asset_id === PRESET_WALL_CORNER);
    const doors = room.objects.filter((object) => object.asset_id === PRESET_WALL_DOOR);
    // 10x8 perimeter = 32 cells: one door, 4 real 90°-turn corners (each of
    // a rectangle's own corners), the rest straight runs.
    expect(walls).toHaveLength(27);
    expect(corners).toHaveLength(4);
    expect(doors).toHaveLength(1);
    expect(room.objects).toHaveLength(32);
    // The 4 corners are exactly the room's own 4 geometric corners.
    expect(new Set(corners.map((c) => `${c.x},${c.y}`))).toEqual(
      new Set(["0,0", "9,0", "0,7", "9,7"])
    );
    // Door-in-wall fix: the door cell sits at the SAME elevation as its
    // wall neighbors (not a ground-level gap one step below them) so a
    // full-height Wall Doorway piece meets its neighbors flush, and it
    // must span its own cell's run axis exactly like a plain wall would —
    // its rotation matches classifyWallCell's own computation for that
    // position (bottom edge => 0), not a hardcoded value.
    const door = doors[0];
    const doorCell = room.cells.find((cell) => cell.x === door.x && cell.y === door.y)!;
    const wallCellNextToDoor = room.cells.find((cell) => cell.x === door.x - 1 && cell.y === door.y)!;
    expect(doorCell.elevation).toBe(wallCellNextToDoor.elevation);
    expect(door.rotation).toBe(0);
  });

  it("door-in-wall fix: no template places the free-standing Door prop anymore", () => {
    // Every one of the 21 built-in templates that has a door places it via
    // walledRoom/buildingOutline/multiDoorRoom, and all three now place
    // PRESET_WALL_DOOR (a wall segment with its own doorway) instead of the
    // old free-standing PRESET_DOOR — see PRESET_WALL_DOOR's own doc
    // comment in templates.ts for why. PRESET_DOOR itself stays a valid,
    // seeded asset (still importable/placeable by hand) — this only proves
    // no BUILT-IN template still floats it next to an intact wall.
    for (const template of MAP_TEMPLATES) {
      expect(template.objects.some((object) => object.asset_id === PRESET_DOOR)).toBe(false);
    }
  });

  it("shapes the corridor as two full-length wall lines with torches between", () => {
    const corridor = MAP_TEMPLATES.find((template) => template.id === "corridor")!;
    const walls = corridor.objects.filter((object) => object.asset_id === PRESET_WALL);
    const torches = corridor.objects.filter((object) => object.asset_id === PRESET_TORCH);
    expect(walls).toHaveLength(24);
    expect(walls.every((wall) => wall.x === 0 || wall.x === 2)).toBe(true);
    expect(torches).toHaveLength(2);
    expect(torches.every((torch) => torch.x === 1)).toBe(true);
  });

  it("shapes the tavern as a walled room with a door, six tables, and two torches", () => {
    const tavern = MAP_TEMPLATES.find((template) => template.id === "tavern")!;
    const counts = new Map<string, number>();
    for (const object of tavern.objects) {
      counts.set(object.asset_id, (counts.get(object.asset_id) ?? 0) + 1);
    }
    // 14x12 perimeter = 48 cells: 41 straight walls + 4 real corners + 1
    // door + 2 torch sconces.
    expect(counts.get(PRESET_WALL)).toBe(41);
    expect(counts.get(PRESET_WALL_CORNER)).toBe(4);
    expect(counts.get(PRESET_WALL_DOOR)).toBe(1);
    expect(counts.get(PRESET_TORCH)).toBe(2);
    expect(counts.get(PRESET_TABLE)).toBe(6);
    // Tables sit on the flat interior, inside the walls.
    const tables = tavern.objects.filter((object) => object.asset_id === PRESET_TABLE);
    expect(
      tables.every(
        (table) =>
          table.x > 0 && table.x < tavern.gridWidth - 1 && table.y > 0 && table.y < tavern.gridHeight - 1
      )
    ).toBe(true);
  });

  it("corridor's walls stay straight runs — no false corners at its open ends", () => {
    // Regression guard: a corridor's end cells have exactly one wall
    // neighbor (the rest of their own column), never a perpendicular one —
    // classifyWallCell must not mistake an open-ended dead end for a
    // corner. corridorTemplate doesn't run through classifyWallCell at all
    // (it hardcodes rotation 90 directly), so this instead exercises the
    // classifier itself against the corridor's own wall-cell shape.
    const corridor = MAP_TEMPLATES.find((template) => template.id === "corridor")!;
    const isWall = (x: number, y: number) =>
      x >= 0 && x < corridor.gridWidth && y >= 0 && y < corridor.gridHeight && (x === 0 || x === corridor.gridWidth - 1);
    for (let y = 0; y < corridor.gridHeight; y++) {
      for (const x of [0, corridor.gridWidth - 1]) {
        expect(classifyWallCell(x, y, isWall).assetId).toBe(PRESET_WALL);
      }
    }
  });

  describe("classifyWallCell", () => {
    // A 3x3 room's own isWall lookup: only its 8 perimeter cells are walls.
    const size = 3;
    const isWall = (x: number, y: number) =>
      x >= 0 && x < size && y >= 0 && y < size && (x === 0 || y === 0 || x === size - 1 || y === size - 1);

    it("classifies all 4 corners of a real room as PRESET_WALL_CORNER", () => {
      for (const [x, y] of [
        [0, 0],
        [2, 0],
        [0, 2],
        [2, 2],
      ]) {
        const placement = classifyWallCell(x, y, isWall);
        expect(placement.assetId).toBe(PRESET_WALL_CORNER);
        // Corners are a rotationally-symmetric piece — every corner uses
        // the same rotation, unlike a straight run.
        expect(placement.rotation).toBe(0);
      }
    });

    it("classifies a horizontal-run midpoint as an unrotated straight wall", () => {
      // (1,0) has wall neighbors east+west (0,0) and (2,0) — both on the
      // SAME axis — not a corner.
      expect(classifyWallCell(1, 0, isWall)).toEqual({ assetId: PRESET_WALL, rotation: 0 });
    });

    it("classifies a vertical-run midpoint as a 90°-rotated straight wall", () => {
      // (0,1) has wall neighbors north+south (0,0) and (0,2) — same axis —
      // not a corner.
      expect(classifyWallCell(0, 1, isWall)).toEqual({ assetId: PRESET_WALL, rotation: 90 });
    });

    it("classifies an isolated wall cell (no wall neighbors at all) as a straight wall", () => {
      const noNeighbors = () => false;
      expect(classifyWallCell(5, 5, noNeighbors)).toEqual({ assetId: PRESET_WALL, rotation: 0 });
    });
  });

  describe("themed templates (forest / sand+water / water-only / stone / swamp / town)", () => {
    it("forest templates use only forest/dense_forest/grass ground, no water", () => {
      for (const id of ["forest-clearing", "forest-treeline-ambush", "forest-hollow"]) {
        const template = findTemplate(id);
        expect(usesOnlyGroundTypes(template, ["forest", "dense_forest", "grass"])).toBe(true);
      }
    });

    it("sand+water templates use only sand/water/rock ground", () => {
      for (const id of ["coast-tidal-shallows", "coast-sandbar-crossing", "coast-cove-inlet"]) {
        const template = findTemplate(id);
        expect(usesOnlyGroundTypes(template, ["sand", "water", "rock"])).toBe(true);
      }
    });

    it("the sandbar crossing has a difficult-terrain water channel with a normal-terrain gap across it", () => {
      const template = findTemplate("coast-sandbar-crossing");
      const byKey = new Map(template.cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
      const channelCell = byKey.get("0,4");
      const gapCell = byKey.get("6,4");
      expect(channelCell?.ground_type).toBe("water");
      expect(channelCell?.terrain_type).toBe("difficult");
      expect(gapCell?.ground_type).toBe("sand");
      expect(gapCell?.terrain_type).toBe("normal");
    });

    it("water-only templates are predominantly water, with only sand/grass/rock islands", () => {
      for (const id of ["water-river-bend", "water-lake-crossing", "water-rapids"]) {
        const template = findTemplate(id);
        expect(usesOnlyGroundTypes(template, ["water", "sand", "grass", "rock"])).toBe(true);
        const waterCells = template.cells.filter((cell) => cell.ground_type === "water").length;
        expect(waterCells).toBeGreaterThan(template.cells.length / 2);
      }
    });

    it("water-only templates carry more than one flow direction across the theme", () => {
      const directions = new Set(
        ["water-river-bend", "water-lake-crossing", "water-rapids"]
          .flatMap((id) => findTemplate(id).cells)
          .map((cell) => cell.water_flow_direction)
          .filter((direction): direction is NonNullable<typeof direction> => direction !== null && direction !== undefined)
      );
      expect(directions.size).toBeGreaterThan(1);
    });

    it("stone templates use only stone/rock ground and reuse wall/door placement", () => {
      for (const id of ["stone-corridor-junction", "stone-cavern-chamber", "stone-sunken-vault"]) {
        const template = findTemplate(id);
        expect(usesOnlyGroundTypes(template, ["stone", "rock"])).toBe(true);
        expect(template.objects.some((object) => object.asset_id === PRESET_WALL)).toBe(true);
      }
    });

    it("the corridor junction chamber has a door on all four sides", () => {
      const template = findTemplate("stone-corridor-junction");
      const doors = template.objects.filter((object) => object.asset_id === PRESET_WALL_DOOR);
      expect(doors).toHaveLength(4);
      // Two of the four doors sit on the LEFT/RIGHT edges (a vertical run) —
      // regression guard that a Wall Doorway still gets a real edge-relative
      // rotation (matching a plain wall there), not a single hardcoded value
      // that would only happen to look right on a top/bottom edge.
      const rotationAt = (x: number, y: number) =>
        template.objects.find((object) => object.x === x && object.y === y)?.rotation;
      expect(rotationAt(5, 0)).toBe(0);
      expect(rotationAt(5, 9)).toBe(0);
      expect(rotationAt(0, 5)).toBe(90);
      expect(rotationAt(9, 5)).toBe(90);
    });

    it("swamp templates use only swamp/water ground, and pre-paint some difficult bog", () => {
      for (const id of ["swamp-murky-bog", "swamp-fetid-mire", "swamp-sunken-marsh"]) {
        const template = findTemplate(id);
        expect(usesOnlyGroundTypes(template, ["swamp", "water"])).toBe(true);
        expect(template.cells.some((cell) => cell.terrain_type === "difficult")).toBe(true);
      }
    });

    it("town templates use only path/stone/grass streets and plots, and use building outlines, not one room", () => {
      for (const id of ["town-market-square", "town-crossroads-hamlet", "town-tradesmans-row"]) {
        const template = findTemplate(id);
        expect(usesOnlyGroundTypes(template, ["path", "stone", "grass"])).toBe(true);
        const doors = template.objects.filter((object) => object.asset_id === PRESET_WALL_DOOR);
        // Several small structures, not a single enclosing room: more than
        // one door, one per building rather than one for the whole map.
        expect(doors.length).toBeGreaterThan(1);
      }
    });

    it("every themed template's objects reference only Tree/Rock in addition to the original preset set", () => {
      const themedIds = MAP_TEMPLATES.slice(3).map((template) => template.id);
      for (const id of themedIds) {
        const template = findTemplate(id);
        for (const object of template.objects) {
          expect(SEEDED_PRESET_IDS.has(object.asset_id)).toBe(true);
        }
      }
      // Confirm Tree and Rock actually get used somewhere (not dead exports).
      const allThemedObjects = themedIds.flatMap((id) => findTemplate(id).objects);
      expect(allThemedObjects.some((object) => object.asset_id === PRESET_TREE)).toBe(true);
      expect(allThemedObjects.some((object) => object.asset_id === PRESET_ROCK)).toBe(true);
    });
  });
});
