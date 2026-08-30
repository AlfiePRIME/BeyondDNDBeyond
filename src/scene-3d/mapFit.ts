import { COMBINED_TABLE_VISIBLE_TOP } from "./table";
import { EDITOR_MAP_METRICS, type MapSurfaceMetrics } from "./MapSurface";

// Border of bare tabletop left visible around the map, so it reads as a
// game board sitting on the table rather than a resurfaced tabletop.
const TABLE_MAP_MARGIN = 0.3;

/**
 * Fits an arbitrary grid onto the table's REAL physical footprint
 * (table.ts's COMBINED_TABLE_VISIBLE_TOP — the head square's actual visible
 * playing surface, not its wider leg-clearance sibling COMBINED_TABLE_TOP):
 * uniform cell size from the tighter of the two axes (maps rarely match the
 * tabletop's aspect ratio), with slab/step heights kept exactly
 * editor-proportional (same baseHeight/elevationStepHeight-to-cellSize ratio
 * the map editor itself renders at) — deliberately NO minimum step-height
 * floor. An earlier version clamped elevationStepHeight to a minimum so
 * terracing stayed legible on dense grids, but that traded away the game
 * table's own visual consistency with the editor (elevation reading up to
 * ~2x taller than the editor showed on typical/larger maps) — removed per
 * the project owner's explicit call to prioritize matching the editor.
 *
 * THIRD investigation of this exact area (2026-08-30). The previous two
 * attempts both tried growing the table's OWN footprint past its real
 * modeled size on large/lopsided grids — first via computeTableFootprint
 * (a seat-clearance-capped expansion) paired with GameTableScene's
 * TableExtension (a synthetic flat wood-colored slab rendered wherever the
 * footprint grew past the real table.glb model) — and that whole approach
 * is REMOVED here, per the project owner's explicit, direct call: "remove
 * the brown box it places, and make the 3d map fit to the 3d table models
 * that are there." The map now ONLY ever fits inside
 * COMBINED_TABLE_VISIBLE_TOP's own real, already-rendered surface — never
 * synthesizes extra surface to grow onto. A large/extreme grid (e.g.
 * 20x40) legitimately gets a SMALLER cellSize than would read as
 * comfortably legible — an honest tradeoff, not a bug, as long as the grid
 * never visually overflows the table's real edges (which growing the table
 * itself was always a workaround for, not a fix of the actual constraint).
 *
 * Full uniform scaling of the WHOLE table+seating+camera system (considered
 * and rejected during the SECOND investigation) would have moved the seated
 * camera back by the exact same factor the table grew, leaving the DEFAULT
 * view's apparent on-screen size of every cell completely unchanged — the
 * seated camera's position is a pure function of PARTY SEATING (seating.ts),
 * never of the live map's own grid size. Not relevant to growing the table
 * anymore (that idea is gone), but still the reason a "just zoom the camera
 * in on a small map" idea wouldn't have helped the original "large maps look
 * small" report either.
 */
export function computeTableMapMetrics(gridWidth: number, gridHeight: number): MapSurfaceMetrics {
  const cellSize = Math.min(
    (COMBINED_TABLE_VISIBLE_TOP.width - TABLE_MAP_MARGIN * 2) / gridWidth,
    (COMBINED_TABLE_VISIBLE_TOP.depth - TABLE_MAP_MARGIN * 2) / gridHeight
  );
  return {
    cellSize,
    baseHeight: EDITOR_MAP_METRICS.baseHeight * cellSize,
    elevationStepHeight: EDITOR_MAP_METRICS.elevationStepHeight * cellSize,
  };
}
