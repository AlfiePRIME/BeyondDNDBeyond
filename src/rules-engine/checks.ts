import { abilityModifier, proficiencyBonus } from "./abilityScores";
import { SKILL_ABILITY } from "./srd/skills";
import type { AbilityScore, AbilityScores, SkillName } from "./srd/types";

export function savingThrowBonus(
  ability: AbilityScore,
  abilityScores: AbilityScores,
  level: number,
  proficient: boolean
): number {
  return abilityModifier(abilityScores[ability]) + (proficient ? proficiencyBonus(level) : 0);
}

export function skillCheckBonus(
  skill: SkillName,
  abilityScores: AbilityScores,
  level: number,
  proficient: boolean
): number {
  const ability = SKILL_ABILITY[skill];
  return abilityModifier(abilityScores[ability]) + (proficient ? proficiencyBonus(level) : 0);
}

// Generalized over any skill (not hardcoded to Perception) — passive
// Investigation, passive Insight, etc. all use this same 10 + bonus formula.
export function passiveScore(
  skill: SkillName,
  abilityScores: AbilityScores,
  level: number,
  proficient: boolean
): number {
  return 10 + skillCheckBonus(skill, abilityScores, level, proficient);
}
