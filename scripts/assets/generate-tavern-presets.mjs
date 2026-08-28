#!/usr/bin/env node
// Generates the tavern-furniture preset map assets (project owner's own
// "batch of new decorative/furniture presets ... for building tavern
// scenes" request) — low-poly primitive geometry exported as .glb into
// public/assets/presets/, the exact generate-building-presets.mjs/
// generate-map-presets.mjs approach (round-tripped through GLTFLoader so a
// structurally broken export fails generation instead of at render time).
//
// Deliberately a SEPARATE script rather than adding to generate-map-
// presets.mjs's own PRESETS array or generate-building-presets.mjs's — same
// reasoning every post-0016 script gives: those scripts hard-code their
// output migration path to an already-applied migration, so re-running them
// after seeding would silently rewrite shipped SQL instead of adding a new
// migration. This script only ever touches its own 5 new .glb files; the
// seed INSERT lives in its own new numbered migration (see
// supabase/migrations/ — check `ls supabase/migrations | tail -5` for the
// current highest number before adding one), hand-written once from this
// script's own printed migration hint.
//
// Five new presets:
//   - "Bar Counter" (bar-counter.glb): a straight tavern bar segment — a
//     dark-wood cabinet with a lighter overhanging bar top, a footrail, and
//     3 small decorative beer taps built directly into the back of the
//     countertop (NOT the standalone Beer Pump prop below — these are
//     simple integrated fixtures, matching how buildTavern's own hanging
//     sign is baked into that building rather than a separate placeable).
//   - "Bar Corner" (bar-corner.glb): a GENUINELY CURVED quarter-annulus
//     corner segment (see annularSectorSlab's own doc comment for why this
//     was judged worth the extra complexity over a mitered 45° fallback).
//   - "Beer Pump" (beer-pump.glb): a standalone traditional hand-pump
//     ("beer engine") fixture — brass column, badge, drip tray, and the
//     iconic angled handle+knob — a separate placeable prop, distinct from
//     the simpler taps built into Bar Counter's own top surface.
//   - "Glass" (glass.glb): a small pewter tankard with foam and a side
//     handle — an ordinary small placeable prop (see this file's own
//     "single-cell, no surface-detection" note below), sized to read
//     plausibly next to/on either Bar Counter or the existing Table preset.
//   - "Food Plate" (food-plate.glb): a shallow ceramic plate with a raised
//     rim, a bread roll, and a couple of garnish spheres — same "ordinary
//     small prop" treatment as Glass.
//
// Single-cell footprint, no new multi-cell placement mechanic — the SAME
// generate-building-presets.mjs precedent (see that file's own top comment
// for the full reasoning this repeats): every preset here is authored at
// plausible RELATIVE proportions to itself and is then auto-normalized by
// PlacedObject.tsx's existing maxDim-based scaling to fit a single cell,
// exactly like Table/Chest/Torch/every other built-in preset. No multi-cell
// tileable segment convention was introduced for Bar Counter/Bar Corner —
// they don't need to visually butt up edge-to-edge against each other the
// way the wall-family presets do (WALL_FIT_TARGET_BY_URL), so this task
// found no strong reason to deviate from the single-cell convention.
//
// Glass/Food Plate are deliberately NOT wired into any "sits on top of
// asset X" surface-detection logic — the project owner's own Task
// description asked for them to "work as a normal placeable small prop...
// matching how other small decorative objects are already placed today".
// This app's existing map_objects model has exactly one vertical placement
// lever available to a DM for ANY object: a cell's own sculpted terrain
// elevation (baseHeight + elevation*elevationStepHeight, see
// src/scene-3d/MapSurface.tsx's EDITOR_MAP_METRICS) — there is no
// independent per-object height field, and (confirmed by reading
// MapEditor.tsx's handleCellClick before writing this script) exactly one
// placed object is allowed per cell today, so two ordinary objects can
// never occupy the same cell to literally stack one's mesh on the other's.
// "On top of the bar/table" is therefore achieved with tools that already
// exist for every prop: place the furniture in one cell, then place
// Glass/Food Plate in a cell immediately next to it with that cell's own
// terrain elevation raised (via the ordinary Sculpt > Elevation tool) to
// roughly the furniture's own measured top-surface height — see
// scripts/db/verify-tavern-presets.mjs's own comment for the exact
// measured numbers used and a real screenshot judgment call on how
// convincing that reads.
//
// Usage: node scripts/assets/generate-tavern-presets.mjs

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

