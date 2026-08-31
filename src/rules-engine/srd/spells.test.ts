import { describe, expect, it } from "vitest";
import { parseDiceNotation } from "../dice";
import { SPELLS } from "./spells";
import type { ClassName } from "./types";

const SPELL_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const NON_CASTER_CLASSES: ClassName[] = ["Barbarian", "Fighter", "Monk", "Rogue"];
const CASTER_CLASSES: ClassName[] = [
  "Bard",
  "Cleric",
  "Druid",
  "Paladin",
  "Ranger",
  "Sorcerer",
  "Warlock",
  "Wizard",
];

describe("SPELLS", () => {
  it("is a genuinely comprehensive list, not a token handful", () => {
    expect(SPELLS.length).toBeGreaterThan(150);
  });

  it("covers every spell level from 0 (cantrip) through 9", () => {
    for (const level of SPELL_LEVELS) {
      const countAtLevel = SPELLS.filter((s) => s.level === level).length;
      expect(countAtLevel).toBeGreaterThan(0);
    }
  });

  it("gives every spell a concentration flag and valid shape", () => {
    for (const spell of SPELLS) {
      expect(typeof spell.name).toBe("string");
      expect(spell.name.length).toBeGreaterThan(0);
      expect(SPELL_LEVELS).toContain(spell.level);
      expect(typeof spell.concentration).toBe("boolean");
      expect(["single", "area", "self", "point"]).toContain(spell.targetType);
    }
  });

  it("has no duplicate spell names", () => {
    const names = SPELLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("flags well-known concentration spells correctly", () => {
    const byName = Object.fromEntries(SPELLS.map((s) => [s.name, s]));
    if (byName["Bless"]) expect(byName["Bless"].concentration).toBe(true);
    if (byName["Fireball"]) expect(byName["Fireball"].concentration).toBe(false);
  });

  describe("class restriction data (level-up wizard)", () => {
    it("gives every spell at least one class from the real SRD class lists", () => {
      const orphans = SPELLS.filter((s) => s.classes.length === 0).map((s) => s.name);
      expect(orphans).toEqual([]);
    });

    it("never assigns a spell to a non-caster class", () => {
      for (const spell of SPELLS) {
        for (const nonCaster of NON_CASTER_CLASSES) {
          expect(spell.classes).not.toContain(nonCaster);
        }
      }
    });

    it("only ever assigns real caster class names", () => {
      for (const spell of SPELLS) {
        for (const className of spell.classes) {
          expect(CASTER_CLASSES).toContain(className);
        }
      }
    });

    it("flags well-known class-exclusive/iconic spells correctly", () => {
      const byName = Object.fromEntries(SPELLS.map((s) => [s.name, s]));
      expect(byName["Eldritch Blast"].classes).toEqual(["Warlock"]);
      expect(byName["Hex"].classes).toEqual(["Warlock"]);
      expect(byName["Vicious Mockery"].classes).toEqual(["Bard"]);
      expect(byName["Find Familiar"].classes).toEqual(["Wizard"]);
      expect(byName["Shillelagh"].classes).toEqual(["Druid"]);
      expect(byName["Fireball"].classes).toEqual(expect.arrayContaining(["Sorcerer", "Wizard"]));
      expect(byName["Cure Wounds"].classes).toEqual(
        expect.arrayContaining(["Bard", "Cleric", "Druid", "Paladin", "Ranger"])
      );
    });
  });

  describe("attack metadata (Prompt 51)", () => {
    const byName = Object.fromEntries(SPELLS.map((s) => [s.name, s]));

    it("gives every attack-flagged spell a valid, rollable shape", () => {
      for (const spell of SPELLS) {
        if (!spell.attack) continue;
        expect(["melee", "ranged"]).toContain(spell.attack.kind);
        // The notation must actually parse in the dice module the attack
        // flow rolls it through.
        expect(parseDiceNotation(spell.attack.damageNotation)).not.toBeNull();
        // An attack-roll spell always targets another creature — never
        // range "self", and always a single target.
        expect(spell.range).not.toBe("self");
        expect(spell.targetType).toBe("single");
      }
    });

    it("flags the well-known SRD spell-attack spells", () => {
      expect(byName["Fire Bolt"].attack).toEqual({ kind: "ranged", damageNotation: "1d10" });
      expect(byName["Ray of Frost"].attack).toEqual({ kind: "ranged", damageNotation: "1d8" });
      expect(byName["Eldritch Blast"].attack).toEqual({ kind: "ranged", damageNotation: "1d10" });
      expect(byName["Scorching Ray"].attack).toEqual({ kind: "ranged", damageNotation: "2d6" });
      expect(byName["Shocking Grasp"].attack).toEqual({ kind: "melee", damageNotation: "1d8" });
      expect(byName["Inflict Wounds"].attack).toEqual({ kind: "melee", damageNotation: "3d10" });
      expect(byName["Guiding Bolt"].attack).toEqual({ kind: "ranged", damageNotation: "4d6" });
    });

    it("leaves save-based, auto-hit, and no-damage spells unflagged", () => {
      // Saving throws the TARGET makes:
      expect(byName["Fireball"].attack).toBeUndefined();
      expect(byName["Acid Splash"].attack).toBeUndefined();
      expect(byName["Sacred Flame"].attack).toBeUndefined();
      expect(byName["Vicious Mockery"].attack).toBeUndefined();
      // Auto-hit, no attack roll:
      expect(byName["Magic Missile"].attack).toBeUndefined();
      // Attack roll but no damage dice:
      expect(byName["Ray of Enfeeblement"].attack).toBeUndefined();
      // Buffs/utility:
      expect(byName["Mage Armor"].attack).toBeUndefined();
      expect(byName["Cure Wounds"].attack).toBeUndefined();
    });
  });
});
