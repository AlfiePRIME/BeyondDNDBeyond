#!/usr/bin/env node
// Generates the "Pressure Plate" built-in preset map asset (Map Editor
// Batch A6, general step-on trigger system) — low-poly primitive geometry
// exported as .glb into public/assets/presets/, the exact
// generate-map-presets.mjs/generate-bridge-preset.mjs approach
// (round-tripped through GLTFLoader so a structurally broken export fails
// generation instead of at render time).
//
// Deliberately a SEPARATE script rather than adding to generate-map-
// presets.mjs's own PRESETS array: that script hard-codes its output
// migration path to 0016_asset_library_presets.sql, which is already
// applied in every environment — re-running it after adding an entry would
// silently rewrite an already-shipped migration file instead of adding a
// new one. This script only ever touches the new .glb; the seed INSERT for
// the new asset_library row lives in its own new numbered migration
// (supabase/migrations/0059_interaction_events.sql), hand-written once, the
// same way every other addition after 0016 has worked.
//
// Usage: node scripts/assets/generate-pressure-plate-preset.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Same Node/FileReader shim generate-map-presets.mjs needs for the binary
// GLTFExporter path.
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

// Same stone/iron palette as generate-map-presets.mjs's own STONE_DARK/IRON,
// so a pressure plate reads as part of the same built-in prop set.
const STONE_DARK = 0x4c5057;
const IRON = 0x3a3d42;
const IRON_DARK = 0x2a2c30;

const stoneDark = () => new THREE.MeshStandardMaterial({ color: STONE_DARK, roughness: 0.9, flatShading: true });
const iron = () => new THREE.MeshStandardMaterial({ color: IRON, roughness: 0.5, metalness: 0.6 });
const ironDark = () => new THREE.MeshStandardMaterial({ color: IRON_DARK, roughness: 0.55, metalness: 0.5 });

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

// A flush, near-flat stone recess with a slightly raised iron plate sitting
// in it — reads as "a trap DM prop sitting on the floor", never as a solid
// block, and low enough (0.05 tall at its highest) that it never interferes
// with a token's own placement height on the same cell.
function buildPressurePlate() {
  return prop(
    [new THREE.CylinderGeometry(0.42, 0.42, 0.03, 16), stoneDark(), 0, 0.015, 0],
    [new THREE.CylinderGeometry(0.33, 0.33, 0.05, 16), iron(), 0, 0.04, 0],
    [new THREE.CylinderGeometry(0.24, 0.24, 0.01, 16), ironDark(), 0, 0.07, 0]
  );
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
scene.add(buildPressurePlate());
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
  throw new Error("export of pressure-plate reloaded with no geometry");
}

writeFileSync(join(outDir, "pressure-plate.glb"), glb);
console.log(
  `wrote public/assets/presets/pressure-plate.glb (${glb.length} bytes, ${meshCount} meshes, ${triangleCount} triangles)`
);
