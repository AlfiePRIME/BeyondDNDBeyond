import { similarity } from "./fuzzyMatch";
import type { RawRowValue } from "./types";

/** First run of `maxDigits`-or-fewer digits found anywhere in the text. */
export function extractFirstInt(text: string, maxDigits = 2): number | null {
  const match = text.match(new RegExp(`\\d{1,${maxDigits}}`));
  return match ? Number(match[0]) : null;
}

/** The "NN ft" pattern D&D Beyond prints speed as, e.g. "30 ft. (Walking)". */
export function extractFeet(text: string): number | null {
  const match = text.match(/(\d{1,3})\s*ft/i);
  return match ? Number(match[1]) : null;
}

/**
 * Class & level are OCR'd together as one banner value (e.g. "Rogue 2");
 * search rather than anchor, since stray OCR noise can land on either side
 * of the real text within the cropped region.
 */
export function extractClassAndLevel(text: string): { classRaw: string; level: number } | null {
  const match = text.match(/([A-Za-z][A-Za-z' -]{2,24}?)\s+(\d{1,2})\b/);
  if (!match) return null;
  const classRaw = match[1].trim();
  const level = Number(match[2]);
  if (!classRaw || level < 1 || level > 20) return null;
  return { classRaw, level };
}

/**
 * Free-text fields (character name) have no vocabulary to fuzzy-match
 * against, so pick whichever OCR'd line has the most letters — the actual
 * value reads longer than stray label bleed-in or border-line noise.
 */
export function pickMostAlphabeticLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let best = "";
  let bestCount = -1;
  for (const line of lines) {
    const count = (line.match(/[A-Za-z]/g) ?? []).length;
    if (count > bestCount) {
      bestCount = count;
      best = line;
    }
  }
  return cleanFreeText(best);
}

export function cleanFreeText(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9' .,-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Longest contiguous run of letters (plus spaces/apostrophes) in a line. */
export function longestAlphabeticRun(line: string): string {
  const runs = line.match(/[A-Za-z][A-Za-z' ]*/g) ?? [];
  return runs.reduce((longest, run) => (run.length > longest.length ? run : longest), "");
}

/**
 * A save/skill row's bonus is the first signed 1-2 digit number in its
 * line, printed to the left of the name. OCR reliably finds the digits but
 * not the "+" sign, so default to positive unless a "-" immediately
 * precedes them.
 */
export function extractBonus(line: string): number | null {
  const match = line.match(/(-)?\s?(\d{1,2})/);
  if (!match) return null;
  const magnitude = Number(match[2]);
  if (magnitude > 25) return null;
  return match[1] ? -magnitude : magnitude;
}

/**
 * Matches each expected save/skill name against the best-scoring line in a
 * block OCR result, rather than trusting line position — occasional stray
 * lines (bleed from neighboring page content) shift positions by one, so
 * name-matching is what keeps rows aligned to the right name.
 */
export function matchRowsToOcrText(names: string[], ocrText: string): RawRowValue[] {
  const lines = ocrText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const used = new Set<number>();

  return names.map((name) => {
    let bestIndex = -1;
    let bestScore = 0;
    lines.forEach((line, i) => {
      if (used.has(i)) return;
      const score = similarity(longestAlphabeticRun(line), name);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });
    if (bestIndex === -1 || bestScore < 0.55) return { name, bonus: null };
    used.add(bestIndex);
    return { name, bonus: extractBonus(lines[bestIndex]) };
  });
}
