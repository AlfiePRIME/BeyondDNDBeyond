#!/usr/bin/env node
// Generates the medieval building exterior-facade preset map assets (Map
// Editor Batch A8a) — low-poly primitive geometry exported as .glb into
// public/assets/presets/, the exact generate-map-presets.mjs/
// generate-wall-variants-presets.mjs approach (round-tripped through
// GLTFLoader so a structurally broken export fails generation instead of at
// render time).
//
// Deliberately a SEPARATE script rather than adding to generate-map-
// presets.mjs's own PRESETS array (every post-0016 script's identical
// reasoning): that script hard-codes its output migration path to the
// already-applied 0016_asset_library_presets.sql — re-running it after
// adding entries would silently rewrite a shipped migration instead of
// adding a new one. This script only ever touches the new .glb files; the
// seed INSERT for each new asset_library row lives in its own new numbered
// migration (supabase/migrations/0066_building_presets.sql), hand-written
// once from this script's own printed migration hint, the same way every
// other addition after 0016 has worked.
//
// Per the project owner's decision (this prompt's own Context): favor FEWER
// distinct base models, with visual variety coming from the separate
// object-coloring/tint feature (Map Editor Batch A3) rather than many
// fully-separate models — these 8 presets deliberately reuse the same
// handful of primitive-construction techniques (a shared hip-roof cone
// helper, the existing wood/stone palette) rather than each getting bespoke
// geometry, exactly like the existing Chest/Torch/Rock presets share
// materials and techniques with each other.
//
// Single-cell footprint, no new multi-cell placement mechanic: every
// existing preset (Chest, Table, Tree, Rock, Wall Segment, Bridge, etc.) is
// auto-normalized to fit inside ONE cell by PlacedObject.tsx's PropModel —
// it measures each model's own real Box3 maxDim and scales it down to
// PLACED_OBJECT_SIZE (0.92 world units), regardless of how "large" the
// asset is authored. No existing preset opts out of this (only the
// wall-object family gets a different, still single-cell, fit target — see
// WALL_FIT_TARGET_BY_URL). These building presets follow that SAME
// precedent rather than inventing a new multi-cell footprint system: each
// one is authored at plausible real-world relative proportions (a door
// looks door-sized next to its own wall, a cart's wheels look wheel-sized
// next to its own bed) and is then auto-scaled down to a single cell like
// every other prop, reading as a "model-village" scale building sitting on
// its own cell — matching a Chest or a Tree's own existing single-cell
// scale convention. This keeps A8a pure generator-script/asset-library work
// with zero changes to map_objects, template collision logic, or the
// placement/movement code that would be needed for a REAL multi-cell
// footprint (out of scope for this prompt; A8b, a separate later prompt,
// only adds a transition-authored-or-not visual badge, not new placement
// mechanics).
//
// Usage: node scripts/assets/generate-building-presets.mjs

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

// Same walnut/stone/gold palette as generate-map-presets.mjs's own WOOD/
// WOOD_DARK/STONE/STONE_DARK/GOLD/IRON, so these buildings read as part of
// the SAME built-in prop set, not a mismatched addition — plus a handful of
// new tones this built-in set didn't need before (thatch, whitewashed
// plaster, dark exposed timber, terracotta roof tile, canvas awning/canopy
// fabric, and a pale hay tone for the farm cart's load).
const WOOD = 0x5a4028;
const WOOD_DARK = 0x42301c;
const STONE = 0x6d7178;
const STONE_DARK = 0x4c5057;
const GOLD = 0xc9a227;
const IRON = 0x3a3d42;
const PLASTER = 0xd9c9a0;
const TIMBER = 0x2b1d12;
const THATCH = 0xcaa752;
const ROOF_TILE = 0x9c4630;
const CANVAS = 0x8a3b2e;
const HAY = 0xd8c164;

