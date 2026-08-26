import type { GroundType, NewMapCell, NewMapObjectSeed, WaterFlowDirection } from "@/data-access";
import type { TerrainType } from "@/rules-engine";

// The built-in preset assets seeded by 0016_asset_library_presets.sql —
// fixed global UUIDs, present in every campaign's palette. Templates may
// reference ONLY these (a custom asset id would be campaign-specific).
export const PRESET_TORCH = "a55e7001-0000-4000-8000-000000000001";
// Chest (0016) — the reward object the treasure-room templates below stage
// (on a plinth, behind a guarded chokepoint, or in a sunken recess). Not
// referenced by any P11 template, but a real seeded preset all along.
export const PRESET_CHEST = "a55e7002-0000-4000-8000-000000000002";
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
// Door-in-wall fix: a wall segment with an actual doorway cut into its own
// mass (generate-wall-variants-presets.mjs's buildWallDoor) — replaces
// PRESET_WALL (or PRESET_WALL_CORNER) at a door cell, INSTEAD of a
// standalone PRESET_DOOR prop placed on an otherwise-plain ground-level
// gap next to intact wall cells. Root cause (confirmed by inspecting
// buildDoor() in generate-map-presets.mjs before changing anything):
// PRESET_DOOR is a genuinely free-standing door frame with NO wall mass of
// its own around it at all, and every template placed it at ground
// elevation while its neighbors sat a full WALL_ELEVATION step higher — so
// it always read as a floating frame standing in a sunken gap between two
// cliffs, never as a doorway cut into a continuous wall, regardless of
// where it was placed. PRESET_DOOR itself is UNCHANGED and still seeded
// (kept available in the palette for a free-standing/interior door not set
// into a raised perimeter wall) — it's just no longer what any of the 21
// built-in templates place at a wall-perimeter door cell.
export const PRESET_WALL_DOOR = "a55e7012-0000-4000-8000-000000000012";

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
 *
 * Door-in-wall fix: does a NEIGHBOR of a door cell need special handling
 * here, now that the door cell renders PRESET_WALL_DOOR instead of
 * PRESET_WALL? Checked, not assumed — `isWall` (both callers below) is a
 * PURE PERIMETER/POSITION predicate that already has no idea which asset
 * ends up at a given cell; a door cell is still `isWall(x, y) === true` to
 * its neighbors exactly as it was before this fix, so a wall cell next to
 * a door is classified identically either way. What DOES need to change at
 * the door cell ITSELF is its own rotation: walledRoom below used to
 * hardcode a door's rotation to 0 regardless of which edge it sat on
 * (harmless for the old free-standing, roughly rotation-agnostic
 * PRESET_DOOR, but wrong for PRESET_WALL_DOOR, which — like PRESET_WALL —
 * must run its own length along the wall line to connect flush with its
 * neighbors) — so walledRoom now applies this function's own computed
 * `rotation` to the door cell too, the same as every other perimeter cell.
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
 * a Wall Corner at each of the room's 4 real 90° turns) on each, and one
 * Wall Doorway cell (PRESET_WALL_DOOR) as the entrance — a wall segment
 * with its own walkable doorway cut into it, at the SAME WALL_ELEVATION as
 * every other perimeter cell (door-in-wall fix: previously ground-level,
 * one full elevation step below its neighbors, which is what made even a
 * wall-shaped piece here read as sunken/disconnected rather than set into
 * the wall line — see PRESET_WALL_DOOR's own doc comment). Movement is
 * unaffected in kind, only in degree: entering ANY raised perimeter cell
 * already cost the SRD's climbing surcharge before this fix (walls have no
 * collision/blocking behavior in this app — confirmed in movement.ts,
 * see this task's own notes — a token could always climb onto one); the
 * door cell now simply pays that SAME existing rule instead of being
 * arbitrarily exempted from it, rather than gaining any new mechanic. */
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
      cells.push({ x, y, elevation: WALL_ELEVATION, terrain_type: "normal" });
      const placement = classifyWallCell(x, y, isWall);
      objects.push({
        asset_id: isDoor ? PRESET_WALL_DOOR : placement.assetId,
        x,
        y,
        elevation: WALL_ELEVATION,
        rotation: placement.rotation,
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
 * door — a Wall Doorway cell (PRESET_WALL_DOOR) at the SAME WALL_ELEVATION
 * as the rest of the structure's perimeter, matching walledRoom's own
 * door-in-wall fix (see PRESET_WALL_DOOR's doc comment). Lets the
 * town/stone themes place several distinct structures on one map instead
 * of one room filling it — same isPerimeter/wallRotation this file already
 * uses for walledRoom, just parameterized by a local origin. wallRotation
 * (not classifyWallCell) is deliberately unchanged here — every door this
 * file places via buildingOutline sits mid-edge, never at an actual 90°
 * turn, and wallRotation already gives a mid-edge door cell the SAME
 * edge-relative rotation a straight wall cell there would get (confirmed
 * across every buildingOutline call site below), which is exactly what a
 * full-cell-width PRESET_WALL_DOOR needs to connect flush with its
 * neighbors. Wall cells are ground_type 'stone' (construction, not
 * terrain) regardless of the theme around them. */
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
      cells.push({ x, y, elevation: WALL_ELEVATION, terrain_type: "normal", ground_type: "stone" });
      objects.push({
        asset_id: isDoor ? PRESET_WALL_DOOR : PRESET_WALL,
        x,
        y,
        elevation: WALL_ELEVATION,
        rotation: wallRotation(lx, ly, width, height),
      });
    }
  }
  return { cells, objects };
}

/** A rectangular room with SEVERAL doors instead of walledRoom's one — used
 * once, for the stone theme's four-way corridor junction chamber. Same
 * door-in-wall treatment as buildingOutline above: each door is a Wall
 * Doorway cell at the room's own WALL_ELEVATION, not a ground-level gap. */
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
      cells.push({ x, y, elevation: WALL_ELEVATION, terrain_type: "normal", ground_type: groundType });
      objects.push({
        asset_id: isDoor ? PRESET_WALL_DOOR : PRESET_WALL,
        x,
        y,
        elevation: WALL_ELEVATION,
        rotation: wallRotation(x, y, width, height),
      });
    }
  }
  return { cells, objects };
}

