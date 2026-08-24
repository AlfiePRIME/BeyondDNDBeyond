import { TABLE_TOP } from "./table";
import { EDITOR_MAP_METRICS, type MapSurfaceMetrics } from "./MapSurface";

// Border of bare tabletop left visible around the map, so it reads as a
// game board sitting on the table rather than a resurfaced tabletop.
const TABLE_MAP_MARGIN = 0.3;

// Below this, ten editor-legal steps compress into a smear at miniature
// scale — the floor trades a little proportionality for readable terracing.
const MIN_STEP_HEIGHT = 0.09;

/**
 * Fits an arbitrary grid onto the physical table's fixed footprint: uniform
 * cell size from the tighter of the two axes (maps rarely match the
 * tabletop's aspect ratio), editor-proportional slab/step heights, with the
 * step height clamped so elevation terracing stays legible on dense grids.
 */
export function computeTableMapMetrics(gridWidth: number, gridHeight: number): MapSurfaceMetrics {
  const cellSize = Math.min(
    (TABLE_TOP.width - TABLE_MAP_MARGIN * 2) / gridWidth,
    (TABLE_TOP.depth - TABLE_MAP_MARGIN * 2) / gridHeight
  );
  return {
    cellSize,
    baseHeight: EDITOR_MAP_METRICS.baseHeight * cellSize,
    elevationStepHeight: Math.max(EDITOR_MAP_METRICS.elevationStepHeight * cellSize, MIN_STEP_HEIGHT),
  };
}
