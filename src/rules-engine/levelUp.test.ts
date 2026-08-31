import { describe, expect, it } from "vitest";
import {
  applyAbilityScoreImprovement,
  asiLevelsForClass,
  featuresGainedBetween,
  isValidAbilityScoreImprovementChoice,
  newSpellsKnownDelta,
  subclassForClass,
  subclassGateLevel,
} from "./levelUp";

describe("subclassGateLevel", () => {
  it("matches the SRD's per-class subclass-choice level", () => {
    expect(subclassGateLevel("Cleric")).toBe(1);
    expect(subclassGateLevel("Sorcerer")).toBe(1);
    expect(subclassGateLevel("Warlock")).toBe(1);
    expect(subclassGateLevel("Druid")).toBe(2);
    expect(subclassGateLevel("Wizard")).toBe(2);
    expect(subclassGateLevel("Rogue")).toBe(3);
    expect(subclassGateLevel("Fighter")).toBe(3);
    expect(subclassGateLevel("Barbarian")).toBe(3);
  });
});

describe("subclassForClass", () => {
  it("resolves every SRD class to its one catalog subclass", () => {
    expect(subclassForClass("Rogue")?.name).toBe("Thief");
    expect(subclassForClass("Wizard")?.name).toBe("School of Evocation");
  });
});

describe("asiLevelsForClass", () => {
  it("finds Barbarian's ASI levels from the completed feature table", () => {
    expect(asiLevelsForClass("Barbarian")).toEqual([4, 8, 12, 16, 19]);
  });

  it("finds Fighter's extra bonus ASI levels (6 and 14)", () => {
    expect(asiLevelsForClass("Fighter")).toEqual([4, 6, 8, 12, 14, 16, 19]);
  });

  it("finds Rogue's extra bonus ASI level (10)", () => {
    expect(asiLevelsForClass("Rogue")).toEqual([4, 8, 10, 12, 16, 19]);
  });
});

describe("featuresGainedBetween", () => {
  it("returns Rogue's Sneak Attack for level 0 -> 1", () => {
    const gained = featuresGainedBetween("Rogue", null, 0, 1);
    expect(gained.map((f) => f.name)).toContain("Sneak Attack");
  });

  it("includes the subclass-gate feature AND the subclass's own first-tier features together at level 3", () => {
    const gained = featuresGainedBetween("Rogue", "Thief", 2, 3);
    const names = gained.map((f) => f.name);
    expect(names).toContain("Roguish Archetype");
    expect(names).toContain("Fast Hands");
    expect(names).toContain("Second-Story Work");
  });

  it("omits subclass features when no subclass is chosen yet", () => {
    const gained = featuresGainedBetween("Rogue", null, 2, 3);
    expect(gained.map((f) => f.name)).not.toContain("Fast Hands");
  });

  it("returns nothing for a level range with no new features", () => {
    expect(featuresGainedBetween("Wizard", null, 4, 4)).toEqual([]);
  });
});

describe("newSpellsKnownDelta", () => {
  it("uses the real SRD Sorcerer known-spells table", () => {
    expect(newSpellsKnownDelta("Sorcerer", 1, 2, 3)).toBe(1); // 2 -> 3
    expect(newSpellsKnownDelta("Sorcerer", 19, 20, 3)).toBe(0); // caps at 15
  });

  it("gives Wizard a flat +2 spellbook spells per level", () => {
    expect(newSpellsKnownDelta("Wizard", 3, 4, 3)).toBe(2);
    expect(newSpellsKnownDelta("Wizard", 3, 5, 3)).toBe(4);
  });

  it("computes Cleric's prepared-spell delta from ability modifier + level", () => {
    // level 1: 1 + 2 = 3 prepared; level 2: 2 + 2 = 4 prepared -> +1
    expect(newSpellsKnownDelta("Cleric", 1, 2, 2)).toBe(1);
  });

  it("computes Paladin's prepared-spell delta at HALF class level", () => {
    // level 1: floor(1/2)=0 -> max(1, 0+2)=2; level 2: floor(2/2)=1 -> 1+2=3
    expect(newSpellsKnownDelta("Paladin", 1, 2, 2)).toBe(1);
  });

  it("is zero for a non-caster", () => {
    expect(newSpellsKnownDelta("Fighter", 3, 4, 0)).toBe(0);
  });
});

describe("ability score improvement", () => {
  it("validates +2-to-one and +1-to-two-different, rejects +1 twice to the same score", () => {
    expect(isValidAbilityScoreImprovementChoice({ mode: "single", ability: "strength" })).toBe(true);
    expect(
      isValidAbilityScoreImprovementChoice({ mode: "double", abilities: ["strength", "dexterity"] })
    ).toBe(true);
    expect(
      isValidAbilityScoreImprovementChoice({ mode: "double", abilities: ["strength", "strength"] })
    ).toBe(false);
    expect(isValidAbilityScoreImprovementChoice(null)).toBe(false);
  });

  const baseScores = {
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
  };

  it("applies +2 to a single score", () => {
    const next = applyAbilityScoreImprovement(baseScores, { mode: "single", ability: "strength" });
    expect(next.strength).toBe(12);
    expect(next.dexterity).toBe(10);
  });

  it("applies +1 to two different scores", () => {
    const next = applyAbilityScoreImprovement(baseScores, {
      mode: "double",
      abilities: ["strength", "wisdom"],
    });
    expect(next.strength).toBe(11);
    expect(next.wisdom).toBe(11);
    expect(next.dexterity).toBe(10);
  });

  it("throws on an invalid choice rather than silently no-op'ing", () => {
    expect(() =>
      applyAbilityScoreImprovement(baseScores, { mode: "double", abilities: ["strength", "strength"] })
    ).toThrow();
  });
});
