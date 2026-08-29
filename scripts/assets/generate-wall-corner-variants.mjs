#!/usr/bin/env node
// Generates three new wall-family preset map assets — a T-junction, a
// genuine right-angle corner, and a curved corner — low-poly primitive
// geometry exported as .glb into public/assets/presets/, the exact
// generate-wall-variants-presets.mjs round-trip-through-GLTFLoader approach
// (a structurally broken export fails generation instead of at render
// time).
//
// Deliberately a SEPARATE script rather than adding to generate-wall-
// variants-presets.mjs's own PRESETS array — that script's existing
// "wall-corner" preset is NOT a right angle (see its own doc comment: a
// rotationally-symmetric 4-way "plus" that reaches all 4 cell edges, used
// as filler at ANY turn regardless of which two sides the wall actually
// approaches from). The three pieces here are genuinely different shapes
// that only cover the sides they're actually meant to, and are therefore
// orientation-dependent (the DM rotates them into place with the ordinary
// 90°-increment rotate control — MapEditor.tsx's handleRotate already
// generalizes to any preset with no changes needed).
//
// Shared geometry constants (WALL_BODY_HEIGHT/WALL_THICKNESS/
// WALL_CAP_HEIGHT/WALL_MERLON_HEIGHT/WALL_PEAK_HEIGHT/CAP_THICKNESS/CAP_Y/
// MERLON_Y) and the prop()/material helpers are DUPLICATED from
// generate-wall-variants-presets.mjs at identical values (not imported —
// this repo's own established "small self-contained generator script"
// convention: generate-tavern-presets.mjs/generate-stairs-half-preset.mjs
// each carry their own copy of the same prop()/FileReader-shim boilerplate
// rather than cross-importing between generator scripts). Keeping the
// VALUES identical is what actually matters — every wall-family piece caps
// out at exactly WALL_PEAK_HEIGHT (0.85) so parapet lines read as
// continuous at every junction, the same invariant
// generate-wall-variants-presets.mjs's own top comment describes fixing for
// the original corner/diagonal pieces.
//
// annularSectorShape/annularSectorSlab (the curved corner's own build) are
// likewise duplicated from generate-tavern-presets.mjs, which documents
// them as fully generic (rInner, rOuter, angleRad, height, bottomY,
// material — nothing tavern-specific baked in); only the RADII passed in
// here differ (wall-thickness-derived, not the tavern bar's proportions).
//
// A note on WALL_FIT_TARGET_BY_URL (see src/scene-3d/PlacedObject.tsx):
// every EXISTING "fit target 1" wall piece (wall.glb, wall-corner.glb,
// wall-diagonal.glb, wall-door.glb) happens to measure a real maxDim of
// very close to 1.0 because each one's own FOOTPRINT reaches a full cell
// width/diagonal in some direction, which is bigger than their shared
// 0.85 peak height — so fit target 1 divided by that ~1.0 maxDim yields
// scale ≈ 1 (no distortion). The T-junction below is authored the same way
// (its full-length through-run footprint reaches the full 1-unit cell
// width, exactly like a straight run), so it also measures maxDim ≈ 1 and
// takes fit target 1 correctly.
//
// The right-angle corner and curved corner are architecturally DIFFERENT:
// by design they only reach ONE cell edge in each of two directions (an "L"
// only touches 2 of the cell's 4 edges, not all 4 like the plus-shaped
// wall-corner.glb, and not corner-to-corner like wall-diagonal.glb) — their
// real measured FOOTPRINT never reaches 1.0 (confirmed by this script's own
// printed Box3 measurement below), so their maxDim is HEIGHT-dominated at
// exactly 0.85, not footprint-dominated at ~1.0. Using fit target 1 for
// those two would scale the WHOLE model (including its height) up by
// 1/0.85 ≈ 1.176×, reproducing — at a smaller magnitude — the exact
// "corner/diagonal peak taller than a straight run's real 0.85" bug
// generate-wall-variants-presets.mjs's own top comment describes finding
// and fixing for the original wall-corner.glb/wall-diagonal.glb. So
// WALL_FIT_TARGET_BY_URL uses each of THESE two pieces' own real measured
// maxDim (0.85, not 1) instead of the literal "1" — this is the same
// "each one's own fit target is simply its own measured maxDim, making
// scale exactly 1" rule that file's own doc comment already establishes,
// just landing on a different real number for these two shapes. See this
// task's own final report for the measured numbers.
//
// Usage: node scripts/assets/generate-wall-corner-variants.mjs

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

// Same stone/wood/gold palette as generate-wall-variants-presets.mjs, so
// these three pieces read as the SAME masonry as every other wall-family
// preset, not a mismatched addition.
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

