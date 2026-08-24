import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { RENDER_DPI } from "./regions";

const execFileAsync = promisify(execFile);

export interface RasterizedPdf {
  pagePath: (page: number) => string;
  cleanup: () => Promise<void>;
}

/**
 * Renders pages 1..lastPage of the PDF to PNG via poppler's pdftoppm CLI
 * (a system dependency documented in the README) — pdfjs-dist's own
 * canvas-based rendering was found to garble this template's embedded
 * font, while pdftoppm renders it correctly. Caller must call cleanup().
 *
 * Deliberately avoids `path.join`/`path.resolve` on these temp-dir paths —
 * Turbopack's build-time asset tracer statically pattern-matches
 * `path.join(...)` calls to guess at filesystem asset references, and with
 * a dynamic (not statically-known) first segment like `tmpdir()` it falls
 * back to conservatively walking the whole project directory looking for a
 * match. That walk hits `supabase/volumes/db/data` (a Docker-owned,
 * permission-restricted Postgres data directory) and hard-crashes the
 * build instead of skipping it — reproduced and confirmed by bisection;
 * plain string concatenation isn't pattern-matched the same way and
 * sidesteps the whole problem. Not a Windows-portable path join, but this
 * app only ever runs on Linux (see README self-hosting notes).
 */
export async function rasterizePdf(pdfBytes: Buffer, lastPage: number): Promise<RasterizedPdf> {
  const dir = await mkdtemp(`${tmpdir()}/dndb-import-`);
  const inputPath = `${dir}/input.pdf`;
  await writeFile(inputPath, pdfBytes);
  const prefix = `${dir}/page`;

  try {
    await execFileAsync("pdftoppm", [
      "-png",
      "-r",
      String(RENDER_DPI),
      "-f",
      "1",
      "-l",
      String(lastPage),
      inputPath,
      prefix,
    ]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new Error("pdftoppm could not rasterize this file", { cause: err });
  }

  // poppler only pads the page-number suffix once the highest page number
  // in a given invocation reaches double digits — lastPage is capped at 4
  // (MAX_PAGES in runImport.ts), so the unpadded form always holds here.
  return {
    pagePath: (page: number) => `${dir}/page-${page}.png`,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
