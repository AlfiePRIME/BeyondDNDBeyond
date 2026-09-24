import { describe, expect, it } from "vitest";
import { RACES } from "./races";
import { SKILLS } from "./skills";
import { raceSkillGrant } from "./raceSkills";

describe("raceSkillGrant", () => {
  it("grants Elves Perception and Half-Orcs Intimidation", () => {
    expect(raceSkillGrant("Elf").fixed).toEqual(["Perception"]);
    expect(raceSkillGrant("Half-Orc").fixed).toEqual(["Intimidation"]);
  });

  it("gives Half-Elves two free choices from any skill", () => {
    const grant = raceSkillGrant("Half-Elf");
    expect(grant.fixed).toEqual([]);
    expect(grant.choice?.count).toBe(2);
    expect(grant.choice?.options).toHaveLength(SKILLS.length);
  });

  it("grants nothing to unlisted, unknown, or missing races", () => {
    expect(raceSkillGrant("Dwarf")).toEqual({ fixed: [], choice: null });
    expect(raceSkillGrant("Not a race")).toEqual({ fixed: [], choice: null });
    expect(raceSkillGrant(null)).toEqual({ fixed: [], choice: null });
  });

  it("only uses real race names and real skills", () => {
    const skillNames = new Set(SKILLS.map((s) => s.name));
    for (const race of RACES) {
      const grant = raceSkillGrant(race.name);
      for (const skill of [...grant.fixed, ...(grant.choice?.options ?? [])]) expect(skillNames.has(skill)).toBe(true);
    }
    for (const name of ["Elf", "Half-Elf", "Half-Orc", "Bugbear", "Goliath", "Tabaxi", "Satyr", "Kenku", "Lizardfolk",
      "Changeling", "Centaur", "Leonin", "Minotaur", "Shifter", "Tortle", "Warforged"]) {
      expect(RACES.some((race) => race.name === name)).toBe(true);
    }
  });
});
