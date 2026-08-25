import { describe, expect, it } from "vitest";
import {
  computeOpportunityAttacks,
  meleeReachFeet,
  meleeWeaponItems,
  type ComputeOpportunityAttacksParams,
  type OpportunityAttackHostile,
} from "./opportunityAttacks";

// A hostile standing at the origin with 5 ft reach — the plain adjacent
// goblin every scenario starts from.
function hostile(overrides: Partial<OpportunityAttackHostile> = {}): OpportunityAttackHostile {
  return {
    combatantId: "goblin",
    position: { x: 0, y: 0 },
    reachFeet: 5,
    reactionUsed: false,
    ...overrides,
  };
}

function params(
  overrides: Partial<ComputeOpportunityAttacksParams>
): ComputeOpportunityAttacksParams {
  return {
    moverFrom: { x: 1, y: 0 },
    moverTo: { x: 3, y: 0 },
    moverDisengaged: false,
    hostiles: [],
    ...overrides,
  };
}

describe("computeOpportunityAttacks", () => {
  it("flags a hostile the mover leaves the reach of", () => {
    // Adjacent (5 ft, within reach) to 15 ft — clearly out.
    expect(computeOpportunityAttacks(params({ hostiles: [hostile()] }))).toEqual(["goblin"]);
  });

  it("treats exactly-at-reach as still within reach on both sides of the move", () => {
    // Ending AT reach (5 ft) provokes nothing — <= is within.
    expect(
      computeOpportunityAttacks(
        params({ moverFrom: { x: 1, y: 0 }, moverTo: { x: 1, y: 1 }, hostiles: [hostile()] })
      )
    ).toEqual([]);
    // Starting AT a 10 ft reach and ending one cell past it provokes.
    expect(
      computeOpportunityAttacks(
        params({
          moverFrom: { x: 2, y: 0 },
          moverTo: { x: 3, y: 0 },
          hostiles: [hostile({ reachFeet: 10 })],
        })
      )
    ).toEqual(["goblin"]);
  });

  it("one cell past the boundary provokes; the cell at it does not", () => {
    // The 5 ft grid's sharpest boundary pair: 5 ft -> 10 ft provokes,
    // 5 ft -> 5 ft (a sidestep along the reach ring) does not.
    expect(
      computeOpportunityAttacks(
        params({ moverFrom: { x: 1, y: 0 }, moverTo: { x: 2, y: 0 }, hostiles: [hostile()] })
      )
    ).toEqual(["goblin"]);
  });

  it("ignores movement entirely within reach", () => {
    expect(
      computeOpportunityAttacks(
        params({
          moverFrom: { x: 1, y: 0 },
          moverTo: { x: 0, y: 1 },
          hostiles: [hostile({ reachFeet: 10 })],
        })
      )
    ).toEqual([]);
  });

  it("ignores a hostile the mover was never in reach of", () => {
    // 10 ft away moving to 20 ft: further, but never threatened.
    expect(
      computeOpportunityAttacks(
        params({ moverFrom: { x: 2, y: 0 }, moverTo: { x: 4, y: 0 }, hostiles: [hostile()] })
      )
    ).toEqual([]);
  });

  it("ignores a move INTO reach (approaching never provokes)", () => {
    expect(
      computeOpportunityAttacks(
        params({ moverFrom: { x: 4, y: 0 }, moverTo: { x: 1, y: 0 }, hostiles: [hostile()] })
      )
    ).toEqual([]);
  });

  it("measures with the flat chessboard diagonal rule", () => {
    // (1,1) is 5 ft from the origin under max() — within reach — and
    // (2,2) is 10 ft — out. A pure diagonal escape provokes.
    expect(
      computeOpportunityAttacks(
        params({ moverFrom: { x: 1, y: 1 }, moverTo: { x: 2, y: 2 }, hostiles: [hostile()] })
      )
    ).toEqual(["goblin"]);
    // A diagonal slide staying on the 5 ft ring does not.
    expect(
      computeOpportunityAttacks(
        params({ moverFrom: { x: 1, y: 1 }, moverTo: { x: 1, y: -1 }, hostiles: [hostile()] })
      )
    ).toEqual([]);
  });

  it("respects a longer weapon reach", () => {
    // 10 ft reach: leaving from 10 ft to 15 ft provokes, and the 5 ft
    // ring is deep inside — leaving 5 ft for 10 ft does NOT escape it.
    const longReach = hostile({ reachFeet: 10 });
    expect(
      computeOpportunityAttacks(
        params({ moverFrom: { x: 2, y: 0 }, moverTo: { x: 3, y: 0 }, hostiles: [longReach] })
      )
    ).toEqual(["goblin"]);
    expect(
      computeOpportunityAttacks(
        params({ moverFrom: { x: 1, y: 0 }, moverTo: { x: 2, y: 0 }, hostiles: [longReach] })
      )
    ).toEqual([]);
  });

  it("excludes a hostile whose reaction is already spent", () => {
    expect(
      computeOpportunityAttacks(params({ hostiles: [hostile({ reactionUsed: true })] }))
    ).toEqual([]);
  });

  it("excludes a hostile that cannot react at all", () => {
    expect(
      computeOpportunityAttacks(params({ hostiles: [hostile({ cannotReact: true })] }))
    ).toEqual([]);
  });

  it("returns nothing for a disengaged mover, whatever the hostiles' state", () => {
    expect(
      computeOpportunityAttacks(
        params({
          moverDisengaged: true,
          hostiles: [hostile(), hostile({ combatantId: "second", position: { x: 2, y: 0 }, reachFeet: 10 })],
        })
      )
    ).toEqual([]);
  });

  it("returns every qualifying hostile in input order, filtering the rest", () => {
    expect(
      computeOpportunityAttacks(
        params({
          hostiles: [
            hostile({ combatantId: "first" }),
            hostile({ combatantId: "spent", reactionUsed: true }),
            hostile({ combatantId: "far", position: { x: 10, y: 10 } }),
            hostile({ combatantId: "second", position: { x: 0, y: 1 } }),
          ],
        })
      )
    ).toEqual(["first", "second"]);
  });
});

