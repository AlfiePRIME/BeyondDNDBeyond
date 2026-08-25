// Public entry point for the rules-engine module. Other modules should only ever
// import from "@/rules-engine" (this file), never reach into internal files —
// enforced by eslint-plugin-boundaries (see eslint.config.mjs).
//
// Pure D&D 5e SRD mechanics: ability modifiers, saves, skills, spell slots,
// attack bonuses, movement cost, and range/targeting queries, plus the
// static SRD content dataset (races, classes, skills, spells, starting
// equipment) they operate over. Perception/vision and advantage/
// disadvantage are out of scope here — see Prompt 56 and Prompt 59.
export const MODULE_NAME = "rules-engine" as const;

export type {
  AbilityScore,
  AbilityScores,
  Size,
  AbilityScoreIncrease,
  RaceTrait,
  DraconicAncestry,
  RaceName,
  SubraceDefinition,
  RaceDefinition,
  ClassName,
  CasterProgression,
  ClassFeature,
  ClassDefinition,
  SkillName,
  SkillDefinition,
  SpellSchool,
  SpellLevel,
  SpellRange,
  TargetType,
  Spell,
  SpellAttack,
  EquipmentChoice,
  ClassStartingEquipment,
  ConditionKey,
  ConditionEffects,
  ConditionDefinition,
  ExhaustionLevel,
} from "./srd/types";

export { RACES } from "./srd/races";
export { CLASSES } from "./srd/classes";
export { SKILLS, SKILL_ABILITY } from "./srd/skills";
export { SPELLS } from "./srd/spells";
export { STARTING_EQUIPMENT } from "./srd/equipment";
export {
  CONDITIONS,
  CONDITION_BY_KEY,
  EXHAUSTION_KEY,
  EXHAUSTION_LEVEL_DESCRIPTIONS,
  MAX_EXHAUSTION_LEVEL,
  exhaustionEffects,
} from "./srd/conditions";

export { abilityModifier, proficiencyBonus } from "./abilityScores";
export { levelOneHitPoints } from "./hitPoints";
export { savingThrowBonus, skillCheckBonus, passiveScore } from "./checks";
export {
  getSpellSlots,
  spellSlotsForClass,
  getPactMagicSlots,
  spellSlotResourceName,
  SPELL_SLOT_LEVELS,
  type SpellSlotLevel,
  type SpellSlots,
} from "./spellSlots";
export { attackBonus, type AttackKind } from "./attackBonus";

export {
  computeQuickActions,
  weaponRangeFeet,
  DEFAULT_MELEE_RANGE_FEET,
  DEFAULT_RANGED_RANGE_FEET,
  type WeaponAttackKind,
  type QuickAction,
  type QuickActionInventoryItem,
  type QuickActionResource,
  type QuickActionTargetInput,
  type ComputeQuickActionsParams,
} from "./quickActions";

export {
  computeOpportunityAttacks,
  meleeReachFeet,
  meleeWeaponItems,
  type OpportunityAttackHostile,
  type ComputeOpportunityAttacksParams,
  type MeleeWeaponItem,
} from "./opportunityAttacks";

export {
  cellMovementCost,
  gridCellDistance,
  gridDistanceFeet,
  straightCellPath,
  pathMovementCost,
  FEET_PER_CELL,
  FEET_PER_ELEVATION_STEP,
  type TerrainType,
  type CellMovementParams,
  type GridPoint,
  type PathCell,
} from "./movement";

export { usableAtRange, isUsableAtRange, type RangedAction } from "./range";

export {
  parseDiceNotation,
  rollDie,
  rollDice,
  rollExpression,
  doubleDiceExpression,
  rollD20,
  resolveAttackOutcome,
  resolveDeathSave,
  type RandomSource,
  type DiceTerm,
  type DiceExpression,
  type RolledDiceGroup,
  type DiceRollResult,
  type AdvantageMode,
  type D20Roll,
  type AttackOutcome,
  type DeathSaveOutcome,
} from "./dice";
