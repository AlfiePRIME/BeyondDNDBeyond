import type { SkillDefinition, SkillName, AbilityScore } from "./types";

export const SKILLS: SkillDefinition[] = [
  { name: "Athletics", ability: "strength" },
  { name: "Acrobatics", ability: "dexterity" },
  { name: "Sleight of Hand", ability: "dexterity" },
  { name: "Stealth", ability: "dexterity" },
  { name: "Arcana", ability: "intelligence" },
  { name: "History", ability: "intelligence" },
  { name: "Investigation", ability: "intelligence" },
  { name: "Nature", ability: "intelligence" },
  { name: "Religion", ability: "intelligence" },
  { name: "Animal Handling", ability: "wisdom" },
  { name: "Insight", ability: "wisdom" },
  { name: "Medicine", ability: "wisdom" },
  { name: "Perception", ability: "wisdom" },
  { name: "Survival", ability: "wisdom" },
  { name: "Deception", ability: "charisma" },
  { name: "Intimidation", ability: "charisma" },
  { name: "Performance", ability: "charisma" },
  { name: "Persuasion", ability: "charisma" },
];

export const SKILL_ABILITY: Record<SkillName, AbilityScore> = Object.fromEntries(
  SKILLS.map((skill) => [skill.name, skill.ability])
) as Record<SkillName, AbilityScore>;
