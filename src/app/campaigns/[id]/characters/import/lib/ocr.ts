import { createWorker, PSM, type Worker } from "tesseract.js";
import { ptBoxToPixelRect, type PtBox } from "./regions";

// Vendored English trained-data, self-hosted per the project's principle of
// not depending on external services at runtime (aside from the one
// carved-out LLM call elsewhere in the app) — tesseract.js defaults to
// fetching this from a CDN, so langPath must point here instead.
// process.cwd() (not __dirname) deliberately keeps this a plain runtime
// filesystem read rather than something a bundler tries to trace/copy —
// `next dev`/`next start` both run from the repo root with the full source
// tree present, so the file is always alongside this route. Built with
// string concatenation rather than `path.join` — see the comment in
// raster.ts on why `path.join` on a dynamic base crashes the Turbopack
// build when it tries to trace it as an asset reference.
const LANG_PATH = `${process.cwd()}/src/app/campaigns/[id]/characters/import/tessdata`;

export async function createOcrWorker(): Promise<Worker> {
  return createWorker("eng", 1, {
    langPath: LANG_PATH,
    gzip: false,
    cachePath: LANG_PATH,
    cacheMethod: "none",
  });
}

export interface OcrResult {
  text: string;
  confidence: number;
}

export async function recognizeRegion(
  worker: Worker,
  pagePath: string,
  box: PtBox,
  psm: PSM
): Promise<OcrResult> {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(pagePath, { rectangle: ptBoxToPixelRect(box) });
  return { text: data.text, confidence: data.confidence };
}

export { PSM };
