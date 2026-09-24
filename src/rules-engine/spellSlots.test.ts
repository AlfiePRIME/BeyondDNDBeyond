import { describe, expect, it } from "vitest";
import {
  getPactMagicSlots,
  planSpellSlotSync,
  spellSlotRecharge,
  spellSlotsForClass,
} from "./spellSlots";

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

describe("spellSlotRecharge", () => {
  it("recharges Pact Magic on a short rest and everyone else on a long rest", () => {
    expect(spellSlotRecharge("Warlock")).toBe("short_rest");
    expect(spellSlotRecharge("Wizard")).toBe("long_rest");
    expect(spellSlotRecharge("Paladin")).toBe("long_rest");
  });
});

describe("planSpellSlotSync", () => {
  const row = (name: string, max_uses: number, recharge = "long_rest") => ({
    name,
    max_uses,
    recharge,
  });

  it("creates missing rows with the class's recharge", () => {
    const plan = planSpellSlotSync("Warlock", 1, []);
    expect(plan.recharge).toBe("short_rest");
    expect(plan.create).toEqual([{ level: 1, maxUses: 1 }]);
  });

  it("moves a warlock's pact slots up a level, removing the old row", () => {
    const old = row("1st-Level Spell Slots", 2, "short_rest");
    const plan = planSpellSlotSync("Warlock", 3, [old]);
    expect(plan.create).toEqual([{ level: 2, maxUses: 2 }]);
    expect(plan.remove).toEqual([old]);
  });

  it("flags a warlock row stored as long_rest and removes stale levels", () => {
    const current = row("5th-Level Spell Slots", 3);
    const stale = row("3rd-Level Spell Slots", 2, "short_rest");
    const plan = planSpellSlotSync("Warlock", 11, [current, stale]);
    expect(plan.fixRecharge).toEqual([current]);
    expect(plan.resize).toEqual([]);
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([stale]);
  });

  it("resizes but never removes a full caster's rows", () => {
    const first = row("1st-Level Spell Slots", 3);
    const ninth = row("9th-Level Spell Slots", 1);
    const plan = planSpellSlotSync("Wizard", 3, [first, ninth]);
    expect(plan.resize).toEqual([{ row: first, maxUses: 4 }]);
    expect(plan.remove).toEqual([]);
    expect(plan.fixRecharge).toEqual([]);
  });
});
