import { describe, expect, it } from "vitest";
import { usableAtRange, type RangedAction } from "./range";

const actions: RangedAction[] = [
  { name: "Dagger Throw", range: 20, targetType: "single" },
  { name: "Longbow Shot", range: 150, targetType: "single" },
  { name: "Fireball", range: 150, targetType: "area" },
  { name: "Shield Spell", range: "self", targetType: "self" },
  { name: "Cure Wounds", range: "touch", targetType: "single" },
];

describe("usableAtRange", () => {
  it("returns only actions usable at the given distance, excluding ones out of range", () => {
    const result = usableAtRange(actions, 30);
    expect(result.map((a) => a.name).sort()).toEqual(["Fireball", "Longbow Shot"]);
    expect(result.some((a) => a.name === "Dagger Throw")).toBe(false);
  });

  it("treats touch range as usable only at adjacent (<=5 ft) distance", () => {
    expect(usableAtRange(actions, 5).some((a) => a.name === "Cure Wounds")).toBe(true);
    expect(usableAtRange(actions, 10).some((a) => a.name === "Cure Wounds")).toBe(false);
  });

  it("treats self range as usable only at distance 0", () => {
    expect(usableAtRange(actions, 0).some((a) => a.name === "Shield Spell")).toBe(true);
    expect(usableAtRange(actions, 5).some((a) => a.name === "Shield Spell")).toBe(false);
  });

  it("works over a mixed list of spells and weapon-attack shaped actions", () => {
    const mixed: RangedAction[] = [...actions, { name: "Magic Missile", range: 120, targetType: "single" }];
    const result = usableAtRange(mixed, 100);
    expect(result.map((a) => a.name)).toContain("Magic Missile");
    expect(result.map((a) => a.name)).toContain("Longbow Shot");
  });
});
