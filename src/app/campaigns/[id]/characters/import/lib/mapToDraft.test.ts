import { describe, expect, it } from "vitest";
import { mapToDraft } from "./mapToDraft";
import type { RawSheetData } from "./types";

// Mirrors the real sample PDF's ground truth (Prompt 14 notes): Robin
// URMum, Rogue 2, Dragonborn, Str10/Dex17/Con15/Int14/Wis12/Cha13,
// proficient in Dex+Int saves and Animal Handling/Deception/Perception
// (expertise)/Persuasion/Stealth (expertise)/Survival.
function sampleRawData(overrides: Partial<RawSheetData> = {}): RawSheetData {
  return {
    characterName: "Robin URMum",
    classLevelRaw: "Rogue 2",
    speciesRaw: "Dragonborn",
    abilityScores: { strength: 10, dexterity: 17, constitution: 15, intelligence: 14, wisdom: 12, charisma: 13 },
    maxHp: 25,
    armorClass: 14,
    speedFeet: 30,
    saveRows: [
      { name: "Strength", bonus: 0 },
      { name: "Dexterity", bonus: 5 },
      { name: "Constitution", bonus: 2 },
      { name: "Intelligence", bonus: 4 },
      { name: "Wisdom", bonus: 1 },
      { name: "Charisma", bonus: 1 },
    ],
    skillRows: [
      { name: "Acrobatics", bonus: 3 },
      { name: "Animal Handling", bonus: 3 },
      { name: "Arcana", bonus: 2 },
      { name: "Athletics", bonus: 0 },
      { name: "Deception", bonus: 3 },
      { name: "History", bonus: 2 },
      { name: "Insight", bonus: 1 },
      { name: "Intimidation", bonus: 1 },
      { name: "Investigation", bonus: 2 },
      { name: "Medicine", bonus: 1 },
      { name: "Nature", bonus: 2 },
      { name: "Perception", bonus: 5 },
      { name: "Performance", bonus: 1 },
      { name: "Persuasion", bonus: 3 },
      { name: "Religion", bonus: 2 },
      { name: "Sleight of Hand", bonus: 3 },
      { name: "Stealth", bonus: 7 },
      { name: "Survival", bonus: 3 },
    ],
    inventory: [{ name: "Dagger", quantity: 1 }],
    spells: [],
    ...overrides,
  };
}

describe("mapToDraft against the sample character's ground truth", () => {
  const draft = mapToDraft(sampleRawData());

  it("resolves the name, race, class and level", () => {
    expect(draft.name).toBe("Robin URMum");
    expect(draft.race).toBe("Dragonborn");
    expect(draft.class).toBe("Rogue");
    expect(draft.level).toBe(2);
  });

  it("carries the ability scores through unchanged", () => {
    expect(draft.abilityScores).toEqual({
      strength: 10,
      dexterity: 17,
      constitution: 15,
      intelligence: 14,
      wisdom: 12,
      charisma: 13,
    });
  });

  it("carries HP/AC/speed through unchanged", () => {
    expect(draft.maxHp).toBe(25);
    expect(draft.armorClass).toBe(14);
    expect(draft.speed).toBe(30);
  });

  it("infers exactly the Dexterity and Intelligence save proficiencies", () => {
    expect(draft.proficiencies).toContain("Dexterity Saving Throws");
    expect(draft.proficiencies).toContain("Intelligence Saving Throws");
    expect(draft.proficiencies).not.toContain("Strength Saving Throws");
    expect(draft.proficiencies).not.toContain("Constitution Saving Throws");
    expect(draft.proficiencies).not.toContain("Wisdom Saving Throws");
    expect(draft.proficiencies).not.toContain("Charisma Saving Throws");
  });

  it("infers exactly the six proficient/expertise skills", () => {
    const expectedProficient = [
      "Animal Handling",
      "Deception",
      "Perception",
      "Persuasion",
      "Stealth",
      "Survival",
    ];
    for (const skill of expectedProficient) {
      expect(draft.proficiencies).toContain(skill);
    }
    const expectedNotProficient = [
      "Acrobatics",
      "Arcana",
      "Athletics",
      "History",
      "Insight",
      "Intimidation",
      "Investigation",
      "Medicine",
      "Nature",
      "Performance",
      "Religion",
      "Sleight of Hand",
    ];
    for (const skill of expectedNotProficient) {
      expect(draft.proficiencies).not.toContain(skill);
    }
  });

  it("produces no warnings when every field reads cleanly", () => {
    expect(draft.warnings).toEqual([]);
  });
});

describe("mapToDraft graceful degradation", () => {
  it("leaves race/class unresolved with a warning instead of guessing", () => {
    const draft = mapToDraft(
      sampleRawData({ classLevelRaw: "###garbled###", speciesRaw: "###garbled###" })
    );
    expect(draft.class).toBeNull();
    expect(draft.race).toBeNull();
    expect(draft.warnings.some((w) => w.toLowerCase().includes("class"))).toBe(true);
    expect(draft.warnings.some((w) => w.toLowerCase().includes("race"))).toBe(true);
  });

  it("falls back to safe defaults with warnings when numbers are unreadable", () => {
    const draft = mapToDraft(sampleRawData({ maxHp: null, armorClass: null, speedFeet: null }));
    expect(draft.maxHp).toBeGreaterThan(0);
    expect(draft.armorClass).toBeGreaterThan(0);
    expect(draft.speed).toBeGreaterThan(0);
    expect(draft.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("skips proficiency inference for a row with no readable bonus rather than guessing", () => {
    const draft = mapToDraft(
      sampleRawData({
        skillRows: [{ name: "Acrobatics", bonus: null }],
        saveRows: [],
      })
    );
    expect(draft.proficiencies).not.toContain("Acrobatics");
  });

  it("never throws on a completely empty sheet", () => {
    expect(() =>
      mapToDraft({
        characterName: "",
        classLevelRaw: "",
        speciesRaw: "",
        abilityScores: { strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 },
        maxHp: null,
        armorClass: null,
        speedFeet: null,
        saveRows: [],
        skillRows: [],
        inventory: [],
        spells: [],
      })
    ).not.toThrow();
  });
});
