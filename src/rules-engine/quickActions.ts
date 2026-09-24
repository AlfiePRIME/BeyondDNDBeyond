import { gridDistanceFeet, type GridPoint } from "./movement";
import { SPELL_SLOT_LEVELS, spellSlotResourceName, type SpellSlotLevel } from "./spellSlots";
import { SPELLS } from "./srd/spells";
import type { SpellLevel } from "./srd/types";

// Pure quick-action decision logic (Prompt 51): given a combatant's
// position/speed, the hostile combatant tokens' positions, the weapon-
// tagged inventory, the known spells, and the current resource state,
// which attacks could be made THIS turn against at least one hostile?
// DB-free like the rest of this module — the Game Room supplies every
// input (the pathMovementCost arrangement). Distance is gridDistanceFeet's
// flat 2D chessboard measure, matching every other range query here;
// elevation affects movement COST (drag-to-move), not range.
//
// "In range" deliberately means "in range given repositioning": the
// character is assumed able to spend their FULL speed stat closing the
// distance (`distance - speed <= range`). There is no per-turn movement
// budget tracked anywhere yet — drag-to-move has no enforced cap, and
// Action/Bonus Action/Movement gating is Prompt 53's dedicated scope — so
// no "movement remaining" input exists to consume here.

/** The three weapon flavors of the roll route's AttackKind — "spell" is
 * never a weapon tag (spell attacks come from Spell.attack metadata). */
export type WeaponAttackKind = "melee" | "ranged" | "finesse";

/** The weapon-relevant slice of data-access's InventoryItem (structural —
 * this module can't import data-access). An item with no attackKind is
 * ordinary gear, never a quick action. */
export interface QuickActionInventoryItem {
  name: string;
  attackKind?: WeaponAttackKind;
  damageNotation?: string;
  rangeFeet?: number;
}

/** The availability-relevant slice of data-access's CharacterResource. */
export interface QuickActionResource {
  name: string;
  current_uses: number;
}

/** A hostile combatant's token, as position plus the id the caller needs
 * back to fire at it. */
export interface QuickActionTargetInput {
  tokenId: string;
  position: GridPoint;
}

export const DEFAULT_MELEE_RANGE_FEET = 5;
/** Documented stand-in: no per-weapon SRD range table is modeled anywhere
 * yet, so an untyped ranged weapon reaches a flat 60 ft until one is. */
export const DEFAULT_RANGED_RANGE_FEET = 60;

/** The item's explicit rangeFeet, or the kind's default (5 ft reach for
 * melee/finesse, the 60 ft ranged stand-in). */
export function weaponRangeFeet(item: {
  attackKind: WeaponAttackKind;
  rangeFeet?: number;
}): number {
  if (item.rangeFeet !== undefined) return item.rangeFeet;
  return item.attackKind === "ranged" ? DEFAULT_RANGED_RANGE_FEET : DEFAULT_MELEE_RANGE_FEET;
}

/** SRD cantrip scaling: damage dice multiply at character levels 5, 11
 * and 17. */
export function cantripScalingMultiplier(characterLevel: number): number {
  if (characterLevel >= 17) return 4;
  if (characterLevel >= 11) return 3;
  if (characterLevel >= 5) return 2;
  return 1;
}

/** Multiplies every "NdS" term's dice count in a notation ("1d10" at level
 * 5 -> "2d10"); flat modifiers are left alone. */
export function multiplyDiceNotation(notation: string, multiplier: number): string {
  if (multiplier === 1) return notation;
  return notation.replace(/(\d*)d(\d+)/gi, (_, count: string, sides: string) => {
    return `${(count === "" ? 1 : Number(count)) * multiplier}d${sides}`;
  });
}

/** Eldritch Blast scales by firing more beams (separate attack rolls),
 * not by rolling more dice per beam. */
const BEAM_CANTRIPS = new Set(["Eldritch Blast"]);

export interface QuickAction {
  source: "weapon" | "spell";
  name: string;
  /** What the roll route should be sent: the weapon's own kind, or "spell"
   * for every spell attack (melee AND ranged spell attacks both roll with
   * the spellcasting ability — Spell.attack.kind is range flavor only). */
  attackKind: WeaponAttackKind | "spell";
  damageNotation: string;
  rangeFeet: number;
  /** null for weapons; 0 for cantrips (no resource cost). */
  spellLevel: SpellLevel | null;
  /** The slot level casting it spends: spellLevel itself, or (with
   * `allowUpcast`) the lowest higher level with a slot left when its own
   * level has none. null for weapons and cantrips. */
  slotLevel: SpellSlotLevel | null;
  /** Attack rolls the action makes — more than 1 only for a beam cantrip
   * (Eldritch Blast) at higher character levels. */
  attackCount: number;
  /** Hostile tokens within `rangeFeet + speed`, in the caller's input
   * order — every qualifying target, so the UI can offer a picker rather
   * than an arbitrary nearest-only default. */
  targetTokenIds: string[];
  /** null when the action is currently usable. Set (Prompt 52) when the
   * action is in range of a hostile but RESOURCE-blocked — a leveled
   * spell with no matching-level slot remaining (or never provisioned) —
   * so the UI can show it disabled with this reason and offer "Flag to
   * DM" instead of silently omitting it. Range-blocked actions are still
   * omitted entirely: movement/targeting is explicitly outside what the
   * DM override covers. */
  blockedReason: string | null;
}

