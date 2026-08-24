#!/usr/bin/env node
// Bundle-size budget check (Prompt 2).
//
// Sums the baseline JS chunks every page loads (Next.js/React runtime +
// polyfills, per .next/build-manifest.json) and fails if the total exceeds
// the budget in perf-budgets.json. Run `yarn build` first.
//
// Usage: node scripts/perf/bundle-size.mjs

import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nextDir = join(rootDir, ".next");
const manifestPath = join(nextDir, "build-manifest.json");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  console.error(
    `Could not read ${manifestPath} — run "yarn build" before this check.`
  );
  process.exit(1);
}

const files = [
  ...(manifest.rootMainFiles ?? []),
  ...(manifest.polyfillFiles ?? []),
];

if (files.length === 0) {
  console.error("No root/polyfill chunks found in build-manifest.json — build output may have changed shape.");
  process.exit(1);
}

let totalBytes = 0;
const breakdown = [];
for (const file of files) {
  const filePath = join(nextDir, file);
  try {
    const { size } = statSync(filePath);
    totalBytes += size;
    breakdown.push({ file, kb: (size / 1024).toFixed(1) });
  } catch {
    console.warn(`Warning: could not stat ${filePath}, skipping.`);
  }
}

const totalKb = totalBytes / 1024;
const budgetKb = budgets.bundleSize.mainPageFirstLoadKb;

console.log("Bundle size (baseline JS every page loads):");
for (const { file, kb } of breakdown) {
  console.log(`  ${file}: ${kb} KB`);
}
console.log(`Total: ${totalKb.toFixed(1)} KB (budget: ${budgetKb} KB)`);

if (totalKb > budgetKb) {
  console.error(`FAIL: bundle size ${totalKb.toFixed(1)} KB exceeds budget ${budgetKb} KB.`);
  process.exit(1);
}

console.log("PASS");
