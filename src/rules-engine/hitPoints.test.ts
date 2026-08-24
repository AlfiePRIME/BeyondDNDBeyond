import { describe, expect, it } from "vitest";
import { levelOneHitPoints } from "./hitPoints";

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
