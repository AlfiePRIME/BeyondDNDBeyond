// Shared type definitions for the SRD content dataset. Every srd/* data file
// and every calculation module in the parent rules-engine/ folder imports
// from here, so this stays free of any actual data.

export type AbilityScore = "strength" | "dexterity" | "constitution" | "intelligence" | "wisdom" | "charisma";

export type AbilityScores = Record<AbilityScore, number>;

export type Size = "tiny" | "small" | "medium" | "large";

export interface AbilityScoreIncrease {
  // "choice" represents SRD races (e.g. Half-Elf) that grant a bonus to
  // ability scores the player picks rather than a fixed one.
  ability: AbilityScore | "choice";
  amount: number;
}

export interface RaceTrait {
  name: string;
}

export interface DraconicAncestry {
  dragonType: string;
  damageType: string;
  breathWeapon: string;
}

export type RaceName =
  | "Dwarf"
  | "Elf"
  | "Halfling"
  | "Human"
  | "Dragonborn"
  | "Gnome"
  | "Half-Elf"
  | "Half-Orc"
  | "Tiefling"
  | "Aarakocra"
  | "Bugbear"
  | "Firbolg"
  | "Goblin"
  | "Goliath"
  | "Hobgoblin"
  | "Kenku"
  | "Kobold"
  | "Lizardfolk"
  | "Orc"
  | "Tabaxi"
  | "Triton"
  | "Yuan-ti Pureblood"
  | "Tortle"
  | "Genasi"
  | "Duergar"
  | "Changeling"
  | "Kalashtar"
  | "Shifter"
  | "Warforged"
  | "Centaur"
  | "Loxodon"
  | "Minotaur"
  | "Vedalken"
  | "Leonin"
  | "Satyr";

export interface SubraceDefinition {
  name: string;
  abilityScoreIncreases: AbilityScoreIncrease[];
  traits: RaceTrait[];
  darkvisionFeet?: number;
  speedFeet?: number;
}

export interface RaceDefinition {
  name: RaceName;
  size: Size;
  speedFeet: number;
  abilityScoreIncreases: AbilityScoreIncrease[];
  darkvisionFeet?: number;
  resistances?: string[];
  traits: RaceTrait[];
  subraces?: SubraceDefinition[];
  draconicAncestries?: DraconicAncestry[];
}

export type ClassName =
  | "Barbarian"
  | "Bard"
  | "Cleric"
  | "Druid"
  | "Fighter"
  | "Monk"
  | "Paladin"
  | "Ranger"
  | "Rogue"
  | "Sorcerer"
  | "Warlock"
  | "Wizard";

// Drives the spell slot table (see spellSlots.ts): full casters use the
// standard 9-level slot progression, half casters use the same table at
// half rate, "pact" is Warlock's distinct Pact Magic progression, and
// "none" gets no slots. SRD base classes have no third-caster subclass, so
// that progression type is intentionally not modeled here.
export type CasterProgression = "full" | "half" | "pact" | "none";

export interface ClassFeature {
  name: string;
  level: number;
}

export interface ClassDefinition {
  name: ClassName;
  hitDie: number;
  savingThrowProficiencies: [AbilityScore, AbilityScore];
  spellcastingAbility?: AbilityScore;
  casterProgression: CasterProgression;
  features: ClassFeature[];
}

/**
 * A single SRD-legal subclass (Barbarian's Primal Path pick, Wizard's
 * Arcane Tradition pick, etc.) — one per base class in this catalog (see
 * srd/subclasses.ts), the exact PHB subclass reproduced in the SRD 5.1
 * document for that class. `features` mirrors ClassDefinition's own
 * level-gated shape so the level-up wizard's feature-diff logic (old level
 * -> new level) treats base-class and subclass features identically; the
 * level-up wizard's own gating (the level-up wizard finds the base class's
 * subclass-CHOICE level from ClassDefinition.features by name, e.g. Rogue's
 * "Roguish Archetype" at level 3) decides WHEN a subclass can be picked,
 * not this type.
 */
export interface SubclassDefinition {
  name: string;
  className: ClassName;
  features: ClassFeature[];
}

