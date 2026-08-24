#!/usr/bin/env node
// Headless 3D render benchmark (Prompt 2).
//
// Loads a Three.js scene in headless Chromium (via Playwright — WebGL needs
// a real browser, not just Node) and measures average frame time. Prompt 2's
// scene is a placeholder table; Prompt 19 points this same harness at the
// real Game Room scene once it exists.
//
// Usage: node scripts/perf/render-benchmark.mjs

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const filePath =
        urlPath === "/"
          ? join(rootDir, "scripts/perf/fixtures/render-benchmark.html")
          : join(rootDir, urlPath);
      try {
        const body = readFileSync(filePath);
        res.writeHead(200, {
          "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const server = await startServer();
const { port } = server.address();

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/scripts/perf/fixtures/render-benchmark.html?frames=180`);

  const result = await page.waitForFunction(
    () => window.__BENCHMARK_RESULT__ ?? false,
    { timeout: 30_000 }
  ).then((handle) => handle.jsonValue());

  const budgetMs = budgets.render3d.maxAvgFrameTimeMs;

  console.log(`3D render benchmark: ${result.frameCount} frames`);
  console.log(`Average frame time: ${result.avgFrameTimeMs.toFixed(2)} ms (budget: ${budgetMs} ms)`);
  console.log(`Implied fps: ${(1000 / result.avgFrameTimeMs).toFixed(1)}`);

  if (result.avgFrameTimeMs > budgetMs) {
    console.error(`FAIL: average frame time ${result.avgFrameTimeMs.toFixed(2)} ms exceeds budget ${budgetMs} ms.`);
    process.exitCode = 1;
  } else {
    console.log("PASS");
  }
} finally {
  await browser.close();
  server.close();
}
