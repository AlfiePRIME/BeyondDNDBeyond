import type { RollLogEntry } from "@/data-access";
import type { DiceTumbleSpec } from "@/scene-3d";

// A percentile ("1d100") roll's real-world convention — a "tens" d10
// printed 00/10/.../90 and a "ones" d10 printed 0-9, read together — per
// docs/design/dice-numbers-and-physics.md §5. Index-aligned to the exact
// same synthetic 1-10 `result` convention percentileDicePair below feeds
// faceNormalForResult/labelForResult through (index 0 = synthetic result 1),
// same as diceGeometry.ts's own DEFAULT_FACE_LABELS[kind][i] convention.
const PERCENTILE_TENS_LABELS: readonly string[] = ["00", "10", "20", "30", "40", "50", "60", "70", "80", "90"];
const PERCENTILE_ONES_LABELS: readonly string[] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * Decomposes one already-authoritative percentile result (`rollDie(100,
 * random)`'s real integer in [1, 100] — rules-engine/dice.ts's own math,
 * completely unchanged by this) into the two ordinary d10 tumbles a real
 * percentile die pair actually is — a PURE, deterministic, display-only
 * transform, never re-randomized (docs/design/dice-numbers-and-physics.md
 * §5's own worked boundary cases: r=1 -> "00"+"1"=01, r=10 -> "10"+"0"=10,
 * r=57 -> "50"+"7", r=90 -> "90"+"0", r=100 -> "00"+"0", the real-world
 * "00 and 0 together mean 100" percentile-dice convention). Both entries
 * are `sides: 10` with a synthetic 1-10 `result` — faceNormalForResult/the
 * scripted (or, later, physics) animator need zero changes, since they only
 * ever see a valid 1-10 d10 result; `labelSet` is what makes each one's
 * face decals/ResultBadge print the real tens/ones value instead of that
 * synthetic index.
 */
function percentileDicePair(result: number): DiceTumbleSpec["dice"] {
  const tensValue = result === 100 ? 0 : Math.floor(result / 10) * 10;
  const onesValue = result === 100 ? 0 : result % 10;
  return [
    { sides: 10, result: tensValue / 10 + 1, labelSet: PERCENTILE_TENS_LABELS },
    { sides: 10, result: onesValue + 1, labelSet: PERCENTILE_ONES_LABELS },
  ];
}

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
 * (a "-1d4" penalty term's die still physically rolled) — except a d100
 * group, whose every individual result becomes a real two-die percentile
 * pair (percentileDicePair above) rather than one die of a nonexistent
 * "d100" shape; diceGeometry.ts's dieKindForSides(100) correctly continues
 * to return null, since there is still no such thing as d100 geometry — the
 * percentile handling lives entirely here, one level above where
 * dieKindForSides is consulted.
 */
export function buildDiceTumbleSpec(roll: RollLogEntry): DiceTumbleSpec {
  const dice =
    roll.breakdown.type === "d20"
      ? roll.breakdown.d20Rolls.map((result) => ({ sides: 20, result }))
      : roll.breakdown.groups.flatMap((group) =>
          group.sides === 100
            ? group.results.flatMap((result) => percentileDicePair(result))
            : group.results.map((result) => ({ sides: group.sides, result }))
        );
  return { id: roll.id, dice };
}
