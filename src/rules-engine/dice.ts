// Pure dice math. Randomness is injected (defaulting to Math.random) — the
// same testable-seam pattern as src/ai's LLM calls — because the ACTUAL
// rolling must happen server-side only (a client claiming "I rolled a 20"
// can't be trusted), while unit tests need deterministic outcomes. This
// module never decides WHERE it runs; the roll Route Handler is the only
// production caller of the rolling functions.

/** Returns a value in [0, 1), like Math.random. */
export type RandomSource = () => number;

export interface DiceTerm {
  count: number;
  sides: number;
  sign: 1 | -1;
}

/** A parsed dice notation: dice terms plus one folded flat modifier. */
export interface DiceExpression {
  terms: DiceTerm[];
  modifier: number;
}

const MAX_TERMS = 10;
const MAX_DICE_PER_TERM = 100;
const MAX_SIDES = 1000;
const MAX_MODIFIER = 10000;

const TERM_PATTERN = /^([+-]?)(?:(\d*)d(\d+)|(\d+))/;

/**
 * Parses "NdS" notation with flat modifiers and multiple dice types:
 * "1d20", "2d6+3", "d8-1", "2d6+1d4+3". Whitespace-insensitive. Returns
 * null on anything malformed or out of sane bounds.
 */
export function parseDiceNotation(notation: string): DiceExpression | null {
  let rest = notation.replace(/\s+/g, "").toLowerCase();
  if (rest === "") return null;

  const terms: DiceTerm[] = [];
  let modifier = 0;
  let first = true;

  while (rest !== "") {
    const match = TERM_PATTERN.exec(rest);
    if (!match) return null;
    const [consumed, signText, countText, sidesText, flatText] = match;
    if (!first && signText === "") return null;
    const sign: 1 | -1 = signText === "-" ? -1 : 1;

    if (sidesText !== undefined) {
      const count = countText === "" || countText === undefined ? 1 : Number(countText);
      const sides = Number(sidesText);
      if (count < 1 || count > MAX_DICE_PER_TERM || sides < 2 || sides > MAX_SIDES) return null;
      if (terms.length >= MAX_TERMS) return null;
      terms.push({ count, sides, sign });
    } else {
      const flat = Number(flatText);
      if (flat > MAX_MODIFIER) return null;
      modifier += sign * flat;
    }

    rest = rest.slice(consumed.length);
    first = false;
  }

  if (terms.length === 0) return null;
  return { terms, modifier };
}

/** Rolls one die: an integer in [1, sides]. */
export function rollDie(sides: number, random: RandomSource = Math.random): number {
  // The min guard only matters for injected sources that return exactly 1.
  return Math.min(sides, Math.floor(random() * sides) + 1);
}

export function rollDice(
  count: number,
  sides: number,
  random: RandomSource = Math.random
): number[] {
  return Array.from({ length: count }, () => rollDie(sides, random));
}

export interface RolledDiceGroup extends DiceTerm {
  results: number[];
}

export interface DiceRollResult {
  groups: RolledDiceGroup[];
  modifier: number;
  total: number;
}

export function rollExpression(
  expression: DiceExpression,
  random: RandomSource = Math.random
): DiceRollResult {
  const groups = expression.terms.map((term) => ({
    ...term,
    results: rollDice(term.count, term.sides, random),
  }));
  const total =
    groups.reduce(
      (sum, group) => sum + group.sign * group.results.reduce((a, b) => a + b, 0),
      0
    ) + expression.modifier;
  return { groups, modifier: expression.modifier, total };
}

/** A critical hit rolls double the attack's damage DICE; flat modifiers are
 * not doubled (SRD rule). */
export function doubleDiceExpression(expression: DiceExpression): DiceExpression {
  return {
    terms: expression.terms.map((term) => ({ ...term, count: term.count * 2 })),
    modifier: expression.modifier,
  };
}

export type AdvantageMode = "normal" | "advantage" | "disadvantage";

export interface D20Roll {
  mode: AdvantageMode;
  /** One entry for a normal roll, two for advantage/disadvantage. */
  rolls: number[];
  /** The die that counts: higher of the two on advantage, lower on
   * disadvantage. */
  result: number;
}

/**
 * The one d20 primitive every d20-based roll (checks, saves, attacks,
 * initiative — and later death saves and concentration) goes through, so
 * advantage/disadvantage is implemented exactly once.
 */
export function rollD20(
  mode: AdvantageMode = "normal",
  random: RandomSource = Math.random
): D20Roll {
  if (mode === "normal") {
    const roll = rollDie(20, random);
    return { mode, rolls: [roll], result: roll };
  }
  const rolls = [rollDie(20, random), rollDie(20, random)];
  const result = mode === "advantage" ? Math.max(...rolls) : Math.min(...rolls);
  return { mode, rolls, result };
}

export interface AttackOutcome {
  natural20: boolean;
  natural1: boolean;
  hit: boolean;
  critical: boolean;
}

export interface DeathSaveOutcome {
  natural20: boolean;
  natural1: boolean;
  /** Natural 20: regain 1 HP immediately, the whole sequence ends. */
  recovers: boolean;
  /** How many successes this roll adds (0 or 1). */
  successesDelta: number;
  /** How many failures this roll adds (0, 1, or 2 — a natural 1 is two). */
  failuresDelta: number;
}

/**
 * SRD death saving throw: a plain d20, no modifiers. Natural 20 regains
 * 1 HP and ends the sequence; natural 1 counts as TWO failures; 10 or
 * higher is one success; anything else is one failure. Pure resolution
 * only — accumulating the counts (and the stabilized/dead outcomes at
 * three) happens in the apply_death_save_roll RPC, which trusts these
 * deltas the same way resolve_attack_damage trusts a pre-computed damage
 * number.
 */
export function resolveDeathSave(naturalRoll: number): DeathSaveOutcome {
  const natural20 = naturalRoll === 20;
  const natural1 = naturalRoll === 1;
  return {
    natural20,
    natural1,
    recovers: natural20,
    successesDelta: !natural20 && !natural1 && naturalRoll >= 10 ? 1 : 0,
    failuresDelta: natural1 ? 2 : !natural20 && naturalRoll < 10 ? 1 : 0,
  };
}

/** Natural 20 always hits and crits regardless of AC; natural 1 always
 * misses regardless of bonus; otherwise meets-it-beats-it. */
export function resolveAttackOutcome(
  naturalRoll: number,
  attackBonus: number,
  targetAc: number
): AttackOutcome {
  const natural20 = naturalRoll === 20;
  const natural1 = naturalRoll === 1;
  const hit = natural20 || (!natural1 && naturalRoll + attackBonus >= targetAc);
  return { natural20, natural1, hit, critical: natural20 };
}
