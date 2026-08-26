import type { GroundType, NewMapCell, NewMapObjectSeed, WaterFlowDirection } from "@/data-access";
import type { TerrainType } from "@/rules-engine";

// The built-in preset assets seeded by 0016_asset_library_presets.sql —
// fixed global UUIDs, present in every campaign's palette. Templates may
// reference ONLY these (a custom asset id would be campaign-specific).
export const PRESET_TORCH = "a55e7001-0000-4000-8000-000000000001";
export const PRESET_DOOR = "a55e7003-0000-4000-8000-000000000003";
export const PRESET_TABLE = "a55e7004-0000-4000-8000-000000000004";
export const PRESET_TREE = "a55e7005-0000-4000-8000-000000000005";
export const PRESET_ROCK = "a55e7006-0000-4000-8000-000000000006";
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

// Side walls rotate 90° so the segment runs along the vertical edge;
// corners keep the horizontal run's orientation. Superseded by
// classifyWallCell below for walledRoom (which now gives a real corner cell
// its own distinct piece), but kept as-is for buildingOutline/multiDoorRoom
// (MapPlan P11's small-structure helpers, added on master while this fix
// was in flight) — retrofitting corner classification onto those isn't this
// fix's job, and they still pick up this fix's gap-closure for free since
// that's keyed by asset url in PlacedObject.tsx, not by which template
// helper placed the object.
function wallRotation(x: number, y: number, width: number, height: number): number {
  if (y === 0 || y === height - 1) return 0;
  return x === 0 || x === width - 1 ? 90 : 0;
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

// ---------------------------------------------------------------------------
// Themed starter templates — forest, sand+water, water-only, stone, swamp,
// and town (18 total, 3 per theme). Built on Prompt 4's GROUND_TYPES and
// Prompt 6's water/flow-direction addition; every value used below already
// exists and already renders (GROUND_COLORS in MapSurface.tsx and
// thumbnail.ts both map all nine real ground types). A small toolkit below
// generalizes the fixed-perimeter-room shape walledRoom already uses to
// open terrain and multi-building layouts, rather than one-off per-template
// loops for each of the 18.
// ---------------------------------------------------------------------------

/** A cell's paintable properties, all optional — used both as a "base" fill
 * for a whole grid and as a per-coordinate override on top of it. */
interface CellSpec {
  elevation?: number;
  terrain_type?: TerrainType;
  ground_type?: GroundType;
  water_flow_direction?: WaterFlowDirection | null;
}

type CellOverride = CellSpec & { x: number; y: number };

/** Applies one override on top of an existing cell. water_flow_direction
 * needs its own branch (not `??`) because `null` is a meaningful, deliberate
 * override (e.g. "this used to be flowing water, now it's an island") that
 * `??` would otherwise treat as "not specified" and skip. */
function applyOverride(current: NewMapCell, override: CellOverride): NewMapCell {
  return {
    x: current.x,
    y: current.y,
    elevation: override.elevation ?? current.elevation,
    terrain_type: override.terrain_type ?? current.terrain_type,
    ground_type: override.ground_type ?? current.ground_type,
    water_flow_direction:
      override.water_flow_direction !== undefined ? override.water_flow_direction : current.water_flow_direction,
  };
}

/** Fills a width x height rectangle with `base`, then applies point/region
 * overrides on top (later entries win on a repeated coordinate; an override
 * outside the grid is silently ignored, so a rect() clipped at an edge is
 * harmless). The general-purpose builder the new themed templates use for
 * open terrain that isn't a walled room. */
function paintedGrid(
  width: number,
  height: number,
  base: CellSpec,
  overrides: CellOverride[] = []
): NewMapCell[] {
  const byKey = new Map<string, NewMapCell>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      byKey.set(`${x},${y}`, {
        x,
        y,
        elevation: base.elevation ?? 0,
        terrain_type: base.terrain_type ?? "normal",
        ground_type: base.ground_type ?? "default",
        water_flow_direction: base.water_flow_direction === undefined ? null : base.water_flow_direction,
      });
    }
  }
  for (const override of overrides) {
    const current = byKey.get(`${override.x},${override.y}`);
    if (!current) continue;
    byKey.set(`${override.x},${override.y}`, applyOverride(current, override));
  }
  return [...byKey.values()];
}

