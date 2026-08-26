import type { NewMapCell, NewMapObjectSeed } from "@/data-access";

// The built-in preset assets seeded by 0016_asset_library_presets.sql —
// fixed global UUIDs, present in every campaign's palette. Templates may
// reference ONLY these (a custom asset id would be campaign-specific).
export const PRESET_TORCH = "a55e7001-0000-4000-8000-000000000001";
export const PRESET_DOOR = "a55e7003-0000-4000-8000-000000000003";
export const PRESET_TABLE = "a55e7004-0000-4000-8000-000000000004";
export const PRESET_WALL = "a55e7007-0000-4000-8000-000000000007";
// Procedural-wall gap/corner/diagonal fix: a proper 90°-turn piece (a
// rotationally-symmetric "plus" of two full-cell-length arms — see
// scripts/assets/generate-wall-variants-presets.mjs — so it connects flush
// with a straight run on ANY of its 4 sides, needing no per-corner rotation)
// and a 45°-orientation piece spanning a cell's own diagonal corner-to-corner
// (for octagonal/organic room shapes, or the void-terrain-carved organic
// shapes this app already supports). Neither existed before this fix —
// every perimeter cell used to get PRESET_WALL, including actual room
// corners, with no distinct corner geometry at all (this fix's root cause).
export const PRESET_WALL_CORNER = "a55e7010-0000-4000-8000-000000000010";
export const PRESET_WALL_DIAGONAL = "a55e7011-0000-4000-8000-000000000011";

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

interface WallPlacement {
  assetId: string;
  rotation: number;
}

/**
 * Classifies a single wall cell as a straight run or a 90° corner PURELY by
 * looking at which of its four orthogonal neighbors are also wall cells —
 * not by its (x, y) position against the grid's own bounds, so this works
 * for any wall footprint (a perfect rectangle's perimeter today; an organic
 * or void-terrain-carved outline tomorrow), not just walledRoom's rectangle.
 *
 * A corner is any cell with wall neighbors on exactly one vertical side
 * (north or south) AND one horizontal side (east or west) — its run bends
 * here. PRESET_WALL_CORNER's own geometry is a rotationally-symmetric
 * "plus" (see generate-wall-variants-presets.mjs), so every corner uses the
 * SAME rotation (0) regardless of which two sides actually have neighbors —
 * unlike a straight run, there's no orientation to get right or wrong.
 *
 * A straight cell (0 or 1 wall neighbor, or neighbors on both opposite
 * sides of one axis) keeps today's convention: a vertical run (neighbors
 * north and/or south) rotates 90° so PRESET_WALL's length axis runs along
 * the vertical edge; everything else (a horizontal run, or an isolated
 * single-cell segment with no wall neighbors at all) uses the unrotated
 * horizontal orientation.
 */
export function classifyWallCell(x: number, y: number, isWall: (x: number, y: number) => boolean): WallPlacement {
  const north = isWall(x, y - 1);
  const south = isWall(x, y + 1);
  const west = isWall(x - 1, y);
  const east = isWall(x + 1, y);
  const hasVertical = north || south;
  const hasHorizontal = east || west;
  if (hasVertical && hasHorizontal) return { assetId: PRESET_WALL_CORNER, rotation: 0 };
  return { assetId: PRESET_WALL, rotation: hasVertical ? 90 : 0 };
}

/** A rectangular walled room: raised perimeter cells with a Wall Segment (or
 * a Wall Corner at each of the room's 4 real 90° turns) on each, one
 * ground-level Door cell as the entrance, flat interior. */
function walledRoom(
  width: number,
  height: number,
  door: { x: number; y: number }
): { cells: NewMapCell[]; objects: NewMapObjectSeed[] } {
  const cells: NewMapCell[] = [];
  const objects: NewMapObjectSeed[] = [];
  const isWall = (x: number, y: number) =>
    x >= 0 && x < width && y >= 0 && y < height && isPerimeter(x, y, width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isPerimeter(x, y, width, height)) continue;
      const isDoor = x === door.x && y === door.y;
      cells.push({ x, y, elevation: isDoor ? 0 : WALL_ELEVATION, terrain_type: "normal" });
      const placement = classifyWallCell(x, y, isWall);
      objects.push({
        asset_id: isDoor ? PRESET_DOOR : placement.assetId,
        x,
        y,
        elevation: isDoor ? 0 : WALL_ELEVATION,
        rotation: isDoor ? 0 : placement.rotation,
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
