#!/usr/bin/env node
// Generates the built-in preset map assets (Prompt 24): low-poly props built
// from primitive geometry, exported as .glb into public/assets/presets/,
// plus the migration that seeds them into asset_library. Unlike the avatar
// presets (static manifest only), map assets live in a real DB table — the
// seed migration IS the manifest, so no parallel TS manifest is generated;
// this script owns the fixed UUIDs so files and rows can't drift apart.
//
// The migration runner applies each file exactly once, so re-running this
// after 0016 has been applied updates the .glb files but NOT existing rows —
// changing the asset SET (not just geometry) needs a new migration.
//
// Usage: node scripts/assets/generate-map-presets.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// GLTFExporter's binary path reads Blobs via FileReader, which Node doesn't
// provide — a minimal arrayBuffer-only shim is enough for geometry+material
// exports (no textures/canvas anywhere in these presets, by design).
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
const migrationPath = join(rootDir, "supabase", "migrations", "0016_asset_library_presets.sql");

// Same walnut palette as GameTableScene's table so "real" wooden props read
// as part of the one scene; stone/leaf/metal tones picked to sit naturally
// alongside it rather than the room's neon accents.
const WOOD = 0x5a4028;
const WOOD_DARK = 0x42301c;
const STONE = 0x6d7178;
const STONE_DARK = 0x4c5057;
const LEAF = 0x2d6a3f;
const IRON = 0x3a3d42;
const GOLD = 0xc9a227;
const FLAME = 0xff8c1a;

const wood = () => new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.75 });
const woodDark = () => new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.8 });
const stone = () => new THREE.MeshStandardMaterial({ color: STONE, roughness: 0.9, flatShading: true });
const stoneDark = () => new THREE.MeshStandardMaterial({ color: STONE_DARK, roughness: 0.9, flatShading: true });
const leaf = () => new THREE.MeshStandardMaterial({ color: LEAF, roughness: 0.85, flatShading: true });
const iron = () => new THREE.MeshStandardMaterial({ color: IRON, roughness: 0.5, metalness: 0.6 });
const gold = () => new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.4, metalness: 0.7 });
const flame = () =>
  new THREE.MeshStandardMaterial({ color: FLAME, emissive: FLAME, emissiveIntensity: 2, roughness: 0.4 });

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

function buildTorch() {
  return prop(
    [new THREE.ConeGeometry(0.13, 0.14, 8), iron(), 0, 0.07, 0],
    [new THREE.CylinderGeometry(0.035, 0.035, 1.1, 8), woodDark(), 0, 0.65, 0],
    [new THREE.CylinderGeometry(0.06, 0.05, 0.12, 8), iron(), 0, 1.2, 0],
    [new THREE.ConeGeometry(0.1, 0.26, 8), flame(), 0, 1.39, 0],
    [new THREE.SphereGeometry(0.06, 8, 6), flame(), 0, 1.3, 0]
  );
}

function buildChest() {
  return prop(
    [new THREE.BoxGeometry(0.7, 0.35, 0.45), wood(), 0, 0.175, 0],
    [new THREE.BoxGeometry(0.7, 0.02, 0.45), woodDark(), 0, 0.36, 0],
    // Half-cylinder lid, laid along the chest's width.
    [
      new THREE.CylinderGeometry(0.225, 0.225, 0.7, 12, 1, false, 0, Math.PI),
      wood(),
      0,
      0.35,
      0,
      [0, 0, Math.PI / 2],
    ],
    [new THREE.BoxGeometry(0.06, 0.37, 0.47), gold(), -0.18, 0.175, 0],
    [new THREE.BoxGeometry(0.06, 0.37, 0.47), gold(), 0.18, 0.175, 0],
    [new THREE.BoxGeometry(0.1, 0.12, 0.05), gold(), 0, 0.34, 0.22]
  );
}

function buildDoor() {
  return prop(
    [new THREE.BoxGeometry(0.14, 2.1, 0.18), stone(), -0.51, 1.05, 0],
    [new THREE.BoxGeometry(0.14, 2.1, 0.18), stone(), 0.51, 1.05, 0],
    [new THREE.BoxGeometry(1.16, 0.16, 0.18), stone(), 0, 2.18, 0],
    [new THREE.BoxGeometry(0.88, 2.1, 0.08), wood(), 0, 1.05, 0],
    [new THREE.BoxGeometry(0.88, 0.08, 0.1), woodDark(), 0, 0.7, 0],
    [new THREE.BoxGeometry(0.88, 0.08, 0.1), woodDark(), 0, 1.5, 0],
    [new THREE.SphereGeometry(0.045, 8, 6), gold(), 0.32, 1.02, 0.07]
  );
}

