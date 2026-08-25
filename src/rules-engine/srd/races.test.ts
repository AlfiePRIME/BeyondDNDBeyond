import { describe, expect, it } from "vitest";
import { RACES, RACE_OPTION_NAMES, resolveRaceOption } from "./races";

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

describe("RACE_OPTION_NAMES", () => {
  it("lists every base race and every subrace, flattened", () => {
    for (const race of RACES) {
      expect(RACE_OPTION_NAMES).toContain(race.name);
      for (const subrace of race.subraces ?? []) {
        expect(RACE_OPTION_NAMES).toContain(subrace.name);
      }
    }
    expect(RACE_OPTION_NAMES).toHaveLength(
      RACES.reduce((sum, race) => sum + 1 + (race.subraces?.length ?? 0), 0)
    );
  });
});

describe("resolveRaceOption", () => {
  it("resolves a base race's own speed and darkvision", () => {
    expect(resolveRaceOption("Human")).toEqual({ speedFeet: 30, darkvisionFeet: null });
    expect(resolveRaceOption("Tiefling")).toEqual({ speedFeet: 30, darkvisionFeet: 60 });
  });

  it("lets a subrace override the base race where it defines a value", () => {
    expect(resolveRaceOption("Wood Elf")).toEqual({ speedFeet: 35, darkvisionFeet: 60 });
    expect(resolveRaceOption("Drow")).toEqual({ speedFeet: 30, darkvisionFeet: 120 });
  });

  it("inherits the base race's values for a subrace that doesn't redefine them", () => {
    expect(resolveRaceOption("Hill Dwarf")).toEqual({ speedFeet: 25, darkvisionFeet: 60 });
    expect(resolveRaceOption("Lightfoot Halfling")).toEqual({ speedFeet: 25, darkvisionFeet: null });
  });

  it("returns null for a name outside the catalog (e.g. an imported 'Unknown')", () => {
    expect(resolveRaceOption("Unknown")).toBeNull();
    expect(resolveRaceOption("")).toBeNull();
  });

  it("resolves every selectable option", () => {
    for (const name of RACE_OPTION_NAMES) {
      expect(resolveRaceOption(name)).not.toBeNull();
    }
  });
});
