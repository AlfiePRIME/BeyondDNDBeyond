// Simplified diagonal rule (DMG variant, not the alternating 5-10-5 rule):
// every cell entered costs a flat 5 ft regardless of direction. Range
// calculations, movement cost, and the future ruler tool all depend on
// this exact decision — see Prompt 9's README for why it was fixed here.
export const FEET_PER_CELL = 5;

export type TerrainType = "normal" | "difficult";

export interface CellMovementParams {
  terrain: TerrainType;
  // Feet climbed to enter this cell; 0 or negative (descending/level) adds
  // no climbing cost.
  elevationDeltaFeet: number;
}

// Difficult terrain and climbing are independent costs that stack: a cell
// that is both difficult terrain and a climb pays both penalties.
export function cellMovementCost({ terrain, elevationDeltaFeet }: CellMovementParams): number {
  const horizontalCost = terrain === "difficult" ? FEET_PER_CELL * 2 : FEET_PER_CELL;
  // SRD climbing rule: 1 extra foot of movement per foot climbed, i.e. the
  // vertical portion costs double.
  const climbCost = elevationDeltaFeet > 0 ? elevationDeltaFeet * 2 : 0;
  return horizontalCost + climbCost;
}

export interface GridPoint {
  x: number;
  y: number;
}

export function gridCellDistance(from: GridPoint, to: GridPoint): number {
  return Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
}

export function gridDistanceFeet(from: GridPoint, to: GridPoint): number {
  return gridCellDistance(from, to) * FEET_PER_CELL;
}

// One stored elevation step is 5 vertical feet — the same unit as the flat
// 5 ft cell, so "one step up" and "one cell over" read as the same distance.
// map_cells.elevation deliberately stores steps, not feet (0014_maps.sql);
// this constant is the single place that conversion decision lives.
export const FEET_PER_ELEVATION_STEP = 5;

/**
 * The straight walk from `from` to `to`, excluding `from` itself: step
 * diagonally while both axes differ, then straight. Its length equals
 * gridCellDistance, so a plain drag over normal level ground costs exactly
 * the ruler distance. Movement UIs recompute this from the origin on every
 * hover — cost depends only on where you are, not how the mouse wobbled.
 */
export function straightCellPath(from: GridPoint, to: GridPoint): GridPoint[] {
  const path: GridPoint[] = [];
  let { x, y } = from;
  while (x !== to.x || y !== to.y) {
    x += Math.sign(to.x - x);
    y += Math.sign(to.y - y);
    path.push({ x, y });
  }
  return path;
}

export interface PathCell {
  terrain: TerrainType;
  elevationSteps: number;
}

/** Total cost of entering each cell in sequence, starting from a cell at
 * `originElevationSteps` — climbs are charged per cell-to-cell delta, so a
 * plateau costs its ascent once, not per cell walked along the top. */
export function pathMovementCost(
  originElevationSteps: number,
  entered: readonly PathCell[]
): number {
  let previousElevation = originElevationSteps;
  let total = 0;
  for (const cell of entered) {
    total += cellMovementCost({
      terrain: cell.terrain,
      elevationDeltaFeet: (cell.elevationSteps - previousElevation) * FEET_PER_ELEVATION_STEP,
    });
    previousElevation = cell.elevationSteps;
  }
  return total;
}