function buildTable() {
  const legX = 0.52;
  const legZ = 0.32;
  const leg = (x, z) => [new THREE.BoxGeometry(0.09, 0.72, 0.09), woodDark(), x, 0.36, z];
  return prop(
    [new THREE.BoxGeometry(1.2, 0.07, 0.8), wood(), 0, 0.755, 0],
    leg(-legX, -legZ),
    leg(legX, -legZ),
    leg(-legX, legZ),
    leg(legX, legZ)
  );
}

function buildTree() {
  return prop(
    [new THREE.CylinderGeometry(0.11, 0.16, 0.5, 8), woodDark(), 0, 0.25, 0],
    [new THREE.ConeGeometry(0.55, 0.85, 8), leaf(), 0, 0.85, 0],
    [new THREE.ConeGeometry(0.42, 0.75, 8), leaf(), 0, 1.4, 0],
    [new THREE.ConeGeometry(0.28, 0.6, 8), leaf(), 0, 1.9, 0]
  );
}

function buildRock() {
  const main = new THREE.Mesh(new THREE.IcosahedronGeometry(0.38, 0), stone());
  main.position.set(0, 0.26, 0);
  main.scale.set(1.15, 0.75, 1);
  main.rotation.set(0.2, 0.6, 0.1);
  const small = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 0), stoneDark());
  small.position.set(0.38, 0.13, 0.16);
  small.scale.set(1, 0.7, 1);
  small.rotation.set(0, 1.1, 0.15);
  const group = new THREE.Group();
  group.add(main, small);
  return group;
}

function buildWall() {
  const merlon = (x) => [new THREE.BoxGeometry(0.32, 0.22, 0.3), stone(), x, 1.59, 0];
  return prop(
    [new THREE.BoxGeometry(2, 1.4, 0.3), stone(), 0, 0.7, 0],
    [new THREE.BoxGeometry(2, 0.08, 0.38), stoneDark(), 0, 1.44, 0],
    merlon(-0.7),
    merlon(0),
    merlon(0.7)
  );
}

function buildStairs() {
  const steps = [];
  // Each step is a full-height block down to the ground (not a floating
  // tread), so the flight reads as solid from every camera angle.
  for (let i = 0; i < 4; i++) {
    const height = 0.22 * (i + 1);
    steps.push([new THREE.BoxGeometry(1, height, 0.3), stone(), 0, height / 2, -0.45 + 0.3 * i]);
  }
  return prop(...steps);
}

const PRESETS = [
  { id: "torch", uuid: "a55e7001-0000-4000-8000-000000000001", name: "Torch", build: buildTorch },
  { id: "chest", uuid: "a55e7002-0000-4000-8000-000000000002", name: "Chest", build: buildChest },
  { id: "door", uuid: "a55e7003-0000-4000-8000-000000000003", name: "Door", build: buildDoor },
  { id: "table", uuid: "a55e7004-0000-4000-8000-000000000004", name: "Table", build: buildTable },
  { id: "tree", uuid: "a55e7005-0000-4000-8000-000000000005", name: "Tree", build: buildTree },
  { id: "rock", uuid: "a55e7006-0000-4000-8000-000000000006", name: "Rock", build: buildRock },
  { id: "wall", uuid: "a55e7007-0000-4000-8000-000000000007", name: "Wall Segment", build: buildWall },
  { id: "stairs", uuid: "a55e7008-0000-4000-8000-000000000008", name: "Stairs", build: buildStairs },
];

function exportGlb(scene) {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(scene, (result) => resolve(Buffer.from(result)), reject, { binary: true });
  });
}

// Round-trip each export through GLTFLoader (not just a magic-bytes sniff)
// so a structurally broken .glb fails generation instead of failing at
// render time in the Game Room.
function loadGlb(buffer) {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, "", resolve, reject);
  });
}

mkdirSync(outDir, { recursive: true });

for (const preset of PRESETS) {
  const scene = new THREE.Scene();
  scene.add(preset.build());
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
    throw new Error(`export of ${preset.id} reloaded with no geometry`);
  }

  writeFileSync(join(outDir, `${preset.id}.glb`), glb);
  console.log(
    `wrote public/assets/presets/${preset.id}.glb (${glb.length} bytes, ${meshCount} meshes, ${triangleCount} triangles)`
  );
}

const migration = `-- Prompt 24: seed the built-in preset map assets. Generated by
-- scripts/assets/generate-map-presets.mjs — regenerate there, don't hand-edit.
--
-- Seeded via migration (as postgres, bypassing RLS) because 0015's insert
-- policy deliberately forbids preset rows (campaign_id null) through the
-- app path — presets are seeded data by design. Fixed UUIDs keep the rows'
-- identity stable and inspectable across environments.

insert into public.asset_library (id, name, source_type, model_ref) values
${PRESETS.map((p) => `  ('${p.uuid}', '${p.name}', 'preset', '/assets/presets/${p.id}.glb')`).join(",\n")}
on conflict (id) do nothing;
`;
writeFileSync(migrationPath, migration);
console.log(`wrote supabase/migrations/0016_asset_library_presets.sql (${PRESETS.length} presets)`);
