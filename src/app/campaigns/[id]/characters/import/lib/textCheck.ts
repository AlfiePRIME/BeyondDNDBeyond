import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import {
  SANITY_CHECK_LABELS,
  SANITY_CHECK_MIN_MATCHES,
  SANITY_CHECK_TOLERANCE_PT,
} from "./regions";

export interface PdfInspection {
  pageCount: number;
  looksLikeDndBeyondSheet: boolean;
}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && "str" in item;
}

/**
 * Text-only pass with pdfjs-dist (no canvas/rendering involved, so none of
 * the embedded-font rendering problems that rule out pdfjs for rasterizing
 * apply here) — confirms the upload is a real PDF and, separately, whether
 * its page-1 static labels land at the positions this whole pipeline's
 * crop regions assume. A PDF from an unrelated app, or a different
 * D&D Beyond template version, fails the second check and must not be
 * OCR'd — it would silently produce a garbage character otherwise.
 */
export async function inspectPdf(pdfBytes: Uint8Array): Promise<PdfInspection> {
  const loadingTask = getDocument({ data: pdfBytes });
  try {
    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const items = content.items
      .filter(isTextItem)
      .map((item) => ({ str: item.str.trim(), x: item.transform[4], y: item.transform[5] }));

    let matches = 0;
    for (const label of SANITY_CHECK_LABELS) {
      const found = items.some(
        (item) =>
          item.str === label.text &&
          Math.abs(item.x - label.x) <= SANITY_CHECK_TOLERANCE_PT &&
          Math.abs(item.y - label.y) <= SANITY_CHECK_TOLERANCE_PT
      );
      if (found) matches += 1;
    }

    return { pageCount, looksLikeDndBeyondSheet: matches >= SANITY_CHECK_MIN_MATCHES };
  } finally {
    await loadingTask.destroy();
  }
}
