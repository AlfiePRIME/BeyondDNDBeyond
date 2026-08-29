import { describe, expect, it } from "vitest";
import { pawnBodyTypeForRace } from "./pawnBodyType";

describe("pawnBodyTypeForRace", () => {
  it("returns 'standard' for null/undefined/empty — no character, or a character row with no race set yet", () => {
    expect(pawnBodyTypeForRace(null)).toBe("standard");
    expect(pawnBodyTypeForRace(undefined)).toBe("standard");
    expect(pawnBodyTypeForRace("")).toBe("standard");
  });

  it("returns 'standard' for an unrecognized race string — an imported 'Unknown' or a MapPlan P2 homebrew name", () => {
    expect(pawnBodyTypeForRace("Unknown")).toBe("standard");
    expect(pawnBodyTypeForRace("My Homebrew Race")).toBe("standard");
  });

  it("returns 'standard' for Human — the single most common pick, unchanged from today's pawn", () => {
    expect(pawnBodyTypeForRace("Human")).toBe("standard");
  });

  it("returns 'standard' for exotic races this taxonomy has no strong build opinion about", () => {
    expect(pawnBodyTypeForRace("Dragonborn")).toBe("standard");
    expect(pawnBodyTypeForRace("Tiefling")).toBe("standard");
    expect(pawnBodyTypeForRace("Half-Elf")).toBe("standard");
    expect(pawnBodyTypeForRace("Warforged")).toBe("standard");
  });

  it("returns 'small' for every size:'small' base race", () => {
    expect(pawnBodyTypeForRace("Halfling")).toBe("small");
    expect(pawnBodyTypeForRace("Gnome")).toBe("small");
    expect(pawnBodyTypeForRace("Goblin")).toBe("small");
    expect(pawnBodyTypeForRace("Kobold")).toBe("small");
  });

  it("returns 'small' for a subrace of a size:'small' base race, stored alone (RACE_OPTION_NAMES convention)", () => {
    expect(pawnBodyTypeForRace("Lightfoot Halfling")).toBe("small");
    expect(pawnBodyTypeForRace("Rock Gnome")).toBe("small");
  });

  it("returns 'bulky' for a race granted the SRD's own 'Powerful Build' trait", () => {
    expect(pawnBodyTypeForRace("Goliath")).toBe("bulky");
    expect(pawnBodyTypeForRace("Firbolg")).toBe("bulky");
    expect(pawnBodyTypeForRace("Bugbear")).toBe("bulky");
    expect(pawnBodyTypeForRace("Loxodon")).toBe("bulky");
  });

  it("returns 'bulky' for the two archetypally stocky core races Powerful Build itself doesn't cover", () => {
    expect(pawnBodyTypeForRace("Dwarf")).toBe("bulky");
    expect(pawnBodyTypeForRace("Half-Orc")).toBe("bulky");
  });

  it("returns 'bulky' for a Dwarf subrace, stored alone", () => {
    expect(pawnBodyTypeForRace("Hill Dwarf")).toBe("bulky");
    expect(pawnBodyTypeForRace("Mountain Dwarf")).toBe("bulky");
  });

  it("returns 'slender' for Elf and every one of its subraces, stored alone", () => {
    expect(pawnBodyTypeForRace("Elf")).toBe("slender");
    expect(pawnBodyTypeForRace("High Elf")).toBe("slender");
    expect(pawnBodyTypeForRace("Wood Elf")).toBe("slender");
    expect(pawnBodyTypeForRace("Drow")).toBe("slender");
    expect(pawnBodyTypeForRace("Eladrin")).toBe("slender");
    expect(pawnBodyTypeForRace("Sea Elf")).toBe("slender");
    expect(pawnBodyTypeForRace("Shadar-kai")).toBe("slender");
  });
});
