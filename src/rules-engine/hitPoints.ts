import { abilityModifier } from "./abilityScores";

// SRD level-1 hit points: the class hit die's maximum value plus the
// Constitution modifier (rolled/average HP only enters at level 2+).
export function levelOneHitPoints(hitDie: number, constitutionScore: number): number {
  return hitDie + abilityModifier(constitutionScore);
}
