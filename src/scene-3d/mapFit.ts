import { seatEllipseSemiAxes } from "./seating";
import { COMBINED_TABLE_TOP, COMBINED_TABLE_VISIBLE_TOP } from "./table";
import { EDITOR_MAP_METRICS, type MapSurfaceMetrics } from "./MapSurface";

// Border of bare tabletop left visible around the map, so it reads as a
// game board sitting on the table rather than a resurfaced tabletop.
const TABLE_MAP_MARGIN = 0.3;

// Bug report (2026-08-26): "this is a 20x40 map, it is very small in game,
// please make it so larger maps display bigger so they can be played
// easier." Below this, a cell (and everything rendered at cellSize scale —
// tokens, terrain steps, dice, printed numbers) stops reading as an
// individual, clickable thing and starts reading as a smear of color at
// this scene's normal seated/orbit viewing distances. Not a hard physical
// limit — a target, chosen against real screenshots at a range of grid
// sizes (scripts/db/verify-large-map-scale.mjs) — that computeTableFootprint
// below tries to reach by growing the table's own footprint, but will still
// fall short of on the very largest/most lopsided grids once
// TABLE_GROWTH_SEAT_CLEARANCE's own cap kicks in (an honest, documented
// limit — the same shape of tradeoff seating.ts's own HEAD_SQUARE_SEAT_
// CAPACITY doc comment already accepts for extreme density).
const MIN_LEGIBLE_CELL_SIZE = 0.22;

// How far past COMBINED_TABLE_TOP's own footprint the live map's table is
// ever allowed to grow, expressed as clearance short of where a seated
// chair could actually be. seatEllipseSemiAxes(COMBINED_TABLE_TOP) is the
// exact ellipse seating.ts places every head-square seat around (the live
// map only ever renders on the head square — GameTableScene's own comment
// on why appended tables never get one) — and it uses the FULL theoretical
// ellipse regardless of how many members are actually seated today, so this
// bound stays safe at any future party size, not just the current one.
// Growing the table's visible footprint right up to that ring, minus this
// flat clearance for a chair/avatar's own bulk, guarantees the grown
// tabletop can never visually run underneath (or appear to float through) a
// real seat.
const TABLE_GROWTH_SEAT_CLEARANCE = 0.5;

/**
 * The physical (x/z) footprint the live map is fit onto. Starts from
 * COMBINED_TABLE_VISIBLE_TOP — the head square's REAL visible playing
 * surface (table.ts's own doc comment on why this differs from
 * COMBINED_TABLE_TOP, its wider leg-clearance sibling used for seating) —
 * which alone is enough to keep most grids at a legible cellSize; this
 * footprint only grows further, symmetrically on both axes, when even that
 * isn't enough (MIN_LEGIBLE_CELL_SIZE), and never past where a seated chair
 * could be (TABLE_GROWTH_SEAT_CLEARANCE, still measured against the WIDER
 * COMBINED_TABLE_TOP ellipse below — a chair's own clearance is a leg-stance
 * question, not a visible-top-surface one, so that part deliberately keeps
 * using the other constant). GameTableScene renders an actual physical slab
 * at this size (TableExtension) whenever it exceeds COMBINED_TABLE_VISIBLE_TOP,
 * so the grid this footprint feeds into computeTableMapMetrics always has
 * real, solid wood underneath it — never floating past the real table
 * model's own edges.
 *
 * A real regression (2026-08-30): this function originally started from
 * COMBINED_TABLE_TOP directly (the wider, leg-based footprint) — visually
 * fine while the fitted grid was small relative to the ~6% error between
 * the two, but a large/wide grid filling most of the footprint rendered
 * genuinely past the table's real visible edge ("this is way too large for
 * the table... the complete opposite of before"). COMBINED_TABLE_VISIBLE_TOP
 * is the real fix, not a numeric tweak of this function's own logic.
 *
 * Deliberately never SMALLER than COMBINED_TABLE_VISIBLE_TOP, for any grid
 * size: a map that already fit comfortably within it keeps rendering
 * exactly as it always has. This is a strict improvement over the
 * single-table footprint this function used to fit against before the
 * "larger maps should display bigger" bug report, never a regression —
 * COMBINED_TABLE_VISIBLE_TOP's own already-rendered head square (table.ts's
 * CombinedTable) was always there, just previously left unused by the live
 * map on the project owner's own earlier, narrower call ("the live map
 * deliberately does NOT use this... it stays sized to a single table's
 * worth of surface").
 *
 * Full uniform scaling of the WHOLE table+seating+camera system (considered
 * and rejected — see mapFit.test.ts's own doc comment on
 * "computeTableFootprint" for the numeric argument) would have moved the
 * seated camera back by the exact same factor the table grew, leaving the
 * DEFAULT view's apparent on-screen size of every cell completely
 * unchanged — the seated camera's position is a pure function of PARTY
 * SEATING (seating.ts), never of the live map's own grid size, and this
 * function deliberately keeps it that way: only the table's own physical
 * footprint (and therefore cellSize) grows here, the camera never moves
 * because of it, so a bigger cellSize is a genuine, real improvement in
 * on-screen size rather than a no-op zoom.
 */
