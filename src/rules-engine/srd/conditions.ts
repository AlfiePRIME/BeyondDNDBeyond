import type { ConditionDefinition, ConditionEffects, ConditionKey } from "./types";

const NO_EFFECTS: ConditionEffects = {
  blocksVision: false,
  blocksHearing: false,
  hiddenFromSight: false,
  speedZero: false,
  speedHalved: false,
  incapacitated: false,
  autoFailStrDexSaves: false,
  attacksAgainstHaveAdvantage: false,
  attacksAgainstHaveDisadvantage: false,
  ownAttacksHaveAdvantage: false,
  ownAttacksHaveDisadvantage: false,
  abilityChecksHaveDisadvantage: false,
  savingThrowsHaveDisadvantage: false,
};

function effects(overrides: Partial<ConditionEffects>): ConditionEffects {
  return { ...NO_EFFECTS, ...overrides };
}

/** The 14 on/off SRD conditions. Exhaustion is deliberately NOT in this
 * list — it's a stacking level 1-6 with cumulative effects, not a boolean
 * state; see exhaustionEffects below. */
export const CONDITIONS: ConditionDefinition[] = [
  {
    key: "blinded",
    name: "Blinded",
    abbreviation: "BL",
    description:
      "Can't see and automatically fails any ability check that requires sight. Attack rolls against the creature have advantage, and its attack rolls have disadvantage.",
    effects: effects({
      blocksVision: true,
      attacksAgainstHaveAdvantage: true,
      ownAttacksHaveDisadvantage: true,
    }),
  },
  {
    key: "charmed",
    name: "Charmed",
    abbreviation: "CH",
    // Its effects are all relative to the charmer (can't attack them; they
    // get advantage on social checks), which no creature-scoped flag can
    // carry — so no flags, description only.
    description:
      "Can't attack the charmer or target them with harmful abilities or magical effects. The charmer has advantage on any ability check to interact socially with the creature.",
    effects: effects({}),
  },
  {
    key: "deafened",
    name: "Deafened",
    abbreviation: "DF",
    description: "Can't hear and automatically fails any ability check that requires hearing.",
    effects: effects({ blocksHearing: true }),
  },
  {
    key: "frightened",
    name: "Frightened",
    abbreviation: "FR",
    description:
      "Disadvantage on ability checks and attack rolls while the source of its fear is within line of sight. Can't willingly move closer to the source of its fear.",
    effects: effects({
      ownAttacksHaveDisadvantage: true,
      abilityChecksHaveDisadvantage: true,
    }),
  },
  {
    key: "grappled",
    name: "Grappled",
    abbreviation: "GR",
    description:
      "Speed becomes 0, and it can't benefit from any bonus to its speed. Ends if the grappler is incapacitated or the creature is removed from the grappler's reach.",
    effects: effects({ speedZero: true }),
  },
  {
    key: "incapacitated",
    name: "Incapacitated",
    abbreviation: "IC",
    description: "Can't take actions or reactions.",
    effects: effects({ incapacitated: true }),
  },
  {
    key: "invisible",
    name: "Invisible",
    abbreviation: "IV",
    description:
      "Impossible to see without the aid of magic or a special sense; heavily obscured for the purpose of hiding. Attack rolls against the creature have disadvantage, and its attack rolls have advantage.",
    effects: effects({
      hiddenFromSight: true,
      attacksAgainstHaveDisadvantage: true,
      ownAttacksHaveAdvantage: true,
    }),
  },
  {
    key: "paralyzed",
    name: "Paralyzed",
    abbreviation: "PA",
    description:
      "Incapacitated and can't move or speak. Automatically fails Strength and Dexterity saving throws. Attack rolls against the creature have advantage, and any hit from within 5 feet is a critical hit.",
    effects: effects({
      incapacitated: true,
      speedZero: true,
      autoFailStrDexSaves: true,
      attacksAgainstHaveAdvantage: true,
    }),
  },
  {
    key: "petrified",
    name: "Petrified",
    abbreviation: "PT",
    // "Unaware of its surroundings" = perceives nothing, hence both
    // blocksVision and blocksHearing (same for unconscious below).
    description:
      "Transformed into a solid inanimate substance. Incapacitated, can't move or speak, and is unaware of its surroundings. Automatically fails Strength and Dexterity saving throws. Attack rolls against the creature have advantage. Resistance to all damage; immune to poison and disease.",
    effects: effects({
      incapacitated: true,
      speedZero: true,
      blocksVision: true,
      blocksHearing: true,
      autoFailStrDexSaves: true,
      attacksAgainstHaveAdvantage: true,
    }),
  },
  {
    key: "poisoned",
    name: "Poisoned",
    abbreviation: "PS",
    description: "Disadvantage on attack rolls and ability checks.",
    effects: effects({
      ownAttacksHaveDisadvantage: true,
      abilityChecksHaveDisadvantage: true,
    }),
  },
  {
    key: "prone",
    name: "Prone",
    abbreviation: "PR",
    // Crawling costs 1 extra foot per foot moved — halved speed in effect.
    // Attacks against it split by range (advantage within 5 feet,
    // disadvantage beyond), so neither attacks-against flag is set — the
    // split lives in the description for Prompt 59 to resolve by range.
    description:
      "Can only crawl (each foot of movement costs 1 extra foot) until it stands up. Disadvantage on attack rolls. Attack rolls against the creature have advantage from within 5 feet, and disadvantage from farther away.",
    effects: effects({
      speedHalved: true,
      ownAttacksHaveDisadvantage: true,
    }),
  },
  {
    key: "restrained",
    name: "Restrained",
    abbreviation: "RS",
    // Its Dexterity-save disadvantage is DEX-only, narrower than the
    // all-saves flag, so it stays in the description.
    description:
      "Speed becomes 0, and it can't benefit from any bonus to its speed. Attack rolls against the creature have advantage, and its attack rolls have disadvantage. Disadvantage on Dexterity saving throws.",
    effects: effects({
      speedZero: true,
      attacksAgainstHaveAdvantage: true,
      ownAttacksHaveDisadvantage: true,
    }),
  },
  {
    key: "stunned",
    name: "Stunned",
    abbreviation: "ST",
    description:
      "Incapacitated, can't move, and can speak only falteringly. Automatically fails Strength and Dexterity saving throws. Attack rolls against the creature have advantage.",
    effects: effects({
      incapacitated: true,
      speedZero: true,
      autoFailStrDexSaves: true,
      attacksAgainstHaveAdvantage: true,
    }),
  },
  {
    key: "unconscious",
    name: "Unconscious",
    abbreviation: "UC",
    description:
      "Incapacitated, can't move or speak, and is unaware of its surroundings. Drops whatever it's holding and falls prone. Automatically fails Strength and Dexterity saving throws. Attack rolls against the creature have advantage, and any hit from within 5 feet is a critical hit.",
    effects: effects({
      incapacitated: true,
      speedZero: true,
      blocksVision: true,
      blocksHearing: true,
      autoFailStrDexSaves: true,
      attacksAgainstHaveAdvantage: true,
    }),
  },
];