describe("meleeReachFeet", () => {
  const sword = { name: "Longsword", attackKind: "melee" as const, damageNotation: "1d8" };
  const whip = { name: "Whip", attackKind: "finesse" as const, damageNotation: "1d4", rangeFeet: 10 };
  const bow = { name: "Longbow", attackKind: "ranged" as const, damageNotation: "1d8", rangeFeet: 150 };

  it("defaults to 5 ft for an empty or untagged inventory", () => {
    expect(meleeReachFeet([])).toBe(5);
    expect(meleeReachFeet([{ name: "Rope (50 ft)" }])).toBe(5);
  });

  it("uses a tagged melee weapon's default 5 ft reach", () => {
    expect(meleeReachFeet([sword])).toBe(5);
  });

  it("takes the longest melee/finesse reach when several are tagged", () => {
    expect(meleeReachFeet([sword, whip])).toBe(10);
  });

  it("never lets a ranged weapon extend melee reach", () => {
    expect(meleeReachFeet([sword, bow])).toBe(5);
  });

  it("never shrinks below the 5 ft unarmed default", () => {
    const stub = { name: "Shiv", attackKind: "melee" as const, damageNotation: "1", rangeFeet: 0 };
    expect(meleeReachFeet([stub])).toBe(5);
  });
});

describe("meleeWeaponItems", () => {
  it("keeps melee and finesse weapons with damage dice, drops everything else", () => {
    const sword = { name: "Longsword", attackKind: "melee" as const, damageNotation: "1d8" };
    const dagger = { name: "Dagger", attackKind: "finesse" as const, damageNotation: "1d4" };
    const bow = { name: "Longbow", attackKind: "ranged" as const, damageNotation: "1d8" };
    const broken = { name: "Hilt", attackKind: "melee" as const };
    const gear = { name: "Rope (50 ft)" };
    expect(meleeWeaponItems([sword, dagger, bow, broken, gear]).map((i) => i.name)).toEqual([
      "Longsword",
      "Dagger",
    ]);
  });
});
