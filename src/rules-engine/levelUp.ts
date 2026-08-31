// Pure calculations for the guided level-up wizard (CharacterSheet's
// one-click levelUp() and PartyDashboard's confirmLevelUp() both used to
// stop at "SRD average HP gain" — this module is everything the wizard
// adds on top: which features were just gained, when a subclass choice is
// on offer, when an Ability Score Improvement is on offer, and how many new
// spells a caster can pick). Nothing here touches the database — the
// LevelUpWizard component and its two trigger points own persistence, the
// same split rules-engine keeps everywhere else (spellSlots.ts computes,
// the character sheet page persists).
import { CLASSES } from "./srd/classes";
import { SUBCLASSES } from "./srd/subclasses";
import type { AbilityScore, AbilityScores, ClassFeature, ClassName } from "./srd/types";

/**
 * The base class's own feature name that marks "this is the level you pick
 * a subclass" — Cleric/Sorcerer/Warlock gate at level 1, Druid/Wizard at
 * level 2, every other class at level 3. Keyed by NAME (not a hardcoded
 * level) so subclassGateLevel below reads the actual level from each
 * class's own `features` array in classes.ts — the single source of truth
 * a future edit to that array can't silently desync from.
 */
const SUBCLASS_GATE_FEATURE_NAME: Record<ClassName, string> = {
  Barbarian: "Primal Path",
  Bard: "Bard College",
  Cleric: "Divine Domain",
  Druid: "Druid Circle",
  Fighter: "Martial Archetype",
  Monk: "Monastic Tradition",
  Paladin: "Sacred Oath",
  Ranger: "Ranger Archetype",
  Rogue: "Roguish Archetype",
  Sorcerer: "Sorcerous Origin",
  Warlock: "Otherworldly Patron",
  Wizard: "Arcane Tradition",
};

/** The character level at which `className` offers its ONE SRD subclass
 * choice, derived from the base class's own named feature rather than a
 * second hardcoded table. Null only for a class name outside the CLASSES
 * catalog (homebrew/unrecognized). */
export function subclassGateLevel(className: ClassName): number | null {
  const featureName = SUBCLASS_GATE_FEATURE_NAME[className];
  const klass = CLASSES.find((c) => c.name === className);
  return klass?.features.find((f) => f.name === featureName)?.level ?? null;
}

/** The catalog's one SRD subclass for `className` (see srd/subclasses.ts
 * for why it's exactly one), or null for an unrecognized class name. */
export function subclassForClass(className: ClassName) {
  return SUBCLASSES.find((s) => s.className === className) ?? null;
}

/** Every catalog subclass option for `className`, for the level-up
 * wizard's subclass-choice card grid — a list (not just subclassForClass's
 * single lookup) since this catalog holding exactly one option per class
 * today is a scope choice, not a structural limit; a future added
 * subclass needs no change here. */
export function subclassesForClass(className: ClassName) {
  return SUBCLASSES.filter((s) => s.className === className);
}

/**
 * Every level at which `className` (optionally combined with an already
 * -chosen `subclassName`) grants an Ability Score Improvement — read
 * straight from both feature lists' own "Ability Score Improvement"
 * entries rather than a hardcoded 4/8/12/16/19 constant, because some
 * classes (Fighter) and in principle some subclasses have bonus ASI levels
 * that differ from the vanilla progression. None of this catalog's 12 SRD
 * subclasses happen to grant a bonus ASI, but the lookup still checks the
 * subclass's own features for one, so a future subclass that does needs no
 * change here.
 */
export function asiLevelsForClass(className: ClassName, subclassName?: string | null): number[] {
  const klass = CLASSES.find((c) => c.name === className);
  const subclass = subclassName
    ? SUBCLASSES.find((s) => s.className === className && s.name === subclassName)
    : undefined;
  const all = [...(klass?.features ?? []), ...(subclass?.features ?? [])];
  const levels = new Set(
    all.filter((f) => f.name === "Ability Score Improvement").map((f) => f.level)
  );
  return [...levels].sort((a, b) => a - b);
}

/**
 * Every base-class AND subclass feature strictly newer than `fromLevel`
 * and at or before `toLevel`, sorted for display. `subclassName` should be
 * the character's subclass in effect for this comparison — either one
 * already chosen at a prior level, or the one just picked in step 2 of the
 * SAME level-up (so a subclass's own first-tier features show as "gained"
 * alongside the base class's subclass-choice feature, exactly like the SRD
 * grants them together). Passing null/undefined when no subclass is chosen
 * yet correctly yields no subclass features.
 */
