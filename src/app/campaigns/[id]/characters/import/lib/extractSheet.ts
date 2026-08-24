import { SPELLS, type AbilityScores } from "@/rules-engine";
import type { InventoryItem } from "@/data-access";
import { ABILITY_ORDER, type RawSheetData } from "./types";
import {
  ARMOR_CLASS_BOX,
  CHARACTER_NAME_BOX,
  CLASS_LEVEL_BOX,
  EQUIPMENT_LEFT_COLUMN_BOX,
  EQUIPMENT_RIGHT_COLUMN_BOX,
  MAX_HP_BOX,
  SAVES_BLOCK_BOX,
  SAVE_ROW_NAMES,
  SKILLS_BLOCK_BOX,
  SKILL_ROW_NAMES,
  SPECIES_BOX,
  SPEED_BOX,
  SPELL_TABLE_BOX,
  abilityScoreBox,
} from "./regions";
import { createOcrWorker, recognizeRegion, PSM } from "./ocr";
import {
  extractFeet,
  extractFirstInt,
  matchRowsToOcrText,
  pickMostAlphabeticLine,
} from "./parseFields";
import { parseEquipmentColumn, parseSpellTable } from "./parseTables";
import type { RasterizedPdf } from "./raster";

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Runs every calibrated OCR pass over the rasterized pages and returns the
 * raw (unmapped) strings/numbers — mapToDraft.ts turns this into a
 * CharacterDraft against rules-engine data. */
export async function extractSheetData(pdf: RasterizedPdf, pageCount: number): Promise<RawSheetData> {
  const worker = await createOcrWorker();
  try {
    const page1 = pdf.pagePath(1);

    const nameResult = await recognizeRegion(worker, page1, CHARACTER_NAME_BOX, PSM.SINGLE_BLOCK);
    const classLevelResult = await recognizeRegion(worker, page1, CLASS_LEVEL_BOX, PSM.SINGLE_BLOCK);
    const speciesResult = await recognizeRegion(worker, page1, SPECIES_BOX, PSM.SINGLE_BLOCK);

    const abilityScores = {} as AbilityScores;
    for (const ability of ABILITY_ORDER) {
      const result = await recognizeRegion(worker, page1, abilityScoreBox(ability), PSM.SPARSE_TEXT);
      abilityScores[ability] = extractFirstInt(result.text, 2) ?? 10;
    }

    const maxHpResult = await recognizeRegion(worker, page1, MAX_HP_BOX, PSM.SINGLE_BLOCK);
    const acResult = await recognizeRegion(worker, page1, ARMOR_CLASS_BOX, PSM.SINGLE_LINE);
    const speedResult = await recognizeRegion(worker, page1, SPEED_BOX, PSM.SINGLE_BLOCK);

    const savesResult = await recognizeRegion(worker, page1, SAVES_BLOCK_BOX, PSM.SINGLE_BLOCK);
    const saveRows = matchRowsToOcrText(SAVE_ROW_NAMES.map(capitalize), savesResult.text);

    const skillsResult = await recognizeRegion(worker, page1, SKILLS_BLOCK_BOX, PSM.SINGLE_BLOCK);
    const skillRows = matchRowsToOcrText(SKILL_ROW_NAMES, skillsResult.text);

    let inventory: InventoryItem[] = [];
    if (pageCount >= 2) {
      const page2 = pdf.pagePath(2);
      const leftResult = await recognizeRegion(worker, page2, EQUIPMENT_LEFT_COLUMN_BOX, PSM.SPARSE_TEXT);
      const rightResult = await recognizeRegion(worker, page2, EQUIPMENT_RIGHT_COLUMN_BOX, PSM.SPARSE_TEXT);
      inventory = [...parseEquipmentColumn(leftResult.text), ...parseEquipmentColumn(rightResult.text)];
    }

    let spellNames: string[] = [];
    if (pageCount >= 4) {
      const page4 = pdf.pagePath(4);
      const spellResult = await recognizeRegion(worker, page4, SPELL_TABLE_BOX, PSM.SPARSE_TEXT);
      spellNames = parseSpellTable(
        spellResult.text,
        SPELLS.map((s) => s.name)
      );
    }

    return {
      characterName: pickMostAlphabeticLine(nameResult.text),
      classLevelRaw: classLevelResult.text,
      speciesRaw: speciesResult.text,
      abilityScores,
      maxHp: extractFirstInt(maxHpResult.text, 3),
      armorClass: extractFirstInt(acResult.text, 2),
      speedFeet: extractFeet(speedResult.text),
      saveRows,
      skillRows,
      inventory,
      spells: spellNames.map((name) => ({
        name,
        level: SPELLS.find((s) => s.name === name)?.level ?? 0,
      })),
    };
  } finally {
    await worker.terminate();
  }
}