const wood = () => new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.75 });
const woodDark = () => new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.8 });
const stone = () => new THREE.MeshStandardMaterial({ color: STONE, roughness: 0.9, flatShading: true });
const stoneDark = () => new THREE.MeshStandardMaterial({ color: STONE_DARK, roughness: 0.9, flatShading: true });
const gold = () => new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.4, metalness: 0.7 });
const iron = () => new THREE.MeshStandardMaterial({ color: IRON, roughness: 0.5, metalness: 0.6 });
const plaster = () => new THREE.MeshStandardMaterial({ color: PLASTER, roughness: 0.85 });
const timber = () => new THREE.MeshStandardMaterial({ color: TIMBER, roughness: 0.7 });
const thatch = () => new THREE.MeshStandardMaterial({ color: THATCH, roughness: 0.95, flatShading: true });
const roofTile = () => new THREE.MeshStandardMaterial({ color: ROOF_TILE, roughness: 0.8, flatShading: true });
const canvas = () => new THREE.MeshStandardMaterial({ color: CANVAS, roughness: 0.6 });
const hay = () => new THREE.MeshStandardMaterial({ color: HAY, roughness: 0.95, flatShading: true });

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

// A 4-sided pyramid ("hip") roof matching a rectangular footprint of
// halfWidth*2 x halfDepth*2, plus a small eave overhang beyond that
// footprint on every side. Built from a 4-radial-segment cone (apex at
// +height/2, base ring at -height/2) — confirmed via a real vertex dump of
// THREE.ConeGeometry(1, 1, 4) (this task's own check, not assumed from the
// three.js docs alone) that the DEFAULT base ring sits at the four
// CARDINAL points (±1,0)/(0,±1), which would make the roof's sloped faces
// point diagonally (NE/SE/SW/NW) — cockeyed relative to a box footprint's
// own flat, cardinal-facing walls. Rotating the geometry 45° about Y moves
// those same ring vertices onto the DIAGONALS instead, which is exactly
// what a hip roof needs: each of the 4 sloped faces then points straight at
// one of the box's own flat walls (N/E/S/W), with the roof's hip edges
// running down to the box's own corners. Because that 45° rotation shrinks
// each vertex's reach from the unit circle to the unit circle's own
// inscribed-square radius (1/√2), the geometry is scaled back up by √2 (on
// top of the requested half-width/half-depth-plus-overhang) so the ring
// lands exactly on the intended rectangle, not 29% short of it.
function hipRoofGeometry(halfWidth, halfDepth, height, overhang = 0.06) {
  const geometry = new THREE.ConeGeometry(1, height, 4);
  geometry.rotateY(Math.PI / 4);
  geometry.scale(Math.SQRT2 * (halfWidth + overhang), 1, Math.SQRT2 * (halfDepth + overhang));
  return geometry;
}

// A small stone cottage: plain stone walls, a straw-thatched hip roof, one
// window, and a corner chimney poking up through the roofline (a low-poly
// simplification — the chimney box isn't boolean-cut into the roof mesh,
// matching this built-in set's existing precedent of accent props sitting
// visually "into" a silhouette without a true intersection, e.g. buildWall's
// merlons).
function buildCottage() {
  const wallHeight = 1.0;
  const roofHeight = 0.65;
  return prop(
    [new THREE.BoxGeometry(1.4, wallHeight, 1.1), stone(), 0, wallHeight / 2, 0],
    [hipRoofGeometry(0.7, 0.55, roofHeight, 0.08), thatch(), 0, wallHeight + roofHeight / 2, 0],
    [new THREE.BoxGeometry(0.32, 0.6, 0.05), woodDark(), 0, 0.3, 0.555],
    [new THREE.BoxGeometry(0.22, 0.22, 0.04), stoneDark(), 0.42, 0.55, 0.555],
    [new THREE.BoxGeometry(0.16, 0.8, 0.16), stoneDark(), 0.5, wallHeight + 0.4, 0.3]
  );
}

// A Tudor-style timber-framed house: whitewashed plaster walls with dark
// exposed-timber corner posts, a mid-rail, and a pair of shallow chevron
// braces, under a terracotta hip roof — visually distinct from the plain
// stone Cottage even though it shares the same hip-roof/box-body technique.
function buildTimberHouse() {
  const wallHeight = 1.1;
  const roofHeight = 0.6;
  const frontZ = 0.515;
  return prop(
    [new THREE.BoxGeometry(1.5, wallHeight, 1.0), plaster(), 0, wallHeight / 2, 0],
    [hipRoofGeometry(0.75, 0.5, roofHeight, 0.1), roofTile(), 0, wallHeight + roofHeight / 2, 0],
    [new THREE.BoxGeometry(1.5, 0.08, 0.03), timber(), 0, wallHeight * 0.55, frontZ],
    [new THREE.BoxGeometry(0.08, wallHeight, 0.03), timber(), -0.71, wallHeight / 2, frontZ],
    [new THREE.BoxGeometry(0.08, wallHeight, 0.03), timber(), 0.71, wallHeight / 2, frontZ],
    [new THREE.BoxGeometry(0.06, 0.5, 0.03), timber(), -0.36, wallHeight * 0.32, frontZ, [0, 0, 0.55]],
    [new THREE.BoxGeometry(0.06, 0.5, 0.03), timber(), 0.36, wallHeight * 0.32, frontZ, [0, 0, -0.55]],
    [new THREE.BoxGeometry(0.3, 0.65, 0.05), woodDark(), 0, 0.325, frontZ],
    [new THREE.BoxGeometry(0.2, 0.22, 0.04), stoneDark(), -0.5, 0.72, frontZ],
    [new THREE.BoxGeometry(0.2, 0.22, 0.04), stoneDark(), 0.5, 0.72, frontZ]
  );
}

