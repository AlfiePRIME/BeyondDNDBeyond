import type { MapSurfaceCell, MapSurfaceMetrics } from "./MapSurface";

// Sits above the block top by a hair so the lines never z-fight the face
// they outline; small enough to stay visually "on" the surface even at the
// table's miniature cell heights.
const LINE_LIFT = 0.004;

const GAP_RATIO = 0.08; // mirrors MapSurface's CELL_GAP_RATIO

/**
 * One flat position buffer outlining every cell block's top face at that
 * cell's own height — a single lineSegments draw call instead of one line
 * object per cell, which matters at table scale where a 20x20 map is 400
 * cells. Because each outline rides its cell's elevation, terrace edges
 * show as visibly offset line rings, which is what makes elevation read at
 * miniature size where the gap shadows alone smear together.
 */
export function buildGridOverlayPositions(
  cells: readonly MapSurfaceCell[],
  metrics: MapSurfaceMetrics,
  gridWidth: number,
  gridHeight: number
): Float32Array {
  const { cellSize, baseHeight, elevationStepHeight } = metrics;
  const offsetX = ((gridWidth - 1) / 2) * cellSize;
  const offsetZ = ((gridHeight - 1) / 2) * cellSize;
  const half = (cellSize * (1 - GAP_RATIO)) / 2;

  // 4 edges per cell, 2 points per edge, 3 floats per point.
  const positions = new Float32Array(cells.length * 24);
  let i = 0;
  for (const cell of cells) {
    const cx = cell.x * cellSize - offsetX;
    const cz = cell.y * cellSize - offsetZ;
    const y = baseHeight + cell.elevation * elevationStepHeight + LINE_LIFT;
    const corners = [
      [cx - half, cz - half],
      [cx + half, cz - half],
      [cx + half, cz + half],
      [cx - half, cz + half],
    ] as const;
    for (let edge = 0; edge < 4; edge++) {
      const [ax, az] = corners[edge];
      const [bx, bz] = corners[(edge + 1) % 4];
      positions[i++] = ax;
      positions[i++] = y;
      positions[i++] = az;
      positions[i++] = bx;
      positions[i++] = y;
      positions[i++] = bz;
    }
  }
  return positions;
}
