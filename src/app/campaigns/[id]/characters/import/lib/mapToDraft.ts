import { RACES, CLASSES, SKILL_ABILITY, abilityModifier, type AbilityScore, type SkillName } from "@/rules-engine";
import { bestFuzzyMatch } from "./fuzzyMatch";
import { cleanFreeText, extractClassAndLevel } from "./parseFields";
import type { CharacterDraft, RawSheetData } from "./types";

const ABILITY_LABEL: Record<AbilityScore, string> = {
  strength: "Strength",
  dexterity: "Dexterity",
  constitution: "Constitution",
  intelligence: "Intelligence",
  wisdom: "Wisdom",
  charisma: "Charisma",
};

const RACE_NAMES = RACES.flatMap((r) => [r.name, ...(r.subraces?.map((s) => s.name) ?? [])]);
const CLASS_NAMES = CLASSES.map((c) => c.name);

function clampScore(value: number): number {
  return Math.min(30, Math.max(1, value));
}

/** Turns raw OCR strings/numbers into a fully-formed, editable draft —
 * fuzzy-matches race/class against rules-engine data (leaving them
 * unresolved rather than guessing when there's no confident match) and
 * infers save/skill proficiency by comparing each OCR'd bonus against the
 * no-proficiency baseline computed from the OCR'd ability scores. */
export function mapToDraft(raw: RawSheetData): CharacterDraft {
  const warnings: string[] = [];

  const name = raw.characterName || "Imported Character";
  if (!raw.characterName) {
    warnings.push("Couldn't read the character's name from the PDF — enter it below.");
  }

  const classAndLevel = extractClassAndLevel(raw.classLevelRaw);
  const classRaw = classAndLevel?.classRaw ?? cleanFreeText(raw.classLevelRaw);
  const level = classAndLevel?.level ?? 1;
  const matchedClass = classRaw ? bestFuzzyMatch(classRaw, CLASS_NAMES) : null;
  if (!matchedClass) {
    warnings.push(`Couldn't confidently match a class from "${classRaw}" — pick one below.`);
  }

  const speciesLines = raw.speciesRaw
    .split("\n")
    .map(cleanFreeText)
    .filter((line) => line.length > 1);
  let matchedRace: string | null = null;
  let raceRaw = speciesLines[speciesLines.length - 1] ?? "";
  for (const line of speciesLines) {
    const match = bestFuzzyMatch(line, RACE_NAMES);
    if (match) {
      matchedRace = match;
      raceRaw = line;
      break;
    }
  }
  if (!matchedRace) {
    warnings.push(`Couldn't confidently match a race from "${raceRaw}" — pick one below.`);
  }

  const abilityScores = {
    strength: clampScore(raw.abilityScores.strength),
    dexterity: clampScore(raw.abilityScores.dexterity),
    constitution: clampScore(raw.abilityScores.constitution),
    intelligence: clampScore(raw.abilityScores.intelligence),
    wisdom: clampScore(raw.abilityScores.wisdom),
    charisma: clampScore(raw.abilityScores.charisma),
  };

  const maxHp = raw.maxHp ?? 10;
  if (raw.maxHp === null) warnings.push("Couldn't read max HP — check it below.");

  const armorClass = raw.armorClass ?? 10 + abilityModifier(abilityScores.dexterity);
  if (raw.armorClass === null) {
    warnings.push("Couldn't read armor class — defaulted from Dexterity, check it below.");
  }

  const speed = raw.speedFeet ?? 30;
  if (raw.speedFeet === null) warnings.push("Couldn't read speed — defaulted to 30 ft, check it below.");

  const proficiencies: string[] = [];
  for (const row of raw.saveRows) {
    if (row.bonus === null) continue;
    const ability = row.name.toLowerCase() as AbilityScore;
    const baseline = abilityModifier(abilityScores[ability]);
    if (row.bonus > baseline) proficiencies.push(`${ABILITY_LABEL[ability]} Saving Throws`);
  }
  for (const row of raw.skillRows) {
    if (row.bonus === null) continue;
    const ability = SKILL_ABILITY[row.name as SkillName];
    const baseline = abilityModifier(abilityScores[ability]);
    if (row.bonus > baseline) proficiencies.push(row.name);
  }

  return {
    name,
    race: matchedRace,
    raceRaw,
    class: matchedClass,
    classRaw,
    level,
    abilityScores,
    maxHp,
    armorClass,
    speed,
    proficiencies,
    inventory: raw.inventory,
    spells: raw.spells,
    warnings,
  };
}