// A round wattle-and-timber roundhouse: cylindrical wood-plank wall, a tall
// conical thatch roof with its own small eave skirt, and a plank door — a
// completely different silhouette from the two rectangular houses above
// (round instead of boxy), reusing this file's existing wood/thatch
// materials rather than introducing new ones just for this shape.
function buildRoundhouse() {
  const wallHeight = 0.9;
  const wallRadius = 0.58;
  const roofHeight = 0.9;
  return prop(
    [new THREE.CylinderGeometry(0.55, wallRadius, wallHeight, 12), wood(), 0, wallHeight / 2, 0],
    [new THREE.CylinderGeometry(0.8, 0.8, 0.06, 12), thatch(), 0, wallHeight + 0.03, 0],
    [new THREE.ConeGeometry(0.72, roofHeight, 12), thatch(), 0, wallHeight + roofHeight / 2, 0],
    [new THREE.BoxGeometry(0.28, 0.55, 0.05), woodDark(), 0, 0.275, 0.56]
  );
}

// The grandest of the eight: a two-tier civic building (a wider stone base
// tier plus a smaller raised central tier under its own hip roof), a
// free-standing corner clock/bell tower reaching above every roofline, and
// a shallow flight of entrance steps — reads unmistakably as "town hall"
// rather than another house, via scale and the tower alone, without needing
// any bespoke geometry technique this file doesn't already have.
function buildTownHall() {
  const baseHeight = 1.0;
  const upperHeight = 0.5;
  const upperRoofHeight = 0.55;
  const towerHeight = 1.6;
  const towerRoofHeight = 0.35;
  const towerFrontZ = 0.65;
  return prop(
    [new THREE.BoxGeometry(1.8, baseHeight, 1.3), stone(), 0, baseHeight / 2, 0],
    [new THREE.BoxGeometry(1.0, upperHeight, 1.0), stone(), 0, baseHeight + upperHeight / 2, 0],
    [
      hipRoofGeometry(0.5, 0.5, upperRoofHeight, 0.08),
      roofTile(),
      0,
      baseHeight + upperHeight + upperRoofHeight / 2,
      0,
    ],
    [new THREE.CylinderGeometry(0.06, 0.06, baseHeight - 0.1, 8), stone(), -0.55, (baseHeight - 0.1) / 2, 0.68],
    [new THREE.CylinderGeometry(0.06, 0.06, baseHeight - 0.1, 8), stone(), 0.55, (baseHeight - 0.1) / 2, 0.68],
    [new THREE.BoxGeometry(0.4, 0.7, 0.05), woodDark(), 0, 0.35, 0.655],
    [new THREE.BoxGeometry(1.0, 0.08, 0.3), stoneDark(), 0, 0.04, 0.75],
    [new THREE.BoxGeometry(0.9, 0.08, 0.22), stoneDark(), 0, 0.12, 0.7],
    [new THREE.BoxGeometry(0.35, towerHeight, 0.35), stone(), 0, towerHeight / 2, towerFrontZ],
    [
      hipRoofGeometry(0.2, 0.2, towerRoofHeight, 0.03),
      roofTile(),
      0,
      towerHeight + towerRoofHeight / 2,
      towerFrontZ,
    ],
    [new THREE.ConeGeometry(0.05, 0.15, 6), gold(), 0, towerHeight + towerRoofHeight + 0.075, towerFrontZ]
  );
}

