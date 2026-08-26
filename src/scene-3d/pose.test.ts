import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { AnimationMixer, BoxGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import type { Bone, Object3D } from "three";
import { SkeletonUtils } from "three-stdlib";
import { buildPoseClip, resolvePoseBones, type PoseName } from "./pose";

// Real, permanent Khronos glTF-Sample-Assets fixtures — see
// public/test-fixtures/README.md and
// docs/design/model-orientation-and-posing.md §3. Confirmed (per the design
// doc's own investigation) to parse fine in plain Node/vitest without jsdom
// since neither fixture carries any material image (the one thing
// GLTFLoader's texture path needs a browser `self` global for).
function loadGlb(relativePath: string): Promise<Object3D> {
  const path = join(process.cwd(), "public", relativePath);
  const buffer = readFileSync(path);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(arrayBuffer, "", (gltf) => resolve(gltf.scene as Object3D), reject);
  });
}

const REQUIRED_ROLES = [
  "hips",
  "spine",
  "leftUpperArm",
  "leftForearm",
  "rightUpperArm",
  "rightForearm",
  "leftUpperLeg",
  "leftLowerLeg",
  "rightUpperLeg",
  "rightLowerLeg",
] as const;

describe("resolvePoseBones", () => {
  it("returns null for a model with no skin data at all (every current preset in this repo)", () => {
    const group = new Group();
    group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    expect(resolvePoseBones(group)).toBeNull();
  });

  it("resolves every required role for RiggedFigure via tolerant, structural matching (not exact bone-name strings)", async () => {
    const scene = await loadGlb("test-fixtures/RiggedFigure.glb");
    const resolved = resolvePoseBones(scene);
    expect(resolved).not.toBeNull();
    for (const role of REQUIRED_ROLES) {
      expect(resolved!.bones[role], `missing role ${role}`).toBeDefined();
    }
    // The skeleton's own root joint, found structurally (no bone-parent
    // within the skin), not by matching a "hips"/"pelvis" string —
    // RiggedFigure's own root is named "torso_joint_1", proving the
    // structural approach (design doc §6: real rigs don't agree on a
    // literal name even for the same joint).
    expect(resolved!.bones.hips!.name).toBe("torso_joint_1");
    expect(resolved!.bones.leftUpperLeg!.name).toBe("leg_joint_L_1");
    expect(resolved!.bones.leftLowerLeg!.name).toBe("leg_joint_L_2");
    expect(resolved!.bones.leftUpperArm!.name).toBe("arm_joint_L_1");
    expect(resolved!.bones.leftForearm!.name).toBe("arm_joint_L_2");
    expect(resolved!.bones.head?.name).toBe("neck_joint_2");
    // Real world-space Y of the root joint in its own rest pose.
    expect(resolved!.hipsRestWorldY).toBeCloseTo(0.686, 2);
  });

  it("returns null for RiggedSimple's 2-bone skeleton — a real skin, but nowhere near enough matching roles", async () => {
    const scene = await loadGlb("test-fixtures/RiggedSimple.glb");
    expect(resolvePoseBones(scene)).toBeNull();
  });
});

