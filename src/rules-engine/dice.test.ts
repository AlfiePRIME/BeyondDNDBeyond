import { describe, expect, it } from "vitest";
import {
  doubleDiceExpression,
  parseDiceNotation,
  resolveAttackOutcome,
  resolveDeathSave,
  rollD20,
  rollDice,
  rollDie,
  rollExpression,
  type RandomSource,
} from "./dice";

/** Deterministic random source: yields the given values in order, then
 * throws — a test consuming more randomness than it planned is a bug. */
function sequence(...values: number[]): RandomSource {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error("random source exhausted");
    return values[index++];
  };
}

describe("parseDiceNotation", () => {
  it("parses a bare single-die term", () => {
    expect(parseDiceNotation("1d20")).toEqual({ terms: [{ count: 1, sides: 20, sign: 1 }], modifier: 0 });
  });

  it("defaults an omitted count to 1", () => {
    expect(parseDiceNotation("d8")).toEqual({ terms: [{ count: 1, sides: 8, sign: 1 }], modifier: 0 });
  });

  it("parses dice plus a flat modifier", () => {
    expect(parseDiceNotation("2d6+3")).toEqual({ terms: [{ count: 2, sides: 6, sign: 1 }], modifier: 3 });
  });

  it("parses a negative modifier", () => {
    expect(parseDiceNotation("1d4-2")).toEqual({ terms: [{ count: 1, sides: 4, sign: 1 }], modifier: -2 });
  });

  it("parses multiple dice types with a modifier", () => {
    expect(parseDiceNotation("2d6+1d4+3")).toEqual({
      terms: [
        { count: 2, sides: 6, sign: 1 },
        { count: 1, sides: 4, sign: 1 },
      ],
      modifier: 3,
    });
  });

  it("parses subtracted dice terms and folds multiple flats", () => {
    expect(parseDiceNotation("4d10-1d6+2-5")).toEqual({
      terms: [
        { count: 4, sides: 10, sign: 1 },
        { count: 1, sides: 6, sign: -1 },
      ],
      modifier: -3,
    });
  });

  it("ignores whitespace and case", () => {
    expect(parseDiceNotation(" 2D6 + 3 ")).toEqual({ terms: [{ count: 2, sides: 6, sign: 1 }], modifier: 3 });
  });

  it.each(["", "abc", "d", "3+4", "2d6+", "1d1", "0d6", "101d6", "1d1001", "--2d6", "2d6+9999999"])(
    "rejects %j",
    (notation) => {
      expect(parseDiceNotation(notation)).toBeNull();
    }
  );
});

describe("rollDie / rollDice", () => {
  it("maps the random range onto [1, sides]", () => {
    expect(rollDie(20, sequence(0))).toBe(1);
    expect(rollDie(20, sequence(0.9999))).toBe(20);
    expect(rollDie(6, sequence(0.5))).toBe(4);
  });

  it("clamps an injected source returning exactly 1", () => {
    expect(rollDie(6, sequence(1))).toBe(6);
  });

  it("rolls N dice in sequence", () => {
    expect(rollDice(3, 6, sequence(0, 0.5, 0.9999))).toEqual([1, 4, 6]);
  });
});

describe("rollExpression", () => {
  it("sums groups and the modifier exactly", () => {
    const expression = parseDiceNotation("2d6+3");
    expect(expression).not.toBeNull();
    const result = rollExpression(expression!, sequence(0.5, 0.9999));
    expect(result.groups).toEqual([{ count: 2, sides: 6, sign: 1, results: [4, 6] }]);
    expect(result.modifier).toBe(3);
    expect(result.total).toBe(13);
  });

  it("subtracts negative-sign groups", () => {
    const expression = parseDiceNotation("1d20-1d4+2");
    const result = rollExpression(expression!, sequence(0.7, 0.6));
    expect(result.groups[0].results).toEqual([15]);
    expect(result.groups[1]).toEqual({ count: 1, sides: 4, sign: -1, results: [3] });
    expect(result.total).toBe(15 - 3 + 2);
  });
});

