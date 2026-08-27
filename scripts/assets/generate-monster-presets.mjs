#!/usr/bin/env node
// Weather & Enemies C6 — default distinct appearance per enemy template:
// generates a low-poly, dependency-free 3D model for each of C5's 8 global
// monster_templates rows (0073_monster_templates.sql: Goblin, Zombie,
// Trader, Guard, High Guard, Daemon, Demon, Witch), exported as .glb into
// public/assets/presets/ — the exact generate-map-presets.mjs/
// generate-building-presets.mjs approach (primitive THREE geometry,
// round-tripped through GLTFLoader so a structurally broken export fails
// generation instead of at render time).
//
// Deliberately a SEPARATE script rather than adding to generate-map-
// presets.mjs's own PRESETS array — same reasoning every post-0016 asset
// script gives: that script's own output migration path is already applied
// (0016_asset_library_presets.sql), so re-running it would silently rewrite
// a shipped migration. This script only ever touches the new .glb files;
// the seed INSERT/UPDATE for each new asset_library row and each
// monster_templates.default_asset_id link lives in its own new numbered
// migration (supabase/migrations/0074_monster_template_visuals.sql),
// hand-written once from this script's own printed migration hint.
//
// Per this prompt's own Task/Notes: "real silhouette/proportion/color
// differences per template... not just re-tinting one identical shape" and
// "keep each model simple... recognizably different at a glance, not
// detailed art." Each of the 8 builders below uses a genuinely different
// body plan (not the same mannequin re-colored):
//   - Goblin: short, hunched, big-eared, holding a crude blade.
//   - Zombie: human-height, slouched head, one arm slack, one reaching.
//   - Trader: a simple robed silhouette (no armor, no weapon) with a pack.
//   - Guard: human-height armored humanoid with spear + round shield.
//   - High Guard: taller/bulkier than Guard, pauldrons, a plumed helm,
//     gold trim — reads as "the same family, but clearly the officer".
//   - Daemon: upright, disciplined, dark-iron armor plates, small
//     backswept horns, a long tail — orderly per this batch's own SRD-
//     convention reasoning (0073's header comment) for yugoloth-type fiends.
//   - Demon: squat, wide crouching stance, oversized clawed arms — the
//     deliberate opposite silhouette from Daemon's tall/orderly one, per
//     0073's own "chaotic and frenzied" vs "mercenary and disciplined" split.
//   - Witch: tall robed silhouette with a pointed hat and a staff.
//
// Usage: node scripts/assets/generate-monster-presets.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Same Node/FileReader shim generate-map-presets.mjs/generate-building-
// presets.mjs need for the binary GLTFExporter path.
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

// One small, distinct palette per creature — the actual visual
// differentiator alongside silhouette, so no two templates are "the same
// shape in a different color" OR "different colors, same shape".
const GOBLIN_SKIN = 0x5b7a3a;
const GOBLIN_CLOTH = 0x3b2a1e;
const ZOMBIE_SKIN = 0x7c8a6e;
const ZOMBIE_CLOTH = 0x554a42;
const TRADER_ROBE = 0x8a5a2e;
const TRADER_TRIM = 0xc9a227;
const TRADER_SKIN = 0xd8b48c;
const GUARD_ARMOR = 0x6d7178;
const GUARD_TRIM = 0x2d4a6d;
const GUARD_WOOD = 0x5a4028;
const HIGH_GUARD_ARMOR = 0x9aa2ad;
const HIGH_GUARD_TRIM = 0xc9a227;
const DAEMON_HIDE = 0x3a4a3d;
const DAEMON_IRON = 0x3a3d42;
const DAEMON_EYE = 0xd8722e;
const DEMON_HIDE = 0x7a2e1e;
const DEMON_CLAW = 0x1c1410;
const DEMON_EYE = 0xf2c14e;
const WITCH_ROBE = 0x3d2b4a;
const WITCH_SKIN = 0x8a9a72;
const WITCH_HAT = 0x1f1a26;
const STAFF_WOOD = 0x42301c;

function material(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, flatShading: true, ...opts });
}

function prop(...meshes) {
  const group = new THREE.Group();
  for (const [geometry, mat, x, y, z, rotation] of meshes) {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(x, y, z);
    if (rotation) mesh.rotation.set(...rotation);
    group.add(mesh);
  }
  return group;
}

