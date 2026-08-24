import { describe, expect, it } from "vitest";
import { getPactMagicSlots, spellSlotsForClass } from "./spellSlots";

describe("spellSlotsForClass", () => {
  it("gives a full caster (Wizard) the standard slot progression", () => {
    const level5 = spellSlotsForClass("Wizard", 5);
    expect(level5).toEqual({ 1: 4, 2: 3, 3: 2, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 });
  });

  it("gives a half caster (Paladin) slots at half the full-caster rate, starting at level 2", () => {
    expect(spellSlotsForClass("Paladin", 1)).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 });
    expect(spellSlotsForClass("Paladin", 5)).toEqual({ 1: 4, 2: 2, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 });
  });

  it("gives Warlock's Pact Magic slots structurally differently from full/half casters", () => {
    // 2 slots, all at 2nd level, at character level 3 — a single non-zero
    // entry rather than a spread across multiple spell levels.
    const level3 = spellSlotsForClass("Warlock", 3);
    expect(level3).toEqual({ 1: 0, 2: 2, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 });
  });

  it("gives a non-caster class (Fighter) no slots at all", () => {
    expect(spellSlotsForClass("Fighter", 20)).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 });
  });
});

describe("getPactMagicSlots", () => {
  it("always casts at the single highest available slot level", () => {
    expect(getPactMagicSlots(11)).toEqual({ slotLevel: 5, slotCount: 3 });
    expect(getPactMagicSlots(20)).toEqual({ slotLevel: 5, slotCount: 4 });
  });
});
