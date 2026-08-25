import { gridDistanceFeet, type GridPoint } from "./movement";
import { spellSlotResourceName, type SpellSlotLevel } from "./spellSlots";
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
  /** Hostile tokens within `rangeFeet + speed`, in the caller's input
   * order — every qualifying target, so the UI can offer a picker rather
   * than an arbitrary nearest-only default. */
  targetTokenIds: string[];
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
 * Every currently-usable quick action: each weapon-tagged inventory item
 * in range-with-movement of at least one hostile, then each known spell
 * with attack metadata that's in range-with-movement of at least one
 * hostile AND either a cantrip (unlimited use, no resource check) or
 * backed by a matching-level spell-slot resource with uses remaining.
 * Input order is preserved (inventory order, then known-spell order).
 */
export function computeQuickActions(params: ComputeQuickActionsParams): QuickAction[] {
  const { position, speed, hostiles, inventory, knownSpellNames, resources } = params;
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
      targetTokenIds,
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
    if (spell.level > 0) {
      const slotName = spellSlotResourceName(spell.level as SpellSlotLevel);
      const slot = resources.find((resource) => resource.name === slotName);
      // Matching-level slot only — no upcast-from-a-higher-slot fallback
      // (and so no Pact Magic mapping); a missing row means the slot level
      // was never provisioned, which is the same "nothing to spend" state
      // as an exhausted one.
      if (!slot || slot.current_uses <= 0) continue;
    }
    const targetTokenIds = reachableTargets(position, speed, rangeFeet, hostiles);
    if (targetTokenIds.length === 0) continue;
    actions.push({
      source: "spell",
      name: spell.name,
      attackKind: "spell",
      damageNotation: spell.attack.damageNotation,
      rangeFeet,
      spellLevel: spell.level,
      targetTokenIds,
    });
  }

  return actions;
}