// A short, hunched raider: small torso, oversized head with two side-swept
// pointed ears, bent (shortened) legs for the crouched stance, and a crude
// blade held out in front — the smallest-footprint, lowest-height template
// in the set (Goblin is CR 1/4 and meant to read as a small skirmisher).
function buildGoblin() {
  const skin = material(GOBLIN_SKIN);
  const cloth = material(GOBLIN_CLOTH);
  return prop(
    [new THREE.BoxGeometry(0.13, 0.32, 0.42), cloth, -0.09, 0.16, 0.04, [0.5, 0, 0]],
    [new THREE.BoxGeometry(0.13, 0.32, 0.42), cloth, 0.09, 0.16, 0.04, [0.5, 0, 0]],
    [new THREE.BoxGeometry(0.34, 0.32, 0.2), cloth, 0, 0.42, 0],
    [new THREE.BoxGeometry(0.09, 0.24, 0.09), skin, -0.21, 0.44, 0.05, [0, 0, 0.4]],
    [new THREE.BoxGeometry(0.09, 0.22, 0.09), skin, 0.24, 0.5, 0.1, [0.6, 0, -0.5]],
    [new THREE.BoxGeometry(0.22, 0.2, 0.24), skin, 0.05, 0.63, 0.06],
    [new THREE.ConeGeometry(0.05, 0.14, 4), skin, -0.13, 0.68, 0.02, [0, 0, -0.9]],
    [new THREE.ConeGeometry(0.05, 0.14, 4), skin, 0.19, 0.68, 0.02, [0, 0, 0.9]],
    [new THREE.SphereGeometry(0.02, 6, 6), material(0xf2e7c9), -0.02, 0.63, 0.17],
    [new THREE.SphereGeometry(0.02, 6, 6), material(0xf2e7c9), 0.12, 0.63, 0.17],
    [new THREE.BoxGeometry(0.03, 0.03, 0.26), material(0x8f96a3), 0.3, 0.52, 0.2, [0.6, 0, -0.5]]
  );
}

// A human-height shambler, deliberately asymmetric (one arm slack at the
// side, one raised and reaching forward) and slouched (the head tipped
// down) — reads as "wrong" at a glance, distinct from every upright
// humanoid template in the set.
function buildZombie() {
  const skin = material(ZOMBIE_SKIN);
  const cloth = material(ZOMBIE_CLOTH);
  return prop(
    [new THREE.BoxGeometry(0.14, 0.5, 0.14), skin, -0.11, 0.25, 0, [0, 0, 0.06]],
    [new THREE.BoxGeometry(0.14, 0.5, 0.14), skin, 0.11, 0.25, 0, [0, 0, -0.06]],
    [new THREE.BoxGeometry(0.34, 0.5, 0.22), cloth, 0, 0.63, 0],
    [new THREE.BoxGeometry(0.11, 0.42, 0.11), cloth, -0.24, 0.6, 0, [0, 0, 0.25]],
    [new THREE.BoxGeometry(0.11, 0.38, 0.11), cloth, 0.24, 0.78, -0.08, [-1.3, 0, -0.3]],
    [new THREE.SphereGeometry(0.15, 8, 6), skin, 0.03, 0.98, 0.02, [0.35, 0, 0]],
    [new THREE.BoxGeometry(0.09, 0.03, 0.02), material(0x2a1f1a), 0.03, 0.99, 0.15, [0.35, 0, 0]]
  );
}

// A plain, unarmed, unarmored merchant NPC — a simple robed silhouette
// (cylinder body, not blocky limbs like the fighting humanoids above) with
// a satchel and a gold-trimmed collar. The only template with no weapon at
// all, matching its 'neutral', non-combat description.
function buildTrader() {
  const robe = material(TRADER_ROBE);
  const skin = material(TRADER_SKIN);
  return prop(
    [new THREE.CylinderGeometry(0.16, 0.22, 0.62, 10), robe, 0, 0.31, 0],
    [new THREE.TorusGeometry(0.15, 0.025, 6, 12), material(TRADER_TRIM), 0, 0.6, 0, [Math.PI / 2, 0, 0]],
    [new THREE.CylinderGeometry(0.05, 0.06, 0.3, 8), robe, -0.17, 0.42, 0.02, [0, 0, 0.5]],
    [new THREE.CylinderGeometry(0.05, 0.06, 0.3, 8), robe, 0.17, 0.42, 0.02, [0, 0, -0.5]],
    [new THREE.SphereGeometry(0.13, 10, 8), skin, 0, 0.76, 0],
    [new THREE.BoxGeometry(0.16, 0.2, 0.08), material(0x5a4028), -0.2, 0.4, -0.14, [0, 0, 0.15]]
  );
}

