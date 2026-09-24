// Pure level-1 character-creation math for the new-character wizard:
// ability score generation (standard array / point buy), spells known at
// 1st level, and starting armor class.
import { abilityModifier } from "./abilityScores";
import { spellSlotsForClass, SPELL_SLOT_LEVELS } from "./spellSlots";
import type { AbilityScore, AbilityScores, ClassName } from "./srd/types";

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;

export const POINT_BUY_BUDGET = 27;
export const POINT_BUY_MIN = 8;
export const POINT_BUY_MAX = 15;

/** Ability scores can't exceed 20 at creation (racial bonuses included). */
export const CREATION_SCORE_MAX = 20;

const POINT_BUY_COST: Record<number, number> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};

/** SRD point-buy cost of one score, or null outside 8-15. */
export function pointBuyCost(score: number): number | null {
  return POINT_BUY_COST[score] ?? null;
}

/** Total point-buy cost of a set of base scores, or null if any is
 * outside 8-15. */
export function pointBuyTotal(scores: readonly number[]): number | null {
  let total = 0;
  for (const score of scores) {
    const cost = pointBuyCost(score);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

/** True when `scores` uses each standard-array value exactly once. */
export function isStandardArrayAssignment(scores: readonly number[]): boolean {
  const sorted = [...scores].sort((a, b) => b - a);
  return sorted.length === STANDARD_ARRAY.length && sorted.every((v, i) => v === STANDARD_ARRAY[i]);
}

// Cantrips known at 1st level (SRD class tables).
const CANTRIPS_AT_LEVEL_1: Partial<Record<ClassName, number>> = {
  Bard: 2,
  Cleric: 3,
  Druid: 2,
  Sorcerer: 4,
  Warlock: 2,
  Wizard: 3,
};

// Leveled spells known at 1st level for the known-spell classes; Wizard's
// is its starting spellbook (six 1st-level spells).
const SPELLS_AT_LEVEL_1: Partial<Record<ClassName, number>> = {
  Bard: 4,
  Sorcerer: 2,
  Warlock: 2,
  Wizard: 6,
};

/**
 * How many cantrips and 1st-level spells a new level-1 character picks.
 * Cleric/Druid prepare spellcasting modifier + 1 (minimum 1). Both zero
 * for a class with no spellcasting at level 1 (Paladin, Ranger, the
 * non-casters).
 */
export function startingSpellCounts(
  className: ClassName,
  spellcastingScore: number | null
): { cantrips: number; spells: number } {
  const slots = spellSlotsForClass(className, 1);
  if (!SPELL_SLOT_LEVELS.some((level) => slots[level] > 0)) return { cantrips: 0, spells: 0 };
  const cantrips = CANTRIPS_AT_LEVEL_1[className] ?? 0;
  if (className === "Cleric" || className === "Druid") {
    const modifier = spellcastingScore === null ? 0 : abilityModifier(spellcastingScore);
    return { cantrips, spells: Math.max(1, 1 + modifier) };
  }
  return { cantrips, spells: SPELLS_AT_LEVEL_1[className] ?? 0 };
}

interface ArmorDefinition {
  base: number;
  /** Max DEX modifier added; null = the full modifier; 0 = none (heavy). */
  dexCap: number | null;
}

// SRD armor table, keyed by lower-cased item name.
const ARMOR: Record<string, ArmorDefinition> = {
  "padded armor": { base: 11, dexCap: null },
  "leather armor": { base: 11, dexCap: null },
  "studded leather armor": { base: 12, dexCap: null },
  "hide armor": { base: 12, dexCap: 2 },
  "chain shirt": { base: 13, dexCap: 2 },
  "scale mail": { base: 14, dexCap: 2 },
  breastplate: { base: 14, dexCap: 2 },
  "half plate": { base: 15, dexCap: 2 },
  "ring mail": { base: 14, dexCap: 0 },
  "chain mail": { base: 16, dexCap: 0 },
  splint: { base: 17, dexCap: 0 },
  "splint armor": { base: 17, dexCap: 0 },
  plate: { base: 18, dexCap: 0 },
  "plate armor": { base: 18, dexCap: 0 },
};

const SHIELDS = new Set(["shield", "wooden shield"]);

/**
 * Best starting AC from the character's own gear and class: 10 + DEX
 * unarmored, any armor in the inventory, Barbarian Unarmored Defense
 * (10 + DEX + CON, shield allowed) or Monk Unarmored Defense (10 + DEX +
 * WIS, no armor or shield) — whichever is highest, since the character
 * would wear their best option. A shield adds 2 where allowed.
 */
export function startingArmorClass(
  className: ClassName | null,
  scores: AbilityScores,
  itemNames: readonly string[]
): number {
  const mod = (ability: AbilityScore) => abilityModifier(scores[ability]);
  const dex = mod("dexterity");
  const names = itemNames.map((name) => name.trim().toLowerCase());
  const shield = names.some((name) => SHIELDS.has(name)) ? 2 : 0;

  const bodies = [10 + dex];
  for (const name of names) {
    const armor = ARMOR[name];
    if (armor) {
      // Heavy armor ignores DEX entirely, a penalty included.
      const dexPart = armor.dexCap === null ? dex : armor.dexCap === 0 ? 0 : Math.min(dex, armor.dexCap);
      bodies.push(armor.base + dexPart);
    }
  }
  if (className === "Barbarian") bodies.push(10 + dex + mod("constitution"));

  const candidates = [Math.max(...bodies) + shield];
  if (className === "Monk") candidates.push(10 + dex + mod("wisdom"));
  return Math.max(...candidates);
}
