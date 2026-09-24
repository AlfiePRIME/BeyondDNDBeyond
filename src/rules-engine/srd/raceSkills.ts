import { SKILLS } from "./skills";
import type { SkillName } from "./types";

export interface RaceSkillGrant {
  /** Skills every member of the race is proficient in. */
  fixed: SkillName[];
  /** A racial "choose N" proficiency, if any. */
  choice: { count: number; options: SkillName[] } | null;
}

const ANY_SKILL: SkillName[] = SKILLS.map((skill) => skill.name);

/** Racial skill proficiencies, keyed by the race names in RACES. Races not
 * listed grant none. */
const RACE_SKILL_GRANTS: Record<string, RaceSkillGrant> = {
  Elf: { fixed: ["Perception"], choice: null }, // Keen Senses
  "Half-Elf": { fixed: [], choice: { count: 2, options: ANY_SKILL } }, // Skill Versatility
  "Half-Orc": { fixed: ["Intimidation"], choice: null }, // Menacing
  Bugbear: { fixed: ["Stealth"], choice: null }, // Sneaky
  Goliath: { fixed: ["Athletics"], choice: null }, // Natural Athlete
  Tabaxi: { fixed: ["Perception", "Stealth"], choice: null }, // Cat's Talent
  Satyr: { fixed: ["Performance", "Persuasion"], choice: null }, // Reveler
  Kenku: {
    fixed: [],
    choice: { count: 2, options: ["Acrobatics", "Deception", "Stealth", "Sleight of Hand"] },
  },
  Lizardfolk: {
    fixed: [],
    choice: { count: 2, options: ["Animal Handling", "Nature", "Perception", "Stealth", "Survival"] },
  },
  Changeling: {
    fixed: [],
    choice: { count: 2, options: ["Deception", "Insight", "Intimidation", "Persuasion"] },
  },
  Centaur: { fixed: [], choice: { count: 1, options: ["Animal Handling", "Medicine", "Nature", "Survival"] } },
  Leonin: { fixed: [], choice: { count: 1, options: ["Athletics", "Intimidation", "Perception", "Survival"] } },
  Minotaur: { fixed: [], choice: { count: 1, options: ["Intimidation", "Persuasion"] } },
  Shifter: { fixed: [], choice: { count: 1, options: ["Acrobatics", "Athletics", "Intimidation", "Survival"] } },
  Tortle: {
    fixed: [],
    choice: { count: 1, options: ["Animal Handling", "Medicine", "Nature", "Perception", "Stealth", "Survival"] },
  },
  Warforged: { fixed: [], choice: { count: 1, options: ANY_SKILL } }, // Specialized Design
};

const NO_GRANT: RaceSkillGrant = { fixed: [], choice: null };

export function raceSkillGrant(raceName: string | null | undefined): RaceSkillGrant {
  return (raceName && RACE_SKILL_GRANTS[raceName]) || NO_GRANT;
}