// Same walnut/gold/iron palette as generate-map-presets.mjs/generate-
// building-presets.mjs, so these tavern furnishings read as part of the
// SAME built-in prop set, plus a handful of new tones this set didn't need
// before: a lighter varnished bar-top wood, pewter (tankard), foam/ceramic
// (drink head / plate), a maroon tap badge, and a bread-crust tan.
const WOOD = 0x5a4028;
const WOOD_DARK = 0x42301c;
const BAR_TOP = 0x7a5636;
const GOLD = 0xc9a227;
const IRON = 0x3a3d42;
const PEWTER = 0x6d7580;
const FOAM = 0xf3e9c9;
const CERAMIC = 0xf1ece0;
const BADGE = 0x7a2020;
const BREAD = 0xcf9a54;
const GARNISH = 0x6a8f3d;

const wood = () => new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.75 });
const woodDark = () => new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.8 });
const barTop = () => new THREE.MeshStandardMaterial({ color: BAR_TOP, roughness: 0.35 });
const gold = () => new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.4, metalness: 0.7 });
const iron = () => new THREE.MeshStandardMaterial({ color: IRON, roughness: 0.5, metalness: 0.6 });
const pewter = () => new THREE.MeshStandardMaterial({ color: PEWTER, roughness: 0.45, metalness: 0.35 });
const foam = () => new THREE.MeshStandardMaterial({ color: FOAM, roughness: 0.9 });
const ceramic = () => new THREE.MeshStandardMaterial({ color: CERAMIC, roughness: 0.3 });
const badge = () => new THREE.MeshStandardMaterial({ color: BADGE, roughness: 0.5 });
const bread = () => new THREE.MeshStandardMaterial({ color: BREAD, roughness: 0.9, flatShading: true });
const garnish = () => new THREE.MeshStandardMaterial({ color: GARNISH, roughness: 0.6 });

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
// Bar Counter — a straight segment.
// ═══════════════════════════════════════════════════════════════════════
const CABINET_WIDTH = 1.6;
const CABINET_HEIGHT = 0.85;
const CABINET_DEPTH = 0.55;
const TOP_HEIGHT = 0.07;
const TOP_Y = CABINET_HEIGHT + TOP_HEIGHT; // top surface of the bar (world-authored, pre-normalization)

// One small integrated tap fixture (column + ball handle + short spout) —
// deliberately simpler than the standalone Beer Pump below (this file's own
// top comment explains the distinction). `z` lets Bar Corner reuse this at
// its own back-edge depth.
function tapAt(x, z) {
  const colHeight = 0.09;
  const colY = TOP_Y + colHeight / 2;
  return [
    [new THREE.CylinderGeometry(0.02, 0.02, colHeight, 8), gold(), x, colY, z],
    [new THREE.SphereGeometry(0.024, 8, 6), gold(), x, TOP_Y + colHeight + 0.012, z],
    [
      new THREE.CylinderGeometry(0.011, 0.011, 0.08, 6),
      gold(),
      x,
      TOP_Y + colHeight * 0.3,
      z + 0.055,
      [Math.PI / 2, 0, 0],
    ],
  ];
}

