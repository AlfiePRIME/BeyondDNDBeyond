import { CONDITION_BY_KEY, EXHAUSTION_KEY, exhaustionEffects } from "./srd/conditions";
import type { AbilityScore, ConditionEffects, ConditionKey } from "./srd/types";

// Turns applied conditions into advantage/disadvantage SOURCES (the
// human-readable strings combineAdvantageSources consumes) for a d20 roll,
// from both sides: the roller's own conditions (Poisoned attacker,
// exhausted saver...) and the attack target's (Prone, Paralyzed...). Pure —
// the roll route loads the rows and feeds them in.

/** The slice of a combatant_conditions / character_conditions row this
 * module needs. `level` is only meaningful for exhaustion. */
export interface AppliedCondition {
  condition_key: string;
  level: number | null;
}

/** The d20 roll families conditions distinguish between. Skill checks,
 * initiative and Stealth-to-hide are all ability checks. */
export type SelfRollKind = "attack" | "ability_check" | "saving_throw";

export interface SelfConditionRollEffects {
  advantageSources: string[];
  disadvantageSources: string[];
  /** Why the roll fails automatically (a STR/DEX save while Paralyzed,
   * Petrified, Stunned or Unconscious), or null. */
  autoFailReason: string | null;
}

export interface TargetConditionAttackEffects {
  advantageSources: string[];
  disadvantageSources: string[];
  /** Why a hit becomes a critical hit (Paralyzed/Unconscious target hit
   * from within 5 ft), or null. */
  autoCriticalReason: string | null;
}

/** Melee reach for the "within 5 feet" condition rules. */
const WITHIN_FEET = 5;

/**
 * Unions condition rows from several sources (a combatant's rows and the
 * character's own combat-independent rows) by key — the merge rule every
 * display surface already follows: each on/off condition once, exhaustion
 * at the higher of the levels.
 */
export function mergeAppliedConditions(
  ...lists: readonly (readonly AppliedCondition[])[]
): AppliedCondition[] {
  const byKey = new Map<string, AppliedCondition>();
  for (const list of lists) {
    for (const row of list) {
      const existing = byKey.get(row.condition_key);
      if (!existing) {
        byKey.set(row.condition_key, { condition_key: row.condition_key, level: row.level });
      } else if (row.condition_key === EXHAUSTION_KEY) {
        existing.level = Math.max(existing.level ?? 0, row.level ?? 0);
      }
    }
  }
  return [...byKey.values()];
}

/** Every [label, effects] pair in play: each catalog condition under its
 * display name, plus exhaustion's cumulative flags under "Exhaustion
 * (level N)". Unknown keys are ignored. */
function activeEffects(conditions: readonly AppliedCondition[]): [string, ConditionEffects][] {
  const result: [string, ConditionEffects][] = [];
  for (const row of conditions) {
    if (row.condition_key === EXHAUSTION_KEY) {
      const level = row.level ?? 0;
      if (level > 0) result.push([`Exhaustion (level ${level})`, exhaustionEffects(level)]);
      continue;
    }
    const definition = CONDITION_BY_KEY.get(row.condition_key as ConditionKey);
    if (definition) result.push([definition.name, definition.effects]);
  }
  return result;
}

/**
 * The roller's own conditions applied to one of their d20 rolls. Frightened
 * is applied unconditionally (whether the source of fear is in sight isn't
 * tracked); the manual toggle remains for the DM to rule otherwise.
 */
export function selfConditionRollEffects(
  conditions: readonly AppliedCondition[],
  kind: SelfRollKind,
  ability?: AbilityScore
): SelfConditionRollEffects {
  const advantageSources: string[] = [];
  const disadvantageSources: string[] = [];
  let autoFailReason: string | null = null;
  for (const [name, effects] of activeEffects(conditions)) {
    if (kind === "attack") {
      if (effects.ownAttacksHaveAdvantage) advantageSources.push(`attacker is ${name}`);
      if (effects.ownAttacksHaveDisadvantage) disadvantageSources.push(`attacker is ${name}`);
    } else if (kind === "ability_check") {
      if (effects.abilityChecksHaveDisadvantage) disadvantageSources.push(name);
    } else {
      if (
        effects.savingThrowsHaveDisadvantage ||
        (ability === "dexterity" && effects.dexteritySavesHaveDisadvantage)
      ) {
        disadvantageSources.push(name);
      }
      if (
        autoFailReason === null &&
        effects.autoFailStrDexSaves &&
        (ability === "strength" || ability === "dexterity")
      ) {
        autoFailReason = `${name} — automatically fails Strength and Dexterity saves`;
      }
    }
  }
  return { advantageSources, disadvantageSources, autoFailReason };
}

/**
 * The attack target's conditions applied to an attack against it.
 * `distanceFeet` is the attacker-to-target distance (gridDistanceFeet, the
 * flat measure every other range query uses), or null when it can't
 * be measured (no tokens, different maps) — the range-dependent rules
 * (Prone's split, the within-5-ft auto-crit) then contribute nothing.
 */
export function targetConditionAttackEffects(
  conditions: readonly AppliedCondition[],
  distanceFeet: number | null
): TargetConditionAttackEffects {
  const advantageSources: string[] = [];
  const disadvantageSources: string[] = [];
  let autoCriticalReason: string | null = null;
  const within = distanceFeet !== null && distanceFeet <= WITHIN_FEET;
  for (const [name, effects] of activeEffects(conditions)) {
    if (effects.attacksAgainstHaveAdvantage) {
      advantageSources.push(`target has ${name} (advantage against)`);
    }
    if (effects.attacksAgainstHaveDisadvantage) {
      disadvantageSources.push(`target has ${name} (disadvantage against)`);
    }
    if (effects.attacksAgainstSplitByRange && distanceFeet !== null) {
      if (within) advantageSources.push(`target has ${name} (attacker within 5 ft)`);
      else disadvantageSources.push(`target has ${name} (attacker beyond 5 ft)`);
    }
    if (effects.hitsWithin5FtAreCritical && within && autoCriticalReason === null) {
      autoCriticalReason = `target has ${name} (hit within 5 ft is a critical hit)`;
    }
  }
  return { advantageSources, disadvantageSources, autoCriticalReason };
}