// A town-guard humanoid: chest armor, a domed helmet, a spear held
// upright, and a small round shield — the baseline "armored human"
// silhouette that High Guard below deliberately scales up from.
function buildGuard() {
  const armor = material(GUARD_ARMOR);
  const trim = material(GUARD_TRIM);
  return prop(
    [new THREE.BoxGeometry(0.13, 0.48, 0.13), armor, -0.1, 0.24, 0],
    [new THREE.BoxGeometry(0.13, 0.48, 0.13), armor, 0.1, 0.24, 0],
    [new THREE.BoxGeometry(0.34, 0.4, 0.22), armor, 0, 0.68, 0],
    [new THREE.BoxGeometry(0.34, 0.08, 0.23), trim, 0, 0.5, 0],
    [new THREE.BoxGeometry(0.1, 0.34, 0.1), armor, -0.22, 0.7, 0],
    [new THREE.BoxGeometry(0.1, 0.34, 0.1), armor, 0.22, 0.7, 0],
    [new THREE.SphereGeometry(0.14, 10, 8), armor, 0, 1.0, 0],
    [new THREE.ConeGeometry(0.15, 0.08, 10), armor, 0, 1.09, 0],
    [new THREE.CylinderGeometry(0.015, 0.015, 0.85, 6), material(GUARD_WOOD), 0.3, 0.85, 0.08],
    [new THREE.ConeGeometry(0.035, 0.14, 6), material(0x9aa2ad), 0.3, 1.29, 0.08],
    [new THREE.CylinderGeometry(0.16, 0.16, 0.03, 12), trim, -0.28, 0.62, 0.09, [Math.PI / 2, 0, 0]]
  );
}

// The same armored-humanoid family as Guard, but visibly the officer: a
// wider/taller torso, extra pauldron plates on both shoulders, a plumed
// (coned) crest on the helm, gold trim instead of blue, and a longsword
// instead of a spear — bigger and more ornate at every point of comparison,
// never just a recolor of Guard.
function buildHighGuard() {
  const armor = material(HIGH_GUARD_ARMOR);
  const trim = material(HIGH_GUARD_TRIM);
  return prop(
    [new THREE.BoxGeometry(0.15, 0.55, 0.15), armor, -0.12, 0.275, 0],
    [new THREE.BoxGeometry(0.15, 0.55, 0.15), armor, 0.12, 0.275, 0],
    [new THREE.BoxGeometry(0.42, 0.46, 0.26), armor, 0, 0.78, 0],
    [new THREE.BoxGeometry(0.42, 0.07, 0.27), trim, 0, 0.58, 0],
    [new THREE.BoxGeometry(0.42, 0.07, 0.27), trim, 0, 0.98, 0],
    [new THREE.BoxGeometry(0.16, 0.14, 0.24), trim, -0.29, 1.0, 0],
    [new THREE.BoxGeometry(0.16, 0.14, 0.24), trim, 0.29, 1.0, 0],
    [new THREE.BoxGeometry(0.11, 0.4, 0.11), armor, -0.27, 0.8, 0],
    [new THREE.BoxGeometry(0.11, 0.4, 0.11), armor, 0.27, 0.8, 0],
    [new THREE.SphereGeometry(0.16, 10, 8), armor, 0, 1.15, 0],
    [new THREE.ConeGeometry(0.05, 0.32, 8), trim, 0, 1.34, -0.02, [0.15, 0, 0]],
    [new THREE.CylinderGeometry(0.02, 0.02, 0.75, 6), material(0x8f96a3), 0.34, 0.95, 0.05, [0, 0, -0.08]],
    [new THREE.BoxGeometry(0.14, 0.03, 0.03), trim, 0.34, 1.28, 0.06],
    [new THREE.CylinderGeometry(0.18, 0.18, 0.03, 12), trim, -0.32, 0.7, 0.11, [Math.PI / 2, 0, 0]]
  );
}

