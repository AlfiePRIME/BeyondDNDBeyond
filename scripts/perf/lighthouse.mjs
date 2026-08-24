#!/usr/bin/env node
// Lighthouse check for the app's 2D pages (Prompt 2).
//
// Reuses Playwright's already-installed Chromium (via chrome-launcher's
// chromePath option) instead of downloading a second copy of Chrome.
// Runs against the production server — build first with `yarn build`.
//
// Usage: node scripts/perf/lighthouse.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));
const PORT = 3100;

function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(url);
        if (res.ok || res.status < 500) return resolve();
      } catch {
        /* not up yet */
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Server at ${url} did not start within ${timeoutMs}ms`));
      }
      setTimeout(attempt, 300);
    };
    attempt();
  });
}

const server = spawn("yarn", ["start", "--port", String(PORT)], {
  cwd: rootDir,
  stdio: "ignore",
});

let chrome;
try {
  await waitForServer(`http://localhost:${PORT}/`);

  chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"],
  });

  const result = await lighthouse(`http://localhost:${PORT}/`, {
    port: chrome.port,
    onlyCategories: ["performance", "accessibility"],
    output: "json",
  });

  const perfScore = Math.round(result.lhr.categories.performance.score * 100);
  const a11yScore = Math.round(result.lhr.categories.accessibility.score * 100);

  const minPerf = budgets.lighthouse.minPerformanceScore;
  const minA11y = budgets.lighthouse.minAccessibilityScore;

  console.log(`Lighthouse performance score: ${perfScore} (budget: >= ${minPerf})`);
  console.log(`Lighthouse accessibility score: ${a11yScore} (budget: >= ${minA11y})`);

  if (perfScore < minPerf || a11yScore < minA11y) {
    console.error("FAIL: one or more Lighthouse scores are below budget.");
    process.exitCode = 1;
  } else {
    console.log("PASS");
  }
} finally {
  if (chrome) await chrome.kill();
  server.kill();
}
