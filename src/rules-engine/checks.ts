import { abilityModifier, proficiencyBonus } from "./abilityScores";
import { CLASSES } from "./srd/classes";
import { SKILL_ABILITY } from "./srd/skills";
import type { AbilityScore, AbilityScores, SkillName } from "./srd/types";

const ABILITY_LABEL: Record<AbilityScore, string> = {
  strength: "Strength",
  dexterity: "Dexterity",
  constitution: "Constitution",
  intelligence: "Intelligence",
  wisdom: "Wisdom",
  charisma: "Charisma",
};

/** The proficiencies-list entry recording a saving-throw proficiency, e.g.
 * "Dexterity Saving Throws" — the form character creation and the PDF
 * importer both store. */
export function savingThrowProficiencyLabel(ability: AbilityScore): string {
  return `${ABILITY_LABEL[ability]} Saving Throws`;
}

/** Whether a character is proficient in `ability` saves: their class's
 * saving-throw proficiencies, unioned with any stored "X Saving Throws"
 * entry (imported sheets, feats like Resilient). */
export function isSavingThrowProficient(
  ability: AbilityScore,
  className: string | null | undefined,
  proficiencies: readonly string[]
): boolean {
  const klass = CLASSES.find((c) => c.name === className);
  if (klass?.savingThrowProficiencies.includes(ability)) return true;
  const label = savingThrowProficiencyLabel(ability).toLowerCase();
  return proficiencies.some((entry) => entry.trim().toLowerCase() === label);
}

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