export type SkillName =
  | "Acrobatics"
  | "Animal Handling"
  | "Arcana"
  | "Athletics"
  | "Deception"
  | "History"
  | "Insight"
  | "Intimidation"
  | "Investigation"
  | "Medicine"
  | "Nature"
  | "Perception"
  | "Performance"
  | "Persuasion"
  | "Religion"
  | "Sleight of Hand"
  | "Stealth"
  | "Survival";

export interface SkillDefinition {
  name: SkillName;
  ability: AbilityScore;
}

export type SpellSchool =
  | "abjuration"
  | "conjuration"
  | "divination"
  | "enchantment"
  | "evocation"
  | "illusion"
  | "necromancy"
  | "transmutation";

export type SpellLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

// A number is feet; "self" and "touch" are the SRD's symbolic ranges that
// don't reduce to a feet value. Non-spell actions (range.ts) reuse this
// exact type so both can flow through the same range query.
export type SpellRange = number | "self" | "touch";

export type TargetType = "self" | "single" | "area" | "point";

/**
 * How a spell that RAW resolves via a SPELL ATTACK ROLL against a single
 * target lands (Prompt 51). `kind` records the SRD's melee-vs-ranged spell
 * attack wording (display/range flavor only — BOTH use the spellcasting
 * ability, so the roll route's attackKind is always "spell");
 * `damageNotation` is the spell's base on-hit dice in the dice module's
 * notation. Populated ONLY for catalog spells whose SRD 5.1 text says
 * "make a melee/ranged spell attack" AND that deal fixed on-hit dice —
 * spells resolved by a saving throw the TARGET makes (Fireball), auto-hit
 * spells (Magic Missile), and attack-roll spells with no damage dice (Ray
 * of Enfeeblement, Contagion) leave this undefined. See srd/spells.ts for
 * the curated table and its per-spell reasoning.
 */
export interface SpellAttack {
  kind: "melee" | "ranged";
  damageNotation: string;
}

export interface Spell {
  name: string;
  level: SpellLevel;
  school: SpellSchool;
  range: SpellRange;
  targetType: TargetType;
  concentration: boolean;
  classes: ClassName[];
  attack?: SpellAttack;
}

export type ConditionKey =
  | "blinded"
  | "charmed"
  | "deafened"
  | "frightened"
  | "grappled"
  | "incapacitated"
  | "invisible"
  | "paralyzed"
  | "petrified"
  | "poisoned"
  | "prone"
  | "restrained"
  | "stunned"
  | "unconscious";

export type ExhaustionLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Mechanical-effect flags as structured data, NOT enforcement — Prompt 47
 * only stores and displays them; Prompt 53 (action economy) reads
 * incapacitated/speed flags, Prompt 56 (vision) reads blocksVision/
 * hiddenFromSight, Prompt 59 (advantage/disadvantage) reads the roll
 * flags. A flag records that the condition imposes the effect at all;
 * situational qualifiers in the SRD text (frightened's line-of-sight
 * clause, prone's melee-vs-ranged split) stay in the description and are
 * the enforcing prompt's problem, so a new condition never needs a new
 * storage shape.
 */
export interface ConditionEffects {
  blocksVision: boolean;
  blocksHearing: boolean;
  /** Invisible — can't be seen without a special sense (Prompt 56). */
  hiddenFromSight: boolean;
  speedZero: boolean;
  speedHalved: boolean;
  /** Can't take actions or reactions. */
  incapacitated: boolean;
  autoFailStrDexSaves: boolean;
  attacksAgainstHaveAdvantage: boolean;
  attacksAgainstHaveDisadvantage: boolean;
  ownAttacksHaveAdvantage: boolean;
  ownAttacksHaveDisadvantage: boolean;
  abilityChecksHaveDisadvantage: boolean;
  savingThrowsHaveDisadvantage: boolean;
}

export interface ConditionDefinition {
  key: ConditionKey;
  name: string;
  /** Two-letter badge label for token chips, unique across the catalog. */
  abbreviation: string;
  description: string;
  effects: ConditionEffects;
}

export interface EquipmentChoice {
  // Each inner string[] is one selectable bundle of items; the character
  // picks exactly one bundle from `options`.
  options: string[][];
}

export interface ClassStartingEquipment {
  className: ClassName;
  fixed: string[];
  choices: EquipmentChoice[];
}
