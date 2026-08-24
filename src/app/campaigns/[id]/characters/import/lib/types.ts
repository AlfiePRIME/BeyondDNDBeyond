import type { AbilityScore, AbilityScores } from "@/rules-engine";
import type { InventoryItem, KnownSpell } from "@/data-access";

export interface CharacterDraft {
  name: string;
  race: string | null;
  raceRaw: string;
  class: string | null;
  classRaw: string;
  level: number;
  abilityScores: AbilityScores;
  maxHp: number;
  armorClass: number;
  speed: number;
  proficiencies: string[];
  inventory: InventoryItem[];
  spells: KnownSpell[];
  warnings: string[];
}

export type ImportFailureReason = "not-a-pdf" | "unrecognized-sheet" | "server-error";

export interface ImportFailure {
  ok: false;
  reason: ImportFailureReason;
  message: string;
}

export interface ImportSuccess {
  ok: true;
  draft: CharacterDraft;
}

export type ImportResult = ImportSuccess | ImportFailure;

export interface RawRowValue {
  name: string;
  bonus: number | null;
}

export interface RawSheetData {
  characterName: string;
  classLevelRaw: string;
  speciesRaw: string;
  abilityScores: AbilityScores;
  maxHp: number | null;
  armorClass: number | null;
  speedFeet: number | null;
  saveRows: RawRowValue[];
  skillRows: RawRowValue[];
  inventory: InventoryItem[];
  spells: KnownSpell[];
}

export const ABILITY_ORDER: AbilityScore[] = [
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
];
