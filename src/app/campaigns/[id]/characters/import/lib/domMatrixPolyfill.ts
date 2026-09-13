import CSSMatrix from "@thednp/dommatrix";

// pdfjs-dist's legacy Node build unconditionally constructs one at module
// scope (`const SCALE_MATRIX = new DOMMatrix();` in
// legacy/build/pdf.mjs) — merely importing it crashes in plain Node with
// "DOMMatrix is not defined" unless something has already polyfilled the
// global first. pdfjs-dist's own fallback only fires if `@napi-rs/canvas`
// is installed, which this project deliberately avoids (see raster.ts: it
// garbles this PDF template's embedded font when used for actual
// rendering) — but a full DOMMatrix implementation has nothing to do with
// that font problem, since textCheck.ts's inspectPdf() never renders
// anything. A tiny, native-binary-free polyfill is enough to satisfy the
// otherwise-dead top-level construction. Must be imported before any
// `pdfjs-dist/legacy/build/pdf.mjs` import.
if (typeof globalThis.DOMMatrix === "undefined") {
  // @ts-expect-error - polyfilling a browser global pdfjs-dist's Node build expects
  globalThis.DOMMatrix = CSSMatrix;
}
