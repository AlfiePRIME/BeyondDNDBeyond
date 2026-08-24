import type { InventoryItem } from "@/data-access";
import { bestFuzzyMatch } from "./fuzzyMatch";
import { cleanFreeText, longestAlphabeticRun } from "./parseFields";

const IGNORED_ROW =
  /^(equipment|name|qty|weight|attuned magic items|weight carried|encumbered|push\/drag\/lift|cp|ep|pp|gp|sp)$/i;

/**
 * Best-effort: OCR'd rows don't reliably line up name/qty/weight into
 * columns, so this scans line-by-line, treating a run of letters as an
 * item name and a bare following number as its quantity (defaulting to 1
 * when no distinct quantity line follows — the common case, since most
 * equipment quantities are 1).
 */
export function parseEquipmentColumn(ocrText: string): InventoryItem[] {
  const lines = ocrText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const items: InventoryItem[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i += 1;
    if (IGNORED_ROW.test(line)) continue;
    if (/^tm\s*&/i.test(line)) continue;
    // A weight-column line, e.g. "10 lb." — OCR is inconsistent about the
    // "l"/"I" in "lb", sometimes misreading it as a capital "I" ("10 Ib."),
    // sometimes dropping it and the space entirely ("10b."), so all of
    // those forms are accepted.
    if (/^[\d,]+\.?\s*[lI]?b\.?$/i.test(line)) continue;
    if (!/[A-Za-z]/.test(line)) continue;
    if (/^[\d,]+$/.test(line)) continue;

    const name = cleanFreeText(line.replace(/,\s*$/, ""));
    if (name.length < 2) continue;

    let quantity = 1;
    for (let j = i; j < Math.min(i + 2, lines.length); j++) {
      const next = lines[j];
      const qtyMatch = next.match(/^([\d,]+)$/);
      if (qtyMatch) {
        quantity = Number(qtyMatch[1].replace(/,/g, "")) || 1;
        i = j + 1;
        break;
      }
      if (/[A-Za-z]/.test(next)) break;
    }
    items.push({ name, quantity });
  }
  return items;
}

/**
 * Best-effort spell extraction: fuzzy-matches OCR'd lines against the
 * rules-engine's known spell list rather than trying to parse the table's
 * columns, since level/school aren't reliably OCR-able from this table and
 * the known list already carries level. Unverified against a real filled
 * caster sheet — see the spell-table unit test for synthetic coverage.
 */
export function parseSpellTable(ocrText: string, knownSpellNames: readonly string[]): string[] {
  const lines = ocrText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const matched = new Set<string>();
  for (const line of lines) {
    const run = longestAlphabeticRun(line);
    if (run.length < 3) continue;
    const match = bestFuzzyMatch(run, knownSpellNames, 0.8);
    if (match) matched.add(match);
  }
  return [...matched];
}