/** Looks up a cell's elevation by coordinate — used when placing foliage or
 * other props onto terrain painted earlier in the same function, so an
 * object's elevation always matches its cell's real elevation (the
 * invariant templates.test.ts enforces) without re-deriving the terrain
 * rule (which ring, which band, which raised dais) by hand again at every
 * placement site. Falls back to 0 for a coordinate with no painted cell —
 * shouldn't happen for anything paintedGrid produced, since it fills every
 * cell in its own rectangle. */
function elevationAt(cells: NewMapCell[], x: number, y: number): number {
  return cells.find((cell) => cell.x === x && cell.y === y)?.elevation ?? 0;
}

/** Evenly-spaced points along a rectangle's own outer edge (all 4 sides),
 * skipping the corners — a deterministic scatter for a treeline/rockline
 * that rings a whole map, so an enlarged template's perimeter reads as
 * genuinely populated (many trunks) rather than the same handful of
 * corner-only props stretched across more space. `step` controls density;
 * `inset` shifts the ring inward (0 = the map's own true edge cells). By
 * construction (each side's loop starts one `step` past the shared corner)
 * no two returned points ever coincide. */
function perimeterSpots(width: number, height: number, inset: number, step: number): Array<{ x: number; y: number }> {
  const spots: Array<{ x: number; y: number }> = [];
  const x0 = inset;
  const x1 = width - 1 - inset;
  const y0 = inset;
  const y1 = height - 1 - inset;
  for (let x = x0 + step; x < x1; x += step) {
    spots.push({ x, y: y0 });
    spots.push({ x, y: y1 });
  }
  for (let y = y0 + step; y < y1; y += step) {
    spots.push({ x: x0, y });
    spots.push({ x: x1, y });
  }
  return spots;
}

/** Evenly-spaced points along a single horizontal run [x0, x1] at a fixed
 * row — for a treeline/rockline that runs along ONE edge of the map, a
 * shape perimeterSpots' all-4-sides ring doesn't fit. */
function rowSpots(x0: number, x1: number, y: number, step: number): Array<{ x: number; y: number }> {
  const spots: Array<{ x: number; y: number }> = [];
  for (let x = x0; x <= x1; x += step) spots.push({ x, y });
  return spots;
}

// ─── Forest (3): forest / dense_forest / grass, varied elevation, no water ──
//
// Enlarged from P11's original 12x10/14x10 footprints and given a genuinely
// populated treeline (perimeterSpots/rowSpots scatter many trunks across the
// wider ring/band, rather than the same 3-4 corner trees stretched across
// more space) per the project owner's "make the outdoor ones larger and add
// foliage" request.

/** A grass clearing ringed by a forest band and a dense outer treeline —
 * concentric rings by distance to the map edge, raised slightly at the rim
 * so the treeline reads as higher ground around a sunken-feeling clearing. */