export function computeTableFootprint(gridWidth: number, gridHeight: number): { width: number; depth: number } {
  const naturalCellSize = Math.min(
    (COMBINED_TABLE_VISIBLE_TOP.width - TABLE_MAP_MARGIN * 2) / gridWidth,
    (COMBINED_TABLE_VISIBLE_TOP.depth - TABLE_MAP_MARGIN * 2) / gridHeight
  );
  if (naturalCellSize >= MIN_LEGIBLE_CELL_SIZE) {
    return { width: COMBINED_TABLE_VISIBLE_TOP.width, depth: COMBINED_TABLE_VISIBLE_TOP.depth };
  }

  const { semiX, semiZ } = seatEllipseSemiAxes(COMBINED_TABLE_TOP);
  const maxWidth = (semiX - TABLE_GROWTH_SEAT_CLEARANCE) * 2;
  const maxDepth = (semiZ - TABLE_GROWTH_SEAT_CLEARANCE) * 2;

  const wantedWidth = gridWidth * MIN_LEGIBLE_CELL_SIZE + TABLE_MAP_MARGIN * 2;
  const wantedDepth = gridHeight * MIN_LEGIBLE_CELL_SIZE + TABLE_MAP_MARGIN * 2;

  return {
    width: Math.min(Math.max(COMBINED_TABLE_VISIBLE_TOP.width, wantedWidth), maxWidth),
    depth: Math.min(Math.max(COMBINED_TABLE_VISIBLE_TOP.depth, wantedDepth), maxDepth),
  };
}

/**
 * Fits an arbitrary grid onto computeTableFootprint's own physical
 * footprint: uniform cell size from the tighter of the two axes (maps
 * rarely match the tabletop's aspect ratio), with slab/step heights kept
 * exactly editor-proportional (same baseHeight/elevationStepHeight-to-
 * cellSize ratio the map editor itself renders at) — deliberately NO
 * minimum step-height floor. An earlier version clamped elevationStepHeight
 * to a minimum so terracing stayed legible on dense grids, but that traded
 * away the game table's own visual consistency with the editor (elevation
 * reading up to ~2x taller than the editor showed on typical/larger maps) —
 * removed per the project owner's explicit call to prioritize matching the
 * editor. That same reasoning is why THIS fix grows the table itself
 * (computeTableFootprint) rather than reintroducing a floor of any kind on
 * cellSize directly: a floored cellSize with a fixed-size table would make
 * the grid overflow the table's own visible edges, the exact broken look a
 * floor was already rejected for once.
 */
export function computeTableMapMetrics(gridWidth: number, gridHeight: number): MapSurfaceMetrics {
  const footprint = computeTableFootprint(gridWidth, gridHeight);
  const cellSize = Math.min(
    (footprint.width - TABLE_MAP_MARGIN * 2) / gridWidth,
    (footprint.depth - TABLE_MAP_MARGIN * 2) / gridHeight
  );
  return {
    cellSize,
    baseHeight: EDITOR_MAP_METRICS.baseHeight * cellSize,
    elevationStepHeight: EDITOR_MAP_METRICS.elevationStepHeight * cellSize,
  };
}
