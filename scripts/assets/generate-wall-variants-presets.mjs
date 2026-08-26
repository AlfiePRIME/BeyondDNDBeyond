#!/usr/bin/env node
// Generates the "Wall Corner" and "Wall Diagonal" built-in preset map assets
// (procedural-wall gap/corner/diagonal fix) — low-poly primitive geometry
// exported as .glb into public/assets/presets/, the exact
// generate-map-presets.mjs/generate-bridge-preset.mjs approach (round-tripped
// through GLTFLoader so a structurally broken export fails generation
// instead of at render time).
//
// Deliberately a SEPARATE script rather than adding to generate-map-
// presets.mjs's own PRESETS array (generate-bridge-preset.mjs's identical
// reasoning): that script hard-codes its output migration path to the
// already-applied 0016_asset_library_presets.sql — re-running it after
// adding entries would silently rewrite a shipped migration instead of
// adding a new one. This script only ever touches the two new .glb files;
// the seed INSERT for the two new asset_library rows lives in its own new
// numbered migration (supabase/migrations/, see that migration's own
// comment), hand-written once, the same way bridge.glb's addition worked.
//
// Both new presets are authored DIRECTLY at their final on-screen size
// (unlike wall.glb's legacy 2-unit-wide authoring, scaled down 0.46x by
// PLACED_OBJECT_SIZE historically, now 0.5x by the new full-span fit
// target) — see src/scene-3d/PlacedObject.tsx's WALL_FIT_TARGET_BY_URL doc
// comment for exactly how each of the three wall presets' own authored
// bounding box maps to its render-time scale, and why the diagonal
// specifically needs its own precisely-measured fit target rather than the
// shared 1 (cell-size) the straight and corner presets use.
//
// Usage: node scripts/assets/generate-wall-variants-presets.mjs

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

// Same stone palette as generate-map-presets.mjs's buildWall(), so these two
// new presets read as the SAME masonry, not a mismatched addition.
const STONE = 0x6d7178;
const STONE_DARK = 0x4c5057;

const stone = () => new THREE.MeshStandardMaterial({ color: STONE, roughness: 0.9, flatShading: true });
const stoneDark = () => new THREE.MeshStandardMaterial({ color: STONE_DARK, roughness: 0.9, flatShading: true });

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

// Final target proportions a straight Wall Segment lands at AFTER this same
// fix's new full-span (1 world-unit) fit target is applied to wall.glb's own
// legacy 2-unit-wide authoring: height 1.7 * (1/2) = 0.85, thickness
// 0.38 * (1/2) = 0.19 — see PlacedObject.tsx. Both new presets below are
// authored using these exact numbers directly (rather than a doubled size
// needing the same 0.5 scale-down) so a straight run, a corner, and a
// diagonal all present the identical cross-section/height, reading as one
// consistent wall family with no visible seam where they meet.
const WALL_HEIGHT = 0.85;
const WALL_THICKNESS = 0.19;
const CAP_HEIGHT = 0.08;
const CAP_THICKNESS = WALL_THICKNESS + 0.08;
const CAP_Y = WALL_HEIGHT + CAP_HEIGHT / 2;

// A symmetric "plus" of two full-cell-length wall slabs crossing at 90° —
// each arm is the SAME cross-section/height as the (fixed) straight Wall
// Segment, spanning the ENTIRE cell edge-to-edge exactly like a straight
// run does, so it connects flush with a straight neighbor on ANY of its 4
// sides. Rotationally symmetric under 90° turns by construction, so a room
// corner needs no per-corner rotation at all (see templates.ts's
// classifyWallCell) — the same asset/rotation works at every one of a
// rectangular room's 4 corners.
function buildWallCorner() {
  const merlon = (x, z) => [new THREE.BoxGeometry(0.16, 0.22, 0.16), stone(), x, WALL_HEIGHT + 0.11, z];
  return prop(
    [new THREE.BoxGeometry(1, WALL_HEIGHT, WALL_THICKNESS), stone(), 0, WALL_HEIGHT / 2, 0],
    [new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, 1), stone(), 0, WALL_HEIGHT / 2, 0],
    [new THREE.BoxGeometry(1, CAP_HEIGHT, CAP_THICKNESS), stoneDark(), 0, CAP_Y, 0],
    [new THREE.BoxGeometry(CAP_THICKNESS, CAP_HEIGHT, 1), stoneDark(), 0, CAP_Y, 0],
    merlon(-0.35, 0),
    merlon(0.35, 0),
    merlon(0, -0.35),
    merlon(0, 0.35),
    merlon(0, 0)
  );
}

// A single beam long enough to reach both opposite corners of a 1x1 cell
// (Math.SQRT2, the cell's own diagonal) baked at a 45° rotation — for
// octagonal/organic room shapes (or the void-terrain-carved organic shapes
// this app already supports) where a straight/corner run needs to cut a
// cell's true corner instead of turning a right angle through it.
function buildWallDiagonal() {
  const beamLength = Math.SQRT2;
  const bake = [0, Math.PI / 4, 0];
  return prop(
    [new THREE.BoxGeometry(beamLength, WALL_HEIGHT, WALL_THICKNESS), stone(), 0, WALL_HEIGHT / 2, 0, bake],
    [new THREE.BoxGeometry(beamLength, CAP_HEIGHT, CAP_THICKNESS), stoneDark(), 0, CAP_Y, 0, bake]
  );
}

const PRESETS = [
  { id: "wall-corner", uuid: "a55e7010-0000-4000-8000-000000000010", name: "Wall Corner", build: buildWallCorner },
  {
    id: "wall-diagonal",
    uuid: "a55e7011-0000-4000-8000-000000000011",
    name: "Wall Diagonal",
    build: buildWallDiagonal,
  },
];

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

  // The exact real, vertex-level measurement PlacedObject.tsx's PropModel
  // itself performs at render time (Box3.setFromObject on the real,
  // round-tripped glTF scene) — printed here so WALL_FIT_TARGET_BY_URL's
  // per-asset fit target can be set from a REAL measured number, not a
  // hand-derived guess (this project's own established debugging
  // discipline — see this task's brief).
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  writeFileSync(join(outDir, `${preset.id}.glb`), glb);
  console.log(
    `wrote public/assets/presets/${preset.id}.glb (${glb.length} bytes, ${meshCount} meshes, ${triangleCount} triangles)`
  );
  console.log(
    `  measured bounding box: x=${size.x.toFixed(5)} y=${size.y.toFixed(5)} z=${size.z.toFixed(5)} → maxDim=${maxDim.toFixed(5)}`
  );
}

const migrationHint = `-- Add the following to a new numbered migration (see supabase/migrations/):
insert into public.asset_library (id, name, source_type, model_ref) values
${PRESETS.map((p) => `  ('${p.uuid}', '${p.name}', 'preset', '/assets/presets/${p.id}.glb')`).join(",\n")}
on conflict (id) do nothing;
`;
console.log(`\n${migrationHint}`);
