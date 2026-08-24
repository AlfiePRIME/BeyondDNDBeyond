import { inspectPdf } from "./textCheck";
import { rasterizePdf } from "./raster";
import { extractSheetData } from "./extractSheet";
import { mapToDraft } from "./mapToDraft";
import type { ImportResult } from "./types";

const MAX_PAGES = 4;

export const NOT_A_PDF_MESSAGE =
  "That file doesn't look like a valid PDF. Export your character as a PDF from D&D Beyond and try again.";

export const UNRECOGNIZED_SHEET_MESSAGE =
  "This PDF doesn't look like a D&D Beyond character sheet export — the layout doesn't match what this importer expects. Build your character manually instead.";

export const SERVER_ERROR_MESSAGE =
  "Something went wrong reading that PDF. You can try again, or build your character manually instead.";

/** Full pipeline: validate → sanity-check → rasterize → OCR → map. Every
 * failure path returns a typed result rather than throwing, so the route
 * handler never has to guess what went wrong. */
export async function importCharacterSheet(bytes: Buffer): Promise<ImportResult> {
  let inspection: Awaited<ReturnType<typeof inspectPdf>>;
  try {
    inspection = await inspectPdf(new Uint8Array(bytes));
  } catch {
    return { ok: false, reason: "not-a-pdf", message: NOT_A_PDF_MESSAGE };
  }

  if (!inspection.looksLikeDndBeyondSheet) {
    return { ok: false, reason: "unrecognized-sheet", message: UNRECOGNIZED_SHEET_MESSAGE };
  }

  const pdf = await rasterizePdf(bytes, Math.min(MAX_PAGES, inspection.pageCount));
  try {
    const raw = await extractSheetData(pdf, inspection.pageCount);
    const draft = mapToDraft(raw);
    return { ok: true, draft };
  } catch {
    return { ok: false, reason: "server-error", message: SERVER_ERROR_MESSAGE };
  } finally {
    await pdf.cleanup();
  }
}