/** Expands a rectangular region (inclusive corners) into the point-override
 * list paintedGrid expects — a labeled band or zone (a treeline half, a
 * water channel) rather than every cell spelled out by hand. */
function rect(x0: number, y0: number, x1: number, y1: number, spec: CellSpec): CellOverride[] {
  const overrides: CellOverride[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      overrides.push({ x, y, ...spec });
    }
  }
  return overrides;
}

/** Merges cell arrays with later groups overriding earlier ones on a shared
 * coordinate — lets a base ground fill (streets, a cave floor) sit under
 * buildings/walls authored separately, without either side needing to know
 * the other's exact footprint. */
function mergeCells(...groups: NewMapCell[][]): NewMapCell[] {
  const byKey = new Map<string, NewMapCell>();
  for (const group of groups) {
    for (const cell of group) byKey.set(`${cell.x},${cell.y}`, cell);
  }
  return [...byKey.values()];
}

/** Generalizes walledRoom to an arbitrary origin offset on a shared grid: a
 * small rectangular structure's raised perimeter walls plus (at most) one
 * ground-level door. Lets the town/stone themes place several distinct
 * structures on one map instead of one room filling it — same
 * isPerimeter/wallRotation this file already uses for walledRoom, just
 * parameterized by a local origin. Wall cells are ground_type 'stone'
 * (construction, not terrain) regardless of the theme around them. */
function buildingOutline(
  x0: number,
  y0: number,
  width: number,
  height: number,
  door: { x: number; y: number } | null
): { cells: NewMapCell[]; objects: NewMapObjectSeed[] } {
  const cells: NewMapCell[] = [];
  const objects: NewMapObjectSeed[] = [];
  for (let ly = 0; ly < height; ly++) {
    for (let lx = 0; lx < width; lx++) {
      if (!isPerimeter(lx, ly, width, height)) continue;
      const isDoor = door !== null && lx === door.x && ly === door.y;
      const x = x0 + lx;
      const y = y0 + ly;
      const elevation = isDoor ? 0 : WALL_ELEVATION;
      cells.push({ x, y, elevation, terrain_type: "normal", ground_type: "stone" });
      objects.push({
        asset_id: isDoor ? PRESET_DOOR : PRESET_WALL,
        x,
        y,
        elevation,
        rotation: wallRotation(lx, ly, width, height),
      });
    }
  }
  return { cells, objects };
}

/** A rectangular room with SEVERAL doors instead of walledRoom's one — used
 * once, for the stone theme's four-way corridor junction chamber. */
function multiDoorRoom(
  width: number,
  height: number,
  doors: Array<{ x: number; y: number }>,
  groundType: GroundType
): { cells: NewMapCell[]; objects: NewMapObjectSeed[] } {
  const cells: NewMapCell[] = [];
  const objects: NewMapObjectSeed[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isPerimeter(x, y, width, height)) continue;
      const isDoor = doors.some((door) => door.x === x && door.y === y);
      const elevation = isDoor ? 0 : WALL_ELEVATION;
      cells.push({ x, y, elevation, terrain_type: "normal", ground_type: groundType });
      objects.push({
        asset_id: isDoor ? PRESET_DOOR : PRESET_WALL,
        x,
        y,
        elevation,
        rotation: wallRotation(x, y, width, height),
      });
    }
  }
  return { cells, objects };
}

// ─── Forest (3): forest / dense_forest / grass, varied elevation, no water ──

/** A grass clearing ringed by a forest band and a dense outer treeline —
 * concentric rings by distance to the map edge, raised slightly at the rim
 * so the treeline reads as higher ground around a sunken-feeling clearing. */
