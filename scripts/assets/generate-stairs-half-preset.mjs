#!/usr/bin/env node
// Generates the "Stairs (Half)" built-in preset map asset — a second,
// additive stairs preset that climbs exactly 1 terrain level (half of the
// existing "Stairs" preset's 2 terrain levels), for the project owner's
// request: "the current stairs preset goes up 2 terrain levels, I would
// like another one that goes up 1 terrain step." The EXISTING "Stairs"
// preset (scripts/assets/generate-map-presets.mjs's buildStairs(), seeded
// 0016) is completely unchanged by this — this is a purely additive new
// .glb + a new seed migration, the exact generate-bridge-preset.mjs
// precedent (a separate script rather than touching generate-map-
// presets.mjs, which hard-codes its output migration path to an
// already-applied 0016_asset_library_presets.sql).
//
// Geometry choice: HALF AS MANY STEPS (2, not 4) at the IDENTICAL per-step
// rise/run (0.22/0.3) as the existing 4-step flight — not 4 shorter/
// shallower steps. This was a deliberate judgment call (the task explicitly
// leaves it open, "whichever produces a more natural-looking result"):
//   - It reuses buildStairs()'s own step-rise/run ratio exactly, so the
//     flight's INCLINE ANGLE is identical to the full-height stairs — a
//     real short flight of stairs (e.g. a stoop, or stairs up to a single
//     raised landing) keeps the SAME riser/tread proportions as a longer
//     flight; a real staircase doesn't get shallower just because it's
//     shorter. Fewer steps at the same rise/run is what "half a flight of
//     the same stairs" means in the real world.
//   - The alternative (4 steps, each half as tall: rise 0.11) would
//     produce a shallow ~20° ramp-like incline instead of a recognizable
//     staircase silhouette, and wouldn't visually read as "the same stairs,
//     just shorter" — it would read as a DIFFERENT (much gentler) object.
//   - 2 steps × 0.22 rise = 0.44 total rise = EXACTLY half of the existing
//     4-step flight's 0.88 total rise — i.e. exactly 1 terrain level where
//     the existing preset is exactly 2, matching STAIRS_STEP_RISE *
//     STAIRS_STEP_COUNT's own halving precisely (not approximately).
// Confirmed visually sensible (not squashed/oddly proportioned) via a real
// rendered screenshot — see this prompt's own final report.
//
// Usage: node scripts/assets/generate-stairs-half-preset.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Same Node/FileReader shim generate-map-presets.mjs/generate-bridge-
// preset.mjs need for the binary GLTFExporter path.
if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((result) => {
        this.result = result;
        this.onloadend?.();
      });
    }
  };
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(rootDir, "public", "assets", "presets");

// The IDENTICAL stone material generate-map-presets.mjs's buildStairs()
// uses, so the two stairs presets read as the same built-in prop family
// (same look and feel), not a mismatched addition.
const STONE = 0x6d7178;
const stone = () => new THREE.MeshStandardMaterial({ color: STONE, roughness: 0.9, flatShading: true });

function prop(...meshes) {
  const group = new THREE.Group();
  for (const [geometry, material, x, y, z, rotation] of meshes) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    if (rotation) mesh.rotation.set(...rotation);
    group.add(mesh);
  }
  return group;
}

// buildStairs()'s OWN step-rise/run ratio and step styling, reused exactly
// (see this file's own top comment for why 2 steps, not 4-at-half-height).
const STEP_RISE = 0.22;
const STEP_RUN = 0.3;
const STEP_COUNT = 2;

function buildStairsHalf() {
  const steps = [];
  // Each step is a full-height block down to the ground (not a floating
  // tread) — the exact buildStairs() approach, so the flight reads as solid
  // from every camera angle, at half the run-length: total z-span 0.6
  // (2 * 0.3) instead of 1.2, centered the same way (starting at -0.3
  // instead of -0.45, buildStairs()'s own `-0.45 + 0.3 * i` formula with
  // this preset's own STEP_COUNT/2 offset).
  const zStart = -(STEP_RUN * STEP_COUNT) / 2 + STEP_RUN / 2; // -0.3
  for (let i = 0; i < STEP_COUNT; i++) {
    const height = STEP_RISE * (i + 1);
    steps.push([new THREE.BoxGeometry(1, height, STEP_RUN), stone(), 0, height / 2, zStart + STEP_RUN * i]);
  }
  return prop(...steps);
}

function exportGlb(scene) {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(scene, (result) => resolve(Buffer.from(result)), reject, { binary: true });
  });
}

function loadGlb(buffer) {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, "", resolve, reject);
  });
}

mkdirSync(outDir, { recursive: true });

const scene = new THREE.Scene();
scene.add(buildStairsHalf());
const glb = await exportGlb(scene);

const gltf = await loadGlb(glb);
let meshCount = 0;
let triangleCount = 0;
gltf.scene.traverse((object) => {
  if (object.isMesh) {
    meshCount++;
    const { index, attributes } = object.geometry;
    triangleCount += (index ? index.count : attributes.position.count) / 3;
  }
});
if (meshCount === 0 || triangleCount === 0) {
  throw new Error("export of stairs-half reloaded with no geometry");
}

writeFileSync(join(outDir, "stairs-half.glb"), glb);
console.log(
  `wrote public/assets/presets/stairs-half.glb (${glb.length} bytes, ${meshCount} meshes, ${triangleCount} triangles)`
);
