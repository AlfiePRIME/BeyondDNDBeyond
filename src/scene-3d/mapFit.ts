import { TABLE_TOP } from "./table";
import { EDITOR_MAP_METRICS, type MapSurfaceMetrics } from "./MapSurface";

// Border of bare tabletop left visible around the map, so it reads as a
// game board sitting on the table rather than a resurfaced tabletop.
const TABLE_MAP_MARGIN = 0.3;

/**
 * Fits an arbitrary grid onto the physical table's fixed footprint: uniform
 * cell size from the tighter of the two axes (maps rarely match the
 * tabletop's aspect ratio), with slab/step heights kept exactly
 * editor-proportional (same baseHeight/elevationStepHeight-to-cellSize ratio
 * the map editor itself renders at) — deliberately NO minimum step-height
 * floor. An earlier version clamped elevationStepHeight to a minimum so
 * terracing stayed legible on dense grids, but that traded away the game
 * table's own visual consistency with the editor (elevation reading up to
 * ~2x taller than the editor showed on typical/larger maps) — removed per
 * the project owner's explicit call to prioritize matching the editor.
 */
export function computeTableMapMetrics(gridWidth: number, gridHeight: number): MapSurfaceMetrics {
  const cellSize = Math.min(
    (TABLE_TOP.width - TABLE_MAP_MARGIN * 2) / gridWidth,
    (TABLE_TOP.depth - TABLE_MAP_MARGIN * 2) / gridHeight
  );
  return {
    cellSize,
    baseHeight: EDITOR_MAP_METRICS.baseHeight * cellSize,
    elevationStepHeight: EDITOR_MAP_METRICS.elevationStepHeight * cellSize,
  };
}
