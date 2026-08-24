import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Both do Node-specific filesystem/worker things (pdfjs-dist spawns a
  // "fake worker" via a dynamic import of its own worker script;
  // tesseract.js reads its core/wasm files off disk) that Turbopack's
  // bundling breaks — pdfjs-dist's worker import resolves to a bundled
  // chunk path that doesn't exist on disk. Excluding them from bundling
  // lets native Node `require`/`import` resolve them directly instead.
  serverExternalPackages: ["pdfjs-dist", "tesseract.js"],
};

export default nextConfig;
