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
  // runtime rather than importing them, and tesseract.js spawns its OCR
  // work in a real Node worker_thread (src/worker-script/node/index.js)
  // that itself does a relative `require('..')` back up into the rest of
  // the tesseract.js package tree once running — something the tracer,
  // walking forward from createWorker's own static imports, never
  // followed. The tracer silently drops all of this — confirmed directly:
  // a built .next/standalone/node_modules/pdfjs-dist contained only
  // legacy/build/pdf.mjs (no worker, no cmaps, no fonts, not even a
  // package.json); tesseract.js-core was entirely absent; and
  // tesseract.js/src/worker-script itself had only 1 of its real 13
  // files. None of this produces a build error. pdfjs-dist's gap throws a
  // catchable exception (surfacing as a generic "not a valid PDF" via this
  // route's own broad try/catch). tesseract.js's gap is worse: the missing
  // module crashes the newly-spawned worker THREAD before it can send its
  // own "I'm ready" message, and that failure never propagates back to the
  // main thread's awaited createWorker() promise at all — the request just
  // hangs forever with near-zero CPU (a dead, waiting thread, not
  // computation), the exact symptom this was root-caused against a real
  // browser session, not assumed.
  outputFileTracingIncludes: {
    "/campaigns/\\[id\\]/characters/import/parse": [
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/tesseract.js/**/*",
      "./node_modules/tesseract.js-core/**/*",
    ],
  },
};

export default nextConfig;
