import { gridDistanceFeet, type GridPoint } from "./movement";
import {
  DEFAULT_MELEE_RANGE_FEET,
  weaponRangeFeet,
  type QuickActionInventoryItem,
} from "./quickActions";

// Pure opportunity-attack detection (Prompt 54): given a mover's pre-move
// and post-move grid positions and the hostile combatants' state, which
// hostiles could take an opportunity attack against the mover? DB-free
// like computeQuickActions — the Game Room supplies every input from what
// it already holds (combatant rows, token positions, readable character
// rows) right after a tracked move_combat_token succeeds. Distance is
// gridDistanceFeet's flat 2D chessboard measure, matching every other
// range query here.
//
// The rule, exactly: a hostile who was within their reach of the mover's
// PRE-move position, is no longer within their reach of the POST-move
// position, and still has their reaction this turn, is a candidate —
// against a mover who has NOT disengaged this turn. Reach is the
// hostile's tagged melee/finesse weapon reach (meleeReachFeet below);
// there is deliberately NO per-creature "reach" stat anywhere in the SRD
// catalog to consult instead.

/** One hostile combatant's detection-relevant state. */
export interface OpportunityAttackHostile {
  /** The combat_combatants row id, handed back for qualifying hostiles. */
  combatantId: string;
  position: GridPoint;
  /** This hostile's melee reach in feet — meleeReachFeet of its readable
   * character's inventory, or the plain 5 ft default for an NPC/unreadable
   * combatant (no stat block exists anywhere until Prompt 61). */
  reachFeet: number;
  /** A hostile whose reaction is already spent this turn never qualifies. */
  reactionUsed: boolean;
  /** True when the hostile clearly can't take reactions at all — the
   * caller derives it from state it can see (an incapacitated-flagged
   * condition on the combatant, or a readable character that is dead or
   * at 0 HP). Deliberately a single pre-derived flag rather than raw
   * condition/HP inputs: what disqualifies is the caller's judgment call
   * over viewer-readable state, not something this pure function can
   * resolve for an unreadable character. Defaults to false. */
  cannotReact?: boolean;
}

export interface ComputeOpportunityAttacksParams {
  /** Where the mover stood before the move (the drag's origin cell). */
  moverFrom: GridPoint;
  /** Where the mover ended up (the committed destination cell). */
  moverTo: GridPoint;
  /** A mover who declared Disengage this turn provokes nothing at all. */
  moverDisengaged: boolean;
  hostiles: readonly OpportunityAttackHostile[];
}

/**
 * The reach a combatant threatens with for opportunity-attack purposes:
 * the longest tagged melee/finesse weapon's rangeFeet in the inventory
 * (weaponRangeFeet, so an untyped melee weapon reads as 5 ft), or the
 * same 5 ft DEFAULT_MELEE_RANGE_FEET an unarmed/untagged creature already
 * uses everywhere else when nothing qualifies. Ranged weapons and spells
 * never contribute — RAW 5e, only melee attacks threaten reach. This is
 * the ONE reach concept in the codebase, shared by detection (the
 * hostile's threat range) and deliberately not a new per-creature stat.
 */
export function meleeReachFeet(inventory: readonly QuickActionInventoryItem[]): number {
  let reach = DEFAULT_MELEE_RANGE_FEET;
  for (const item of meleeWeaponItems(inventory)) {
    reach = Math.max(
      reach,
      weaponRangeFeet({ attackKind: item.attackKind, rangeFeet: item.rangeFeet })
    );
  }
  return reach;
}

/** A QuickActionInventoryItem narrowed to what meleeWeaponItems keeps:
 * melee/finesse tag plus damage dice, both guaranteed present. */
export interface MeleeWeaponItem extends QuickActionInventoryItem {
  attackKind: "melee" | "finesse";
  damageNotation: string;
}

/**
 * The inventory items usable AS an opportunity attack: melee/finesse
 * weapon-tagged entries with damage dice (the same "attackKind +
 * damageNotation = weapon" rule computeQuickActions applies), never
 * ranged weapons or spells — an opportunity attack is a melee swing.
 * Shared by meleeReachFeet above and the take-the-attack weapon picker.
 */
export function meleeWeaponItems(
  inventory: readonly QuickActionInventoryItem[]
): MeleeWeaponItem[] {
  return inventory.filter(
    (item): item is MeleeWeaponItem =>
      (item.attackKind === "melee" || item.attackKind === "finesse") &&
      item.damageNotation !== undefined
  );
}

/**
 * The hostiles that could take an opportunity attack against this move,
 * as their combatant ids in the caller's input order. Empty whenever the
 * mover has disengaged this turn. Boundary semantics: "within reach" is
 * inclusive (`distance <= reach`, the meets-it convention every range
 * query here uses), so a move ENDING exactly at reach — still within it —
 * provokes nothing, and only a move from `<= reach` to `> reach`
 * qualifies. A hostile never in reach of the pre-move position has
 * nothing to react to, however far the mover ends up.
 */
export function computeOpportunityAttacks(params: ComputeOpportunityAttacksParams): string[] {
  const { moverFrom, moverTo, moverDisengaged, hostiles } = params;
  if (moverDisengaged) return [];
  return hostiles
    .filter(
      (hostile) =>
        !hostile.reactionUsed &&
        !hostile.cannotReact &&
        gridDistanceFeet(hostile.position, moverFrom) <= hostile.reachFeet &&
        gridDistanceFeet(hostile.position, moverTo) > hostile.reachFeet
    )
    .map((hostile) => hostile.combatantId);
}
