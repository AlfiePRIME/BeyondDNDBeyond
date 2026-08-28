#!/usr/bin/env node
// E1 research spike: end-to-end proof-of-concept.
//
// For each synthetic test map (fixtures.mjs): renders the tuned
// control image (controlImage.mjs), uploads it to the real ComfyUI
// instance, builds this track's one fixed default workflow
// (workflow.mjs) with a prompt generated straight from the map's own
// data (buildLegendPrompt), queues it, polls to completion, and saves
// the resulting PNG — real generations against a real GPU-backed
// instance, not a mock. Run in the foreground; this blocks until every
// map is done (a few minutes total) and prints its own progress.
//
// Usage:
//   node scripts/poc/map-art-generation/run.mjs
//   COMFYUI_URL=http://host:8188 node scripts/poc/map-art-generation/run.mjs
//
// See docs/map-art-generation-research.md for what this validated and the
// concrete recommendation for E2-E6.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_MAPS } from "./fixtures.mjs";
import { overlayFromRows, DEFAULT_CELL } from "./mapShapes.mjs";
import { renderMapArtControlImage } from "./controlImage.mjs";
import { encodeRgbPng } from "./png.mjs";
import { buildMapArtWorkflow, buildLegendPrompt, DEFAULTS } from "./workflow.mjs";
import { ComfyClient } from "./comfyClient.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, "../../../docs/map-art-poc-output");

async function runOneMap(client, map, seed) {
  console.log(`\n=== ${map.name} (${map.gridWidth}x${map.gridHeight} cells) ===`);
  const overlay = overlayFromRows(map.cells);

  const { width, height, rgb } = renderMapArtControlImage(map.gridWidth, map.gridHeight, overlay, DEFAULT_CELL);
  const controlPng = encodeRgbPng(width, height, rgb);
  const controlPath = path.join(OUTPUT_DIR, `control-${map.name}.png`);
  fs.writeFileSync(controlPath, controlPng);
  console.log(`control image: ${controlPath} (${width}x${height})`);

  const uploadedName = await client.uploadImage(controlPng, `control-${map.name}.png`);
  console.log(`uploaded as: ${uploadedName}`);

  const prompt = buildLegendPrompt(map.gridWidth, map.gridHeight, overlay, DEFAULT_CELL);
  const graph = buildMapArtWorkflow({
    controlImageFilename: uploadedName,
    prompt,
    width,
    height,
    seed,
    filenamePrefix: `map_art_${map.name}`,
  });

  const started = Date.now();
  const promptId = await client.queuePrompt(graph);
  console.log(`queued: prompt_id=${promptId}`);
  const images = await client.waitForImages(promptId);
  const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`completed in ${elapsedS}s -> ${images[0].filename}`);

  const imageBuffer = await client.fetchImage(images[0]);
  const outPath = path.join(OUTPUT_DIR, `final-${map.name}.png`);
  fs.writeFileSync(outPath, imageBuffer);
  console.log(`saved: ${outPath}`);
  return { map: map.name, controlPath, outPath, elapsedS };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const client = new ComfyClient();

  const stats = await client.systemStats();
  console.log(
    `ComfyUI ${stats.system.comfyui_version} @ ${client.baseUrl} — ` +
      `${stats.devices[0]?.name ?? "unknown device"}`
  );

  const results = [];
  let seed = 42;
  for (const map of TEST_MAPS) {
    results.push(await runOneMap(client, map, seed++));
  }

  console.log("\n=== summary ===");
  console.log(`sampler defaults: steps=${DEFAULTS.steps} guidance=${DEFAULTS.guidance}`);
  for (const r of results) {
    console.log(`${r.map}: ${r.outPath} (${r.elapsedS}s)`);
  }
}

main().catch((err) => {
  console.error("PoC run failed:", err);
  process.exitCode = 1;
});
