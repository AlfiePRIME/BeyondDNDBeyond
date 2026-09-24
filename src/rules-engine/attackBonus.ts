import { abilityModifier, proficiencyBonus } from "./abilityScores";
import type { AbilityScore, AbilityScores } from "./srd/types";

export type AttackKind = "melee" | "ranged" | "finesse" | "spell";

/** The ability an attack of `kind` rolls with. Finesse uses the higher of
 * Strength and Dexterity (the attacker's choice, and they'd pick the
 * better one); ties go to Dexterity. */
export function attackAbility(
  kind: AttackKind,
  abilityScores: AbilityScores,
  spellcastingAbility?: AbilityScore
): AbilityScore {
  switch (kind) {
    case "melee":
      return "strength";
    case "ranged":
      return "dexterity";
    case "finesse":
      return abilityScores.strength > abilityScores.dexterity ? "strength" : "dexterity";
    case "spell":
      if (!spellcastingAbility) {
        throw new Error("spell attack bonus requires a spellcastingAbility");
      }
      return spellcastingAbility;
  }
}

// Assumes proficiency with the weapon/spell — whether a character is
// actually proficient is a character-sheet concern for a later prompt, not
// this pure-rules module's job.
export function attackBonus(
  kind: AttackKind,
  abilityScores: AbilityScores,
  level: number,
  spellcastingAbility?: AbilityScore
): number {
  const ability = attackAbility(kind, abilityScores, spellcastingAbility);
  return abilityModifier(abilityScores[ability]) + proficiencyBonus(level);
}
