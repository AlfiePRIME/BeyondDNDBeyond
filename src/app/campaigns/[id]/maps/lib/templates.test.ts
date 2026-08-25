import { describe, expect, it } from "vitest";
import {
  MAP_TEMPLATES,
  PRESET_DOOR,
  PRESET_TABLE,
  PRESET_TORCH,
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

describe("MAP_TEMPLATES structural invariants", () => {
  it("includes the three named starter layouts", () => {
    expect(MAP_TEMPLATES.map((template) => template.id)).toEqual([
      "empty-room",
      "corridor",
      "tavern",
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
});