// A wide, jettied (upper floor overhanging the ground floor) wooden tavern
// with a hanging sign on an iron bracket and a barrel out front — the
// hanging sign is this preset's own distinguishing signature, matching how
// a real tavern is usually spotted at a glance.
function buildTavern() {
  const groundHeight = 0.7;
  const upperHeight = 0.55;
  const roofHeight = 0.6;
  const frontZ = 0.575;
  return prop(
    [new THREE.BoxGeometry(1.7, groundHeight, 1.1), wood(), 0, groundHeight / 2, 0],
    [new THREE.BoxGeometry(1.85, upperHeight, 1.2), woodDark(), 0, groundHeight + upperHeight / 2, 0],
    [
      hipRoofGeometry(0.925, 0.6, roofHeight, 0.1),
      roofTile(),
      0,
      groundHeight + upperHeight + roofHeight / 2,
      0,
    ],
    [new THREE.BoxGeometry(0.32, 0.6, 0.05), woodDark(), 0, 0.3, frontZ],
    [new THREE.BoxGeometry(0.04, 0.04, 0.35), iron(), 0.62, 0.95, frontZ + 0.15],
    [new THREE.CylinderGeometry(0.01, 0.01, 0.18, 6), iron(), 0.62, 0.82, frontZ + 0.32],
    [new THREE.BoxGeometry(0.4, 0.3, 0.03), woodDark(), 0.62, 0.65, frontZ + 0.32],
    [new THREE.CylinderGeometry(0.18, 0.18, 0.35, 10), woodDark(), -0.7, 0.175, frontZ + 0.05],
    [new THREE.TorusGeometry(0.18, 0.02, 6, 12), gold(), -0.7, 0.28, frontZ + 0.05, [Math.PI / 2, 0, 0]]
  );
}

// A single-story plaster shopfront: a large dark display window, a canvas
// awning on two iron support poles, and a small signboard — the awning is
// this preset's own distinguishing signature (a house has none, a tavern's
// sign hangs rather than shades a window).
function buildShop() {
  const wallHeight = 0.85;
  const roofHeight = 0.45;
  const frontZ = 0.515;
  return prop(
    [new THREE.BoxGeometry(1.4, wallHeight, 1.0), plaster(), 0, wallHeight / 2, 0],
    [hipRoofGeometry(0.7, 0.5, roofHeight, 0.08), roofTile(), 0, wallHeight + roofHeight / 2, 0],
    [new THREE.BoxGeometry(0.6, 0.45, 0.04), stoneDark(), -0.3, 0.45, frontZ],
    [new THREE.BoxGeometry(0.3, 0.65, 0.05), woodDark(), 0.4, 0.325, frontZ],
    [new THREE.BoxGeometry(0.5, 0.14, 0.03), woodDark(), 0.4, 0.75, frontZ],
    [new THREE.BoxGeometry(0.95, 0.04, 0.35), canvas(), 0.05, 0.72, frontZ + 0.17, [-0.35, 0, 0]],
    [new THREE.CylinderGeometry(0.02, 0.02, 0.7, 6), iron(), -0.35, 0.35, frontZ + 0.34],
    [new THREE.CylinderGeometry(0.02, 0.02, 0.7, 6), iron(), 0.5, 0.35, frontZ + 0.34]
  );
}

// A small two-wheeled vendor's food cart with a canvas tent-canopy on 4
// posts and a cooking pot on the serving bed — the canopy reuses
// hipRoofGeometry (a shallow "tent" is the same shape family as a hip roof)
// rather than inventing a second roof-shape technique for a prop this small.
function buildFoodCart() {
  const wheelRadius = 0.22;
  const bedY = wheelRadius * 2 + 0.03;
  const wheel = (x) => [
    new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.06, 12),
    woodDark(),
    x,
    wheelRadius,
    0,
    [0, 0, Math.PI / 2],
  ];
  const post = (x, z) => [
    new THREE.CylinderGeometry(0.015, 0.015, 0.55, 6),
    iron(),
    x,
    bedY + 0.03 + 0.275,
    z,
  ];
  return prop(
    wheel(-0.32),
    wheel(0.32),
    [new THREE.BoxGeometry(0.6, 0.06, 0.4), wood(), 0, bedY, 0],
    [new THREE.BoxGeometry(0.6, 0.18, 0.04), woodDark(), 0, bedY + 0.03 + 0.09, -0.2],
    [new THREE.BoxGeometry(0.6, 0.18, 0.04), woodDark(), 0, bedY + 0.03 + 0.09, 0.2],
    [new THREE.SphereGeometry(0.08, 8, 6), iron(), 0, bedY + 0.03 + 0.08, 0],
    post(-0.28, -0.17),
    post(0.28, -0.17),
    post(-0.28, 0.17),
    post(0.28, 0.17),
    [hipRoofGeometry(0.35, 0.25, 0.18, 0.04), canvas(), 0, bedY + 0.03 + 0.55 + 0.09, 0]
  );
}

