import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-server-only cross-origin guard (Next.js 15+): by default `next dev`
  // rejects requests whose Host/Origin isn't localhost or an explicit
  // 127.0.0.1 address, to stop a malicious site from reaching your local
  // dev server. Accessing the app through a reverse proxy on a real
  // domain (Nginx Proxy Manager, in this project's case) trips that guard
  // — static chunk requests 403 and the HMR websocket fails to connect.
  // This does not affect a production build (`next start`), only `next dev`.
  allowedDevOrigins: ["beyond.alfieprime.com"],

  // Both do Node-specific filesystem/worker things (pdfjs-dist spawns a
  // "fake worker" via a dynamic import of its own worker script;
  // tesseract.js reads its core/wasm files off disk) that Turbopack's
  // bundling breaks — pdfjs-dist's worker import resolves to a bundled
  // chunk path that doesn't exist on disk. Excluding them from bundling
  // lets native Node `require`/`import` resolve them directly instead.
  serverExternalPackages: ["pdfjs-dist", "tesseract.js"],

  // Prompt 62 — production Docker image. Emits a minimal, self-contained
  // server (.next/standalone) with only the production node_modules a
  // request actually needs traced in, instead of requiring the full
  // repo + node_modules in the runtime image. Orthogonal to
  // serverExternalPackages above (that controls what Turbopack/webpack
  // bundles vs. leaves as a native `require`; this controls what
  // `next build` copies into a deployable output directory) — verified
  // by actually building afterward, not just assumed.
  output: "standalone",

  // The standalone trace above is static analysis (@vercel/nft): it can
  // only see literal import/require calls, not a package's own INTERNAL
  // runtime-dynamic file resolution. Both pdfjs-dist and tesseract.js do
  // exactly that (see serverExternalPackages' own comment above) — pdf.js
  // resolves its worker script, character maps (cmaps/), and non-embedded
  // font substitutes (standard_fonts/) by constructing a path/URL at
  // runtime rather than importing them, and tesseract.js's actual OCR
  // engine lives in the separate tesseract.js-core package, loaded the
  // same dynamic way. The tracer silently drops all of it — confirmed
  // directly: a built .next/standalone/node_modules/pdfjs-dist contained
  // only legacy/build/pdf.mjs (no worker, no cmaps, no fonts, not even a
  // package.json), and tesseract.js-core was entirely absent. This
  // produces no build error and no obvious symptom until a real PDF
  // exercises the missing code path at runtime (a non-embedded/unusual
  // font or encoding for pdf.js; any OCR pass at all for tesseract.js),
  // at which point the failure gets caught by this route's own broad
  // try/catch and surfaces as a generic "not a valid PDF" — the actual
  // cause is a missing runtime file, not the uploaded PDF.
  outputFileTracingIncludes: {
    "/campaigns/\\[id\\]/characters/import/parse": [
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/tesseract.js-core/**/*",
    ],
  },
};

export default nextConfig;