export interface ComputeQuickActionsParams {
  /** The acting token's grid position. */
  position: GridPoint;
  /** The character's speed stat in feet — the full-turn repositioning
   * assumption above. */
  speed: number;
  hostiles: readonly QuickActionTargetInput[];
  inventory: readonly QuickActionInventoryItem[];
  /** Known spell names (the caller resolves them against the SPELLS
   * catalog by name; unknown names are ignored). Callers should pass []
   * for a class with no spellcasting ability — the roll route rejects
   * "spell" attacks from such classes. */
  knownSpellNames: readonly string[];
  resources: readonly QuickActionResource[];
  /** The caster's character level, for cantrip damage scaling. Omitted:
   * cantrips stay at their level-1 dice. */
  characterLevel?: number;
  /** When a leveled spell's own slot level has nothing left, fall back to
   * the lowest higher slot level that does (cast without extra upcast
   * dice) — the caller must then spend `slotLevel`, not `spellLevel`. */
  allowUpcast?: boolean;
}

function reachableTargets(
  position: GridPoint,
  speed: number,
  rangeFeet: number,
  hostiles: readonly QuickActionTargetInput[]
): string[] {
  return hostiles
    .filter((hostile) => gridDistanceFeet(position, hostile.position) - speed <= rangeFeet)
    .map((hostile) => hostile.tokenId);
}

/**
 * Every quick action worth showing: each weapon-tagged inventory item in
 * range-with-movement of at least one hostile, then each known spell with
 * attack metadata that's in range-with-movement of at least one hostile.
 * A leveled spell additionally needs a matching-level (or, with
 * allowUpcast, higher) spell-slot resource
 * with uses remaining (cantrips are unlimited) — since Prompt 52 a spell
 * failing ONLY that resource check is still returned, with
 * `blockedReason` set, so the panel can render it disabled with a "Flag
 * to DM" affordance rather than dropping it silently; everything usable
 * carries `blockedReason: null`. Out-of-range actions stay omitted (the
 * override mechanic covers resource/rule restrictions, not
 * movement/targeting). Input order is preserved (inventory order, then
 * known-spell order).
 */
export function computeQuickActions(params: ComputeQuickActionsParams): QuickAction[] {
  const { position, speed, hostiles, inventory, knownSpellNames, resources } = params;
  const cantripMultiplier =
    params.characterLevel !== undefined ? cantripScalingMultiplier(params.characterLevel) : 1;
  const actions: QuickAction[] = [];

  for (const item of inventory) {
    if (!item.attackKind || !item.damageNotation) continue;
    const rangeFeet = weaponRangeFeet({ attackKind: item.attackKind, rangeFeet: item.rangeFeet });
    const targetTokenIds = reachableTargets(position, speed, rangeFeet, hostiles);
    if (targetTokenIds.length === 0) continue;
    actions.push({
      source: "weapon",
      name: item.name,
      attackKind: item.attackKind,
      damageNotation: item.damageNotation,
      rangeFeet,
      spellLevel: null,
      slotLevel: null,
      attackCount: 1,
      targetTokenIds,
      blockedReason: null,
    });
  }

  const seenSpells = new Set<string>();
  for (const name of knownSpellNames) {
    if (seenSpells.has(name)) continue;
    seenSpells.add(name);
    const spell = SPELLS.find((candidate) => candidate.name === name);
    if (!spell?.attack) continue;
    // Attack-flagged spells never carry range "self" in practice (they
    // always target another creature) — skipped defensively if one ever
    // does, since a self-range action has no hostile target to offer.
    if (spell.range === "self") continue;
    const rangeFeet = spell.range === "touch" ? DEFAULT_MELEE_RANGE_FEET : spell.range;
    // Range decides inclusion at all (out of reach even with full
    // movement = omitted, override-ineligible); the resource check below
    // only decides usable-vs-blocked.
    const targetTokenIds = reachableTargets(position, speed, rangeFeet, hostiles);
    if (targetTokenIds.length === 0) continue;
    let blockedReason: string | null = null;
    let slotLevel: SpellSlotLevel | null = null;
    if (spell.level > 0) {
      const hasUses = (level: SpellSlotLevel) =>
        (resources.find((resource) => resource.name === spellSlotResourceName(level))
          ?.current_uses ?? 0) > 0;
      // The spell's own level first; with allowUpcast, the lowest higher
      // level with a slot left (a Warlock's pact slots, or a full caster
      // out of low slots). A missing row means the slot level was never
      // provisioned — the same "nothing to spend" state as an exhausted one.
      const candidates = SPELL_SLOT_LEVELS.filter((level) =>
        params.allowUpcast ? level >= spell.level : level === spell.level
      );
      slotLevel = candidates.find(hasUses) ?? null;
      if (slotLevel === null) {
        // "1st-Level Spell Slots" -> "No 1st-level spell slots remaining".
        const ordinal = spellSlotResourceName(spell.level as SpellSlotLevel).replace(
          "-Level Spell Slots",
          ""
        );
        blockedReason = params.allowUpcast
          ? `No ${ordinal}-level or higher spell slots remaining`
          : `No ${ordinal}-level spell slots remaining`;
        slotLevel = spell.level as SpellSlotLevel;
      }
    }
    const beams = spell.level === 0 && BEAM_CANTRIPS.has(spell.name);
    actions.push({
      source: "spell",
      name: spell.name,
      attackKind: "spell",
      damageNotation:
        spell.level === 0 && !beams
          ? multiplyDiceNotation(spell.attack.damageNotation, cantripMultiplier)
          : spell.attack.damageNotation,
      rangeFeet,
      spellLevel: spell.level,
      slotLevel,
      attackCount: beams ? cantripMultiplier : 1,
      targetTokenIds,
      blockedReason,
    });
  }

  return actions;
}