function forestClearingTemplate(): MapTemplate {
  const width = 18;
  const height = 14;
  const cells: NewMapCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = Math.min(x, y, width - 1 - x, height - 1 - y);
      const ground_type: GroundType = edge === 0 ? "dense_forest" : edge === 1 ? "forest" : "grass";
      const elevation = edge <= 1 ? 1 : 0;
      cells.push({ x, y, elevation, terrain_type: "normal", ground_type });
    }
  }
  // Gentle mounds scattered across the wider clearing floor, so the open
  // ground doesn't read as perfectly flat even far from the treeline.
  for (const { x, y } of [
    { x: 5, y: 5 },
    { x: 12, y: 5 },
    { x: 8, y: 8 },
    { x: 13, y: 9 },
    { x: 5, y: 9 },
    { x: 9, y: 4 },
  ]) {
    const cell = cells.find((c) => c.x === x && c.y === y);
    if (cell) cell.elevation = 1;
  }
  // A dense ring of trees around the WHOLE outer treeline (not just 4
  // corners) — the enlarged clearing needs a genuinely populated border —
  // plus a few rocks accenting the inner forest band.
  const treeSpots = perimeterSpots(width, height, 0, 3);
  const rockSpots = [
    { x: 1, y: 4 },
    { x: width - 2, y: 9 },
    { x: 4, y: height - 2 },
  ];
  const objects: NewMapObjectSeed[] = [
    ...treeSpots.map((spot) => ({
      asset_id: PRESET_TREE,
      x: spot.x,
      y: spot.y,
      elevation: elevationAt(cells, spot.x, spot.y),
      rotation: 0,
    })),
    ...rockSpots.map((spot) => ({
      asset_id: PRESET_ROCK,
      x: spot.x,
      y: spot.y,
      elevation: elevationAt(cells, spot.x, spot.y),
      rotation: 0,
    })),
  ];
  return {
    id: "forest-clearing",
    name: "Woodland Clearing",
    description: "A sunlit grass clearing ringed by forest, with a dense outer treeline thick with trees.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** An open grass field running up to a raised, dense treeline along the
 * north edge — cover for an ambush, per the DM's own framing. */
function treelineAmbushTemplate(): MapTemplate {
  const width = 20;
  const height = 14;
  const cells = paintedGrid(width, height, { ground_type: "grass" }, [
    ...rect(0, 0, width - 1, 1, { ground_type: "dense_forest", elevation: 2 }),
    ...rect(0, 2, width - 1, 3, { ground_type: "forest", elevation: 1 }),
  ]);
  // Low grassy rises scattered through the now-larger open field, well away
  // from the treeline.
  for (const { x, y } of [
    { x: 3, y: 9 },
    { x: 15, y: 11 },
    { x: 8, y: 8 },
    { x: 12, y: 6 },
    { x: 5, y: 12 },
    { x: 17, y: 7 },
  ]) {
    const cell = cells.find((c) => c.x === x && c.y === y);
    if (cell) cell.elevation = 1;
  }
  // A genuinely thick treeline — two staggered rows of trunks across the
  // whole dense_forest band, not the same 3 trees stretched across a wider
  // edge — plus a couple of rocks out in the open field as scattered cover.
  const frontRow = rowSpots(1, width - 2, 0, 3);
  const backRow = rowSpots(2, width - 2, 1, 3);
  const rockSpots = [
    { x: 9, y: 9 },
    { x: 14, y: 5 },
  ];
  const objects: NewMapObjectSeed[] = [
    ...frontRow.map((spot) => ({
      asset_id: PRESET_TREE,
      x: spot.x,
      y: spot.y,
      elevation: elevationAt(cells, spot.x, spot.y),
      rotation: 0,
    })),
    ...backRow.map((spot) => ({
      asset_id: PRESET_TREE,
      x: spot.x,
      y: spot.y,
      elevation: elevationAt(cells, spot.x, spot.y),
      rotation: 0,
    })),
    ...rockSpots.map((spot) => ({
      asset_id: PRESET_ROCK,
      x: spot.x,
      y: spot.y,
      elevation: elevationAt(cells, spot.x, spot.y),
      rotation: 0,
    })),
  ];
  return {
    id: "forest-treeline-ambush",
    name: "Treeline Ambush",
    description:
      "An open grass field runs up to a raised, dense treeline thick with trees along one edge — cover for an ambush.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** Deep dense woods sloping down (via Chebyshev distance) into a sheltered
 * grass hollow tucked off-center — a different composition from the
 * clearing's centered rings and the ambush's half-split field. */
function forestHollowTemplate(): MapTemplate {
  const width = 18;
  const height = 14;
  const hollow = { x: 13, y: 10 };
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
  // A genuinely thick outer treeline (the densest of the three forest
  // templates, per its own "deep dense woods" framing) — a tight ring of
  // trunks around almost the whole map, since the dense_forest band alone
  // now covers most of the enlarged grid — plus one accent rock tucked into
  // the sheltered hollow itself.
  const treeSpots = perimeterSpots(width, height, 0, 2);
  const objects: NewMapObjectSeed[] = [
    ...treeSpots.map((spot) => ({
      asset_id: PRESET_TREE,
      x: spot.x,
      y: spot.y,
      elevation: elevationAt(cells, spot.x, spot.y),
      rotation: 0,
    })),
    { asset_id: PRESET_ROCK, x: hollow.x - 1, y: hollow.y, elevation: elevationAt(cells, hollow.x - 1, hollow.y), rotation: 0 },
  ];
  return {
    id: "forest-hollow",
    name: "Forest Hollow",
    description: "Deep, densely wooded terrain slopes down into a sheltered grass hollow tucked in one corner.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

// ─── Sand + water (3): a coastal/beach mix ───────────────────────────────
//
// Enlarged from P11's 12x10/14x10 footprints, with more dune/reef foliage
// (dune trees, offshore rocks) so the wider coastline reads as populated.

/** A calm sandy beach meeting shallow open water — a scenic coastline, no
 * crossing hazard intended (the shallows are normal terrain throughout). */
function tidalShallowsTemplate(): MapTemplate {
  const width = 20;
  const height = 14;
  const dunes = [
    { x: 3, y: 1 },
    { x: 10, y: 2 },
    { x: 16, y: 1 },
    { x: 6, y: 3 },
  ];
  const rockSpots = [
    { x: 7, y: 6 },
    { x: 13, y: 8 },
    { x: 17, y: 10 },
    { x: 4, y: 9 },
  ];
  const overrides: CellOverride[] = [
    ...rect(0, 0, width - 1, 4, { ground_type: "sand" }),
    ...dunes.map((dune) => ({ x: dune.x, y: dune.y, ground_type: "sand" as GroundType, elevation: 1 })),
    ...rockSpots.map((spot) => ({ x: spot.x, y: spot.y, ground_type: "rock" as GroundType })),
  ];
  const cells = paintedGrid(width, height, { ground_type: "water" }, overrides);
  const objects: NewMapObjectSeed[] = [
    ...rockSpots.map((spot) => ({
      asset_id: PRESET_ROCK,
      x: spot.x,
      y: spot.y,
      elevation: elevationAt(cells, spot.x, spot.y),
      rotation: 0,
    })),
    { asset_id: PRESET_TREE, x: dunes[0].x, y: dunes[0].y, elevation: elevationAt(cells, dunes[0].x, dunes[0].y), rotation: 0 },
    { asset_id: PRESET_TREE, x: dunes[2].x, y: dunes[2].y, elevation: elevationAt(cells, dunes[2].x, dunes[2].y), rotation: 0 },
  ];
  return {
    id: "coast-tidal-shallows",
    name: "Tidal Shallows",
    description:
      "A gentle sandy beach lined with dune trees gives way to calm shallow water, with rocks breaking the surface offshore.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** Two sandy banks split by a deep tidal channel (difficult terrain — an
 * actual crossing challenge) except for a narrow two-cell exposed sandbar:
 * the bridge-free crossing point, since Prompt 8's bridges may not exist
 * yet. */
function sandbarCrossingTemplate(): MapTemplate {
  const width = 20;
  const height = 14;
  const dunes = [
    { x: 2, y: 1 },
    { x: 15, y: 10 },
    { x: 4, y: 11 },
    { x: 17, y: 2 },
  ];
  const cells = paintedGrid(width, height, { ground_type: "sand" }, [
    ...rect(0, 4, width - 1, 5, { ground_type: "water", terrain_type: "difficult" }),
    ...rect(6, 4, 7, 5, { ground_type: "sand", terrain_type: "normal" }),
    ...dunes.map((dune) => ({ x: dune.x, y: dune.y, elevation: 1 })),
    { x: 6, y: 3, ground_type: "rock" as GroundType },
    { x: 7, y: 6, ground_type: "rock" as GroundType },
  ]);
  const objects: NewMapObjectSeed[] = [
    ...dunes.map((dune) => ({
      asset_id: PRESET_TREE,
      x: dune.x,
      y: dune.y,
      elevation: elevationAt(cells, dune.x, dune.y),
      rotation: 0,
    })),
    { asset_id: PRESET_ROCK, x: 6, y: 3, elevation: elevationAt(cells, 6, 3), rotation: 0 },
    { asset_id: PRESET_ROCK, x: 7, y: 6, elevation: elevationAt(cells, 7, 6), rotation: 0 },
  ];
  return {
    id: "coast-sandbar-crossing",
    name: "Sandbar Crossing",
    description:
      "Two tree-dotted sandy banks are split by a deep tidal channel — a narrow exposed sandbar is the only dry way across.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** A curved sandy cove wrapping a quiet water inlet, with a rocky point at
 * its mouth — per-row water-start columns table a symmetric curve inward
 * around the vertical center rather than straight coastal bands. */
function coveInletTemplate(): MapTemplate {
  const width = 18;
  const height = 14;
  const waterStart = [18, 14, 11, 9, 7, 6, 5, 5, 6, 7, 9, 11, 14, 18];
  const cells: NewMapCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ground_type: GroundType = x >= waterStart[y] ? "water" : "sand";
      cells.push({ x, y, elevation: 0, terrain_type: "normal", ground_type });
    }
  }
  for (const y of [6, 7]) {
    const point = cells.find((c) => c.x === width - 1 && c.y === y);
    if (point) point.ground_type = "rock";
  }
  const dunes = [
    { x: 1, y: 1 },
    { x: 2, y: 12 },
    { x: 3, y: 3 },
    { x: 2, y: 10 },
  ];
  for (const dune of dunes) {
    const cell = cells.find((c) => c.x === dune.x && c.y === dune.y);
    if (cell) cell.elevation = 1;
  }
  const rockSpots = [
    { x: 6, y: 0 },
    { x: 8, y: 13 },
  ];
  for (const spot of rockSpots) {
    const cell = cells.find((c) => c.x === spot.x && c.y === spot.y);
    if (cell) cell.ground_type = "rock";
  }
  const objects: NewMapObjectSeed[] = [
    { asset_id: PRESET_ROCK, x: width - 1, y: 6, elevation: elevationAt(cells, width - 1, 6), rotation: 0 },
    ...rockSpots.map((spot) => ({
      asset_id: PRESET_ROCK,
      x: spot.x,
      y: spot.y,
      elevation: elevationAt(cells, spot.x, spot.y),
      rotation: 0,
    })),
    ...dunes.map((dune) => ({
      asset_id: PRESET_TREE,
      x: dune.x,
      y: dune.y,
      elevation: elevationAt(cells, dune.x, dune.y),
      rotation: 0,
    })),
  ];
  return {
    id: "coast-cove-inlet",
    name: "Cove Inlet",
    description: "A curved, tree-dotted sandy cove wraps around a quiet water inlet, with a rocky point at its mouth.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

// ─── Water-only (3): a lake or river feel ────────────────────────────────
//
// Enlarged from P11's 10x14/12x12/14x10 footprints, with more tree/rock
// islands so the wider water reads as populated rather than emptier.

/** A wide river bending from an east flow to a south flow, small islands
 * scattered near the bend, and a couple of eddy accents (opposite-direction
 * flow cells) near the inside of the turn for visual variety. */
function riverBendTemplate(): MapTemplate {
  const width = 20;
  const height = 14;
  const islands: Array<{ x: number; y: number; ground_type: GroundType }> = [
    { x: 3, y: 3, ground_type: "sand" },
    { x: 5, y: 9, ground_type: "grass" },
    { x: 9, y: 4, ground_type: "rock" },
    { x: 8, y: 10, ground_type: "sand" },
    { x: 13, y: 3, ground_type: "rock" },
    { x: 15, y: 9, ground_type: "grass" },
    { x: 17, y: 5, ground_type: "sand" },
  ];
  const extraRocks = [
    { x: 6, y: 7 },
    { x: 14, y: 7 },
  ];
  const overrides: CellOverride[] = [
    ...rect(0, 0, 10, height - 1, { water_flow_direction: "east" }),
    ...rect(11, 0, width - 1, height - 1, { water_flow_direction: "south" }),
    { x: 10, y: 2, water_flow_direction: "north" },
    { x: 11, y: 11, water_flow_direction: "west" },
    ...extraRocks.map((spot) => ({ x: spot.x, y: spot.y, ground_type: "rock" as GroundType })),
  ];
  for (const island of islands) {
    overrides.push({ x: island.x, y: island.y, ground_type: island.ground_type, elevation: 1, water_flow_direction: null });
  }
  const cells = paintedGrid(width, height, { ground_type: "water" }, overrides);
  const objects: NewMapObjectSeed[] = [
    ...islands
      .filter((island) => island.ground_type === "rock" || island.ground_type === "grass")
      .map((island) => ({
        asset_id: island.ground_type === "rock" ? PRESET_ROCK : PRESET_TREE,
        x: island.x,
        y: island.y,
        elevation: elevationAt(cells, island.x, island.y),
        rotation: 0,
      })),
    ...extraRocks.map((spot) => ({
      asset_id: PRESET_ROCK,
      x: spot.x,
      y: spot.y,
      elevation: elevationAt(cells, spot.x, spot.y),
      rotation: 0,
    })),
  ];
  return {
    id: "water-river-bend",
    name: "River Bend",
    description:
      "A wide river bends from flowing east to flowing south, with a scatter of small tree- and rock-studded islands mid-current.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** An open lake, mostly still, with a visible feeder stream entering one
 * corner and an outflow draining the opposite one, plus a line of small
 * islands strung across it as natural stepping stones for a crossing. */
function lakeCrossingTemplate(): MapTemplate {
  const width = 18;
  const height = 16;
  const islands: Array<{ x: number; y: number; ground_type: GroundType }> = [
    { x: 2, y: 2, ground_type: "grass" },
    { x: 4, y: 4, ground_type: "sand" },
    { x: 6, y: 6, ground_type: "rock" },
    { x: 8, y: 8, ground_type: "sand" },
    { x: 10, y: 9, ground_type: "grass" },
    { x: 12, y: 10, ground_type: "rock" },
    { x: 14, y: 12, ground_type: "sand" },
    { x: 15, y: 14, ground_type: "grass" },
  ];
  const overrides: CellOverride[] = [
    ...rect(0, 0, 2, 2, { water_flow_direction: "east" }),
    ...rect(width - 3, height - 3, width - 1, height - 1, { water_flow_direction: "south" }),
  ];
  for (const island of islands) {
    overrides.push({ x: island.x, y: island.y, ground_type: island.ground_type, elevation: 1, water_flow_direction: null });
  }
  const cells = paintedGrid(width, height, { ground_type: "water" }, overrides);
  const objects: NewMapObjectSeed[] = islands
    .filter((island) => island.ground_type !== "sand")
    .map((island) => ({
      asset_id: island.ground_type === "rock" ? PRESET_ROCK : PRESET_TREE,
      x: island.x,
      y: island.y,
      elevation: elevationAt(cells, island.x, island.y),
      rotation: 0,
    }));
  return {
    id: "water-lake-crossing",
    name: "Lake Crossing",
    description:
      "An open lake with a long line of small tree- and rock-topped islands strung across it — natural stepping stones for a crossing.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** A fast, mostly-difficult river channel flowing south, boulders breaking
 * the current, and a calmer entry pool before the rapids begin in earnest. */
function rapidsTemplate(): MapTemplate {
  const width = 14;
  const height = 20;
  const boulderSpots = [
    { x: 2, y: 3 },
    { x: 9, y: 4 },
    { x: 5, y: 6 },
    { x: 11, y: 8 },
    { x: 3, y: 10 },
    { x: 8, y: 12 },
    { x: 2, y: 15 },
    { x: 10, y: 16 },
    { x: 5, y: 18 },
  ];
  const overrides: CellOverride[] = [...rect(0, 0, width - 1, 1, { terrain_type: "normal" })];
  overrides.push({ x: 6, y: 6, water_flow_direction: "east" });
  overrides.push({ x: 9, y: 13, water_flow_direction: "west" });
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
//
// Enlarged from P11's 12x12/14x10/16x10 footprints. These 3 previously
// carried zero objects at all — the enlargement adds gnarled trees on the
// firmer hummocks/rises and a few rocks in the shallows, so "add foliage"
// applies here too, not just to forest/coast/water.

/** A wide bog dotted with stagnant pools and several difficult, boggy
 * patches — pre-painted difficult terrain so the DM doesn't have to, per
 * the SRD-flavored "swamp is hard to traverse" convention. */
function murkyBogTemplate(): MapTemplate {
  const width = 20;
  const height = 14;
  const overrides: CellOverride[] = [
    ...rect(3, 2, 4, 3, { ground_type: "water" }),
    ...rect(14, 8, 15, 9, { ground_type: "water" }),
    ...rect(9, 5, 9, 6, { ground_type: "water" }),
    ...rect(17, 3, 18, 4, { ground_type: "water" }),
    ...rect(1, 5, 2, 6, { terrain_type: "difficult" }),
    ...rect(10, 1, 12, 2, { terrain_type: "difficult" }),
    ...rect(6, 7, 8, 8, { terrain_type: "difficult" }),
    ...rect(15, 11, 17, 12, { terrain_type: "difficult" }),
  ];
  const hummocks = [
    { x: 2, y: 2 },
    { x: 16, y: 5 },
    { x: 5, y: 8 },
    { x: 18, y: 8 },
    { x: 9, y: 11 },
    { x: 12, y: 9 },
  ];
  for (const hummock of hummocks) overrides.push({ x: hummock.x, y: hummock.y, elevation: 1 });
  const cells = paintedGrid(width, height, { ground_type: "swamp" }, overrides);
  // Gnarled trees on the firmer hummocks and a couple of rocks in the
  // shallows — the bog reads as overgrown, not just wet.
  const objects: NewMapObjectSeed[] = [
    ...hummocks.map((hummock) => ({
      asset_id: PRESET_TREE,
      x: hummock.x,
      y: hummock.y,
      elevation: elevationAt(cells, hummock.x, hummock.y),
      rotation: 0,
    })),
    { asset_id: PRESET_ROCK, x: 7, y: 3, elevation: elevationAt(cells, 7, 3), rotation: 0 },
    { asset_id: PRESET_ROCK, x: 13, y: 6, elevation: elevationAt(cells, 13, 6), rotation: 0 },
  ];
  return {
    id: "swamp-murky-bog",
    name: "Murky Bog",
    description:
      "A wide bog dotted with stagnant pools and gnarled trees on the firmer hummocks; soft ground bogs down movement in several patches.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** A mire that's difficult terrain almost everywhere, with a single winding
 * line of firmer, raised hummocks as the only easy way through. */
function fetidMireTemplate(): MapTemplate {
  const width = 18;
  const height = 16;
  const waterPools: CellOverride[] = [
    ...rect(1, 1, 3, 3, { ground_type: "water" }),
    ...rect(13, 12, 15, 14, { ground_type: "water" }),
    ...rect(14, 2, 15, 3, { ground_type: "water" }),
    ...rect(2, 12, 3, 13, { ground_type: "water" }),
  ];
  const hummockPath = [
    { x: 1, y: 9 },
    { x: 2, y: 9 },
    { x: 3, y: 10 },
    { x: 4, y: 10 },
    { x: 5, y: 9 },
    { x: 6, y: 9 },
    { x: 7, y: 8 },
    { x: 8, y: 8 },
    { x: 9, y: 7 },
    { x: 10, y: 7 },
    { x: 11, y: 8 },
    { x: 12, y: 8 },
    { x: 13, y: 7 },
    { x: 14, y: 7 },
    { x: 15, y: 8 },
    { x: 16, y: 8 },
  ];
  const overrides: CellOverride[] = [...waterPools];
  for (const step of hummockPath) {
    overrides.push({ x: step.x, y: step.y, ground_type: "swamp", terrain_type: "normal", elevation: 1 });
  }
  const cells = paintedGrid(width, height, { ground_type: "swamp", terrain_type: "difficult" }, overrides);
  // Gnarled trees and rot-slick boulders out in the difficult mire itself —
  // never on the safe hummock path — so straying off the line reads as
  // genuinely overgrown, not just empty bog.
  const mireProps: Array<{ x: number; y: number; asset: string }> = [
    { x: 3, y: 4, asset: PRESET_TREE },
    { x: 14, y: 10, asset: PRESET_TREE },
    { x: 7, y: 13, asset: PRESET_TREE },
    { x: 12, y: 3, asset: PRESET_TREE },
    { x: 2, y: 14, asset: PRESET_ROCK },
    { x: 15, y: 4, asset: PRESET_ROCK },
  ];
  const objects: NewMapObjectSeed[] = mireProps.map((prop) => ({
    asset_id: prop.asset,
    x: prop.x,
    y: prop.y,
    elevation: elevationAt(cells, prop.x, prop.y),
    rotation: 0,
  }));
  return {
    id: "swamp-fetid-mire",
    name: "Fetid Mire",
    description:
      "A stagnant mire choked with difficult bog, pools, and gnarled trees — a single line of firm hummocks offers the only easy crossing.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** A vast waterlogged marsh — mostly difficult, water-heavy ground with only
 * a handful of firmer rises to stand on. The most water-dominant, and the
 * hardest to cross, of the three swamp templates. */
function sunkenMarshTemplate(): MapTemplate {
  const width = 22;
  const height = 14;
  const rises = [
    { x: 2, y: 4 },
    { x: 19, y: 4 },
    { x: 10, y: 10 },
    { x: 17, y: 9 },
    { x: 5, y: 9 },
    { x: 13, y: 3 },
  ];
  const overrides: CellOverride[] = [
    ...rect(0, 0, width - 1, 1, { ground_type: "water", terrain_type: "difficult" }),
    ...rect(7, 5, 14, 8, { ground_type: "water", terrain_type: "difficult" }),
    ...rect(0, 12, width - 1, 13, { ground_type: "water", terrain_type: "difficult" }),
    ...rises.map((rise) => ({
      x: rise.x,
      y: rise.y,
      ground_type: "swamp" as GroundType,
      terrain_type: "normal" as TerrainType,
      elevation: 1,
    })),
  ];
  const cells = paintedGrid(width, height, { ground_type: "swamp", terrain_type: "difficult" }, overrides);
  // A handful of the firmer rises carry a gnarled tree or a mossy boulder —
  // the only solid ground in the whole marsh shouldn't be completely bare.
  const objects: NewMapObjectSeed[] = [
    { asset_id: PRESET_TREE, x: 2, y: 4, elevation: elevationAt(cells, 2, 4), rotation: 0 },
    { asset_id: PRESET_TREE, x: 19, y: 4, elevation: elevationAt(cells, 19, 4), rotation: 0 },
    { asset_id: PRESET_TREE, x: 13, y: 3, elevation: elevationAt(cells, 13, 3), rotation: 0 },
    { asset_id: PRESET_ROCK, x: 10, y: 10, elevation: elevationAt(cells, 10, 10), rotation: 0 },
    { asset_id: PRESET_ROCK, x: 17, y: 9, elevation: elevationAt(cells, 17, 9), rotation: 0 },
  ];
  return {
    id: "swamp-sunken-marsh",
    name: "Sunken Marsh",
    description:
      "A vast waterlogged marsh — nearly all of it difficult going, with only a few tree- and boulder-topped rises to stand on.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

// ─── Town (3): a structured settlement — streets, plazas, building outlines ─
//
// Towns are more architectural than the other 5 themes, so these are NOT
// enlarged — but two of the three DO have real outdoor ground (the plaza's
// garden plots, the hamlet's grassy commons), so each gets a light touch of
// ornamental trees per the project owner's own framing ("a light touch of
// trees in a market square is reasonable, a dense treeline is not").
// Tradesman's Row is left untouched: it's entirely path/stone, with no
// outdoor ground to plant anything in.

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
    // A light touch of shade trees at two corners of the stone plaza — an
    // ornamental pair, not a treeline; the square is still mostly paved.
    { asset_id: PRESET_TREE, x: 6, y: 5, elevation: elevationAt(cells, 6, 5), rotation: 0 },
    { asset_id: PRESET_TREE, x: 9, y: 8, elevation: elevationAt(cells, 9, 8), rotation: 0 },
  ];
  return {
    id: "town-market-square",
    name: "Market Square",
    description:
      "Four shopfronts face a paved central plaza across a web of streets, a pair of shade trees softening the stone — ready for stalls and townsfolk.",
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
    // A couple of trees on the grassy commons, clear of buildings and
    // roads — the hamlet's outdoor character, kept light.
    { asset_id: PRESET_TREE, x: 10, y: 8, elevation: elevationAt(cells, 10, 8), rotation: 0 },
    { asset_id: PRESET_TREE, x: 12, y: 9, elevation: elevationAt(cells, 12, 9), rotation: 0 },
  ];
  return {
    id: "town-crossroads-hamlet",
    name: "Crossroads Hamlet",
    description:
      "A handful of houses cluster where two dirt roads cross, a couple of trees dotting the grassy commons between them.",
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

// ─── Battleground (3): open, tactical combat arenas ──────────────────────
//
// The project owner's own framing: "a battleground one" — distinct from the
// themed exploration maps above. No walls, no doors, no furniture: these
// are built purely for a fight, not a place to explore. Each variant
// supplies genuine tactical terrain variety (elevation for high ground,
// difficult terrain or obstacles for cover, or a real hazard) while staying
// open enough for several combatants to maneuver.

/** A grass field with two raised plateaus facing off across open ground —
 * high ground worth fighting for, boulders scattered mid-field for cover,
 * nothing walled or roomed. */
function openFieldBattlegroundTemplate(): MapTemplate {
  const width = 18;
  const height = 16;
  const cells = paintedGrid(width, height, { ground_type: "grass" }, [
    ...rect(1, 1, 6, 3, { elevation: 2 }),
    ...rect(1, 4, 6, 4, { elevation: 1 }),
    ...rect(11, 12, 16, 14, { elevation: 2 }),
    ...rect(11, 11, 16, 11, { elevation: 1 }),
  ]);
  const coverSpots = [
    { x: 8, y: 7 },
    { x: 10, y: 9 },
    { x: 6, y: 10 },
    { x: 12, y: 6 },
  ];
  for (const spot of coverSpots) {
    const cell = cells.find((c) => c.x === spot.x && c.y === spot.y);
    if (cell) cell.ground_type = "rock";
  }
  const objects: NewMapObjectSeed[] = [
    ...coverSpots.map((spot) => ({
      asset_id: PRESET_ROCK,
      x: spot.x,
      y: spot.y,
      elevation: elevationAt(cells, spot.x, spot.y),
      rotation: 0,
    })),
    { asset_id: PRESET_TREE, x: 1, y: 14, elevation: elevationAt(cells, 1, 14), rotation: 0 },
    { asset_id: PRESET_TREE, x: 16, y: 1, elevation: elevationAt(cells, 16, 1), rotation: 0 },
  ];
  return {
    id: "battleground-open-field",
    name: "Open Field Battleground",
    description:
      "A wide grass field with two raised plateaus facing off across open ground — high ground worth fighting for, and boulders for cover in between.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** Broken, rubble-strewn ground — jagged elevation changes and difficult
 * footing throughout, several boulders for hard cover. Rockier and more
 * chaotic underfoot than the open field, the same "built for a fight"
 * openness with no walls or rooms. */
function brokenGroundBattlegroundTemplate(): MapTemplate {
  const width = 18;
  const height = 16;
  const boulders = [
    { x: 7, y: 4 },
    { x: 10, y: 6 },
    { x: 4, y: 11 },
    { x: 13, y: 3 },
    { x: 8, y: 13 },
  ];
  const overrides: CellOverride[] = [
    ...rect(2, 2, 5, 5, { ground_type: "rock", elevation: 2 }),
    ...rect(12, 10, 15, 13, { ground_type: "rock", elevation: 2 }),
    ...rect(6, 6, 9, 8, { terrain_type: "difficult" }),
    ...rect(9, 9, 12, 11, { terrain_type: "difficult" }),
    ...boulders.map((boulder) => ({ x: boulder.x, y: boulder.y, ground_type: "rock" as GroundType, elevation: 1 })),
  ];
  const cells = paintedGrid(width, height, { ground_type: "stone" }, overrides);
  const objects: NewMapObjectSeed[] = boulders.map((boulder) => ({
    asset_id: PRESET_ROCK,
    x: boulder.x,
    y: boulder.y,
    elevation: elevationAt(cells, boulder.x, boulder.y),
    rotation: 0,
  }));
  return {
    id: "battleground-broken-ground",
    name: "Broken Ground Battleground",
    description:
      "Jagged, rubble-strewn terrain with two rocky rises and difficult footing throughout — hard cover everywhere, nowhere flat for long.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** An arena built around a genuine hazard: a deep central pit ringed by
 * solid ground, with two elevated ledges overlooking it — the tactical
 * question here is who controls the high ground around the drop, not just
 * who has cover. */
function sinkholeArenaBattlegroundTemplate(): MapTemplate {
  const width = 16;
  const height = 16;
  const coverSpots = [
    { x: 3, y: 8 },
    { x: 12, y: 6 },
    { x: 8, y: 12 },
  ];
  const overrides: CellOverride[] = [
    ...rect(6, 6, 9, 9, { terrain_type: "pit", elevation: -2 }),
    ...rect(1, 1, 4, 2, { elevation: 2 }),
    ...rect(11, 13, 14, 14, { elevation: 2 }),
    ...coverSpots.map((spot) => ({ x: spot.x, y: spot.y, ground_type: "rock" as GroundType })),
  ];
  const cells = paintedGrid(width, height, { ground_type: "grass" }, overrides);
  const objects: NewMapObjectSeed[] = coverSpots.map((spot) => ({
    asset_id: PRESET_ROCK,
    x: spot.x,
    y: spot.y,
    elevation: elevationAt(cells, spot.x, spot.y),
    rotation: 0,
  }));
  return {
    id: "battleground-sinkhole-arena",
    name: "Sinkhole Arena Battleground",
    description:
      "A grassy arena built around a genuine hazard — a deep central pit ringed by open ground, with two raised ledges overlooking the drop.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

// ─── Cave / corridor (3): natural, UNBUILT passages carved from void ─────
//
// The project owner asked for "generic corridors/cave walkways for
// adventuring" — deliberately distinct from P11's stone-corridor-junction,
// which is a WORKED stone chamber (walls, four doors, pillars). These carve
// an organic, non-rectangular tunnel shape directly out of void terrain
// (0039_void_terrain.sql's own stated purpose: "the DM paints [void] to
// carve caves/winding corridors out of the rectangular grid") instead of
// building a room: no walls, no doors — nobody built these, water and time
// did. Ground is rock throughout; a little elevation variation (a bump, a
// ledge) keeps the floor from reading as a paved room with the walls
// removed.

const VOID_BASE: CellSpec = { terrain_type: "void", ground_type: "default" };

/** Reverts a single cell back to void — used to round off a rectangular
 * floor blob's sharp corner into a more organic outline after the blob
 * itself has already been painted as floor (a later override in the same
 * paintedGrid call always wins on a repeated coordinate). */
function voidCorner(x: number, y: number): CellOverride {
  return { x, y, terrain_type: "void", ground_type: "default", elevation: 0 };
}

/** A single, mostly-straight passage between two rock chambers — the
 * simplest of the three: one winding but unbranching route, corners
 * softened so it doesn't read as a rectangular room with the walls
 * stripped out. */
function naturalCavePassageTemplate(): MapTemplate {
  const width = 14;
  const height = 10;
  const cells = paintedGrid(width, height, VOID_BASE, [
    ...rect(1, 4, 4, 5, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(3, 3, 9, 6, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(8, 4, 12, 5, { terrain_type: "normal", ground_type: "rock" }),
    voidCorner(3, 3),
    voidCorner(9, 3),
    voidCorner(3, 6),
    voidCorner(9, 6),
  ]);
  const bumps = [
    { x: 5, y: 4 },
    { x: 7, y: 5 },
  ];
  for (const bump of bumps) {
    const cell = cells.find((c) => c.x === bump.x && c.y === bump.y);
    if (cell) cell.elevation = 1;
  }
  const boulders = [
    { x: 2, y: 4 },
    { x: 6, y: 3 },
    { x: 10, y: 5 },
  ];
  const objects: NewMapObjectSeed[] = boulders.map((boulder) => ({
    asset_id: PRESET_ROCK,
    x: boulder.x,
    y: boulder.y,
    elevation: elevationAt(cells, boulder.x, boulder.y),
    rotation: 0,
  }));
  return {
    id: "cave-natural-passage",
    name: "Natural Cave Passage",
    description:
      "A rough-hewn natural tunnel winds through solid rock — an unbuilt, organic passage carved by water and time, not by hands.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** A passage that opens into a rough chamber and splits — one branch
 * climbing away in each direction. The differentiator from
 * stone-corridor-junction's four-doored crossing: no doors, no walls, and
 * an organic staggered outline instead of a rectangular room. */
function branchingCaveJunctionTemplate(): MapTemplate {
  const width = 16;
  const height = 14;
  const cells = paintedGrid(width, height, VOID_BASE, [
    ...rect(1, 6, 6, 7, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(6, 5, 9, 8, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(9, 4, 10, 5, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(10, 2, 11, 4, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(11, 1, 13, 2, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(9, 8, 10, 9, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(10, 9, 11, 11, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(11, 11, 13, 12, { terrain_type: "normal", ground_type: "rock" }),
    voidCorner(6, 5),
    voidCorner(6, 8),
  ]);
  const bumps = [
    { x: 7, y: 6 },
    { x: 8, y: 6 },
    { x: 7, y: 7 },
    { x: 12, y: 1 },
    { x: 12, y: 12 },
  ];
  for (const bump of bumps) {
    const cell = cells.find((c) => c.x === bump.x && c.y === bump.y);
    if (cell) cell.elevation = 1;
  }
  const boulders = [
    { x: 3, y: 6 },
    { x: 10, y: 3 },
    { x: 10, y: 10 },
  ];
  const objects: NewMapObjectSeed[] = boulders.map((boulder) => ({
    asset_id: PRESET_ROCK,
    x: boulder.x,
    y: boulder.y,
    elevation: elevationAt(cells, boulder.x, boulder.y),
    rotation: 0,
  }));
  return {
    id: "cave-branching-junction",
    name: "Branching Cave Junction",
    description:
      "A natural tunnel opens into a rough stone chamber where the passage splits — one unbuilt branch climbing away in each direction.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

/** A long, sinuous tunnel that switches back on itself repeatedly, its
 * floor rising and falling more than the other two — the most organic and
 * least room-like of the three, reading as a real cave passage rather than
 * a corridor with rounded corners. */
function windingCaveTunnelTemplate(): MapTemplate {
  const width = 18;
  const height = 12;
  const cells = paintedGrid(width, height, VOID_BASE, [
    ...rect(0, 2, 3, 4, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(3, 4, 6, 6, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(5, 6, 8, 8, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(7, 7, 10, 9, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(9, 5, 12, 7, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(11, 3, 14, 5, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(13, 1, 16, 3, { terrain_type: "normal", ground_type: "rock" }),
    ...rect(15, 3, 17, 5, { terrain_type: "normal", ground_type: "rock" }),
    voidCorner(0, 2),
    voidCorner(3, 2),
    voidCorner(8, 8),
    voidCorner(16, 1),
    voidCorner(17, 5),
  ]);
  const bumps = [
    { x: 1, y: 3 },
    { x: 6, y: 7 },
    { x: 10, y: 6 },
    { x: 14, y: 2 },
  ];
  for (const bump of bumps) {
    const cell = cells.find((c) => c.x === bump.x && c.y === bump.y);
    if (cell) cell.elevation = 1;
  }
  const boulders = [
    { x: 4, y: 5 },
    { x: 9, y: 7 },
    { x: 13, y: 4 },
  ];
  const objects: NewMapObjectSeed[] = boulders.map((boulder) => ({
    asset_id: PRESET_ROCK,
    x: boulder.x,
    y: boulder.y,
    elevation: elevationAt(cells, boulder.x, boulder.y),
    rotation: 0,
  }));
  return {
    id: "cave-winding-tunnel",
    name: "Winding Cave Tunnel",
    description:
      "A long, sinuous natural tunnel snakes back and forth through the rock, its floor rising and dipping with no two stretches quite level.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects,
  };
}

// ─── Treasure room (3): small, defensible reward rooms ───────────────────
//
// The project owner asked for "treasure rooms etc." — small, walled,
// single-door vaults built around the Chest preset (a55e7002, seeded since
// 0016 but never referenced by any earlier template), each staging the
// chest a little differently so the reward reads as a deliberate
// destination rather than a prop dropped in an ordinary room.

/** A small stone vault: a raised central plinth (a step up, then the chest
 * itself higher still) at the heart of an otherwise plain walled room. */
function vaultPlinthTreasureRoomTemplate(): MapTemplate {
  const width = 8;
  const height = 8;
  const { cells: wallCells, objects: wallObjects } = walledRoom(width, height, { x: 4, y: 7 });
  const floor = paintedGrid(width, height, { ground_type: "stone" }, [
    ...rect(2, 2, 5, 5, { elevation: 1 }),
    ...rect(3, 3, 4, 4, { elevation: 2 }),
  ]);
  const cells = mergeCells(floor, wallCells);
  return {
    id: "treasure-vault-plinth",
    name: "Vault Plinth",
    description: "A small stone vault with a single door — its treasure sits raised on a plinth at the very center of the room.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [...wallObjects, { asset_id: PRESET_CHEST, x: 3, y: 3, elevation: elevationAt(cells, 3, 3), rotation: 0 }],
  };
}

/** A small strongroom with torches flanking its single door like a guard
 * post — the chest sits opposite the entrance, raised on a low dais, so
 * reaching it means crossing the whole watched room. */
function guardedStrongroomTreasureRoomTemplate(): MapTemplate {
  const width = 9;
  const height = 7;
  const { cells: wallCells, objects: wallObjectsRaw } = walledRoom(width, height, { x: 4, y: 6 });
  const wallObjects = [...wallObjectsRaw];
  for (const torch of [
    { x: 2, y: 6 },
    { x: 6, y: 6 },
  ]) {
    const index = wallObjects.findIndex((object) => object.x === torch.x && object.y === torch.y);
    if (index !== -1) {
      wallObjects[index] = { asset_id: PRESET_TORCH, x: torch.x, y: torch.y, elevation: WALL_ELEVATION, rotation: 0 };
    }
  }
  const floor = paintedGrid(width, height, { ground_type: "stone" }, [...rect(3, 1, 5, 1, { elevation: 1 })]);
  const cells = mergeCells(floor, wallCells);
  return {
    id: "treasure-strongroom",
    name: "Guarded Strongroom",
    description:
      "A small stone strongroom with a single guarded door, torches flanking the entrance — the chest sits opposite, raised on a low dais.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [...wallObjects, { asset_id: PRESET_CHEST, x: 4, y: 1, elevation: elevationAt(cells, 4, 1), rotation: 0 }],
  };
}

/** A small chamber built up on a raised floor, except for one recessed
 * hollow at its heart where the chest is tucked away — "sunken" expressed
 * as a relative dip below the surrounding raised floor (never a negative
 * elevation on ordinary terrain, which this codebase reserves for pit
 * cells only). */
function sunkenCacheTreasureRoomTemplate(): MapTemplate {
  const width = 9;
  const height = 9;
  const { cells: wallCells, objects: wallObjects } = walledRoom(width, height, { x: 4, y: 8 });
  const floor = paintedGrid(width, height, { ground_type: "stone", elevation: 1 }, [
    ...rect(3, 3, 5, 5, { elevation: 0 }),
  ]);
  const cells = mergeCells(floor, wallCells);
  return {
    id: "treasure-sunken-cache",
    name: "Sunken Cache",
    description:
      "A small stone chamber built up on a raised floor, except for one recessed hollow at its heart where the chest is tucked away.",
    gridWidth: width,
    gridHeight: height,
    cells,
    objects: [...wallObjects, { asset_id: PRESET_CHEST, x: 4, y: 4, elevation: elevationAt(cells, 4, 4), rotation: 0 }],
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
  // Battleground
  openFieldBattlegroundTemplate(),
  brokenGroundBattlegroundTemplate(),
  sinkholeArenaBattlegroundTemplate(),
  // Cave / corridor
  naturalCavePassageTemplate(),
  branchingCaveJunctionTemplate(),
  windingCaveTunnelTemplate(),
  // Treasure room
  vaultPlinthTreasureRoomTemplate(),
  guardedStrongroomTreasureRoomTemplate(),
  sunkenCacheTreasureRoomTemplate(),
];