function forestClearingTemplate(): MapTemplate {
  const width = 12;
  const height = 10;
  const cells: NewMapCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = Math.min(x, y, width - 1 - x, height - 1 - y);
      const ground_type: GroundType = edge === 0 ? "dense_forest" : edge === 1 ? "forest" : "grass";
      const elevation = edge <= 1 ? 1 : 0;
      cells.push({ x, y, elevation, terrain_type: "normal", ground_type });
    }
  }
  // A few gentle mounds scattered across the clearing floor, so the open
  // ground doesn't read as perfectly flat.
  for (const { x, y } of [
    { x: 5, y: 4 },
    { x: 7, y: 6 },
    { x: 4, y: 6 },
  ]) {
    const cell = cells.find((c) => c.x === x && c.y === y);
    if (cell) cell.elevation = 1;
  }
  return {
    id: "forest-clearing",
    name: "Woodland Clearing",
    description: "A sunlit grass clearing ringed by forest, with a dense outer treeline.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [
      { asset_id: PRESET_TREE, x: 1, y: 1, elevation: 1, rotation: 0 },
      { asset_id: PRESET_TREE, x: 10, y: 1, elevation: 1, rotation: 0 },
      { asset_id: PRESET_TREE, x: 1, y: 8, elevation: 1, rotation: 0 },
      { asset_id: PRESET_TREE, x: 10, y: 8, elevation: 1, rotation: 0 },
    ],
  };
}

/** An open grass field running up to a raised, dense treeline along the
 * north edge — cover for an ambush, per the DM's own framing. */
function treelineAmbushTemplate(): MapTemplate {
  const width = 14;
  const height = 10;
  const cells = paintedGrid(width, height, { ground_type: "grass" }, [
    ...rect(0, 0, width - 1, 1, { ground_type: "dense_forest", elevation: 2 }),
    ...rect(0, 2, width - 1, 3, { ground_type: "forest", elevation: 1 }),
  ]);
  // A couple of low grassy rises out in the open field, away from the treeline.
  for (const { x, y } of [
    { x: 3, y: 7 },
    { x: 10, y: 8 },
    { x: 6, y: 6 },
  ]) {
    const cell = cells.find((c) => c.x === x && c.y === y);
    if (cell) cell.elevation = 1;
  }
  return {
    id: "forest-treeline-ambush",
    name: "Treeline Ambush",
    description: "An open grass field runs up to a raised, dense treeline along one edge — cover for an ambush.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [
      { asset_id: PRESET_TREE, x: 2, y: 0, elevation: 2, rotation: 0 },
      { asset_id: PRESET_TREE, x: 6, y: 1, elevation: 2, rotation: 0 },
      { asset_id: PRESET_TREE, x: 11, y: 0, elevation: 2, rotation: 0 },
    ],
  };
}

/** Deep dense woods sloping down (via Chebyshev distance) into a sheltered
 * grass hollow tucked off-center — a different composition from the
 * clearing's centered rings and the ambush's half-split field. */
function forestHollowTemplate(): MapTemplate {
  const width = 12;
  const height = 10;
  const hollow = { x: 8, y: 7 };
  const cells: NewMapCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dist = Math.max(Math.abs(x - hollow.x), Math.abs(y - hollow.y));
      let ground_type: GroundType;
      let elevation: number;
      if (dist <= 1) {
        ground_type = "grass";
        elevation = 0;
      } else if (dist <= 3) {
        ground_type = "forest";
        elevation = 1;
      } else {
        ground_type = "dense_forest";
        elevation = 2;
      }
      cells.push({ x, y, elevation, terrain_type: "normal", ground_type });
    }
  }
  return {
    id: "forest-hollow",
    name: "Forest Hollow",
    description: "Deep woods slope down into a sheltered grass hollow tucked in one corner.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [
      { asset_id: PRESET_TREE, x: 1, y: 1, elevation: 2, rotation: 0 },
      { asset_id: PRESET_TREE, x: 4, y: 1, elevation: 2, rotation: 0 },
      { asset_id: PRESET_TREE, x: 1, y: 5, elevation: 2, rotation: 0 },
    ],
  };
}

// ─── Sand + water (3): a coastal/beach mix ───────────────────────────────

/** A calm sandy beach meeting shallow open water — a scenic coastline, no
 * crossing hazard intended (the shallows are normal terrain throughout). */
