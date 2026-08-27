import { describe, expect, it } from "vitest";
import type { RollLogEntry } from "@/data-access";
import { buildDiceTumbleSpec } from "./tumble";

function freeformRoll(notation: string, groups: { sides: number; results: number[] }[]): RollLogEntry {
  return {
    id: "roll-1",
    campaign_id: "campaign-1",
    roller_user_id: "user-1",
    character_id: null,
    kind: "freeform",
    total: 0,
    visibility: "public",
    created_at: new Date().toISOString(),
    breakdown: {
      type: "dice",
      label: "Free-form roll",
      notation,
      modifier: 0,
      groups: groups.map((group) => ({ count: group.results.length, sides: group.sides, sign: 1, results: group.results })),
    },
  };
}

function d20Roll(rolls: number[]): RollLogEntry {
  return {
    id: "roll-2",
    campaign_id: "campaign-1",
    roller_user_id: "user-1",
    character_id: null,
    kind: "check",
    total: 0,
    visibility: "public",
    created_at: new Date().toISOString(),
    breakdown: {
      type: "d20",
      label: "Check",
      mode: rolls.length === 2 ? "advantage" : "normal",
      d20Rolls: rolls,
      d20Result: Math.max(...rolls),
      modifiers: [],
    },
  };
}

describe("buildDiceTumbleSpec", () => {
  it("carries one die per d20Rolls entry, unaffected by this change", () => {
    const spec = buildDiceTumbleSpec(d20Roll([14]));
    expect(spec.dice).toEqual([{ sides: 20, result: 14 }]);
  });

  it("carries both dice of an advantage/disadvantage pair", () => {
    const spec = buildDiceTumbleSpec(d20Roll([14, 7]));
    expect(spec.dice).toEqual([
      { sides: 20, result: 14 },
      { sides: 20, result: 7 },
    ]);
  });

  it("carries an ordinary freeform group's dice completely unchanged (not sides === 100)", () => {
    const spec = buildDiceTumbleSpec(freeformRoll("2d6+1d4", [{ sides: 6, results: [3, 5] }, { sides: 4, results: [2] }]));
    expect(spec.dice).toEqual([
      { sides: 6, result: 3 },
      { sides: 6, result: 5 },
      { sides: 4, result: 2 },
    ]);
  });

  describe("a d100 group's percentile decomposition (docs/design/dice-numbers-and-physics.md §5)", () => {
    it("r=1 -> tens '00' (synthetic 1), ones '1' (synthetic 2)", () => {
      const spec = buildDiceTumbleSpec(freeformRoll("1d100", [{ sides: 100, results: [1] }]));
      expect(spec.dice).toEqual([
        { sides: 10, result: 1, labelSet: ["00", "10", "20", "30", "40", "50", "60", "70", "80", "90"] },
        { sides: 10, result: 2, labelSet: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] },
      ]);
    });

    it("r=10 -> tens '10' (synthetic 2), ones '0' (synthetic 1)", () => {
      const spec = buildDiceTumbleSpec(freeformRoll("1d100", [{ sides: 100, results: [10] }]));
      expect(spec.dice[0].result).toBe(2);
      expect(spec.dice[0].labelSet?.[spec.dice[0].result - 1]).toBe("10");
      expect(spec.dice[1].result).toBe(1);
      expect(spec.dice[1].labelSet?.[spec.dice[1].result - 1]).toBe("0");
    });

    it("r=57 -> tens '50', ones '7'", () => {
      const spec = buildDiceTumbleSpec(freeformRoll("1d100", [{ sides: 100, results: [57] }]));
      expect(spec.dice[0].labelSet?.[spec.dice[0].result - 1]).toBe("50");
      expect(spec.dice[1].labelSet?.[spec.dice[1].result - 1]).toBe("7");
    });

    it("r=90 -> tens '90', ones '0'", () => {
      const spec = buildDiceTumbleSpec(freeformRoll("1d100", [{ sides: 100, results: [90] }]));
      expect(spec.dice[0].labelSet?.[spec.dice[0].result - 1]).toBe("90");
      expect(spec.dice[1].labelSet?.[spec.dice[1].result - 1]).toBe("0");
    });

    it("r=100 -> tens '00', ones '0' (the real percentile-dice '00 and 0 mean 100' convention)", () => {
      const spec = buildDiceTumbleSpec(freeformRoll("1d100", [{ sides: 100, results: [100] }]));
      expect(spec.dice[0].labelSet?.[spec.dice[0].result - 1]).toBe("00");
      expect(spec.dice[1].labelSet?.[spec.dice[1].result - 1]).toBe("0");
    });

    it("both percentile dice are ordinary sides:10 entries — dieKindForSides/faceNormalForResult need zero changes", () => {
      const spec = buildDiceTumbleSpec(freeformRoll("1d100", [{ sides: 100, results: [42] }]));
      expect(spec.dice).toHaveLength(2);
      for (const die of spec.dice) {
        expect(die.sides).toBe(10);
        expect(die.result).toBeGreaterThanOrEqual(1);
        expect(die.result).toBeLessThanOrEqual(10);
      }
    });

    it("decomposes every result of a multi-d100 group independently", () => {
      const spec = buildDiceTumbleSpec(freeformRoll("2d100", [{ sides: 100, results: [1, 100] }]));
      expect(spec.dice).toHaveLength(4);
    });
  });
});