// An upright, disciplined lesser fiend: dark-iron chest/limb plating (a
// "wears armor" silhouette, unlike Demon's bare hide below), small backswept
// horns, glowing orange eyes, and a long tapered tail — orderly and
// vertical, the deliberate visual opposite of Demon's squat chaos, per
// 0073's own daemon-vs-demon design split.
function buildDaemon() {
  const hide = material(DAEMON_HIDE);
  const iron = material(DAEMON_IRON, { metalness: 0.4, roughness: 0.6 });
  const eye = new THREE.MeshStandardMaterial({ color: DAEMON_EYE, emissive: DAEMON_EYE, emissiveIntensity: 0.8 });
  return prop(
    [new THREE.CylinderGeometry(0.08, 0.06, 0.5, 8), hide, -0.1, 0.25, 0],
    [new THREE.CylinderGeometry(0.08, 0.06, 0.5, 8), hide, 0.1, 0.25, 0],
    [new THREE.BoxGeometry(0.32, 0.14, 0.2), iron, -0.1, 0.53, 0],
    [new THREE.BoxGeometry(0.32, 0.14, 0.2), iron, 0.1, 0.53, 0],
    [new THREE.BoxGeometry(0.3, 0.36, 0.18), hide, 0, 0.76, 0],
    [new THREE.BoxGeometry(0.32, 0.1, 0.2), iron, 0, 0.9, 0],
    [new THREE.CylinderGeometry(0.07, 0.06, 0.38, 8), hide, -0.21, 0.78, 0],
    [new THREE.CylinderGeometry(0.07, 0.06, 0.38, 8), hide, 0.21, 0.78, 0],
    [new THREE.ConeGeometry(0.16, 0.22, 8), hide, 0, 1.1, 0],
    [new THREE.ConeGeometry(0.03, 0.14, 4), iron, -0.08, 1.24, -0.02, [0.3, 0, -0.3]],
    [new THREE.ConeGeometry(0.03, 0.14, 4), iron, 0.08, 1.24, -0.02, [0.3, 0, 0.3]],
    [new THREE.SphereGeometry(0.018, 6, 6), eye, -0.06, 1.12, 0.14],
    [new THREE.SphereGeometry(0.018, 6, 6), eye, 0.06, 1.12, 0.14],
    [new THREE.CylinderGeometry(0.035, 0.01, 0.5, 6), hide, 0, 0.34, -0.16, [Math.PI / 2.3, 0, 0]]
  );
}

// A squat, wide-crouching lesser demon: a low stance (short, spread legs),
// an oversized head/jaw, and thick clawed arms hanging past the knees — the
// widest-footprint, shortest template in the set, deliberately the opposite
// silhouette from Daemon's tall/orderly one.
function buildDemon() {
  const hide = material(DEMON_HIDE);
  const claw = material(DEMON_CLAW);
  const eye = new THREE.MeshStandardMaterial({ color: DEMON_EYE, emissive: DEMON_EYE, emissiveIntensity: 0.7 });
  return prop(
    [new THREE.CylinderGeometry(0.08, 0.1, 0.22, 8), hide, -0.16, 0.11, 0, [0, 0, 0.35]],
    [new THREE.CylinderGeometry(0.08, 0.1, 0.22, 8), hide, 0.16, 0.11, 0, [0, 0, -0.35]],
    [new THREE.BoxGeometry(0.46, 0.3, 0.32), hide, 0, 0.36, 0],
    [new THREE.CylinderGeometry(0.05, 0.08, 0.4, 8), hide, -0.28, 0.32, 0, [0, 0, 0.85]],
    [new THREE.CylinderGeometry(0.05, 0.08, 0.4, 8), hide, 0.28, 0.32, 0, [0, 0, -0.85]],
    [new THREE.ConeGeometry(0.06, 0.13, 5), claw, -0.44, 0.1, 0, [0, 0, 0.5]],
    [new THREE.ConeGeometry(0.06, 0.13, 5), claw, 0.44, 0.1, 0, [0, 0, -0.5]],
    [new THREE.SphereGeometry(0.2, 10, 8), hide, 0, 0.62, 0.02],
    [new THREE.ConeGeometry(0.035, 0.1, 4), hide, -0.1, 0.78, -0.02, [0.3, 0, -0.2]],
    [new THREE.ConeGeometry(0.035, 0.1, 4), hide, 0.1, 0.78, -0.02, [0.3, 0, 0.2]],
    [new THREE.SphereGeometry(0.022, 6, 6), eye, -0.08, 0.63, 0.2],
    [new THREE.SphereGeometry(0.022, 6, 6), eye, 0.08, 0.63, 0.2]
  );
}

