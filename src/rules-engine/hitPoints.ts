import { abilityModifier } from "./abilityScores";

// SRD level-1 hit points: the class hit die's maximum value plus the
// Constitution modifier (rolled/average HP only enters at level 2+).
export function levelOneHitPoints(hitDie: number, constitutionScore: number): number {
  return hitDie + abilityModifier(constitutionScore);
}

// SRD's deterministic "average" hit-die-per-level method (the fixed
// alternative to rolling): half the hit die rounded down, plus one, plus
// the Constitution modifier. Used for level 2+ gains — level 1 always uses
// levelOneHitPoints instead.
export function levelUpHitPointGain(hitDie: number, constitutionScore: number): number {
  return Math.floor(hitDie / 2) + 1 + abilityModifier(constitutionScore);
}
