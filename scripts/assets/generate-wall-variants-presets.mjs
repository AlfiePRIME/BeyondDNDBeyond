#!/usr/bin/env node
// Generates the "Wall Corner", "Wall Diagonal", and "Wall Doorway" built-in
// preset map assets (procedural-wall gap/corner/diagonal fix, plus the
// door-in-wall follow-up fix) — low-poly primitive geometry exported as
// .glb into public/assets/presets/, the exact generate-map-presets.mjs/
// generate-bridge-preset.mjs approach (round-tripped through GLTFLoader so
// a structurally broken export fails generation instead of at render
// time).
//
// Deliberately a SEPARATE script rather than adding to generate-map-
// presets.mjs's own PRESETS array (generate-bridge-preset.mjs's identical
// reasoning): that script hard-codes its output migration path to the
// already-applied 0016_asset_library_presets.sql — re-running it after
// adding entries would silently rewrite a shipped migration instead of
// adding a new one. This script only ever touches its own .glb files; the
// seed INSERT for a new asset_library row lives in its own new numbered
// migration (supabase/migrations/, see that migration's own comment),
// hand-written once, the same way bridge.glb's addition worked. Re-running
// this script after wall-corner.glb/wall-diagonal.glb's own 0055 migration
// was applied is still safe — it only overwrites the two .glb FILES on
// disk (regenerating them with corrected geometry, see below), never an
// already-applied migration's own SQL content.
//
// All three presets are authored DIRECTLY at their final on-screen size
// (unlike wall.glb's legacy 2-unit-wide authoring, scaled down 0.46x by
// PLACED_OBJECT_SIZE historically, now 0.5x by the new full-span fit
// target) — see src/scene-3d/PlacedObject.tsx's WALL_FIT_TARGET_BY_URL doc
// comment for exactly how each wall preset's own authored bounding box
// maps to its render-time scale.
//
// Door-in-wall fix / corner+diagonal re-measurement (this task): the
// original wall-corner.glb/wall-diagonal.glb both had their cap/merlon
// accents stacked ON TOP of WALL_HEIGHT (0.85) — but 0.85 is wall.glb's
// own ALREADY-final, already-merlon-topped peak height (see this file's
// own comment on WALL_BODY_HEIGHT below), so both new pieces actually
// overshot the straight run's real peak: corner measured 1.07 tall,
// diagonal 0.93 tall, next to a straight run's real 0.85 — a real, measured
// ~0.08-0.22 unit height mismatch at every corner/diagonal junction
// (confirmed via this task's own Box3 measurement of the shipped .glb
// files BEFORE changing anything, replicating PlacedObject.tsx's exact
// PropModel formula against real numbers, not hand-derived trig). Fixed by
// building corner/diagonal's own body+cap+merlon out of the SAME
// WALL_BODY_HEIGHT/WALL_CAP_HEIGHT/WALL_MERLON_HEIGHT layers wall.glb
// itself resolves to post-fit-scale, so all three top out at exactly the
// same WALL_PEAK_HEIGHT.
//
// The diagonal ALSO had a real, measured horizontal overshoot: its beam
// and cap were both authored at length Math.SQRT2 (a cell's own
// corner-to-corner diagonal) baked at 45°, but a box with real THICKNESS
// rotated 45° has an axis-aligned bounding box LARGER than its own
// centerline length (the square-cut ends' corners poke out past the
// centerline's own endpoint) — measured at ~0.095-0.19 world units
// (≈10-19% of a cell) protruding into whichever neighbor cell the diagonal
// bordered, in EVERY direction, not just along the diagonal.
//
// Fixed with a MITERED cross-section (hexDiagonalShape below) rather than
// just shortening the beam: shortening a plain box to stop the bounding
// box overshooting also pulls the beam's own CENTERLINE TIP back from the
// true corner by the same real amount — trading the overshoot bug for a
// visible gap at the exact point the diagonal is supposed to connect to a
// neighbor. A hexagon (the exact intersection of the long 45°-rotated
// rectangle with the unit cell square) has neither problem: its two tip
// vertices are built exactly ON the cell's own opposite corners, while its
// side edges never cross the cell boundary. Confirmed via this task's own
// real Box3 re-measurement of the actual built geometry (see
// hexDiagonalShape's own doc comment) landing at exactly [-0.5, 0.5] on
// both horizontal axes — not a hand-derived approximation left unverified.
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

// Same stone/wood/gold palette as generate-map-presets.mjs's buildWall()/
// buildDoor(), so these presets read as the SAME masonry (and the same
// door) as the rest of the built-in set, not a mismatched addition.
const STONE = 0x6d7178;
const STONE_DARK = 0x4c5057;
const WOOD = 0x5a4028;
const GOLD = 0xc9a227;

const stone = () => new THREE.MeshStandardMaterial({ color: STONE, roughness: 0.9, flatShading: true });
const stoneDark = () => new THREE.MeshStandardMaterial({ color: STONE_DARK, roughness: 0.9, flatShading: true });
const wood = () => new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.75 });
const gold = () => new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.4, metalness: 0.7 });

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