// A larger open farm cart: two big wheels, plank side/end rails, a forward
// yoke for a draft animal, and a loose pile of hay on the bed — no canopy at
// all, the clearest visual contrast against the Food Cart.
function buildFarmCart() {
  const wheelRadius = 0.28;
  const bedY = wheelRadius * 2 + 0.04;
  const wheel = (x) => [
    new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.07, 12),
    woodDark(),
    x,
    wheelRadius,
    0,
    [0, 0, Math.PI / 2],
  ];
  const hayClump = (x, z, scaleX, scaleZ) => {
    const geometry = new THREE.IcosahedronGeometry(0.15, 0);
    geometry.scale(scaleX, 0.6, scaleZ);
    return [geometry, hay(), x, bedY + 0.04 + 0.08, z];
  };
  return prop(
    wheel(-0.5),
    wheel(0.5),
    [new THREE.BoxGeometry(1.1, 0.08, 0.55), woodDark(), 0, bedY, 0],
    [new THREE.BoxGeometry(1.1, 0.22, 0.05), wood(), 0, bedY + 0.04 + 0.11, -0.27],
    [new THREE.BoxGeometry(1.1, 0.22, 0.05), wood(), 0, bedY + 0.04 + 0.11, 0.27],
    [new THREE.BoxGeometry(0.05, 0.22, 0.55), wood(), -0.55, bedY + 0.04 + 0.11, 0],
    [new THREE.BoxGeometry(0.05, 0.22, 0.55), wood(), 0.55, bedY + 0.04 + 0.11, 0],
    [new THREE.BoxGeometry(0.04, 0.04, 0.9), woodDark(), -0.18, bedY, 0.725],
    [new THREE.BoxGeometry(0.04, 0.04, 0.9), woodDark(), 0.18, bedY, 0.725],
    hayClump(-0.25, -0.05, 1.2, 0.9),
    hayClump(0.1, 0.08, 1.0, 1.1),
    hayClump(0.3, -0.1, 0.9, 1.0)
  );
}

const PRESETS = [
  { id: "cottage", uuid: "a55e7014-0000-4000-8000-000000000014", name: "Cottage", build: buildCottage },
  {
    id: "timber-house",
    uuid: "a55e7015-0000-4000-8000-000000000015",
    name: "Timber House",
    build: buildTimberHouse,
  },
  { id: "roundhouse", uuid: "a55e7016-0000-4000-8000-000000000016", name: "Roundhouse", build: buildRoundhouse },
  { id: "town-hall", uuid: "a55e7017-0000-4000-8000-000000000017", name: "Town Hall", build: buildTownHall },
  { id: "tavern", uuid: "a55e7018-0000-4000-8000-000000000018", name: "Tavern", build: buildTavern },
  { id: "shop", uuid: "a55e7019-0000-4000-8000-000000000019", name: "Shop", build: buildShop },
  { id: "food-cart", uuid: "a55e7020-0000-4000-8000-000000000020", name: "Food Cart", build: buildFoodCart },
  { id: "farm-cart", uuid: "a55e7021-0000-4000-8000-000000000021", name: "Farm Cart", build: buildFarmCart },
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

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  writeFileSync(join(outDir, `${preset.id}.glb`), glb);
  console.log(
    `wrote public/assets/presets/${preset.id}.glb (${glb.length} bytes, ${meshCount} meshes, ${triangleCount} triangles)`
  );
  console.log(
    `  measured bounding box: x=${size.x.toFixed(5)} y=${size.y.toFixed(5)} z=${size.z.toFixed(5)} -> maxDim=${maxDim.toFixed(5)} (auto-normalized to a single cell at render time, same as every other preset)`
  );
}

const migrationHint = `-- Add the following to a new numbered migration (see supabase/migrations/):
insert into public.asset_library (id, name, source_type, model_ref) values
${PRESETS.map((p) => `  ('${p.uuid}', '${p.name}', 'preset', '/assets/presets/${p.id}.glb')`).join(",\n")}
on conflict (id) do nothing;
`;
console.log(`\n${migrationHint}`);