describe("buildPoseClip", () => {
  it("idle pose corrects both arms without touching the legs", async () => {
    const scene = await loadGlb("test-fixtures/RiggedFigure.glb");
    const resolved = resolvePoseBones(scene)!;
    const clip = buildPoseClip("idle", resolved);

    expect(clip.name).toBe("idle");
    expect(clip.duration).toBe(4);

    const trackNames = clip.tracks.map((track) => track.name);
    expect(trackNames).toContain(`${resolved.bones.leftUpperArm!.name}.quaternion`);
    expect(trackNames).toContain(`${resolved.bones.rightForearm!.name}.quaternion`);
    // Idle deliberately doesn't touch the legs (RiggedFigure's rest legs
    // already hang straight down — fine for "standing"; see PropModel's
    // own comment on why it needs no anchor override either).
    expect(trackNames).not.toContain(`${resolved.bones.leftUpperLeg!.name}.quaternion`);

    // The baked arm quaternion must differ meaningfully from the model's
    // own rest quaternion — proof the wide, T-pose-adjacent rest arm angle
    // is actually being corrected, not just re-emitted unchanged.
    const restQuat = resolved.bones.leftUpperArm!.quaternion;
    const track = clip.tracks.find((candidate) => candidate.name === `${resolved.bones.leftUpperArm!.name}.quaternion`)!;
    const bakedQuat = new Quaternion(track.values[0], track.values[1], track.values[2], track.values[3]);
    expect(bakedQuat.angleTo(restQuat)).toBeGreaterThan(0.2);
  });

  it("sitting pose additionally bends both legs at the hip and knee", async () => {
    const scene = await loadGlb("test-fixtures/RiggedFigure.glb");
    const resolved = resolvePoseBones(scene)!;
    const clip = buildPoseClip("sitting", resolved);
    const trackNames = clip.tracks.map((track) => track.name);

    for (const role of ["leftUpperLeg", "leftLowerLeg", "rightUpperLeg", "rightLowerLeg"] as const) {
      const boneName = resolved.bones[role]!.name;
      expect(trackNames, `expected a track for ${role} (${boneName})`).toContain(`${boneName}.quaternion`);
      const restQuat = resolved.bones[role]!.quaternion;
      const track = clip.tracks.find((candidate) => candidate.name === `${boneName}.quaternion`)!;
      const bakedQuat = new Quaternion(track.values[0], track.values[1], track.values[2], track.values[3]);
      expect(bakedQuat.angleTo(restQuat), `${role} should be visibly bent`).toBeGreaterThan(0.2);
    }
  });

  it.each<PoseName>(["idle", "sitting"])(
    "%s pose plays back correctly against an INDEPENDENTLY CLONED skeleton — the real per-instance <Clone> path",
    async (poseName) => {
      const scene = await loadGlb("test-fixtures/RiggedFigure.glb");
      const resolved = resolvePoseBones(scene)!;
      const clip = buildPoseClip(poseName, resolved);

      // SkeletonUtils.clone is exactly what drei's <Clone> already does per
      // rendered instance (design doc §5) — this is the real end-to-end
      // claim buildPoseClip makes: track names bind correctly against a
      // SEPARATE cloned skeleton's own bones, not just the original scene
      // object the roles were resolved from.
      const clone = SkeletonUtils.clone(scene);
      const clonedUpperArm = clone.getObjectByName(resolved.bones.leftUpperArm!.name)!;
      const restQuat = clonedUpperArm.quaternion.clone();

      const mixer = new AnimationMixer(clone);
      mixer.clipAction(clip).play();
      mixer.update(0.5);

      expect(clonedUpperArm.quaternion.angleTo(restQuat)).toBeGreaterThan(0.2);
      // The clone's bones actually moved; the ORIGINAL scene's bones (what
      // resolvePoseBones/buildPoseClip read from) must stay untouched —
      // useGLTF's cache is shared across every instance rendering the same
      // URL, so mutating it would corrupt every other instance. restQuat
      // was captured from the clone BEFORE playback, i.e. the shared rest
      // value both the original and the (not-yet-posed) clone started
      // from — the original should still match it almost exactly.
      expect(resolved.bones.leftUpperArm!.quaternion.angleTo(restQuat)).toBeLessThan(1e-4);
    }
  );

  // Regression test for a real bug caught only by a real-GPU screenshot
  // during this module's own development, not by the "some rotation
  // happened" checks above: an earlier version computed each posed bone's
  // parent-world-quaternion from the nearest TRACKED role ancestor (e.g.
  // "spine") rather than the bone's REAL parent (bone.parent) — wrong
  // whenever an untracked bone sits in between, which RiggedFigure's own
  // arm chain does (arm_joint_L_1's actual parent is torso_joint_3, an
  // untracked third torso joint, not the tracked "spine" role
  // torso_joint_2 one level up — the same shape as a Mixamo-style rig's
  // untracked "Shoulder" bone). That bug still produced a large rotation
  // (so the angleTo(...) > 0.2 checks above passed), just pointed at the
  // wrong world direction entirely (an arm ending up pointing sideways
  // instead of down). This test plays each clip against a REAL cloned
  // skeleton (exactly PosedClone's own path) and checks the ACTUAL
  // resulting world-space limb direction against the intended target,
  // not just "did something change".
  it("idle pose brings both arms down toward the body — the actual resulting world direction, not just 'something changed'", async () => {
    const scene = await loadGlb("test-fixtures/RiggedFigure.glb");
    const resolved = resolvePoseBones(scene)!;
    const clip = buildPoseClip("idle", resolved);

    const clone = SkeletonUtils.clone(scene);
    const mixer = new AnimationMixer(clone);
    mixer.clipAction(clip).play();
    mixer.update(0.5);
    clone.updateMatrixWorld(true);

    for (const side of ["left", "right"] as const) {
      const shoulder = clone.getObjectByName(resolved.bones[`${side}UpperArm`]!.name) as Bone;
      const elbow = clone.getObjectByName(resolved.bones[`${side}Forearm`]!.name) as Bone;
      const shoulderPos = shoulder.getWorldPosition(new Vector3());
      const elbowPos = elbow.getWorldPosition(new Vector3());
      const dir = elbowPos.sub(shoulderPos).normalize();
      // "Mostly down": the dominant component must be -Y, clearly more
      // negative than either horizontal component is large in either
      // direction — this is what actually distinguishes "hanging at the
      // side" from "reaching sideways/forward" (the bug's actual failure
      // mode: a resulting direction of roughly [0.28, -0.12, 0.95], almost
      // entirely horizontal).
      expect(dir.y, `${side} arm should point mostly downward, got ${dir.toArray()}`).toBeLessThan(-0.7);
      expect(Math.abs(dir.x), `${side} arm should not point mostly sideways, got ${dir.toArray()}`).toBeLessThan(0.6);
      expect(Math.abs(dir.z), `${side} arm should not point mostly forward/back, got ${dir.toArray()}`).toBeLessThan(0.6);
    }
  });

  it("sitting pose bends the thigh roughly horizontal and the shin back down toward the floor", async () => {
    const scene = await loadGlb("test-fixtures/RiggedFigure.glb");
    const resolved = resolvePoseBones(scene)!;
    const clip = buildPoseClip("sitting", resolved);

    const clone = SkeletonUtils.clone(scene);
    const mixer = new AnimationMixer(clone);
    mixer.clipAction(clip).play();
    mixer.update(0.5);
    clone.updateMatrixWorld(true);

    for (const side of ["left", "right"] as const) {
      const hip = clone.getObjectByName(resolved.bones[`${side}UpperLeg`]!.name) as Bone;
      const knee = clone.getObjectByName(resolved.bones[`${side}LowerLeg`]!.name) as Bone;
      const ankleEquivalent = knee.children.find((child) => (child as { isBone?: boolean }).isBone) as Bone;
      const hipPos = hip.getWorldPosition(new Vector3());
      const kneePos = knee.getWorldPosition(new Vector3());
      const anklePos = ankleEquivalent.getWorldPosition(new Vector3());

      const thighDir = kneePos.clone().sub(hipPos).normalize();
      // A seated thigh sticks out roughly horizontally from the hip — the
      // vertical component should be small relative to the horizontal one.
      expect(Math.abs(thighDir.y), `${side} thigh should be roughly horizontal, got ${thighDir.toArray()}`).toBeLessThan(0.6);

      const shinDir = anklePos.clone().sub(kneePos).normalize();
      // The shin hangs back down from the bent knee toward the floor.
      expect(shinDir.y, `${side} shin should point back down toward the floor, got ${shinDir.toArray()}`).toBeLessThan(-0.7);
    }
  });
});
