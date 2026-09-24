import { describe, expect, it } from "vitest";
import { attackAbility, attackBonus } from "./attackBonus";
import type { AbilityScores } from "./srd/types";

const abilityScores: AbilityScores = {
  strength: 16,
  dexterity: 14,
  constitution: 12,
  intelligence: 10,
  wisdom: 13,
  charisma: 18,
};

describe("attackBonus", () => {
  it("uses Strength for melee attacks", () => {
    expect(attackBonus("melee", abilityScores, 5)).toBe(6); // +3 mod + 3 proficiency
  });

  it("uses Dexterity for ranged attacks", () => {
    expect(attackBonus("ranged", abilityScores, 5)).toBe(5); // +2 mod + 3 proficiency
  });

  it("uses the higher of Strength and Dexterity for finesse attacks", () => {
    expect(attackBonus("finesse", abilityScores, 5)).toBe(6); // STR 16 beats DEX 14
    expect(attackBonus("finesse", { ...abilityScores, dexterity: 18 }, 5)).toBe(7);
    expect(attackAbility("finesse", abilityScores)).toBe("strength");
    expect(attackAbility("finesse", { ...abilityScores, strength: 14 })).toBe("dexterity");
  });

  it("uses the spellcasting ability for spell attacks", () => {
    expect(attackBonus("spell", abilityScores, 5, "charisma")).toBe(7); // +4 mod + 3 proficiency
  });

  it("throws for a spell attack without a spellcasting ability", () => {
    expect(() => attackBonus("spell", abilityScores, 5)).toThrow();
  });
});