// wall.glb's OWN real post-fit-scale profile (measured — see this file's
// top comment — not just the 2-unit legacy authoring): a body up to 0.7,
// a thin dark cap ring 0.7-0.74, and three merlons rising from the cap to
// the true PEAK at 0.85 (buildWall()'s 1.4/1.48/1.70 unscaled heights,
// halved by the straight run's own 0.5 fit-scale). Every wall-family piece
// below is built from these SAME layers — reaching the SAME peak — instead
// of treating 0.85 as a "body" to stack a cap+merlon ON TOP of (the
// original corner/diagonal bug this task fixed: that stacking put their
// own peaks at 1.07 and 0.93, both taller than a real straight run's 0.85).
const WALL_BODY_HEIGHT = 0.7;
const WALL_CAP_HEIGHT = 0.04;
const WALL_CAP_TOP = WALL_BODY_HEIGHT + WALL_CAP_HEIGHT; // 0.74
const WALL_MERLON_HEIGHT = 0.11;
const WALL_PEAK_HEIGHT = WALL_CAP_TOP + WALL_MERLON_HEIGHT; // 0.85 — wall.glb's own real peak
const WALL_THICKNESS = 0.19;
const CAP_THICKNESS = WALL_THICKNESS + 0.08;
const CAP_Y = WALL_BODY_HEIGHT + WALL_CAP_HEIGHT / 2;
const MERLON_Y = (WALL_CAP_TOP + WALL_PEAK_HEIGHT) / 2;

// A symmetric "plus" of two full-cell-length wall slabs crossing at 90° —
// each arm is the SAME cross-section/height as the (fixed) straight Wall
// Segment, spanning the ENTIRE cell edge-to-edge exactly like a straight
// run does, so it connects flush with a straight neighbor on ANY of its 4
// sides. Rotationally symmetric under 90° turns by construction, so a room
// corner needs no per-corner rotation at all (see templates.ts's
// classifyWallCell) — the same asset/rotation works at every one of a
// rectangular room's 4 corners.
function buildWallCorner() {
  const merlon = (x, z) => [new THREE.BoxGeometry(0.16, WALL_MERLON_HEIGHT, 0.16), stone(), x, MERLON_Y, z];
  return prop(
    [new THREE.BoxGeometry(1, WALL_BODY_HEIGHT, WALL_THICKNESS), stone(), 0, WALL_BODY_HEIGHT / 2, 0],
    [new THREE.BoxGeometry(WALL_THICKNESS, WALL_BODY_HEIGHT, 1), stone(), 0, WALL_BODY_HEIGHT / 2, 0],
    [new THREE.BoxGeometry(1, WALL_CAP_HEIGHT, CAP_THICKNESS), stoneDark(), 0, CAP_Y, 0],
    [new THREE.BoxGeometry(CAP_THICKNESS, WALL_CAP_HEIGHT, 1), stoneDark(), 0, CAP_Y, 0],
    merlon(-0.35, 0),
    merlon(0.35, 0),
    merlon(0, -0.35),
    merlon(0, 0.35),
    merlon(0, 0)
  );
}

// A beam spanning a 1x1 cell's own opposite corners — for octagonal/organic
// room shapes (or the void-terrain-carved organic shapes this app already
// supports) where a straight/corner run needs to cut a cell's true corner
// instead of turning a right angle through it.
//
// The ORIGINAL authoring (a plain BoxGeometry of length Math.SQRT2 — the
// cell's own diagonal — baked at a 45° rotation) has a real, measured bug:
// a box has real THICKNESS, and a rectangle's own CORNERS (not its
// centerline tip) are what actually stick out furthest once rotated 45°
// off-axis — this task's own real Box3 measurement of the original .glb
// confirmed the rendered piece overshot the cell edge by ~0.095-0.19 world
// units (≈10-19% of a cell) in EVERY direction, poking into whichever
// neighbor cell it bordered. Simply shortening the beam so its rotated
// bounding box stops overshooting (L = √2 − thickness) trades that bug for
// a DIFFERENT one: it pulls the beam's own CENTERLINE tip back from the
// true corner by the same amount (≈0.067-0.135 units) — a real, visible gap
// at the exact point a diagonal is supposed to connect to a neighbor.
//
// Both numbers are real trade-offs of the same underlying tension: a
// rectangle's corners sit further from center than its centerline tip once
// rotated off-axis. The actual fix is a MITERED cross-section — the exact
// intersection of the long 45°-rotated rectangle with the unit cell square
// — which has NEITHER problem: its two tip vertices sit exactly ON the
// cell's own opposite corners (built as explicit vertices, not approached
// via a shortened length), while its side edges never cross the cell
// boundary (the corner notch removes exactly the part of the rectangle
// that would have overshot). Confirmed via this task's own real Box3
// re-measurement of the actual built geometry below (a hexagon of
// half-thickness W notched by √2·W at each tip) landing at EXACTLY
// [-0.5, 0.5] on both horizontal axes — not a guess or a hand-derived
// approximation left unverified.
function hexDiagonalShape(halfThickness) {
  const notch = Math.SQRT2 * halfThickness;
  const vertices = [
    [0.5 - notch, 0.5],
    [0.5, 0.5],
    [0.5, 0.5 - notch],
    [-0.5 + notch, -0.5],
    [-0.5, -0.5],
    [-0.5, -0.5 + notch],
  ];
  const shape = new THREE.Shape();
  // ExtrudeGeometry extrudes a shape lying in its own local XY plane along
  // +Z; rotateX(-90°) below then maps local (x, y, z) -> world (x, z, -y),
  // so feeding -worldZ as the shape's own Y here lands each vertex at its
  // intended world (x, z) after that rotation — confirmed against the real
  // built geometry's own measured Box3, not assumed from the matrix algebra
  // alone.
  shape.moveTo(vertices[0][0], -vertices[0][1]);
  for (let i = 1; i < vertices.length; i++) shape.lineTo(vertices[i][0], -vertices[i][1]);
  shape.closePath();
  return shape;
}