export const CONDITION_BY_KEY: ReadonlyMap<ConditionKey, ConditionDefinition> = new Map(
  CONDITIONS.map((condition) => [condition.key, condition])
);

/** The stored condition_key for exhaustion rows — outside ConditionKey on
 * purpose, since exhaustion is leveled state, not an on/off condition. */
export const EXHAUSTION_KEY = "exhaustion" as const;

export const MAX_EXHAUSTION_LEVEL = 6;

/** What each level newly adds; the effects in play are the union of every
 * level up to the current one (see exhaustionEffects). */
export const EXHAUSTION_LEVEL_DESCRIPTIONS: Record<number, string> = {
  1: "Disadvantage on ability checks.",
  2: "Speed halved.",
  3: "Disadvantage on attack rolls and saving throws.",
  4: "Hit point maximum halved.",
  5: "Speed reduced to 0.",
  6: "Death.",
};

/**
 * Cumulative flags active at an exhaustion level — level 3 includes levels
 * 1 and 2's effects, per the SRD, so a higher level's flags are always a
 * superset of a lower level's (level 5 keeps speedHalved alongside
 * speedZero; zero wins naturally wherever both are applied). Level 4's
 * halved HP maximum and level 6's death aren't representable as
 * ConditionEffects flags; consumers that care (death handling, HP math)
 * read the level itself alongside EXHAUSTION_LEVEL_DESCRIPTIONS.
 */
export function exhaustionEffects(level: number): ConditionEffects {
  return effects({
    abilityChecksHaveDisadvantage: level >= 1,
    speedHalved: level >= 2,
    ownAttacksHaveDisadvantage: level >= 3,
    savingThrowsHaveDisadvantage: level >= 3,
    speedZero: level >= 5,
  });
}
