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
