import { describe, expect, it } from "vitest";
import { passiveScore, savingThrowBonus, skillCheckBonus } from "./checks";
import type { AbilityScores } from "./srd/types";

const abilityScores: AbilityScores = {
  strength: 14,
  dexterity: 16,
  constitution: 12,
  intelligence: 10,
  wisdom: 13,
  charisma: 8,
};

describe("savingThrowBonus", () => {
  it("adds proficiency bonus when proficient", () => {
    // Con 12 -> +1 modifier, level 5 -> +3 proficiency
    expect(savingThrowBonus("constitution", abilityScores, 5, true)).toBe(4);
  });

  it("omits proficiency bonus when not proficient", () => {
    expect(savingThrowBonus("constitution", abilityScores, 5, false)).toBe(1);
  });
});

describe("skillCheckBonus", () => {
  it("uses the skill's governing ability and adds proficiency when proficient", () => {
    // Stealth -> Dexterity 16 -> +3 modifier, level 3 -> +2 proficiency
    expect(skillCheckBonus("Stealth", abilityScores, 3, true)).toBe(5);
  });

  it("omits proficiency bonus when not proficient", () => {
    expect(skillCheckBonus("Stealth", abilityScores, 3, false)).toBe(3);
  });
});

describe("passiveScore", () => {
  it("generalizes to any skill, not just Perception", () => {
    // Wisdom 13 -> +1 modifier, proficient at level 1 -> +2 proficiency
    expect(passiveScore("Perception", abilityScores, 1, true)).toBe(13);
    expect(passiveScore("Insight", abilityScores, 1, false)).toBe(11);
  });
});
