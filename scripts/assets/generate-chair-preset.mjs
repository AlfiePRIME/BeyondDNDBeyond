#!/usr/bin/env node
// Generates the "Chair" placeable map preset (project owner's own follow-up
// request: "we also need chairs, these should be able to be sat on by
// players NPCs and enemies") — low-poly primitive geometry exported as a
// .glb into public/assets/presets/, the exact generate-tavern-presets.mjs/
// generate-building-presets.mjs approach (round-tripped through GLTFLoader
// so a structurally broken export fails generation instead of at render
// time).
//
// A plain wooden dining chair — four legs, a seat, and three vertical
// backrest slats — the SAME "ordinary small prop" treatment as every other
// built-in furniture preset (Table, Chest, the tavern furniture batch).
//
// "Sat on" needs no seat-occupancy mechanic of its own: confirmed by
// reading src/rules-engine/movement.ts's computeReachableCells (the token
// pathing/reachability computation) before writing this script — it only
// ever consults OTHER TOKENS' positions (occupiedCells) and cell terrain,
// never map_objects at all, so a token has always been free to move onto
// any placed object's cell, decorative or not. A Chair preset is therefore
// "sittable" by any player, NPC, or hostile token the moment it exists,
// with zero new movement/occupancy logic required — this script and its
// matching asset_library seed migration are the whole feature.
//
// Deliberately a SEPARATE script rather than adding to an already-applied
// migration's own preset list — same reasoning every post-0016 preset
// script gives (see generate-tavern-presets.mjs's own top comment): those
// scripts hard-code their output migration path to an already-applied
// migration, so re-running them after seeding would silently rewrite
// shipped SQL instead of adding a new one.
//
// Usage: node scripts/assets/generate-chair-preset.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Same Node/FileReader shim every generate-*-presets.mjs script needs for
// the binary GLTFExporter path.
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

// Same walnut/dark-accent palette as generate-tavern-presets.mjs, so this
// reads as part of the same built-in furniture set.
const WOOD = 0x5a4028;
const WOOD_DARK = 0x42301c;

const wood = () => new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.75 });
const woodDark = () => new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.8 });

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

// ═══════════════════════════════════════════════════════════════════════
// Chair — four legs, a seat, and three vertical backrest slats. +Z is the
// chair's own front (where a seated occupant's legs would face) — no
// forward-direction correction needed at seed time (asset_library's
// model_orientation defaults to 0, meaning "already authored facing the
// convention" — see docs/design/model-orientation-and-posing.md §8), the
// same as every other non-directional-looking built-in prop.
// ═══════════════════════════════════════════════════════════════════════
const SEAT_WIDTH = 0.46;
const SEAT_DEPTH = 0.46;
const SEAT_HEIGHT = 0.05;
const SEAT_Y = 0.45; // top of the legs
const LEG_SIZE = 0.045;
const LEG_HEIGHT = SEAT_Y;
const BACK_HEIGHT = 0.4;
const BACK_TOP_Y = SEAT_Y + SEAT_HEIGHT + BACK_HEIGHT;

function buildChair() {
  const inset = SEAT_WIDTH / 2 - LEG_SIZE / 2 - 0.01;
  const leg = (x, z) => [
    new THREE.BoxGeometry(LEG_SIZE, LEG_HEIGHT, LEG_SIZE),
    wood(),
    x,
    LEG_HEIGHT / 2,
    z,
  ];
  const slat = (x) => [
    new THREE.BoxGeometry(0.05, BACK_HEIGHT, 0.03),
    woodDark(),
    x,
    SEAT_Y + SEAT_HEIGHT + BACK_HEIGHT / 2,
    -SEAT_DEPTH / 2 + 0.02,
  ];
  return prop(
    leg(-inset, -inset),
    leg(inset, -inset),
    leg(-inset, inset),
    leg(inset, inset),
    [new THREE.BoxGeometry(SEAT_WIDTH, SEAT_HEIGHT, SEAT_DEPTH), woodDark(), 0, SEAT_Y + SEAT_HEIGHT / 2, 0],
    // Top rail joining the two back legs, capping the slats.
    [
      new THREE.BoxGeometry(SEAT_WIDTH - 0.04, 0.04, 0.03),
      wood(),
      0,
      BACK_TOP_Y - 0.02,
      -SEAT_DEPTH / 2 + 0.02,
    ],
    slat(-0.14),
    slat(0),
    slat(0.14)
  );
}

const PRESETS = [{ id: "chair", uuid: "a55e7036-0000-4000-8000-000000000036", name: "Chair", build: buildChair }];

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

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = maxDim > 1e-3 ? 0.92 / maxDim : 1;

  writeFileSync(join(outDir, `${preset.id}.glb`), glb);
  console.log(
    `wrote public/assets/presets/${preset.id}.glb (${glb.length} bytes, ${meshCount} meshes, ${triangleCount} triangles)`
  );
  console.log(
    `  measured bounding box: x=${size.x.toFixed(5)} y=${size.y.toFixed(5)} z=${size.z.toFixed(5)} -> maxDim=${maxDim.toFixed(5)}, render scale=${scale.toFixed(5)}, render height=${(size.y * scale).toFixed(5)} (auto-normalized to a single cell at render time, same as every other preset)`
  );
}

const migrationHint = `-- Add the following to a new numbered migration (see supabase/migrations/):
insert into public.asset_library (id, name, source_type, model_ref) values
${PRESETS.map((p) => `  ('${p.uuid}', '${p.name}', 'preset', '/assets/presets/${p.id}.glb')`).join(",\n")}
on conflict (id) do nothing;
`;
console.log(`\n${migrationHint}`);
