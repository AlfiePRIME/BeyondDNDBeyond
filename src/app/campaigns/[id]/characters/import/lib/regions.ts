import type { AbilityScore } from "@/rules-engine";
import { ABILITY_ORDER } from "./types";

// D&D Beyond's character sheet PDF template is US Letter (612x792pt) with a
// fixed layout — these coordinates were measured directly against a real
// export (see Prompt 14 notes) and only hold for this template version. The
// sanity check in textCheck.ts is what protects against a different
// template silently producing garbage instead of failing loudly.
export const PAGE_WIDTH_PT = 612;
export const PAGE_HEIGHT_PT = 792;
export const RENDER_DPI = 200;

export interface PtBox {
  xPt: number;
  yTopPt: number;
  wPt: number;
  hPt: number;
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function ptBoxToPixelRect(box: PtBox, dpi: number = RENDER_DPI): PixelRect {
  const scale = dpi / 72;
  return {
    left: Math.round(box.xPt * scale),
    top: Math.round((PAGE_HEIGHT_PT - box.yTopPt) * scale),
    width: Math.round(box.wPt * scale),
    height: Math.round(box.hPt * scale),
  };
}

export const CHARACTER_NAME_BOX: PtBox = { xPt: 55, yTopPt: 725, wPt: 210, hPt: 26 };
export const CLASS_LEVEL_BOX: PtBox = { xPt: 260, yTopPt: 750, wPt: 215, hPt: 26 };
export const SPECIES_BOX: PtBox = { xPt: 260, yTopPt: 725, wPt: 120, hPt: 26 };
export const MAX_HP_BOX: PtBox = { xPt: 415, yTopPt: 645, wPt: 90, hPt: 55 };
export const ARMOR_CLASS_BOX: PtBox = { xPt: 336, yTopPt: 636, wPt: 34, hPt: 20 };
export const SPEED_BOX: PtBox = { xPt: 225, yTopPt: 410, wPt: 150, hPt: 45 };

// Ability score header label positions (top-left of the label text, in pt),
// measured from the sample export. The score's shield-shaped value box sits
// just below each label.
const ABILITY_LABEL_POS: Record<AbilityScore, { x: number; y: number }> = {
  strength: { x: 41.1, y: 637.6 },
  dexterity: { x: 41.5, y: 560.7 },
  constitution: { x: 34.3, y: 484.5 },
  intelligence: { x: 36.0, y: 407.6 },
  wisdom: { x: 44.1, y: 331.0 },
  charisma: { x: 41.5, y: 254.6 },
};

export function abilityScoreBox(ability: AbilityScore): PtBox {
  const pos = ABILITY_LABEL_POS[ability];
  return { xPt: pos.x - 19, yTopPt: pos.y - 2, wPt: 75, hPt: 34 };
}

// Saving throw and skill rows share one list widget (circle proficiency
// glyph + underlined bonus + name + ability abbreviation), 13.5pt apart.
// Row order here matches the alphabetical order D&D Beyond prints them in
// — not the rules-engine's internal SKILLS array order.
export const SAVE_ROW_NAMES: AbilityScore[] = ABILITY_ORDER;
const SAVE_ROW_TOP_Y = 662;
const SAVE_ROW_BOTTOM_Y = 577;
export const SAVES_BLOCK_BOX: PtBox = {
  xPt: 95,
  yTopPt: SAVE_ROW_TOP_Y,
  wPt: 155,
  hPt: SAVE_ROW_TOP_Y - SAVE_ROW_BOTTOM_Y,
};

export const SKILL_ROW_NAMES: string[] = [
  "Acrobatics",
  "Animal Handling",
  "Arcana",
  "Athletics",
  "Deception",
  "History",
  "Insight",
  "Intimidation",
  "Investigation",
  "Medicine",
  "Nature",
  "Perception",
  "Performance",
  "Persuasion",
  "Religion",
  "Sleight of Hand",
  "Stealth",
  "Survival",
];
const SKILLS_BLOCK_TOP_Y = 495;
const SKILLS_BLOCK_BOTTOM_Y = 245;
export const SKILLS_BLOCK_BOX: PtBox = {
  xPt: 95,
  yTopPt: SKILLS_BLOCK_TOP_Y,
  wPt: 155,
  hPt: SKILLS_BLOCK_TOP_Y - SKILLS_BLOCK_BOTTOM_Y,
};

// Page 2's equipment table is two side-by-side NAME/QTY/WEIGHT columns —
// only NAME and QTY map onto the character schema.
export const EQUIPMENT_LEFT_COLUMN_BOX: PtBox = { xPt: 105, yTopPt: 268, wPt: 230, hPt: 260 };
export const EQUIPMENT_RIGHT_COLUMN_BOX: PtBox = { xPt: 345, yTopPt: 268, wPt: 200, hPt: 260 };

// Page 4's spell table body, below the PREP/SPELL NAME/... header row.
// Unlike every other region here, this was never calibrated against a
// filled-in example (the sample character is a non-caster) — see
// mapToDraft.ts and the README notes on this being best-effort.
export const SPELL_TABLE_BOX: PtBox = { xPt: 25, yTopPt: 635, wPt: 210, hPt: 580 };

// Labels + approximate positions checked to confirm a PDF is a recognizable
// D&D Beyond sheet before attempting OCR on it at all.
export const SANITY_CHECK_LABELS: { text: string; x: number; y: number }[] = [
  { text: "CHARACTER NAME", x: 69.1, y: 695.5 },
  { text: "CLASS & LEVEL", x: 270.7, y: 721.8 },
  { text: "SPECIES", x: 270.7, y: 695.7 },
  { text: "STRENGTH", x: 41.1, y: 637.6 },
  { text: "DEXTERITY", x: 41.5, y: 560.7 },
  { text: "SKILLS", x: 140.0, y: 189.9 },
  { text: "HIT POINTS", x: 480.0, y: 599.7 },
  { text: "PROFICIENCY BONUS", x: 283.4, y: 472.3 },
  { text: "INITIATIVE", x: 240.7, y: 600.2 },
  { text: "SAVING THROWS", x: 124.6, y: 512.3 },
];
export const SANITY_CHECK_TOLERANCE_PT = 5;
export const SANITY_CHECK_MIN_MATCHES = 8;
