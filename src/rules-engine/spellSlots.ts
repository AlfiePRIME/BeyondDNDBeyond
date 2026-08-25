import { CLASSES } from "./srd/classes";
import type { CasterProgression, ClassDefinition, ClassName } from "./srd/types";

export type SpellSlotLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type SpellSlots = Record<SpellSlotLevel, number>;

/** Every slot level, in order — the iteration order provisioning and
 * lookups share. */
export const SPELL_SLOT_LEVELS: SpellSlotLevel[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const ORDINAL: Record<SpellSlotLevel, string> = {
  1: "1st",
  2: "2nd",
  3: "3rd",
  4: "4th",
  5: "5th",
  6: "6th",
  7: "7th",
  8: "8th",
  9: "9th",
};

/**
 * The `character_resources.name` under which a slot level's uses are
 * tracked (the sheet provisions these rows lazily on a caster's first
 * sheet load). Extracted here in Prompt 51 from the character sheet
 * page's local copy so the sheet and the quick-actions availability check
 * derive the same names from one source of truth — it's a pure function
 * of SpellSlotLevel, so this module is its natural home.
 */
export function spellSlotResourceName(level: SpellSlotLevel): string {
  return `${ORDINAL[level]}-Level Spell Slots`;
}

const EMPTY_SLOTS: SpellSlots = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };

function slotsFromArray(counts: readonly number[]): SpellSlots {
  return {
    1: counts[0] ?? 0,
    2: counts[1] ?? 0,
    3: counts[2] ?? 0,
    4: counts[3] ?? 0,
    5: counts[4] ?? 0,
    6: counts[5] ?? 0,
    7: counts[6] ?? 0,
    8: counts[7] ?? 0,
    9: counts[8] ?? 0,
  };
}

// Standard SRD full-caster slot table (Bard/Cleric/Druid/Sorcerer/Wizard),
// indexed by character level 1-20. Index 0 in each row is 1st-level slots,
// index 8 is 9th-level slots.
const FULL_CASTER_SLOTS_BY_LEVEL: readonly (readonly number[])[] = [
  [], // level 0 unused, character levels start at 1
  [2, 0, 0, 0, 0, 0, 0, 0, 0],
  [3, 0, 0, 0, 0, 0, 0, 0, 0],
  [4, 2, 0, 0, 0, 0, 0, 0, 0],
  [4, 3, 0, 0, 0, 0, 0, 0, 0],
  [4, 3, 2, 0, 0, 0, 0, 0, 0],
  [4, 3, 3, 0, 0, 0, 0, 0, 0],
  [4, 3, 3, 1, 0, 0, 0, 0, 0],
  [4, 3, 3, 2, 0, 0, 0, 0, 0],
  [4, 3, 3, 3, 1, 0, 0, 0, 0],
  [4, 3, 3, 3, 2, 0, 0, 0, 0],
  [4, 3, 3, 3, 2, 1, 0, 0, 0],
  [4, 3, 3, 3, 2, 1, 0, 0, 0],
  [4, 3, 3, 3, 2, 1, 1, 0, 0],
  [4, 3, 3, 3, 2, 1, 1, 0, 0],
  [4, 3, 3, 3, 2, 1, 1, 1, 0],
  [4, 3, 3, 3, 2, 1, 1, 1, 0],
  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

// Warlock's Pact Magic: unlike every other caster, Warlock has very few
// slots but they're always all cast at (and regained up to) this single
// highest available slot level — there's no spread across multiple spell
// levels the way full/half casters have.
const PACT_MAGIC_BY_LEVEL: readonly { slotLevel: SpellSlotLevel; slotCount: number }[] = [
  { slotLevel: 1, slotCount: 0 }, // level 0 unused
  { slotLevel: 1, slotCount: 1 },
  { slotLevel: 1, slotCount: 2 },
  { slotLevel: 2, slotCount: 2 },
  { slotLevel: 2, slotCount: 2 },
  { slotLevel: 3, slotCount: 2 },
  { slotLevel: 3, slotCount: 2 },
  { slotLevel: 4, slotCount: 2 },
  { slotLevel: 4, slotCount: 2 },
  { slotLevel: 5, slotCount: 2 },
  { slotLevel: 5, slotCount: 2 },
  { slotLevel: 5, slotCount: 3 },
  { slotLevel: 5, slotCount: 3 },
  { slotLevel: 5, slotCount: 3 },
  { slotLevel: 5, slotCount: 3 },
  { slotLevel: 5, slotCount: 3 },
  { slotLevel: 5, slotCount: 3 },
  { slotLevel: 5, slotCount: 4 },
  { slotLevel: 5, slotCount: 4 },
  { slotLevel: 5, slotCount: 4 },
  { slotLevel: 5, slotCount: 4 },
];

function clampLevel(characterLevel: number): number {
  return Math.min(Math.max(Math.trunc(characterLevel), 0), 20);
}

export function getPactMagicSlots(characterLevel: number): { slotLevel: SpellSlotLevel; slotCount: number } {
  return PACT_MAGIC_BY_LEVEL[clampLevel(characterLevel)];
}

function slotsForProgression(progression: CasterProgression, characterLevel: number): SpellSlots {
  const level = clampLevel(characterLevel);

  if (progression === "none") return EMPTY_SLOTS;

  if (progression === "pact") {
    const { slotLevel, slotCount } = getPactMagicSlots(level);
    if (slotCount === 0) return EMPTY_SLOTS;
    return { ...EMPTY_SLOTS, [slotLevel]: slotCount };
  }

  // Half casters (Paladin/Ranger) don't get spells until level 2, and from
  // then on progress at half the rate of a full caster — modeled as
  // reading the full-caster table at half the character level rather than
  // a second hand-copied table, so the two stay in sync by construction.
  const effectiveLevel = progression === "half" ? (level < 2 ? 0 : Math.ceil(level / 2)) : level;

  return slotsFromArray(FULL_CASTER_SLOTS_BY_LEVEL[effectiveLevel] ?? []);
}

export function getSpellSlots(classDefinition: ClassDefinition, characterLevel: number): SpellSlots {
  return slotsForProgression(classDefinition.casterProgression, characterLevel);
}

export function spellSlotsForClass(className: ClassName, characterLevel: number): SpellSlots {
  const classDefinition = CLASSES.find((c) => c.name === className);
  if (!classDefinition) throw new Error(`Unknown class: ${className}`);
  return getSpellSlots(classDefinition, characterLevel);
}
