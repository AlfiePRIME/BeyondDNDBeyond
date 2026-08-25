import type { RollLogEntry } from "@/data-access";
import type { DiceTumbleSpec } from "@/scene-3d";

/**
 * Flattens a persisted roll's breakdown into the plain, data-access-free
 * shape scene-3d's DiceTumble understands — scene-3d deliberately never
 * imports RollLogEntry/RollBreakdown directly (the
 * MapSurfaceCell/CampaignMember decoupling precedent documented in
 * scene-3d/README.md), so this app-layer function is the one place a
 * roll_log row gets translated into "just dice and results" for the
 * tumble. A d20 breakdown carries one die normally, two under
 * advantage/disadvantage (both animate — the log already shows both, so the
 * tumble does too); a freeform/dice breakdown carries every group's every
 * individual result, one tumbling die each, regardless of the group's sign
 * (a "-1d4" penalty term's die still physically rolled).
 */
export function buildDiceTumbleSpec(roll: RollLogEntry): DiceTumbleSpec {
  const dice =
    roll.breakdown.type === "d20"
      ? roll.breakdown.d20Rolls.map((result) => ({ sides: 20, result }))
      : roll.breakdown.groups.flatMap((group) =>
          group.results.map((result) => ({ sides: group.sides, result }))
        );
  return { id: roll.id, dice };
}