function tidalShallowsTemplate(): MapTemplate {
  const width = 14;
  const height = 10;
  const cells = paintedGrid(width, height, { ground_type: "water" }, [
    ...rect(0, 0, width - 1, 3, { ground_type: "sand" }),
    { x: 3, y: 1, ground_type: "sand", elevation: 1 },
    { x: 10, y: 2, ground_type: "sand", elevation: 1 },
    { x: 7, y: 5, ground_type: "rock" },
  ]);
  return {
    id: "coast-tidal-shallows",
    name: "Tidal Shallows",
    description: "A gentle sandy beach gives way to calm shallow water, with one rock breaking the surface offshore.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [{ asset_id: PRESET_ROCK, x: 7, y: 5, elevation: 0, rotation: 0 }],
  };
}

/** Two sandy banks split by a deep tidal channel (difficult terrain — an
 * actual crossing challenge) except for a narrow two-cell exposed sandbar:
 * the bridge-free crossing point, since Prompt 8's bridges may not exist
 * yet. */
function sandbarCrossingTemplate(): MapTemplate {
  const width = 14;
  const height = 10;
  const cells = paintedGrid(width, height, { ground_type: "sand" }, [
    ...rect(0, 4, width - 1, 5, { ground_type: "water", terrain_type: "difficult" }),
    ...rect(6, 4, 7, 5, { ground_type: "sand", terrain_type: "normal" }),
    { x: 2, y: 1, elevation: 1 },
    { x: 11, y: 8, elevation: 1 },
  ]);
  return {
    id: "coast-sandbar-crossing",
    name: "Sandbar Crossing",
    description: "Two sandy banks are split by a deep tidal channel — a narrow exposed sandbar is the only dry way across.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [],
  };
}

/** A curved sandy cove wrapping a quiet water inlet, with a rocky point at
 * its mouth — per-row water-start columns table a symmetric curve inward
 * around the vertical center rather than straight coastal bands. */
function coveInletTemplate(): MapTemplate {
  const width = 12;
  const height = 10;
  const waterStart = [12, 9, 7, 5, 4, 4, 5, 7, 9, 12];
  const cells: NewMapCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ground_type: GroundType = x >= waterStart[y] ? "water" : "sand";
      cells.push({ x, y, elevation: 0, terrain_type: "normal", ground_type });
    }
  }
  for (const y of [4, 5]) {
    const point = cells.find((c) => c.x === width - 1 && c.y === y);
    if (point) point.ground_type = "rock";
  }
  for (const { x, y } of [
    { x: 1, y: 1 },
    { x: 2, y: 8 },
  ]) {
    const cell = cells.find((c) => c.x === x && c.y === y);
    if (cell) cell.elevation = 1;
  }
  return {
    id: "coast-cove-inlet",
    name: "Cove Inlet",
    description: "A curved sandy cove wraps around a quiet water inlet, with a rocky point at its mouth.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [{ asset_id: PRESET_ROCK, x: width - 1, y: 4, elevation: 0, rotation: 0 }],
  };
}

// ─── Water-only (3): a lake or river feel ────────────────────────────────

/** A wide river bending from an east flow to a south flow, small islands
 * scattered near the bend, and a couple of eddy accents (opposite-direction
 * flow cells) near the inside of the turn for visual variety. */
function riverBendTemplate(): MapTemplate {
  const width = 14;
  const height = 10;
  const overrides: CellOverride[] = [
    ...rect(0, 0, 7, height - 1, { water_flow_direction: "east" }),
    ...rect(8, 0, width - 1, height - 1, { water_flow_direction: "south" }),
    { x: 7, y: 2, water_flow_direction: "north" },
    { x: 8, y: 8, water_flow_direction: "west" },
    { x: 3, y: 3, ground_type: "sand", elevation: 1, water_flow_direction: null },
    { x: 4, y: 3, ground_type: "sand", elevation: 1, water_flow_direction: null },
    { x: 9, y: 6, ground_type: "rock", elevation: 1, water_flow_direction: null },
    { x: 6, y: 7, ground_type: "grass", elevation: 1, water_flow_direction: null },
  ];
  const cells = paintedGrid(width, height, { ground_type: "water" }, overrides);
  return {
    id: "water-river-bend",
    name: "River Bend",
    description: "A wide river bends from flowing east to flowing south, with a scatter of small islands mid-current.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [{ asset_id: PRESET_ROCK, x: 9, y: 6, elevation: 1, rotation: 0 }],
  };
}

