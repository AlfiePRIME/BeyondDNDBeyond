import { describe, expect, it } from "vitest";
import {
  CONCEALED_PIT_SAVE_DC,
  FEET_PER_FALL_DAMAGE_DIE,
  MAX_FALL_DAMAGE_DICE,
  MIN_HAZARD_DEPTH_STEPS,
  fallDamageDiceCount,
  fallDepthFeet,
  resolveFall,
  type FallOutcome,
} from "./falling";
import { FEET_PER_ELEVATION_STEP } from "./movement";
import type { RandomSource } from "./dice";

/** Deterministic random source: yields the given values in order, then
 * throws — a test consuming more randomness than it planned is a bug. Same
 * helper shape as dice.test.ts's own `sequence`. */
function sequence(...values: number[]): RandomSource {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error("random source exhausted");
    return values[index++];
  };
}

describe("fallDamageDiceCount", () => {
  it("deals zero dice for zero depth", () => {
    expect(fallDamageDiceCount(0)).toBe(0);
  });

  it("deals zero dice for negative depth", () => {
    expect(fallDamageDiceCount(-20)).toBe(0);
  });

  it("deals zero dice just under the 10 ft threshold", () => {
    expect(fallDamageDiceCount(9)).toBe(0);
  });

  it("deals exactly one die at the 10 ft threshold", () => {
    expect(fallDamageDiceCount(10)).toBe(1);
  });

  it("still deals one die up to (but not including) the next 10 ft band", () => {
    expect(fallDamageDiceCount(19)).toBe(1);
  });

  it("deals two dice at 20 ft", () => {
    expect(fallDamageDiceCount(20)).toBe(2);
  });

  it("deals nineteen dice at 199 ft", () => {
    expect(fallDamageDiceCount(199)).toBe(19);
  });

  it("caps at twenty dice exactly at 200 ft", () => {
    expect(fallDamageDiceCount(200)).toBe(MAX_FALL_DAMAGE_DICE);
  });

  it("caps at twenty dice for anything beyond 200 ft too", () => {
    expect(fallDamageDiceCount(250)).toBe(MAX_FALL_DAMAGE_DICE);
    expect(fallDamageDiceCount(10_000)).toBe(MAX_FALL_DAMAGE_DICE);
  });

  it("matches FEET_PER_FALL_DAMAGE_DIE's own unit (10 ft per die)", () => {
    expect(fallDamageDiceCount(FEET_PER_FALL_DAMAGE_DIE)).toBe(1);
    expect(fallDamageDiceCount(FEET_PER_FALL_DAMAGE_DIE * 2)).toBe(2);
  });
});

describe("resolveFall", () => {
  it("resolves to no dice, no damage, not prone below the hazard threshold", () => {
    const outcome = resolveFall(9, () => {
      throw new Error("should never roll for a sub-10-ft fall");
    });
    expect(outcome).toEqual<FallOutcome>({ diceCount: 0, rolls: [], damage: 0, prone: false });
  });

  it("resolves to no dice, no damage, not prone for zero or negative depth", () => {
    expect(resolveFall(0)).toEqual<FallOutcome>({ diceCount: 0, rolls: [], damage: 0, prone: false });
    expect(resolveFall(-15)).toEqual<FallOutcome>({ diceCount: 0, rolls: [], damage: 0, prone: false });
  });

  it("rolls exactly one d6 and lands prone at 10 ft, from a fixed random sequence", () => {
    // rollDie maps a [0,1) source to [1, sides] via floor(random * sides) + 1
    // — 0.5 on a d6 is floor(3) + 1 = 4.
    const outcome = resolveFall(10, sequence(0.5));
    expect(outcome).toEqual<FallOutcome>({ diceCount: 1, rolls: [4], damage: 4, prone: true });
  });

  it("rolls exactly two d6 at 20 ft, summing an exact fixed sequence", () => {
    // 0.0 -> floor(0) + 1 = 1; 0.999 -> floor(5.994) + 1 = 6.
    const outcome = resolveFall(20, sequence(0.0, 0.999));
    expect(outcome).toEqual<FallOutcome>({ diceCount: 2, rolls: [1, 6], damage: 7, prone: true });
  });

  it("caps at twenty d6 for a 200 ft fall, rolling exactly twenty dice", () => {
    const rolls = Array.from({ length: 20 }, () => 0.5); // each resolves to 4
    const outcome = resolveFall(200, sequence(...rolls));
    expect(outcome.diceCount).toBe(20);
    expect(outcome.rolls).toHaveLength(20);
    expect(outcome.rolls.every((roll) => roll === 4)).toBe(true);
    expect(outcome.damage).toBe(80);
    expect(outcome.prone).toBe(true);
  });

  it("never deals zero damage once diceCount > 0 (an Nd6 roll can't total zero)", () => {
    // The minimum possible roll on every die (0 -> 1).
    const outcome = resolveFall(10, sequence(0));
    expect(outcome.damage).toBeGreaterThan(0);
    expect(outcome.prone).toBe(true);
  });
});

describe("fallDepthFeet", () => {
  it("is zero when the mover and the pit floor are at the same elevation", () => {
    expect(fallDepthFeet(0, 0)).toBe(0);
  });

  it("converts a step difference to feet at FEET_PER_ELEVATION_STEP", () => {
    expect(fallDepthFeet(2, 0)).toBe(2 * FEET_PER_ELEVATION_STEP);
    expect(fallDepthFeet(0, -3)).toBe(3 * FEET_PER_ELEVATION_STEP);
  });

  it("is relative to the mover's OWN prior elevation, not global zero — a pit dug into a raised plateau reads deeper from the plateau than from the ground", () => {
    // Standing on a +4-step plateau, falling into a pit at the plateau's
    // own floor level (0) is 4 steps = 20 ft, not measured against 0 twice.
    expect(fallDepthFeet(4, 0)).toBe(20);
    // The SAME pit (still at absolute elevation 0) is only 2 steps = 10 ft
    // for a mover who was standing at elevation 2, not 4.
    expect(fallDepthFeet(2, 0)).toBe(10);
  });

  it("clamps a rise (or level move) to zero depth, never negative", () => {
    expect(fallDepthFeet(0, 3)).toBe(0);
    expect(fallDepthFeet(-1, 5)).toBe(0);
  });
});

describe("CONCEALED_PIT_SAVE_DC", () => {
  it("is the flat SRD-adjacent DC this design settled on", () => {
    expect(CONCEALED_PIT_SAVE_DC).toBe(15);
  });
});

describe("MIN_HAZARD_DEPTH_STEPS", () => {
  it("names exactly the depth (in steps) where fallDamageDiceCount stops returning zero", () => {
    const thresholdFeet = MIN_HAZARD_DEPTH_STEPS * FEET_PER_ELEVATION_STEP;
    expect(fallDamageDiceCount(thresholdFeet - FEET_PER_ELEVATION_STEP)).toBe(0);
    expect(fallDamageDiceCount(thresholdFeet)).toBeGreaterThan(0);
  });
});
