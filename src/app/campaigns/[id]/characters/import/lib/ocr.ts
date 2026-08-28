import { createWorker, PSM, type Worker } from "tesseract.js";
import { ptBoxToPixelRect, type PtBox } from "./regions";

// Vendored English trained-data, self-hosted per the project's principle of
// not depending on external services at runtime (aside from the one
// carved-out LLM call elsewhere in the app) — tesseract.js defaults to
// fetching this from a CDN, so langPath must point here instead.
// process.cwd() (not __dirname) deliberately keeps this a plain runtime
// filesystem read rather than something a bundler tries to trace/copy.
// Lives under public/ (NOT src/) specifically because of `next build`'s
// standalone output mode: production runs `node server.js` from
// `.next/standalone`, where process.cwd() resolves there too, and standalone
// output only ever carries `public/` and `.next/static` (copied by the
// deploy step, same as every other static asset) — it does NOT carry `src/`
// at all. This file used to live under src/app/.../tessdata, which worked
// under `next dev`/`next start` (both run from the repo root with the full
// source tree present) but silently broke character PDF import specifically
// in the standalone production deployment — confirmed live: a real user
// report of "character PDF importing is broken again," root-caused to
// `.next/standalone/src` simply not existing. Built with string
// concatenation rather than `path.join` — see the comment in raster.ts on
// why `path.join` on a dynamic base crashes the Turbopack build when it
// tries to trace it as an asset reference.
const LANG_PATH = `${process.cwd()}/public/tessdata`;

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

// extractSheetData makes 15+ of these calls sequentially per import (one
// per labeled region across up to 4 pages) with no bound of its own on any
// single one — a single stalled recognize() (a WASM/worker-communication
// stall, or just a heavily CPU-contended host, observed directly) would
// otherwise hang the entire import indefinitely with no way for the route's
// own try/catch (runImport.ts) to ever see it. This doesn't stop the
// underlying tesseract work (the worker keeps running until its own
// terminate() call in extractSheetData's finally block) — it just stops
// making the caller wait past a reasonable bound, so a genuinely stuck
// recognize() surfaces as the normal SERVER_ERROR_MESSAGE instead of an
// unbounded "reading your character sheet."
const RECOGNIZE_TIMEOUT_MS = 30000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function recognizeRegion(
  worker: Worker,
  pagePath: string,
  box: PtBox,
  psm: PSM
): Promise<OcrResult> {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await withTimeout(
    worker.recognize(pagePath, { rectangle: ptBoxToPixelRect(box) }),
    RECOGNIZE_TIMEOUT_MS,
    "OCR recognize()"
  );
  return { text: data.text, confidence: data.confidence };
}

export { PSM };
