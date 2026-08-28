import { describe, expect, it } from "vitest";
import { RACES, RACE_OPTION_NAMES, resolveRaceOption } from "./races";

describe("RACES", () => {
  it("covers every implemented D&D 5e race", () => {
    expect(RACES.map((r) => r.name).sort()).toEqual(
      [
        // Player's Handbook
        "Dragonborn",
        "Dwarf",
        "Elf",
        "Gnome",
        "Half-Elf",
        "Half-Orc",
        "Halfling",
        "Human",
        "Tiefling",
        // Volo's Guide to Monsters
        "Aarakocra",
        "Bugbear",
        "Firbolg",
        "Goblin",
        "Goliath",
        "Hobgoblin",
        "Kenku",
        "Kobold",
        "Lizardfolk",
        "Orc",
        "Tabaxi",
        "Triton",
        "Yuan-ti Pureblood",
        // Tortle Package
        "Tortle",
        // Elemental Evil Player's Companion
        "Genasi",
        // Mordenkainen's Tome of Foes
        "Duergar",
        // Eberron: Rising from the Last War
        "Changeling",
        "Kalashtar",
        "Shifter",
        "Warforged",
        // Guildmasters' Guide to Ravnica
        "Centaur",
        "Loxodon",
        "Minotaur",
        "Vedalken",
        // Mythic Odysseys of Theros
        "Leonin",
        "Satyr",
      ].sort()
    );
  });

  it("defines Hill and Mountain subraces for Dwarf", () => {
    const dwarf = RACES.find((r) => r.name === "Dwarf");
    expect(dwarf?.subraces?.map((s) => s.name)).toEqual(["Hill Dwarf", "Mountain Dwarf"]);
  });

  it("defines High Elf, Wood Elf, Drow, Eladrin, Sea Elf, and Shadar-kai subraces for Elf", () => {
    const elf = RACES.find((r) => r.name === "Elf");
    expect(elf?.subraces?.map((s) => s.name)).toEqual([
      "High Elf",
      "Wood Elf",
      "Drow",
      "Eladrin",
      "Sea Elf",
      "Shadar-kai",
    ]);
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

  it("gives Goliath its exact Volo's Guide ability score increases (STR +2, CON +1)", () => {
    const goliath = RACES.find((r) => r.name === "Goliath");
    expect(goliath?.abilityScoreIncreases).toEqual([
      { ability: "strength", amount: 2 },
      { ability: "constitution", amount: 1 },
    ]);
  });

  it("composes Genasi's base CON +2 with each subrace's own +1, like the Dwarf/Elf base+subrace pattern", () => {
    const genasi = RACES.find((r) => r.name === "Genasi");
    expect(genasi?.abilityScoreIncreases).toEqual([{ ability: "constitution", amount: 2 }]);
    const bySubrace = Object.fromEntries(
      (genasi?.subraces ?? []).map((s) => [
        s.name,
        [...(genasi?.abilityScoreIncreases ?? []), ...s.abilityScoreIncreases],
      ])
    );
    expect(bySubrace["Air Genasi"]).toEqual([
      { ability: "constitution", amount: 2 },
      { ability: "dexterity", amount: 1 },
    ]);
    expect(bySubrace["Earth Genasi"]).toEqual([
      { ability: "constitution", amount: 2 },
      { ability: "strength", amount: 1 },
    ]);
    expect(bySubrace["Fire Genasi"]).toEqual([
      { ability: "constitution", amount: 2 },
      { ability: "intelligence", amount: 1 },
    ]);
    expect(bySubrace["Water Genasi"]).toEqual([
      { ability: "constitution", amount: 2 },
      { ability: "wisdom", amount: 1 },
    ]);
  });

  it("round-trips Kobold's negative STR adjustment without clamping or dropping it", () => {
    const kobold = RACES.find((r) => r.name === "Kobold");
    expect(kobold?.abilityScoreIncreases).toEqual([
      { ability: "dexterity", amount: 2 },
      { ability: "strength", amount: -2 },
    ]);
    const strengthIncrease = kobold?.abilityScoreIncreases.find((inc) => inc.ability === "strength");
    expect(strengthIncrease?.amount).toBe(-2);
    expect(strengthIncrease?.amount).toBeLessThan(0);
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
