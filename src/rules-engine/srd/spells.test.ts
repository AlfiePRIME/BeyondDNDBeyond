import { describe, expect, it } from "vitest";
import { SPELLS } from "./spells";

const SPELL_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

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
});