function buildBarCounter() {
  const tapZ = -CABINET_DEPTH / 2 + 0.08;
  const plank = (x) => [new THREE.BoxGeometry(0.03, CABINET_HEIGHT - 0.1, 0.02), woodDark(), x, CABINET_HEIGHT / 2, CABINET_DEPTH / 2 + 0.01];
  return prop(
    [new THREE.BoxGeometry(CABINET_WIDTH, CABINET_HEIGHT, CABINET_DEPTH), wood(), 0, CABINET_HEIGHT / 2, 0],
    plank(-0.6),
    plank(-0.2),
    plank(0.2),
    plank(0.6),
    [new THREE.BoxGeometry(CABINET_WIDTH + 0.1, TOP_HEIGHT, CABINET_DEPTH + 0.1), barTop(), 0, TOP_Y - TOP_HEIGHT / 2, 0],
    [
      new THREE.CylinderGeometry(0.025, 0.025, CABINET_WIDTH - 0.1, 8),
      iron(),
      0,
      0.12,
      CABINET_DEPTH / 2 + 0.03,
      [0, 0, Math.PI / 2],
    ],
    ...tapAt(-0.5, tapZ),
    ...tapAt(0, tapZ),
    ...tapAt(0.5, tapZ)
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Bar Corner — GENUINELY CURVED (a quarter-annulus), not a mitered
// fallback: an annular-sector shape (the exact same "build a Shape via
// moveTo/absarc/lineTo/absarc/closePath, then ExtrudeGeometry" technique
// generate-wall-variants-presets.mjs's own hexDiagonalShape already uses
// for a DIFFERENT — straight, mitered — cross-section) reads convincingly
// as a rounded bar corner once extruded and given a curveSegments high
// enough (24) to avoid visible faceting, confirmed by this task's own real
// rendered screenshot (see verify-tavern-presets.mjs) rather than assumed
// from the geometry formula alone. A mitered 45° corner was judged
// unnecessary as a fallback — the curved version rendered cleanly on the
// first real screenshot, so no fallback was shipped.
// ═══════════════════════════════════════════════════════════════════════
const CORNER_R_INNER = 0.4;
const CORNER_R_OUTER = 1.0;
const CORNER_ANGLE = Math.PI / 2;

function annularSectorShape(rInner, rOuter, angleRad) {
  const shape = new THREE.Shape();
  shape.moveTo(rInner, 0);
  shape.lineTo(rOuter, 0);
  shape.absarc(0, 0, rOuter, 0, angleRad, false);
  shape.lineTo(rInner * Math.cos(angleRad), rInner * Math.sin(angleRad));
  shape.absarc(0, 0, rInner, angleRad, 0, true);
  shape.closePath();
  return shape;
}

// Extrudes annularSectorShape from `bottomY` up to `bottomY + height` —
// generate-wall-variants-presets.mjs's own miteredDiagonalSlab pattern
// (ExtrudeGeometry's depth spans [0, depth], so this positions by its own
// bottom, not a box's centered [-h/2, h/2]); rotateX(-90°) lays the
// extrusion flat (local shape XY -> world XZ, extrude depth -> world Y).
function annularSectorSlab(rInner, rOuter, angleRad, height, bottomY, material) {
  const geometry = new THREE.ExtrudeGeometry(annularSectorShape(rInner, rOuter, angleRad), {
    depth: height,
    bevelEnabled: false,
    curveSegments: 24,
  });
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, bottomY, 0);
  return mesh;
}

function buildBarCorner() {
  const group = new THREE.Group();
  group.add(annularSectorSlab(CORNER_R_INNER, CORNER_R_OUTER, CORNER_ANGLE, CABINET_HEIGHT, 0, wood()));
  group.add(
    annularSectorSlab(
      CORNER_R_INNER - 0.05,
      CORNER_R_OUTER + 0.05,
      CORNER_ANGLE,
      TOP_HEIGHT,
      CABINET_HEIGHT - TOP_HEIGHT / 2,
      barTop()
    )
  );
  // One tap at the corner's own mid-angle (45°), near its inner (back)
  // edge — visual continuity with Bar Counter's own built-in taps. Reuses
  // tapAt's own tuple format via prop() (rather than hand-rolling Mesh
  // construction here) so the spout's own rotation tuple is respected the
  // same way Bar Counter's taps get it.
  const midAngle = CORNER_ANGLE / 2;
  const tapRadius = CORNER_R_INNER + 0.12;
  const tapX = tapRadius * Math.cos(midAngle);
  const tapZ = -tapRadius * Math.sin(midAngle);
  group.add(prop(...tapAt(tapX, tapZ)));
  return group;
}

// ═══════════════════════════════════════════════════════════════════════
// Beer Pump — a standalone traditional hand-pump ("beer engine") fixture.
// ═══════════════════════════════════════════════════════════════════════
function buildBeerPump() {
  const baseHeight = 0.04;
  const columnHeight = 0.42;
  const columnY = baseHeight + columnHeight / 2;
  const columnTop = baseHeight + columnHeight;
  return prop(
    [new THREE.BoxGeometry(0.14, baseHeight, 0.1), woodDark(), 0, baseHeight / 2, 0],
    [new THREE.CylinderGeometry(0.035, 0.04, columnHeight, 10), gold(), 0, columnY, 0],
    [new THREE.CylinderGeometry(0.045, 0.045, 0.015, 12), badge(), 0, baseHeight + columnHeight * 0.6, 0.045, [Math.PI / 2, 0, 0]],
    // Handle: a short pivot arm plus the angled lever itself, ending in a
    // rounded wooden knob — the classic pulled-toward-the-bartender shape.
    [new THREE.CylinderGeometry(0.02, 0.02, 0.32, 8), gold(), 0.16, columnTop - 0.03, 0, [0, 0, Math.PI / 2]],
    [new THREE.SphereGeometry(0.045, 10, 8), wood(), 0.33, columnTop - 0.03, 0],
    // Spout, angled slightly down and forward.
    [new THREE.CylinderGeometry(0.012, 0.012, 0.09, 6), gold(), 0, baseHeight + columnHeight * 0.22, 0.05, [Math.PI / 2 + 0.25, 0, 0]],
    // Drip tray.
    [new THREE.BoxGeometry(0.12, 0.015, 0.07), iron(), 0, baseHeight + 0.0075, 0.09]
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Glass — a small pewter tankard with foam and a side handle. Ordinary
// small placeable prop (see this file's own top comment on why there's no
// surface-detection logic here).
// ═══════════════════════════════════════════════════════════════════════
function buildGlass() {
  // Taller, slimmer body than the first pass (this task's own real-
  // screenshot iteration: a squat body + a wide flat foam cap read as a
  // pale bucket/lidded cup rather than a tankard — see
  // scripts/db/verify-tavern-presets.mjs's own comment for the before/after
  // screenshots). A taller body shows more of its own side wall from the
  // editor's oblique camera, a thinner foam cap (barely wider than the
  // body) stops it reading as a second, dominant cylinder, and a bigger
  // handle torus is actually visible at this render distance.
  const bodyHeight = 0.22;
  const bodyRadiusTop = 0.095;
  const bodyRadiusBottom = 0.078;
  const foamHeight = 0.016;
  return prop(
    [new THREE.CylinderGeometry(bodyRadiusTop, bodyRadiusBottom, bodyHeight, 12), pewter(), 0, bodyHeight / 2, 0],
    [new THREE.CylinderGeometry(bodyRadiusTop + 0.002, bodyRadiusTop, foamHeight, 12), foam(), 0, bodyHeight + foamHeight / 2, 0],
    [
      new THREE.TorusGeometry(0.075, 0.02, 8, 16, Math.PI * 1.15),
      pewter(),
      bodyRadiusTop + 0.055,
      bodyHeight * 0.5,
      0,
      [0, Math.PI / 2, -Math.PI * 0.05],
    ]
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Food Plate — a shallow ceramic plate with a raised rim, a bread roll, and
// garnish. Same "ordinary small prop" treatment as Glass.
// ═══════════════════════════════════════════════════════════════════════
function buildFoodPlate() {
  const plateRadius = 0.32;
  const plateHeight = 0.025;
  return prop(
    [new THREE.CylinderGeometry(plateRadius, plateRadius - 0.02, plateHeight, 20), ceramic(), 0, plateHeight / 2, 0],
    [new THREE.TorusGeometry(plateRadius - 0.02, 0.018, 8, 24), ceramic(), 0, plateHeight + 0.005, 0, [Math.PI / 2, 0, 0]],
    (() => {
      const geometry = new THREE.IcosahedronGeometry(0.12, 0);
      geometry.scale(1.3, 0.55, 1.0);
      return [geometry, bread(), -0.05, plateHeight + 0.06, 0.02];
    })(),
    [new THREE.SphereGeometry(0.035, 8, 6), garnish(), 0.15, plateHeight + 0.035, -0.1],
    [new THREE.SphereGeometry(0.035, 8, 6), garnish(), 0.2, plateHeight + 0.035, -0.03],
    [new THREE.SphereGeometry(0.035, 8, 6), garnish(), 0.13, plateHeight + 0.035, -0.17]
  );
}

const PRESETS = [
  { id: "bar-counter", uuid: "a55e7030-0000-4000-8000-000000000030", name: "Bar Counter", build: buildBarCounter },
  { id: "bar-corner", uuid: "a55e7031-0000-4000-8000-000000000031", name: "Bar Corner", build: buildBarCorner },
  { id: "beer-pump", uuid: "a55e7032-0000-4000-8000-000000000032", name: "Beer Pump", build: buildBeerPump },
  { id: "glass", uuid: "a55e7033-0000-4000-8000-000000000033", name: "Glass", build: buildGlass },
  { id: "food-plate", uuid: "a55e7034-0000-4000-8000-000000000034", name: "Food Plate", build: buildFoodPlate },
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