export function featuresGainedBetween(
  className: ClassName,
  subclassName: string | null | undefined,
  fromLevel: number,
  toLevel: number
): ClassFeature[] {
  const klass = CLASSES.find((c) => c.name === className);
  const subclass = subclassName
    ? SUBCLASSES.find((s) => s.className === className && s.name === subclassName)
    : undefined;
  const all = [...(klass?.features ?? []), ...(subclass?.features ?? [])];
  return all
    .filter((f) => f.level > fromLevel && f.level <= toLevel)
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

// --- New spells known/prepared (advisory only — see newSpellsKnownDelta) ---

// Real SRD "Spells Known" columns for the four classes that keep a fixed
// known-spell list (everyone else prepares from their WHOLE class list
// each day instead — see preparedSpellCount below). Index 0 is unused
// (character levels are 1-based); index N is the total known AT level N.
const BARD_SPELLS_KNOWN = [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 15, 16, 18, 19, 19, 20, 22, 22, 22];
const SORCERER_SPELLS_KNOWN = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 15];
const RANGER_SPELLS_KNOWN = [0, 0, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11];
const WARLOCK_SPELLS_KNOWN = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15];

function knownSpellsTable(className: ClassName): readonly number[] | null {
  switch (className) {
    case "Bard":
      return BARD_SPELLS_KNOWN;
    case "Sorcerer":
      return SORCERER_SPELLS_KNOWN;
    case "Ranger":
      return RANGER_SPELLS_KNOWN;
    case "Warlock":
      return WARLOCK_SPELLS_KNOWN;
    default:
      return null;
  }
}

/** SRD "prepared spells" formula for the whole-list-prepared classes:
 * spellcasting ability modifier + class level (Paladin: + HALF class
 * level, rounded down, since it's a half caster that still prepares
 * rather than knows) — minimum 1. Wizard also uses this for how many
 * spells it can PREPARE, but separately gets a flat +2 spellbook additions
 * per level (see newSpellsKnownDelta) — this app has no prepared/known
 * distinction (one flat `character.spells` list), and the flat spellbook
 * number is the closer fit for "how many can I add to my sheet this
 * level" for a Wizard specifically. */
function preparedSpellCount(className: ClassName, level: number, abilityModifier: number): number {
  const effectiveLevel = className === "Paladin" ? Math.floor(level / 2) : level;
  return Math.max(1, effectiveLevel + abilityModifier);
}

/**
 * How many NEW spells `className` can add to its list going from
 * oldLevel to newLevel — real SRD progressions, but ADVISORY only: this
 * app tracks one flat `character.spells` array with no enforced cap
 * anywhere (the character sheet's own manual "Add a spell" control has
 * never enforced one either), so the level-up wizard shows this as a
 * suggested count on an otherwise-freely-editable step, never a hard
 * block. Returns 0 for a non-caster or an unrecognized class name.
 */
export function newSpellsKnownDelta(
  className: ClassName,
  oldLevel: number,
  newLevel: number,
  spellcastingAbilityModifier: number
): number {
  const table = knownSpellsTable(className);
  if (table) {
    const clampedOld = Math.min(20, Math.max(0, Math.trunc(oldLevel)));
    const clampedNew = Math.min(20, Math.max(0, Math.trunc(newLevel)));
    return Math.max(0, table[clampedNew] - table[clampedOld]);
  }
  if (className === "Wizard") {
    return Math.max(0, Math.trunc(newLevel) - Math.trunc(oldLevel)) * 2;
  }
  if (className === "Cleric" || className === "Druid" || className === "Paladin") {
    return Math.max(
      0,
      preparedSpellCount(className, newLevel, spellcastingAbilityModifier) -
        preparedSpellCount(className, oldLevel, spellcastingAbilityModifier)
    );
  }
  return 0;
}

// --- Ability Score Improvement ---

export type AbilityScoreImprovementChoice =
  | { mode: "single"; ability: AbilityScore }
  | { mode: "double"; abilities: [AbilityScore, AbilityScore] };

/** The SRD rule itself: a valid ASI is +2 to one score, or +1 to two
 * DIFFERENT scores — never +1 twice to the same score (that's just +2
 * mislabeled) and never a partial pick. */
export function isValidAbilityScoreImprovementChoice(
  choice: Partial<AbilityScoreImprovementChoice> | null | undefined
): choice is AbilityScoreImprovementChoice {
  if (!choice) return false;
  if (choice.mode === "single") return Boolean(choice.ability);
  if (choice.mode === "double") {
    const abilities = choice.abilities;
    return (
      Array.isArray(abilities) &&
      abilities.length === 2 &&
      Boolean(abilities[0]) &&
      Boolean(abilities[1]) &&
      abilities[0] !== abilities[1]
    );
  }
  return false;
}

/** Applies a validated ASI choice to a set of ability scores, returning a
 * NEW object (scores are otherwise plain character columns the caller
 * patches in one updateCharacter call alongside everything else the
 * level-up wizard changes). Throws on an invalid choice rather than
 * silently no-op'ing — callers gate the confirm button on
 * isValidAbilityScoreImprovementChoice first. */
export function applyAbilityScoreImprovement(
  scores: AbilityScores,
  choice: AbilityScoreImprovementChoice
): AbilityScores {
  if (!isValidAbilityScoreImprovementChoice(choice)) {
    throw new Error("An Ability Score Improvement must be +2 to one score or +1 to two different scores.");
  }
  const next = { ...scores };
  if (choice.mode === "single") {
    next[choice.ability] += 2;
  } else {
    const [a, b] = choice.abilities;
    next[a] += 1;
    next[b] += 1;
  }
  return next;
}