/** An open lake, mostly still, with a visible feeder stream entering one
 * corner and an outflow draining the opposite one, plus a line of small
 * islands strung across it as natural stepping stones for a crossing. */
function lakeCrossingTemplate(): MapTemplate {
  const width = 12;
  const height = 12;
  const islands: Array<{ x: number; y: number; ground_type: GroundType }> = [
    { x: 2, y: 2, ground_type: "grass" },
    { x: 4, y: 4, ground_type: "sand" },
    { x: 6, y: 6, ground_type: "rock" },
    { x: 8, y: 8, ground_type: "sand" },
    { x: 10, y: 9, ground_type: "grass" },
  ];
  const overrides: CellOverride[] = [
    ...rect(0, 0, 2, 2, { water_flow_direction: "east" }),
    ...rect(width - 3, height - 3, width - 1, height - 1, { water_flow_direction: "south" }),
  ];
  for (const island of islands) {
    overrides.push({ x: island.x, y: island.y, ground_type: island.ground_type, elevation: 1, water_flow_direction: null });
  }
  const cells = paintedGrid(width, height, { ground_type: "water" }, overrides);
  return {
    id: "water-lake-crossing",
    name: "Lake Crossing",
    description: "An open lake with a line of small islands strung across it — natural stepping stones for a crossing.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [{ asset_id: PRESET_ROCK, x: 6, y: 6, elevation: 1, rotation: 0 }],
  };
}

/** A fast, mostly-difficult river channel flowing south, boulders breaking
 * the current, and a calmer entry pool before the rapids begin in earnest. */
