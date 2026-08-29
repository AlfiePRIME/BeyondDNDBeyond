import { describe, expect, it } from "vitest";
import { levelOneHitPoints, levelUpHitPointGain } from "./hitPoints";

describe("levelOneHitPoints", () => {
  it("is the full hit die plus the Constitution modifier", () => {
    expect(levelOneHitPoints(10, 15)).toBe(12);
    expect(levelOneHitPoints(6, 12)).toBe(7);
  });

  it("applies a negative Constitution modifier", () => {
    expect(levelOneHitPoints(8, 8)).toBe(7);
  });

  it("adds nothing at Constitution 10", () => {
    expect(levelOneHitPoints(12, 10)).toBe(12);
  });
});

describe("levelUpHitPointGain", () => {
  it("is half the hit die rounded down, plus one, plus the Constitution modifier", () => {
    // d8 class, CON 14 (+2 modifier): 4 + 1 + 2 = 7.
    expect(levelUpHitPointGain(8, 14)).toBe(7);
    // d12 class, CON 10 (+0 modifier): 6 + 1 + 0 = 7.
    expect(levelUpHitPointGain(12, 10)).toBe(7);
    // d6 class, CON 8 (-1 modifier): 3 + 1 - 1 = 3.
    expect(levelUpHitPointGain(6, 8)).toBe(3);
  });

  it("applies a negative Constitution modifier", () => {
    expect(levelUpHitPointGain(10, 6)).toBe(4);
  });
});
