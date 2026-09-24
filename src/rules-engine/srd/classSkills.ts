import { SKILLS } from "./skills";
import type { ClassName, SkillName } from "./types";

export interface ClassSkillChoice {
  /** How many skills the class picks at 1st level. */
  count: number;
  options: SkillName[];
}

/** SRD 5.1 class "Skills: Choose N from ..." proficiencies (Bard: any
 * three). */
export const CLASS_SKILL_CHOICES: Record<ClassName, ClassSkillChoice> = {
  Barbarian: {
    count: 2,
    options: ["Animal Handling", "Athletics", "Intimidation", "Nature", "Perception", "Survival"],
  },
  Bard: { count: 3, options: SKILLS.map((skill) => skill.name) },
  Cleric: { count: 2, options: ["History", "Insight", "Medicine", "Persuasion", "Religion"] },
  Druid: {
    count: 2,
    options: [
      "Arcana",
      "Animal Handling",
      "Insight",
      "Medicine",
      "Nature",
      "Perception",
      "Religion",
      "Survival",
    ],
  },
  Fighter: {
    count: 2,
    options: [
      "Acrobatics",
      "Animal Handling",
      "Athletics",
      "History",
      "Insight",
      "Intimidation",
      "Perception",
      "Survival",
    ],
  },
  Monk: {
    count: 2,
    options: ["Acrobatics", "Athletics", "History", "Insight", "Religion", "Stealth"],
  },
  Paladin: {
    count: 2,
    options: ["Athletics", "Insight", "Intimidation", "Medicine", "Persuasion", "Religion"],
  },
  Ranger: {
    count: 3,
    options: [
      "Animal Handling",
      "Athletics",
      "Insight",
      "Investigation",
      "Nature",
      "Perception",
      "Stealth",
      "Survival",
    ],
  },
  Rogue: {
    count: 4,
    options: [
      "Acrobatics",
      "Athletics",
      "Deception",
      "Insight",
      "Intimidation",
      "Investigation",
      "Perception",
      "Performance",
      "Persuasion",
      "Sleight of Hand",
      "Stealth",
    ],
  },
  Sorcerer: {
    count: 2,
    options: ["Arcana", "Deception", "Insight", "Intimidation", "Persuasion", "Religion"],
  },
  Warlock: {
    count: 2,
    options: [
      "Arcana",
      "Deception",
      "History",
      "Intimidation",
      "Investigation",
      "Nature",
      "Religion",
    ],
  },
  Wizard: {
    count: 2,
    options: ["Arcana", "History", "Insight", "Investigation", "Medicine", "Religion"],
  },
};