function rapidsTemplate(): MapTemplate {
  const width = 10;
  const height = 14;
  const boulderSpots = [
    { x: 2, y: 3 },
    { x: 7, y: 5 },
    { x: 4, y: 8 },
    { x: 8, y: 10 },
    { x: 3, y: 12 },
  ];
  const overrides: CellOverride[] = [...rect(0, 0, width - 1, 1, { terrain_type: "normal" })];
  overrides.push({ x: 6, y: 5, water_flow_direction: "east" });
  overrides.push({ x: 8, y: 9, water_flow_direction: "west" });
  for (const spot of boulderSpots) {
    overrides.push({
      x: spot.x,
      y: spot.y,
      ground_type: "rock",
      terrain_type: "normal",
      elevation: 1,
      water_flow_direction: null,
    });
  }
  const cells = paintedGrid(
    width,
    height,
    { ground_type: "water", terrain_type: "difficult", water_flow_direction: "south" },
    overrides
  );
  const objects: NewMapObjectSeed[] = boulderSpots.map((spot) => ({
    asset_id: PRESET_ROCK,
    x: spot.x,
    y: spot.y,
    elevation: 1,
    rotation: 0,
  }));
  return {
    id: "water-rapids",
    name: "Rapids",
    description: "A fast, turbulent river channel — mostly difficult water rushing south around scattered boulders.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

// ─── Stone (3): dungeon/cavern chambers built from stone/rock ────────────

/** A worked stone chamber where four corridors meet — a door on every side,
 * a worn slab at the crossing's center, and two flanking pillars. */
function stoneCorridorJunctionTemplate(): MapTemplate {
  const width = 10;
  const height = 10;
  const doors = [
    { x: 5, y: 0 },
    { x: 5, y: 9 },
    { x: 0, y: 5 },
    { x: 9, y: 5 },
  ];
  const { cells: wallCells, objects: wallObjects } = multiDoorRoom(width, height, doors, "stone");
  const floor = paintedGrid(width, height, { ground_type: "stone" }, [...rect(4, 4, 5, 5, { ground_type: "rock" })]);
  const pillarSpots = [
    { x: 3, y: 3 },
    { x: 6, y: 6 },
  ];
  const pillarCells: NewMapCell[] = [];
  const pillarObjects: NewMapObjectSeed[] = [];
  for (const spot of pillarSpots) {
    pillarCells.push({ x: spot.x, y: spot.y, elevation: WALL_ELEVATION, terrain_type: "normal", ground_type: "stone" });
    pillarObjects.push({ asset_id: PRESET_WALL, x: spot.x, y: spot.y, elevation: WALL_ELEVATION, rotation: 0 });
  }
  const cells = mergeCells(floor, wallCells, pillarCells);
  return {
    id: "stone-corridor-junction",
    name: "Stone Corridor Junction",
    description: "A worked stone chamber where four corridors meet, doors on all sides and pillars flanking the crossing.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [...wallObjects, ...pillarObjects],
  };
}

/** A natural rock cavern with a flatter worked patch at its heart and
 * rubble mounding near the walls — walledRoom's single-door shape, reused
 * as-is, with a rock/stone floor filled in underneath it. */
function cavernChamberTemplate(): MapTemplate {
  const width = 12;
  const height = 10;
  const { cells: wallCells, objects: wallObjects } = walledRoom(width, height, { x: 6, y: 9 });
  const floor = paintedGrid(width, height, { ground_type: "rock" }, [...rect(4, 3, 7, 6, { ground_type: "stone" })]);
  const mounds = [
    { x: 2, y: 2 },
    { x: 9, y: 3 },
    { x: 3, y: 7 },
  ];
  for (const { x, y } of mounds) {
    const cell = floor.find((c) => c.x === x && c.y === y);
    if (cell) cell.elevation = 1;
  }
  const cells = mergeCells(floor, wallCells);
  return {
    id: "stone-cavern-chamber",
    name: "Cavern Chamber",
    description: "A natural rock cavern with a flatter worked patch at its heart and rubble mounding near the walls.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [...wallObjects, { asset_id: PRESET_ROCK, x: 2, y: 2, elevation: 1, rotation: 0 }],
  };
}

/** A large pillared stone vault, one corner collapsed into difficult-terrain
 * rubble — the biggest and most "built" of the three stone templates. */
function sunkenVaultTemplate(): MapTemplate {
  const width = 14;
  const height = 12;
  const { cells: wallCells, objects: wallObjects } = walledRoom(width, height, { x: 7, y: 11 });
  const floor = paintedGrid(width, height, { ground_type: "stone" }, [
    ...rect(2, 8, 4, 9, { ground_type: "rock", terrain_type: "difficult" }),
  ]);
  const pillarSpots = [
    { x: 3, y: 3 },
    { x: 6, y: 3 },
    { x: 10, y: 3 },
    { x: 3, y: 8 },
    { x: 6, y: 8 },
    { x: 10, y: 8 },
  ];
  const pillarCells: NewMapCell[] = [];
  const pillarObjects: NewMapObjectSeed[] = [];
  for (const spot of pillarSpots) {
    pillarCells.push({ x: spot.x, y: spot.y, elevation: WALL_ELEVATION, terrain_type: "normal", ground_type: "stone" });
    pillarObjects.push({ asset_id: PRESET_WALL, x: spot.x, y: spot.y, elevation: WALL_ELEVATION, rotation: 0 });
  }
  const cells = mergeCells(floor, wallCells, pillarCells);
  return {
    id: "stone-sunken-vault",
    name: "Sunken Vault",
    description: "A large stone vault lined with support pillars, one corner collapsed into treacherous rubble.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [...wallObjects, ...pillarObjects],
  };
}

// ─── Swamp (3): swamp mixed with water, uneven elevation, murky/bog feel ─

/** A wide bog dotted with stagnant pools and several difficult, boggy
 * patches — pre-painted difficult terrain so the DM doesn't have to, per
 * the SRD-flavored "swamp is hard to traverse" convention. */
function murkyBogTemplate(): MapTemplate {
  const width = 14;
  const height = 10;
  const overrides: CellOverride[] = [
    ...rect(3, 2, 4, 3, { ground_type: "water" }),
    ...rect(9, 6, 10, 7, { ground_type: "water" }),
    ...rect(6, 4, 6, 5, { ground_type: "water" }),
    ...rect(1, 5, 2, 6, { terrain_type: "difficult" }),
    ...rect(10, 1, 12, 2, { terrain_type: "difficult" }),
    ...rect(6, 7, 8, 8, { terrain_type: "difficult" }),
  ];
  const hummocks = [
    { x: 2, y: 2 },
    { x: 11, y: 5 },
    { x: 5, y: 8 },
    { x: 12, y: 8 },
  ];
  for (const hummock of hummocks) overrides.push({ x: hummock.x, y: hummock.y, elevation: 1 });
  const cells = paintedGrid(width, height, { ground_type: "swamp" }, overrides);
  return {
    id: "swamp-murky-bog",
    name: "Murky Bog",
    description: "A wide bog dotted with stagnant pools; soft ground bogs down movement in several patches.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [],
  };
}

/** A mire that's difficult terrain almost everywhere, with a single winding
 * line of firmer, raised hummocks as the only easy way through. */
function fetidMireTemplate(): MapTemplate {
  const width = 12;
  const height = 12;
  const waterPools: CellOverride[] = [
    ...rect(1, 1, 3, 3, { ground_type: "water" }),
    ...rect(7, 8, 9, 10, { ground_type: "water" }),
    ...rect(8, 2, 9, 3, { ground_type: "water" }),
  ];
  const hummockPath = [
    { x: 1, y: 6 },
    { x: 2, y: 6 },
    { x: 3, y: 7 },
    { x: 4, y: 7 },
    { x: 5, y: 6 },
    { x: 6, y: 6 },
    { x: 7, y: 5 },
    { x: 8, y: 5 },
    { x: 9, y: 6 },
    { x: 10, y: 6 },
  ];
  const overrides: CellOverride[] = [...waterPools];
  for (const step of hummockPath) {
    overrides.push({ x: step.x, y: step.y, ground_type: "swamp", terrain_type: "normal", elevation: 1 });
  }
  const cells = paintedGrid(width, height, { ground_type: "swamp", terrain_type: "difficult" }, overrides);
  return {
    id: "swamp-fetid-mire",
    name: "Fetid Mire",
    description: "A stagnant mire choked with difficult bog and pools — a single line of firm hummocks offers the only easy crossing.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [],
  };
}

/** A vast waterlogged marsh — mostly difficult, water-heavy ground with only
 * a handful of firmer rises to stand on. The most water-dominant, and the
 * hardest to cross, of the three swamp templates. */
function sunkenMarshTemplate(): MapTemplate {
  const width = 16;
  const height = 10;
  const cells = paintedGrid(width, height, { ground_type: "swamp", terrain_type: "difficult" }, [
    ...rect(0, 0, width - 1, 1, { ground_type: "water", terrain_type: "difficult" }),
    ...rect(5, 4, 10, 6, { ground_type: "water", terrain_type: "difficult" }),
    ...rect(0, 8, width - 1, 9, { ground_type: "water", terrain_type: "difficult" }),
    { x: 2, y: 3, ground_type: "swamp", terrain_type: "normal", elevation: 1 },
    { x: 13, y: 3, ground_type: "swamp", terrain_type: "normal", elevation: 1 },
    { x: 7, y: 7, ground_type: "swamp", terrain_type: "normal", elevation: 1 },
    { x: 12, y: 6, ground_type: "swamp", terrain_type: "normal", elevation: 1 },
  ]);
  return {
    id: "swamp-sunken-marsh",
    name: "Sunken Marsh",
    description: "A vast waterlogged marsh — nearly all of it difficult going, with only a few firmer rises to stand on.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [],
  };
}

// ─── Town (3): a structured settlement — streets, plazas, building outlines ─

/** Four shopfronts (building outlines, not one enclosing room) face a paved
 * central plaza across a web of streets, closest in spirit to walledRoom
 * but reimagined as several small structures instead of one. */
function marketSquareTemplate(): MapTemplate {
  const width = 16;
  const height = 14;
  const doorSouth = { x: 2, y: 3 };
  const doorNorth = { x: 2, y: 0 };
  const buildings = [
    buildingOutline(1, 1, 4, 4, doorSouth),
    buildingOutline(11, 1, 4, 4, doorSouth),
    buildingOutline(1, 9, 4, 4, doorNorth),
    buildingOutline(11, 9, 4, 4, doorNorth),
  ];
  const ground = paintedGrid(width, height, { ground_type: "path" }, [
    ...rect(6, 5, 9, 8, { ground_type: "stone" }),
    ...rect(2, 2, 3, 3, { ground_type: "default" }),
    ...rect(12, 2, 13, 3, { ground_type: "default" }),
    ...rect(2, 10, 3, 11, { ground_type: "default" }),
    ...rect(12, 10, 13, 11, { ground_type: "default" }),
  ]);
  const cells = mergeCells(ground, ...buildings.map((building) => building.cells));
  const objects: NewMapObjectSeed[] = [
    ...buildings.flatMap((building) => building.objects),
    { asset_id: PRESET_TABLE, x: 7, y: 6, elevation: 0, rotation: 0 },
    { asset_id: PRESET_TABLE, x: 8, y: 7, elevation: 0, rotation: 0 },
  ];
  return {
    id: "town-market-square",
    name: "Market Square",
    description: "Four shopfronts face a paved central plaza across a web of streets — ready for stalls and townsfolk.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** A handful of houses cluster where two dirt roads cross, grassy commons
 * filling the gaps — smaller and less paved than the Market Square, a rural
 * hamlet rather than a town square. */
function crossroadsHamletTemplate(): MapTemplate {
  const width = 14;
  const height = 12;
  const buildings = [
    buildingOutline(1, 1, 4, 4, { x: 2, y: 3 }),
    buildingOutline(9, 1, 4, 4, { x: 1, y: 3 }),
    buildingOutline(1, 7, 4, 4, { x: 2, y: 0 }),
  ];
  const ground = paintedGrid(width, height, { ground_type: "grass" }, [
    ...rect(0, 5, width - 1, 6, { ground_type: "path" }),
    ...rect(6, 0, 7, height - 1, { ground_type: "path" }),
  ]);
  const cells = mergeCells(ground, ...buildings.map((building) => building.cells));
  const objects: NewMapObjectSeed[] = [
    ...buildings.flatMap((building) => building.objects),
    { asset_id: PRESET_TORCH, x: 6, y: 5, elevation: 0, rotation: 0 },
  ];
  return {
    id: "town-crossroads-hamlet",
    name: "Crossroads Hamlet",
    description: "A handful of houses cluster where two dirt roads cross, grassy commons filling the gaps between them.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** Three small shopfronts share one side of a paved street — a single
 * linear block, the most "just streets and doors" of the three town
 * templates. */
function tradesmansRowTemplate(): MapTemplate {
  const width = 16;
  const height = 8;
  const doorSouth = { x: 1, y: 3 };
  const buildings = [
    buildingOutline(1, 0, 4, 4, doorSouth),
    buildingOutline(6, 0, 4, 4, doorSouth),
    buildingOutline(11, 0, 4, 4, doorSouth),
  ];
  const ground = paintedGrid(width, height, { ground_type: "stone" }, [
    ...rect(0, 4, width - 1, 5, { ground_type: "path" }),
    ...rect(0, 6, width - 1, 7, { ground_type: "stone" }),
  ]);
  const cells = mergeCells(ground, ...buildings.map((building) => building.cells));
  const objects: NewMapObjectSeed[] = [
    ...buildings.flatMap((building) => building.objects),
    { asset_id: PRESET_TORCH, x: 4, y: 4, elevation: 0, rotation: 0 },
    { asset_id: PRESET_TORCH, x: 13, y: 4, elevation: 0, rotation: 0 },
  ];
  return {
    id: "town-tradesmans-row",
    name: "Tradesman's Row",
    description: "Three small shopfronts share one side of a paved street, doors opening onto the lane.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
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
  // Forest
  forestClearingTemplate(),
  treelineAmbushTemplate(),
  forestHollowTemplate(),
  // Sand + water
  tidalShallowsTemplate(),
  sandbarCrossingTemplate(),
  coveInletTemplate(),
  // Water-only
  riverBendTemplate(),
  lakeCrossingTemplate(),
  rapidsTemplate(),
  // Stone
  stoneCorridorJunctionTemplate(),
  cavernChamberTemplate(),
  sunkenVaultTemplate(),
  // Swamp
  murkyBogTemplate(),
  fetidMireTemplate(),
  sunkenMarshTemplate(),
  // Town
  marketSquareTemplate(),
  crossroadsHamletTemplate(),
  tradesmansRowTemplate(),
];