// A tall, robed hedge-witch: a cone-based long dress (the same "robe, not
// limbs" body plan as Trader, but taller and darker), a wide pointed hat,
// gnarled hands, and a staff topped with a small gem — the tallest template
// in the set.
function buildWitch() {
  const robe = material(WITCH_ROBE);
  const skin = material(WITCH_SKIN);
  const hat = material(WITCH_HAT);
  return prop(
    [new THREE.ConeGeometry(0.26, 0.85, 10), robe, 0, 0.425, 0],
    [new THREE.CylinderGeometry(0.03, 0.05, 0.3, 6), robe, -0.2, 0.65, 0.05, [0, 0, 0.6]],
    [new THREE.CylinderGeometry(0.03, 0.05, 0.3, 6), robe, 0.22, 0.7, 0, [0, 0, -0.75]],
    [new THREE.SphereGeometry(0.03, 6, 6), skin, -0.32, 0.78, 0.08],
    [new THREE.SphereGeometry(0.11, 10, 8), skin, 0, 0.95, 0],
    [new THREE.ConeGeometry(0.02, 0.06, 4), skin, 0, 0.9, 0.11, [1.6, 0, 0]],
    [new THREE.CylinderGeometry(0.15, 0.18, 0.05, 12), hat, 0, 1.02, 0],
    [new THREE.ConeGeometry(0.11, 0.34, 10), hat, 0, 1.24, 0],
    [new THREE.CylinderGeometry(0.012, 0.012, 0.95, 6), material(STAFF_WOOD), 0.34, 0.68, 0.06],
    [new THREE.SphereGeometry(0.035, 8, 8), material(0x63b3d6, { roughness: 0.3, metalness: 0.2 }), 0.34, 1.17, 0.06]
  );
}

const PRESETS = [
  { id: "goblin", uuid: "a55e7022-0000-4000-8000-000000000022", name: "Goblin", build: buildGoblin },
  { id: "zombie", uuid: "a55e7023-0000-4000-8000-000000000023", name: "Zombie", build: buildZombie },
  { id: "trader", uuid: "a55e7024-0000-4000-8000-000000000024", name: "Trader", build: buildTrader },
  { id: "guard", uuid: "a55e7025-0000-4000-8000-000000000025", name: "Guard", build: buildGuard },
  { id: "high-guard", uuid: "a55e7026-0000-4000-8000-000000000026", name: "High Guard", build: buildHighGuard },
  { id: "daemon", uuid: "a55e7027-0000-4000-8000-000000000027", name: "Daemon", build: buildDaemon },
  { id: "demon", uuid: "a55e7028-0000-4000-8000-000000000028", name: "Demon", build: buildDemon },
  { id: "witch", uuid: "a55e7029-0000-4000-8000-000000000029", name: "Witch", build: buildWitch },
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

const measurements = [];
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
  measurements.push({ id: preset.id, size, maxDim });

  writeFileSync(join(outDir, `${preset.id}.glb`), glb);
  console.log(
    `wrote public/assets/presets/${preset.id}.glb (${glb.length} bytes, ${meshCount} meshes, ${triangleCount} triangles)`
  );
  console.log(
    `  measured bounding box: x=${size.x.toFixed(5)} y=${size.y.toFixed(5)} z=${size.z.toFixed(5)} -> maxDim=${maxDim.toFixed(5)} (auto-normalized to a single cell at render time, same as every other preset)`
  );
}

// Sanity check this task's own "genuinely distinct" acceptance criterion at
// generation time, not just by eye: no two templates should measure an
// (almost) identical bounding box, which would suggest an accidental
// copy-paste of one shape rather than a real distinct silhouette.
for (let i = 0; i < measurements.length; i++) {
  for (let j = i + 1; j < measurements.length; j++) {
    const a = measurements[i];
    const b = measurements[j];
    const same =
      Math.abs(a.size.x - b.size.x) < 0.01 &&
      Math.abs(a.size.y - b.size.y) < 0.01 &&
      Math.abs(a.size.z - b.size.z) < 0.01;
    if (same) {
      throw new Error(`${a.id} and ${b.id} measured near-identical bounding boxes — not a distinct silhouette`);
    }
  }
}
console.log("\nconfirmed: every preset's measured bounding box is distinct from every other preset's.");

const migrationHint = `-- Add the following to a new numbered migration (see supabase/migrations/):
insert into public.asset_library (id, name, source_type, model_ref) values
${PRESETS.map((p) => `  ('${p.uuid}', '${p.name}', 'preset', '/assets/presets/${p.id}.glb')`).join(",\n")}
on conflict (id) do nothing;

update public.monster_templates set default_asset_id = case name
${PRESETS.map((p) => `  when '${p.name}' then '${p.uuid}'::uuid`).join("\n")}
  else default_asset_id
end
where name in (${PRESETS.map((p) => `'${p.name}'`).join(", ")});
`;
console.log(`\n${migrationHint}`);