// IDENTICAL values to generate-wall-variants-presets.mjs's own — see this
// file's top comment for why these are duplicated rather than imported.
const WALL_BODY_HEIGHT = 0.7;
const WALL_CAP_HEIGHT = 0.04;
const WALL_CAP_TOP = WALL_BODY_HEIGHT + WALL_CAP_HEIGHT; // 0.74
const WALL_MERLON_HEIGHT = 0.11;
const WALL_PEAK_HEIGHT = WALL_CAP_TOP + WALL_MERLON_HEIGHT; // 0.85
const WALL_THICKNESS = 0.19;
const CAP_THICKNESS = WALL_THICKNESS + 0.08;
const CAP_Y = WALL_BODY_HEIGHT + WALL_CAP_HEIGHT / 2;
const MERLON_Y = (WALL_CAP_TOP + WALL_PEAK_HEIGHT) / 2;

// ═══════════════════════════════════════════════════════════════════════
// Wall T-Junction — a full straight run through the cell (identical
// cross-section to a straight Wall Segment, reaching both the west and east
// edges) plus ONE perpendicular stub arm (center to the south edge only) —
// generate-wall-variants-presets.mjs's buildWallCorner() with one of its
// four arms (and that arm's own tip merlon) dropped, per this task's brief.
// Authored in a single canonical orientation (stub pointing south); the
// DM reaches the other 3 orientations with the ordinary rotate control,
// the same way wall-diagonal.glb's own single canonical NW-SE orientation
// covers all 4 diagonal directions.
//
// Only 3 merlons (not buildWallCorner's 5): the through-run's own two tips
// (-0.35, 0.35) plus the stub's own tip (0, 0.35) — no center merlon. A
// straight run's own convention is 3 merlons per full-length run (see
// buildWall()/buildWallDoor()); the plus-shaped wall-corner.glb needs a
// 5th, CENTER merlon only because all 4 of its arms actually converge
// there. Here only 3 arms converge at the center, and the center is
// already a stub's own inner endpoint (not a naked crossing point), so a
// separate center merlon was judged unnecessary — this task's own explicit
// "3 merlons total" acceptance criterion.
// ═══════════════════════════════════════════════════════════════════════
function buildWallT() {
  const merlon = (x, z) => [new THREE.BoxGeometry(0.16, WALL_MERLON_HEIGHT, 0.16), stone(), x, MERLON_Y, z];
  return prop(
    // Through run (west <-> east), full cell width — identical cross-section
    // to a straight Wall Segment.
    [new THREE.BoxGeometry(1, WALL_BODY_HEIGHT, WALL_THICKNESS), stone(), 0, WALL_BODY_HEIGHT / 2, 0],
    [new THREE.BoxGeometry(1, WALL_CAP_HEIGHT, CAP_THICKNESS), stoneDark(), 0, CAP_Y, 0],
    // Stub arm (center -> south edge only).
    [new THREE.BoxGeometry(WALL_THICKNESS, WALL_BODY_HEIGHT, 0.5), stone(), 0, WALL_BODY_HEIGHT / 2, 0.25],
    [new THREE.BoxGeometry(CAP_THICKNESS, WALL_CAP_HEIGHT, 0.5), stoneDark(), 0, CAP_Y, 0.25],
    merlon(-0.35, 0),
    merlon(0.35, 0),
    merlon(0, 0.35)
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Wall Corner (Right Angle) — a GENUINE right-angle turn: exactly TWO
// adjacent half-arms (center -> east edge, center -> north edge) meeting at
// a real 90° bend, unlike wall-corner.glb's own rotationally-symmetric
// 4-way plus. Authored in a single canonical orientation (east + north
// arms); the DM reaches the other 3 orientations with the ordinary rotate
// control.
//
// 3 merlons: the east arm's own tip, the north arm's own tip, and one at
// the bend itself (the two arms' own crossing point is genuinely crowded —
// both arms' cap/body layers converge there — so a merlon there reads the
// same way wall-corner.glb's own CENTER merlon caps its own, similarly
// crowded, 4-way crossing).
//
// This piece's own real, measured footprint only reaches ONE cell edge in
// each of two directions (never both edges of any axis, unlike a straight
// run or the T-junction's own through-run) — its maxDim is therefore
// HEIGHT-dominated at exactly WALL_PEAK_HEIGHT (0.85), not footprint-
// dominated at ~1.0. See this file's own top comment for why
// WALL_FIT_TARGET_BY_URL uses this piece's own real measured maxDim (0.85)
// rather than the literal 1 the other wall-family pieces happen to share.
// ═══════════════════════════════════════════════════════════════════════
function buildWallCornerL() {
  const merlon = (x, z) => [new THREE.BoxGeometry(0.16, WALL_MERLON_HEIGHT, 0.16), stone(), x, MERLON_Y, z];
  return prop(
    // East arm (center -> east edge).
    [new THREE.BoxGeometry(0.5, WALL_BODY_HEIGHT, WALL_THICKNESS), stone(), 0.25, WALL_BODY_HEIGHT / 2, 0],
    [new THREE.BoxGeometry(0.5, WALL_CAP_HEIGHT, CAP_THICKNESS), stoneDark(), 0.25, CAP_Y, 0],
    // North arm (center -> north edge).
    [new THREE.BoxGeometry(WALL_THICKNESS, WALL_BODY_HEIGHT, 0.5), stone(), 0, WALL_BODY_HEIGHT / 2, -0.25],
    [new THREE.BoxGeometry(CAP_THICKNESS, WALL_CAP_HEIGHT, 0.5), stoneDark(), 0, CAP_Y, -0.25],
    merlon(0.35, 0),
    merlon(0, -0.35),
    merlon(0, 0)
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Wall Corner (Curved) — a GENUINELY CURVED quarter-annulus corner, built
// with the exact same "Shape via moveTo/lineTo/absarc/closePath, then
// ExtrudeGeometry" technique generate-tavern-presets.mjs's own Bar Corner
// (and generate-wall-variants-presets.mjs's own hexDiagonalShape, for a
// different, mitered cross-section) already use — see annularSectorShape/
// annularSectorSlab's own doc comments below (duplicated verbatim from
// generate-tavern-presets.mjs, which documents them as fully generic).
// Called here with WALL_THICKNESS/WALL_BODY_HEIGHT-derived radii/height,
// not the tavern bar's own CABINET_HEIGHT/CORNER_R_INNER/CORNER_R_OUTER
// proportions.
//
// The ring's radial band width (rOuter - rInner) equals WALL_THICKNESS —
// the same "constant cross-section along the run" a straight Wall Segment
// has, just swept along an arc instead of a straight line — pivoted at the
// cell's own center, reaching the east edge (rOuter = 0.5) and sweeping a
// quarter turn around to the north edge, the same "east arm + north arm"
// pair the right-angle corner above connects, just rounded instead of
// mitered.
//
// Like the right-angle corner above, this piece's own real footprint only
// reaches ONE cell edge in each of two directions — maxDim is
// HEIGHT-dominated at 0.85, not footprint-dominated at ~1.0 — see this
// file's own top comment for why WALL_FIT_TARGET_BY_URL uses this piece's
// own real measured maxDim rather than the literal 1.
// ═══════════════════════════════════════════════════════════════════════
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
// ExtrudeGeometry's depth spans [0, depth], so this positions by its own
// bottom, not a box's centered [-h/2, h/2]; rotateX(-90°) lays the
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

const CURVE_ANGLE = Math.PI / 2;
const CURVE_R_OUTER = 0.5; // reaches the cell edge, matching a straight run's own edge-to-edge reach.
const CURVE_R_INNER = CURVE_R_OUTER - WALL_THICKNESS; // ring band width == WALL_THICKNESS.
const CURVE_MID_RADIUS = (CURVE_R_INNER + CURVE_R_OUTER) / 2;
// Cap band centered on the same mid-radius as the body, overhanging both
// the inner and outer edge by (CAP_THICKNESS - WALL_THICKNESS) / 2 (0.04)
// each side — the exact same overhang every other wall-family cap has
// relative to its own body (CAP_THICKNESS = WALL_THICKNESS + 0.08).
const CURVE_CAP_R_INNER = CURVE_MID_RADIUS - CAP_THICKNESS / 2;
const CURVE_CAP_R_OUTER = CURVE_MID_RADIUS + CAP_THICKNESS / 2;

function buildWallCornerCurved() {
  const group = new THREE.Group();
  group.add(annularSectorSlab(CURVE_R_INNER, CURVE_R_OUTER, CURVE_ANGLE, WALL_BODY_HEIGHT, 0, stone()));
  group.add(
    annularSectorSlab(CURVE_CAP_R_INNER, CURVE_CAP_R_OUTER, CURVE_ANGLE, WALL_CAP_HEIGHT, WALL_BODY_HEIGHT, stoneDark())
  );
  // Three merlons along the arc at its own mid-radius (0°, 45°, 90°) — the
  // same "one at each end, one at the midpoint" convention every other
  // wall-family run uses (buildWall()/buildWallDoor()'s own -0.35/0/0.35
  // spacing), just measured in angle instead of linear distance.
  // annularSectorSlab's own world mapping (see its doc comment) puts a
  // point at local angle θ, radius r at world (r·cosθ, y, -r·sinθ).
  const group2 = group;
  for (const angleDeg of [0, 45, 90]) {
    const theta = (angleDeg * Math.PI) / 180;
    const x = CURVE_MID_RADIUS * Math.cos(theta);
    const z = -CURVE_MID_RADIUS * Math.sin(theta);
    group2.add(prop([new THREE.BoxGeometry(0.16, WALL_MERLON_HEIGHT, 0.16), stone(), x, MERLON_Y, z]));
  }
  return group;
}

const PRESETS = [
  { id: "wall-t", uuid: "a55e7040-0000-4000-8000-000000000040", name: "Wall T-Junction", build: buildWallT },
  {
    id: "wall-corner-l",
    uuid: "a55e7041-0000-4000-8000-000000000041",
    name: "Wall Corner (Right Angle)",
    build: buildWallCornerL,
  },
  {
    id: "wall-corner-curved",
    uuid: "a55e7042-0000-4000-8000-000000000042",
    name: "Wall Corner (Curved)",
    build: buildWallCornerCurved,
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
  // itself performs at render time — printed here so WALL_FIT_TARGET_BY_URL's
  // per-asset fit target can be set from a REAL measured number, not a
  // hand-derived guess (see this file's own top comment).
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
