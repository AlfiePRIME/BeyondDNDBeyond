#!/usr/bin/env node
// Generates the "Bridge" built-in preset map asset (bridges and stairs, a
// post-roadmap addition) — low-poly primitive geometry exported as .glb
// into public/assets/presets/, the exact generate-map-presets.mjs approach
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
// (supabase/migrations/, see that migration's own comment), hand-written
// once, the same way every other addition after 0016 has worked.
//
// "Stairs" needed no equivalent script — that preset (and its .glb) already
// existed since 0016, purely decorative until this addition gave it real
// movement-rules behavior via map_objects.crossing_type, not new geometry.
//
// Usage: node scripts/assets/generate-bridge-preset.mjs

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

// Same walnut/stone palette as generate-map-presets.mjs's own WOOD/WOOD_DARK/
// IRON, so a bridge reads as part of the same built-in prop set, not a
// mismatched addition.
const WOOD = 0x5a4028;
const WOOD_DARK = 0x42301c;
const IRON = 0x3a3d42;

const wood = () => new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.75 });
const woodDark = () => new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.8 });
const iron = () => new THREE.MeshStandardMaterial({ color: IRON, roughness: 0.5, metalness: 0.6 });

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

// A single-cell plank bridge with two low side rails and four corner-post
// supports — long enough to visually span a 1x1 cell's own footprint (the
// unit MapSurface renders every preset at), reading clearly as "a crossing
// structure laid over whatever's beneath it" rather than a solid block.
function buildBridge() {
  const halfSpan = 0.46;
  const post = (x, z) => [new THREE.CylinderGeometry(0.05, 0.06, 0.5, 8), iron(), x, -0.1, z];
  const rail = (z) => [new THREE.CylinderGeometry(0.03, 0.03, 0.92, 8), woodDark(), 0, 0.28, z, [0, 0, Math.PI / 2]];
  return prop(
    [new THREE.BoxGeometry(0.92, 0.06, 0.7), wood(), 0, 0.1, 0],
    post(-halfSpan, -0.32),
    post(halfSpan, -0.32),
    post(-halfSpan, 0.32),
    post(halfSpan, 0.32),
    rail(-0.32),
    rail(0.32)
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
scene.add(buildBridge());
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
  throw new Error("export of bridge reloaded with no geometry");
}

writeFileSync(join(outDir, "bridge.glb"), glb);
console.log(
  `wrote public/assets/presets/bridge.glb (${glb.length} bytes, ${meshCount} meshes, ${triangleCount} triangles)`
);
