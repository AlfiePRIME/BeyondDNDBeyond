import { describe, expect, it } from "vitest";
import { CLASSES } from "./classes";
import { SUBCLASSES } from "./subclasses";

describe("SUBCLASSES", () => {
  it("gives every one of the 12 SRD classes exactly one subclass", () => {
    const names = CLASSES.map((c) => c.name).sort();
    const covered = SUBCLASSES.map((s) => s.className).sort();
    expect(covered).toEqual(names);
  });

  it("gives every subclass a nonempty, level-tagged feature list", () => {
    for (const subclass of SUBCLASSES) {
      expect(subclass.name.length).toBeGreaterThan(0);
      expect(subclass.features.length).toBeGreaterThan(0);
      for (const feature of subclass.features) {
        expect(feature.name.length).toBeGreaterThan(0);
        expect(feature.level).toBeGreaterThanOrEqual(1);
        expect(feature.level).toBeLessThanOrEqual(20);
      }
    }
  });

  it("starts every subclass's first feature at (or after) its class's own subclass-choice level", () => {
    const gateFeatureNameByClass: Record<string, string> = {
      Barbarian: "Primal Path",
      Bard: "Bard College",
      Cleric: "Divine Domain",
      Druid: "Druid Circle",
      Fighter: "Martial Archetype",
      Monk: "Monastic Tradition",
      Paladin: "Sacred Oath",
      Ranger: "Ranger Archetype",
      Rogue: "Roguish Archetype",
      Sorcerer: "Sorcerous Origin",
      Warlock: "Otherworldly Patron",
      Wizard: "Arcane Tradition",
    };
    for (const subclass of SUBCLASSES) {
      const klass = CLASSES.find((c) => c.name === subclass.className);
      const gateName = gateFeatureNameByClass[subclass.className];
      const gateLevel = klass?.features.find((f) => f.name === gateName)?.level;
      expect(gateLevel).toBeDefined();
      const earliestSubclassLevel = Math.min(...subclass.features.map((f) => f.level));
      expect(earliestSubclassLevel).toBeGreaterThanOrEqual(gateLevel as number);
    }
  });
});