describe("doubleDiceExpression", () => {
  it("doubles dice counts but not the flat modifier", () => {
    expect(doubleDiceExpression(parseDiceNotation("2d6+1d4+3")!)).toEqual({
      terms: [
        { count: 4, sides: 6, sign: 1 },
        { count: 2, sides: 4, sign: 1 },
      ],
      modifier: 3,
    });
  });
});

describe("rollD20", () => {
  it("a normal roll uses one die", () => {
    expect(rollD20("normal", sequence(0.55))).toEqual({ mode: "normal", rolls: [12], result: 12 });
  });

  it("advantage rolls two and takes the higher, whichever order they land", () => {
    expect(rollD20("advantage", sequence(0.1, 0.85))).toEqual({
      mode: "advantage",
      rolls: [3, 18],
      result: 18,
    });
    expect(rollD20("advantage", sequence(0.85, 0.1))).toEqual({
      mode: "advantage",
      rolls: [18, 3],
      result: 18,
    });
  });

  it("disadvantage rolls two and takes the lower, whichever order they land", () => {
    expect(rollD20("disadvantage", sequence(0.1, 0.85))).toEqual({
      mode: "disadvantage",
      rolls: [3, 18],
      result: 3,
    });
    expect(rollD20("disadvantage", sequence(0.85, 0.1))).toEqual({
      mode: "disadvantage",
      rolls: [18, 3],
      result: 3,
    });
  });

  it("ties keep the shared value in both modes", () => {
    expect(rollD20("advantage", sequence(0.5, 0.5)).result).toBe(11);
    expect(rollD20("disadvantage", sequence(0.5, 0.5)).result).toBe(11);
  });
});

describe("resolveAttackOutcome", () => {
  it("a natural 20 always hits and crits, even against an unreachable AC", () => {
    expect(resolveAttackOutcome(20, 0, 100)).toEqual({
      natural20: true,
      natural1: false,
      hit: true,
      critical: true,
    });
  });

  it("a natural 1 always misses, even against AC 1 with a huge bonus", () => {
    expect(resolveAttackOutcome(1, 50, 1)).toEqual({
      natural20: false,
      natural1: true,
      hit: false,
      critical: false,
    });
  });

  it("meeting the AC exactly is a hit; one under is a miss", () => {
    expect(resolveAttackOutcome(10, 5, 15).hit).toBe(true);
    expect(resolveAttackOutcome(10, 4, 15).hit).toBe(false);
  });

  it("an ordinary hit is not a critical", () => {
    expect(resolveAttackOutcome(19, 10, 15)).toEqual({
      natural20: false,
      natural1: false,
      hit: true,
      critical: false,
    });
  });
});

describe("resolveDeathSave", () => {
  it("a natural 20 recovers (1 HP, sequence over) and adds no counts", () => {
    expect(resolveDeathSave(20)).toEqual({
      natural20: true,
      natural1: false,
      recovers: true,
      successesDelta: 0,
      failuresDelta: 0,
    });
  });

  it("a natural 1 counts as TWO failures", () => {
    expect(resolveDeathSave(1)).toEqual({
      natural20: false,
      natural1: true,
      recovers: false,
      successesDelta: 0,
      failuresDelta: 2,
    });
  });

  it("the 2 and 9 boundary rolls are each one failure", () => {
    for (const roll of [2, 9]) {
      expect(resolveDeathSave(roll)).toEqual({
        natural20: false,
        natural1: false,
        recovers: false,
        successesDelta: 0,
        failuresDelta: 1,
      });
    }
  });

  it("the 10 and 19 boundary rolls are each one success", () => {
    for (const roll of [10, 19]) {
      expect(resolveDeathSave(roll)).toEqual({
        natural20: false,
        natural1: false,
        recovers: false,
        successesDelta: 1,
        failuresDelta: 0,
      });
    }
  });

  it("every roll is exactly one of recover / success / failure(s)", () => {
    for (let roll = 1; roll <= 20; roll++) {
      const outcome = resolveDeathSave(roll);
      const kinds = [
        outcome.recovers,
        outcome.successesDelta > 0,
        outcome.failuresDelta > 0,
      ].filter(Boolean).length;
      expect(kinds).toBe(1);
    }
  });
});
