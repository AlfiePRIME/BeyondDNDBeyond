import { describe, expect, it } from "vitest";
import { RACES } from "./races";

describe("RACES", () => {
  it("covers every SRD race", () => {
    expect(RACES.map((r) => r.name).sort()).toEqual(
      [
        "Dragonborn",
        "Dwarf",
        "Elf",
        "Gnome",
        "Half-Elf",
        "Half-Orc",
        "Halfling",
        "Human",
        "Tiefling",
      ].sort()
    );
  });

  it("defines Hill and Mountain subraces for Dwarf", () => {
    const dwarf = RACES.find((r) => r.name === "Dwarf");
    expect(dwarf?.subraces?.map((s) => s.name)).toEqual(["Hill Dwarf", "Mountain Dwarf"]);
  });

  it("defines High, Wood, and Drow subraces for Elf", () => {
    const elf = RACES.find((r) => r.name === "Elf");
    expect(elf?.subraces?.map((s) => s.name)).toEqual(["High Elf", "Wood Elf", "Drow"]);
  });

  it("defines Lightfoot and Stout subraces for Halfling", () => {
    const halfling = RACES.find((r) => r.name === "Halfling");
    expect(halfling?.subraces?.map((s) => s.name)).toEqual(["Lightfoot Halfling", "Stout Halfling"]);
  });

  it("gives every race a size, speed, and at least one ability score increase", () => {
    for (const race of RACES) {
      expect(race.size).toBeTruthy();
      expect(race.speedFeet).toBeGreaterThan(0);
      expect(race.abilityScoreIncreases.length).toBeGreaterThan(0);
    }
  });
});
