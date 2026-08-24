import { describe, expect, it } from "vitest";
import { CLASSES } from "./classes";

describe("CLASSES", () => {
  it("covers every SRD class", () => {
    expect(CLASSES.map((c) => c.name).sort()).toEqual(
      [
        "Barbarian",
        "Bard",
        "Cleric",
        "Druid",
        "Fighter",
        "Monk",
        "Paladin",
        "Ranger",
        "Rogue",
        "Sorcerer",
        "Warlock",
        "Wizard",
      ].sort()
    );
  });

  it("gives every class a hit die and two saving throw proficiencies", () => {
    for (const classDefinition of CLASSES) {
      expect(classDefinition.hitDie).toBeGreaterThan(0);
      expect(classDefinition.savingThrowProficiencies).toHaveLength(2);
    }
  });

  it("marks full casters, half casters, Pact Magic, and non-casters correctly", () => {
    const byName = Object.fromEntries(CLASSES.map((c) => [c.name, c]));
    expect(byName.Wizard.casterProgression).toBe("full");
    expect(byName.Cleric.casterProgression).toBe("full");
    expect(byName.Paladin.casterProgression).toBe("half");
    expect(byName.Ranger.casterProgression).toBe("half");
    expect(byName.Warlock.casterProgression).toBe("pact");
    expect(byName.Fighter.casterProgression).toBe("none");
    expect(byName.Rogue.casterProgression).toBe("none");
  });

  it("gives Fighter Extra Attack at level 5, matching the SRD", () => {
    const fighter = CLASSES.find((c) => c.name === "Fighter");
    expect(fighter?.features.some((f) => f.name === "Extra Attack" && f.level === 5)).toBe(true);
  });
});
