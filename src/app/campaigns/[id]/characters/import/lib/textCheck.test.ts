import { describe, expect, it } from "vitest";
import { inspectPdf } from "./textCheck";

// pdfjs-dist's legacy Node build (`legacy/build/pdf.mjs`) constructs a
// `DOMMatrix` at module scope unconditionally, even though inspectPdf()
// only ever calls getDocument()/getTextContent() (no rendering). Without
// domMatrixPolyfill.ts's globalThis.DOMMatrix shim, merely importing
// textCheck.ts throws "ReferenceError: DOMMatrix is not defined" — this
// broke the entire import route (every request, not just non-matching
// PDFs) after a pdfjs-dist upgrade. A minimal hand-built PDF is enough to
// prove the module loads and runs; it doesn't need to look like a real
// D&D Beyond export.
const MINIMAL_PDF = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj",
    "trailer<</Size 4/Root 1 0 R>>",
    "%%EOF",
  ].join("\n"),
  "utf8"
);

describe("inspectPdf", () => {
  it("loads pdfjs-dist's legacy Node build without throwing", async () => {
    const result = await inspectPdf(new Uint8Array(MINIMAL_PDF));
    expect(result.pageCount).toBe(1);
    expect(result.looksLikeDndBeyondSheet).toBe(false);
  });
});
