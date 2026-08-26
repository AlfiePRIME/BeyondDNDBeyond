// Falling (docs/design/pits-and-falling.md) — the SRD's "Falling" rule,
// modeled directly against the PHB/SRD 5.1 text: "At the end of a fall, a
// creature takes 1d6 bludgeoning damage for each 10 feet it fell, to a
// maximum of 20d6. The creature lands prone, unless it avoids taking damage
// from the fall." No house rule anywhere in this module — every constant
// below is named for the exact SRD number it encodes, not tuned.
//
// This codebase's one-mechanic-per-file shape (dice.ts, conditions.ts,
// opportunityAttacks.ts, perception.ts): pure, DB-free, unit-testable in
// isolation. `resolveFall`'s injectable RandomSource follows dice.ts's own
// pattern for the same reason dice.ts states — real dice must be rolled
// server-side only — but per this app's established architecture (the roll
// Route Handler is the one production caller of rollDice/rollExpression),
// production fall-damage rolls go through the ordinary "freeform" roll kind
// (postRoll) so the total is server-attested like every other die in the
// app; `resolveFall` itself is exercised with real randomness only in this
// module's own unit tests (and in scripts, if a verify script wants a local
// sanity check) — GameRoom.tsx calls `fallDamageDiceCount` to size that
// request, not `resolveFall` with `Math.random`.
import { rollDice, type RandomSource } from "./dice";
import { FEET_PER_ELEVATION_STEP } from "./movement";

/** SRD: "1d6 bludgeoning damage for each 10 feet it fell." */
export const FEET_PER_FALL_DAMAGE_DIE = 10;

/** SRD: "...to a maximum of 20d6" — reached at exactly 200 ft (40 elevation
 * steps at this app's 5 ft/step), the same depth `cellGrid.ts`'s
 * `MIN_PIT_ELEVATION_STEPS` is chosen against, since depth beyond it changes
 * nothing mechanically. */
export const MAX_FALL_DAMAGE_DICE = 20;

/** The hazard threshold (docs/design/pits-and-falling.md §4): 2 elevation
 * steps, i.e. 10 ft, is where the SRD's own math starts mattering —
 * `fallDamageDiceCount` already returns 0 below this depth, so this constant
 * exists for the AUTHORING side (the map editor's pit sculpt tool warns
 * below it, steering a DM toward plain `difficult` terrain instead), not as
 * a second enforcement point. Expressed in elevation steps, this file's
 * native unit, alongside `FEET_PER_ELEVATION_STEP` for converting either
 * way. */
export const MIN_HAZARD_DEPTH_STEPS = 2;

/** A flat DC 15 Dexterity save (docs/design/pits-and-falling.md §5) — not
 * DM-configurable in v1. `concealed_pits.save_dc` carries a per-trap
 * override column at the data layer for a later prompt to expose; until
 * then every concealed pit is authored with (and every caller falls back
 * to) this default. */
export const CONCEALED_PIT_SAVE_DC = 15;

/**
 * How many d6 a fall of `depthFeet` deals: zero below the first full 10 ft
 * (a sub-10-ft "fall" is a mechanical no-op under the raw SRD formula — see
 * MIN_HAZARD_DEPTH_STEPS's doc comment), one per full 10 ft after that,
 * capped at MAX_FALL_DAMAGE_DICE. This is the single point that also
 * decides prone (via resolveFall): SRD prone applies "unless it avoids
 * taking damage from the fall", and a fall dealing zero dice has trivially
 * avoided all damage.
 */
export function fallDamageDiceCount(depthFeet: number): number {
  if (depthFeet <= 0) return 0;
  return Math.min(Math.floor(depthFeet / FEET_PER_FALL_DAMAGE_DIE), MAX_FALL_DAMAGE_DICE);
}

export interface FallOutcome {
  diceCount: number;
  rolls: number[];
  damage: number;
  prone: boolean;
}

/**
 * The full SRD resolution for a fall of `depthFeet`: rolls `diceCount` d6
 * (reusing dice.ts's rollDice — no new dice mechanism) and sums them for
 * `damage`; `prone` is true exactly when `diceCount > 0`, since an Nd6 roll
 * with N >= 1 can never total zero — "unless it avoids taking damage from
 * the fall" and "diceCount is zero" are the same condition under this
 * formula. Zero or negative depth (including a fall that never happened)
 * resolves to no dice, no damage, not prone, without rolling anything.
 */
export function resolveFall(depthFeet: number, random: RandomSource = Math.random): FallOutcome {
  const diceCount = fallDamageDiceCount(depthFeet);
  if (diceCount === 0) return { diceCount: 0, rolls: [], damage: 0, prone: false };
  const rolls = rollDice(diceCount, 6, random);
  return { diceCount, rolls, damage: rolls.reduce((a, b) => a + b, 0), prone: true };
}

/**
 * How far a creature standing at `fromElevationSteps` falls into a pit whose
 * floor is at `pitElevationSteps` — both in this app's elevation-step units
 * (`FEET_PER_ELEVATION_STEP` = 5 ft/step), converted to feet for the SRD
 * formula above. Deliberately relative to where the MOVER stood immediately
 * before entering the pit cell, not to global elevation 0: a pit dug into a
 * raised plateau is deeper relative to the plateau's rim than to the
 * ground far below it, and this gets that right for free. Clamped at 0 so a
 * "fall" that is actually a rise (or level with the mover) never reads as
 * negative depth.
 */
export function fallDepthFeet(fromElevationSteps: number, pitElevationSteps: number): number {
  return Math.max(0, fromElevationSteps - pitElevationSteps) * FEET_PER_ELEVATION_STEP;
}