// A mitered slab: hexDiagonalShape's footprint extruded from `bottomY` up
// to `bottomY + layerHeight` — the diagonal piece's own version of a
// BoxGeometry layer, used in place of `prop()`'s tuple shorthand because
// ExtrudeGeometry's depth spans [0, depth] rather than a box's own
// centered [-h/2, h/2] (so this positions by its own bottom, not a center).
function miteredDiagonalSlab(halfThickness, layerHeight, bottomY, material) {
  const geometry = new THREE.ExtrudeGeometry(hexDiagonalShape(halfThickness), {
    depth: layerHeight,
    bevelEnabled: false,
  });
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, bottomY, 0);
  return mesh;
}

function buildWallDiagonal() {
  const group = new THREE.Group();
  group.add(miteredDiagonalSlab(WALL_THICKNESS / 2, WALL_BODY_HEIGHT, 0, stone()));
  group.add(
    miteredDiagonalSlab(CAP_THICKNESS / 2, WALL_PEAK_HEIGHT - WALL_BODY_HEIGHT, WALL_BODY_HEIGHT, stoneDark())
  );
  return group;
}

// A wall segment with an actual walkable doorway cut into its own mass,
// replacing a plain Wall Segment (or Wall Corner) at that cell — not a
// separate free-standing door prop placed next to/on top of an intact wall
// (this task's own root cause finding: the old standalone `door` preset,
// generate-map-presets.mjs's buildDoor(), has no wall material around it at
// all, so it always read as floating regardless of where it was placed).
//
// Two stone piers (jambs) rise the same WALL_BODY_HEIGHT as a straight run,
// leaving DOOR_OPENING_WIDTH of clear space between them for a token to
// pass through; a header spanning the FULL cell width (matching wall.glb's
// own reach) closes the roofline above the opening at the SAME
// WALL_CAP_TOP/WALL_PEAK_HEIGHT/merlon profile as every other wall-family
// piece, so the parapet line reads as continuous straight through the
// doorway even though the wall's own BODY has a gap in it. A wood leaf
// (the old Door preset's own wood/gold palette, reused rather than
// duplicated with new colors) hangs ajar from one pier, covering less than
// half the opening, so the passage stays visibly clear.
const DOOR_PIER_WIDTH = 0.22;
const DOOR_OPENING_WIDTH = 1 - DOOR_PIER_WIDTH * 2;
const DOOR_PIER_X = 0.5 - DOOR_PIER_WIDTH / 2;
function buildWallDoor() {
  const merlon = (x) => [new THREE.BoxGeometry(0.16, WALL_MERLON_HEIGHT, 0.15), stone(), x, MERLON_Y, 0];
  const pier = (x) => [
    new THREE.BoxGeometry(DOOR_PIER_WIDTH, WALL_BODY_HEIGHT, WALL_THICKNESS),
    stone(),
    x,
    WALL_BODY_HEIGHT / 2,
    0,
  ];
  const leafWidth = DOOR_OPENING_WIDTH * 0.42;
  const leafHeight = WALL_BODY_HEIGHT * 0.88;
  return prop(
    pier(-DOOR_PIER_X),
    pier(DOOR_PIER_X),
    // Header: full cell width, closing the roofline above the opening.
    [new THREE.BoxGeometry(1, WALL_CAP_HEIGHT, CAP_THICKNESS), stoneDark(), 0, CAP_Y, 0],
    merlon(-0.35),
    merlon(0),
    merlon(0.35),
    // Door leaf, ajar against the right pier — covers less than half the
    // DOOR_OPENING_WIDTH gap, so the opening stays clearly walkable.
    [
      new THREE.BoxGeometry(leafWidth, leafHeight, 0.04),
      wood(),
      DOOR_PIER_X - DOOR_PIER_WIDTH / 2 - leafWidth / 2,
      leafHeight / 2,
      0,
    ],
    [
      new THREE.SphereGeometry(0.025, 8, 6),
      gold(),
      DOOR_PIER_X - DOOR_PIER_WIDTH / 2 - leafWidth + 0.05,
      leafHeight * 0.55,
      0.03,
    ]
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
  { id: "wall-door", uuid: "a55e7012-0000-4000-8000-000000000012", name: "Wall Doorway", build: buildWallDoor },
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
