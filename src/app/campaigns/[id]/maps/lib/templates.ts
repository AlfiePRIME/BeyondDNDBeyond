import type { NewMapCell, NewMapObjectSeed } from "@/data-access";

// The built-in preset assets seeded by 0016_asset_library_presets.sql —
// fixed global UUIDs, present in every campaign's palette. Templates may
// reference ONLY these (a custom asset id would be campaign-specific).
export const PRESET_TORCH = "a55e7001-0000-4000-8000-000000000001";
export const PRESET_DOOR = "a55e7003-0000-4000-8000-000000000003";
export const PRESET_TABLE = "a55e7004-0000-4000-8000-000000000004";
export const PRESET_WALL = "a55e7007-0000-4000-8000-000000000007";

/**
 * A starter layout a DM can begin a new map from instead of a blank grid.
 * Static code-defined data (like the rules-engine's RACES/SPELLS), not
 * DB-editable content. Cell/object shapes match createPopulatedMap's inputs
 * so a template instantiates with a single call.
 */
export interface MapTemplate {
  id: string;
  name: string;
  description: string;
  gridWidth: number;
  gridHeight: number;
  cells: NewMapCell[];
  objects: NewMapObjectSeed[];
}

// Wall lines sit on cells raised one step so the room shape reads in both
// the 3D render and the flat thumbnail; the door cell stays at ground level
// (a walkable threshold — the object's elevation must match its cell, the
// same cell/object consistency rule the AI generator's validation enforces).
const WALL_ELEVATION = 1;

function isPerimeter(x: number, y: number, width: number, height: number): boolean {
  return x === 0 || y === 0 || x === width - 1 || y === height - 1;
}

// Side walls rotate 90° so the segment runs along the vertical edge;
// corners keep the horizontal run's orientation.
function wallRotation(x: number, y: number, width: number, height: number): number {
  if (y === 0 || y === height - 1) return 0;
  return x === 0 || x === width - 1 ? 90 : 0;
}

/** A rectangular walled room: raised perimeter cells with a Wall Segment on
 * each, one ground-level Door cell as the entrance, flat interior. */
function walledRoom(
  width: number,
  height: number,
  door: { x: number; y: number }
): { cells: NewMapCell[]; objects: NewMapObjectSeed[] } {
  const cells: NewMapCell[] = [];
  const objects: NewMapObjectSeed[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isPerimeter(x, y, width, height)) continue;
      const isDoor = x === door.x && y === door.y;
      cells.push({ x, y, elevation: isDoor ? 0 : WALL_ELEVATION, terrain_type: "normal" });
      objects.push({
        asset_id: isDoor ? PRESET_DOOR : PRESET_WALL,
        x,
        y,
        elevation: isDoor ? 0 : WALL_ELEVATION,
        rotation: wallRotation(x, y, width, height),
      });
    }
  }
  return { cells, objects };
}

function emptyRoomTemplate(): MapTemplate {
  const { cells, objects } = walledRoom(10, 8, { x: 4, y: 7 });
  return {
    id: "empty-room",
    name: "Empty Room",
    description: "A plain walled chamber with a single door — a blank canvas with bones.",
    gridWidth: 10,
    gridHeight: 8,
    cells,
    objects,
  };
}

function corridorTemplate(): MapTemplate {
  const width = 3;
  const height = 12;
  const cells: NewMapCell[] = [];
  const objects: NewMapObjectSeed[] = [];
  for (let y = 0; y < height; y++) {
    for (const x of [0, width - 1]) {
      cells.push({ x, y, elevation: WALL_ELEVATION, terrain_type: "normal" });
      objects.push({ asset_id: PRESET_WALL, x, y, elevation: WALL_ELEVATION, rotation: 90 });
    }
  }
  for (const y of [3, 8]) {
    objects.push({ asset_id: PRESET_TORCH, x: 1, y, elevation: 0, rotation: 0 });
  }
  return {
    id: "corridor",
    name: "Corridor",
    description: "A long torch-lit passage walled on both sides, open at either end.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

function tavernTemplate(): MapTemplate {
  const width = 14;
  const height = 12;
  const { cells, objects } = walledRoom(width, height, { x: 7, y: 11 });
  // Two wall segments give way to torch sconces flanking the common room.
  for (const torch of [
    { x: 0, y: 5 },
    { x: width - 1, y: 5 },
  ]) {
    const wallIndex = objects.findIndex((object) => object.x === torch.x && object.y === torch.y);
    objects[wallIndex] = {
      asset_id: PRESET_TORCH,
      x: torch.x,
      y: torch.y,
      elevation: WALL_ELEVATION,
      rotation: 0,
    };
  }
  for (const table of [
    { x: 3, y: 3 },
    { x: 6, y: 3 },
    { x: 10, y: 3 },
    { x: 3, y: 7 },
    { x: 6, y: 7 },
    { x: 10, y: 7 },
  ]) {
    objects.push({ asset_id: PRESET_TABLE, x: table.x, y: table.y, elevation: 0, rotation: 0 });
  }
  return {
    id: "tavern",
    name: "Tavern",
    description: "A common room ringed by walls: six tables, wall torches, and a front door.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

export const MAP_TEMPLATES: readonly MapTemplate[] = [
  emptyRoomTemplate(),
  corridorTemplate(),
  tavernTemplate(),
];
