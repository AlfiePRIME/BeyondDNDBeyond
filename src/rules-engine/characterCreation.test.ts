import { describe, expect, it } from "vitest";
import {
  POINT_BUY_BUDGET,
  isStandardArrayAssignment,
  pointBuyCost,
  pointBuyTotal,
  startingArmorClass,
  startingSpellCounts,
} from "./characterCreation";
import { CLASSES } from "./srd/classes";
import { CLASS_SKILL_CHOICES } from "./srd/classSkills";
import type { AbilityScores } from "./srd/types";

const scores = (overrides: Partial<AbilityScores> = {}): AbilityScores => ({
  strength: 10,
  dexterity: 14, // +2
  constitution: 16, // +3
  intelligence: 10,
  wisdom: 12, // +1
  charisma: 10,
  ...overrides,
});

describe("point buy", () => {
  it("prices scores per the SRD table", () => {
    expect([8, 9, 10, 11, 12, 13, 14, 15].map(pointBuyCost)).toEqual([0, 1, 2, 3, 4, 5, 7, 9]);
    expect(pointBuyCost(7)).toBeNull();
    expect(pointBuyCost(16)).toBeNull();
  });

  it("totals a full spread, and the standard array costs exactly the budget", () => {
    expect(pointBuyTotal([15, 14, 13, 12, 10, 8])).toBe(POINT_BUY_BUDGET);
    expect(pointBuyTotal([15, 15, 15, 8, 8, 8])).toBe(27);
    expect(pointBuyTotal([16, 8, 8, 8, 8, 8])).toBeNull();
  });
});

describe("isStandardArrayAssignment", () => {
  it("requires each value exactly once", () => {
    expect(isStandardArrayAssignment([8, 10, 12, 13, 14, 15])).toBe(true);
    expect(isStandardArrayAssignment([15, 15, 13, 12, 10, 8])).toBe(false);
    expect(isStandardArrayAssignment([15, 14, 13, 12, 10])).toBe(false);
  });
});

describe("startingSpellCounts", () => {
  it("gives known-spell classes their level-1 table values", () => {
    expect(startingSpellCounts("Bard", 16)).toEqual({ cantrips: 2, spells: 4 });
    expect(startingSpellCounts("Sorcerer", 16)).toEqual({ cantrips: 4, spells: 2 });
    expect(startingSpellCounts("Warlock", 16)).toEqual({ cantrips: 2, spells: 2 });
    expect(startingSpellCounts("Wizard", 16)).toEqual({ cantrips: 3, spells: 6 });
  });

  it("lets Clerics and Druids prepare modifier + 1 (minimum 1)", () => {
    expect(startingSpellCounts("Cleric", 16)).toEqual({ cantrips: 3, spells: 4 });
    expect(startingSpellCounts("Druid", 8)).toEqual({ cantrips: 2, spells: 1 });
  });

  it("gives nothing to classes without level-1 spellcasting", () => {
    for (const className of ["Paladin", "Ranger", "Fighter", "Barbarian"] as const) {
      expect(startingSpellCounts(className, 16), className).toEqual({ cantrips: 0, spells: 0 });
    }
  });
});

describe("startingArmorClass", () => {
  it("is 10 + DEX with no armor", () => {
    expect(startingArmorClass("Wizard", scores(), [])).toBe(12);
  });

  it("uses Barbarian and Monk Unarmored Defense", () => {
    expect(startingArmorClass("Barbarian", scores(), [])).toBe(15); // 10 + 2 + 3
    expect(startingArmorClass("Monk", scores(), ["Shortsword"])).toBe(13); // 10 + 2 + 1
  });

  it("wears the best armor in the inventory, with a shield", () => {
    expect(startingArmorClass("Rogue", scores(), ["Leather Armor"])).toBe(13);
    expect(startingArmorClass("Cleric", scores(), ["Scale Mail", "Shield"])).toBe(18); // 14 + 2 + 2
    expect(startingArmorClass("Paladin", scores({ dexterity: 8 }), ["Chain Mail"])).toBe(16);
  });

  it("lets a Barbarian keep a shield with Unarmored Defense but not a Monk", () => {
    expect(startingArmorClass("Barbarian", scores(), ["Shield"])).toBe(17);
    // Monk with a shield: 10 + DEX + shield (12 + 2) vs Unarmored Defense 13.
    expect(startingArmorClass("Monk", scores(), ["Shield"])).toBe(14);
  });
});

describe("CLASS_SKILL_CHOICES", () => {
  it("covers every class with enough options to choose from", () => {
    for (const klass of CLASSES) {
      const choice = CLASS_SKILL_CHOICES[klass.name];
      expect(choice, klass.name).toBeDefined();
      expect(choice.options.length, klass.name).toBeGreaterThanOrEqual(choice.count);
      expect(new Set(choice.options).size, klass.name).toBe(choice.options.length);
    }
    expect(CLASS_SKILL_CHOICES.Rogue.count).toBe(4);
    expect(CLASS_SKILL_CHOICES.Bard.options).toHaveLength(18);
  });
});
