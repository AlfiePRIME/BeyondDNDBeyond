// Public entry point for the rules-engine module. Other modules should only ever
// import from "@/rules-engine" (this file), never reach into internal files —
// enforced by eslint-plugin-boundaries (see eslint.config.mjs).
//
// Pure D&D 5e SRD mechanics: ability modifiers, saves, skills, spell slots,
// attack bonuses, movement cost, range/targeting queries, and perception/
// vision, plus the static SRD content dataset (races, classes, skills,
// spells, starting equipment) they operate over. Advantage/disadvantage
// enforcement is still out of scope here — see Prompt 59.
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

export {
  RACES,
  RACE_OPTION_NAMES,
  resolveRaceOption,
  type RaceOptionStats,
} from "./srd/races";
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
export { levelOneHitPoints, levelUpHitPointGain } from "./hitPoints";
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
  computeReachableCells,
  FEET_PER_CELL,
  FEET_PER_ELEVATION_STEP,
  type TerrainType,
  type CrossingType,
  type CellMovementParams,
  type GridPoint,
  type PathCell,
  type MovementCellInput,
  type ComputeReachableCellsParams,
} from "./movement";

export { usableAtRange, isUsableAtRange, type RangedAction } from "./range";

export {
  fallDamageDiceCount,
  resolveFall,
  fallDepthFeet,
  FEET_PER_FALL_DAMAGE_DIE,
  MAX_FALL_DAMAGE_DICE,
  MIN_HAZARD_DEPTH_STEPS,
  CONCEALED_PIT_SAVE_DC,
  type FallOutcome,
} from "./falling";

export {
  computeVisibilityTier,
  computeVisibilityTiers,
  effectiveLightLevel,
  type VisibilityTier,
  type CellLightLevel,
  type ResolvedLightSource,
  type ObserverVision,
  type ComputeVisibilityTierParams,
  type VisibilityCellInput,
  type VisibilityResult,
  type ComputeVisibilityTiersParams,
} from "./perception";

export {
  parseDiceNotation,
  rollDie,
  rollDice,
  rollExpression,
  doubleDiceExpression,
  rollD20,
  combineAdvantageSources,
  resolveAttackOutcome,
  resolveDeathSave,
  type CombinedAdvantage,
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
