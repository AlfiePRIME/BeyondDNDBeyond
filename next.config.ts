import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
};

export default nextConfig;
