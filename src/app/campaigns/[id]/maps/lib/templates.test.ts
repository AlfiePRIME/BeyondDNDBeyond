import { describe, expect, it } from "vitest";
import type { GroundType } from "@/data-access";
import type { MapTemplate } from "./templates";
import {
  MAP_TEMPLATES,
  PRESET_DOOR,
  PRESET_ROCK,
  PRESET_TABLE,
  PRESET_TORCH,
  PRESET_TREE,
  PRESET_WALL,
} from "./templates";

// The exact ids seeded by 0016_asset_library_presets.sql — templates may
// only reference these, since they're the assets guaranteed to exist in
// every campaign.
const SEEDED_PRESET_IDS = new Set([
  "a55e7001-0000-4000-8000-000000000001",
  "a55e7002-0000-4000-8000-000000000002",
  "a55e7003-0000-4000-8000-000000000003",
  "a55e7004-0000-4000-8000-000000000004",
  "a55e7005-0000-4000-8000-000000000005",
  "a55e7006-0000-4000-8000-000000000006",
  "a55e7007-0000-4000-8000-000000000007",
  "a55e7008-0000-4000-8000-000000000008",
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

  it("shapes the empty room as a walled perimeter with exactly one door", () => {
    const room = MAP_TEMPLATES.find((template) => template.id === "empty-room")!;
    const walls = room.objects.filter((object) => object.asset_id === PRESET_WALL);
    const doors = room.objects.filter((object) => object.asset_id === PRESET_DOOR);
    // 10x8 perimeter = 32 cells; one of them is the door.
    expect(walls).toHaveLength(31);
    expect(doors).toHaveLength(1);
    expect(room.objects).toHaveLength(32);
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
    // 14x12 perimeter = 48 cells: 45 walls + 1 door + 2 torch sconces.
    expect(counts.get(PRESET_WALL)).toBe(45);
    expect(counts.get(PRESET_DOOR)).toBe(1);
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
      const doors = template.objects.filter((object) => object.asset_id === PRESET_DOOR);
      expect(doors).toHaveLength(4);
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
        const doors = template.objects.filter((object) => object.asset_id === PRESET_DOOR);
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
