import { describe, expect, it } from "vitest";
import { abilityModifier, proficiencyBonus } from "./abilityScores";

describe("abilityModifier", () => {
  it("returns 0 for a score of 10", () => {
    expect(abilityModifier(10)).toBe(0);
  });

  it("returns a positive modifier for a high score", () => {
    expect(abilityModifier(18)).toBe(4);
  });

  it("returns a negative modifier for a low score", () => {
    expect(abilityModifier(8)).toBe(-1);
    expect(abilityModifier(3)).toBe(-4);
  });
});

describe("proficiencyBonus", () => {
  it("is +2 at levels 1-4", () => {
    expect(proficiencyBonus(1)).toBe(2);
    expect(proficiencyBonus(4)).toBe(2);
  });

  it("is +3 at levels 5-8", () => {
    expect(proficiencyBonus(5)).toBe(3);
    expect(proficiencyBonus(8)).toBe(3);
  });

  it("is +4 at levels 9-12", () => {
    expect(proficiencyBonus(9)).toBe(4);
    expect(proficiencyBonus(12)).toBe(4);
  });

  it("is +5 at levels 13-16", () => {
    expect(proficiencyBonus(13)).toBe(5);
    expect(proficiencyBonus(16)).toBe(5);
  });

  it("is +6 at levels 17-20", () => {
    expect(proficiencyBonus(17)).toBe(6);
    expect(proficiencyBonus(20)).toBe(6);
  });
});
