/**
 * The SRD experience-point thresholds for character levels 1-20 — index i
 * is the MINIMUM total XP for level i + 1 (level 1 starts at 0 XP, level 2
 * at 300, ... level 20 at 355,000). Static SRD data in code, like the
 * proficiencyBonus table one file over — the single source of truth every
 * XP surface (the DM dashboard's award flow, the sheet's XP readout)
 * derives from.
 */
export const XP_LEVEL_THRESHOLDS: readonly number[] = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000,
  165000, 195000, 225000, 265000, 305000, 355000,
];

export const MAX_CHARACTER_LEVEL = 20;

/**
 * The level a total XP amount corresponds to under the SRD table — the
 * highest level whose threshold the total meets or exceeds, capped at 20.
 * Negative totals (which the DB's CHECK forbids anyway) clamp to level 1.
 */
export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 1; i < XP_LEVEL_THRESHOLDS.length; i++) {
    if (xp >= XP_LEVEL_THRESHOLDS[i]) level = i + 1;
  }
  return level;
}

/** The minimum total XP for a level (clamped into 1-20) — level 1 is 0. */
export function xpThresholdForLevel(level: number): number {
  const clamped = Math.min(MAX_CHARACTER_LEVEL, Math.max(1, Math.floor(level)));
  return XP_LEVEL_THRESHOLDS[clamped - 1];
}

/**
 * How far a total is from the NEXT threshold above the given current
 * level, for "X XP to level N" readouts. Deliberately keyed off the
 * character's STORED level, not levelForXp(xp): under the dashboard's
 * suggest-then-confirm flow a character can sit above a threshold without
 * having taken the level yet, and the useful readout is still "what's
 * next from the level you actually are". Null at level 20 — nothing left
 * to climb.
 */
export function xpToNextLevel(
  xp: number,
  currentLevel: number
): { nextLevel: number; threshold: number; remaining: number } | null {
  const clamped = Math.min(MAX_CHARACTER_LEVEL, Math.max(1, Math.floor(currentLevel)));
  if (clamped >= MAX_CHARACTER_LEVEL) return null;
  const threshold = XP_LEVEL_THRESHOLDS[clamped];
  return { nextLevel: clamped + 1, threshold, remaining: Math.max(0, threshold - xp) };
}
