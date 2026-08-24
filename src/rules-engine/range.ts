import type { SpellRange, TargetType } from "./srd/types";

// Parallel shape to Spell's range/targetType fields so weapon attacks and
// spells can flow through the same usableAtRange query as a mixed list.
export interface RangedAction {
  name: string;
  range: SpellRange;
  targetType: TargetType;
}

export function isUsableAtRange(range: SpellRange, distanceFeet: number): boolean {
  if (range === "self") return distanceFeet === 0;
  // Touch range models as reaching an adjacent creature on the grid.
  if (range === "touch") return distanceFeet <= 5;
  return distanceFeet <= range;
}

export function usableAtRange<T extends RangedAction>(actions: readonly T[], distanceFeet: number): T[] {
  return actions.filter((action) => isUsableAtRange(action.range, distanceFeet));
}
