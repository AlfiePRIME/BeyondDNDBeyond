// Skeleton-based posing — see docs/design/model-orientation-and-posing.md §9
// for the full design this implements. Two pieces:
//
//   1. resolvePoseBones: a cheap, upfront compatibility check. Walks a
//      loaded model's skeleton (if it has one at all) and tries to match a
//      small, fixed, documented set of bone ROLES (hips, spine, left/right
//      upper-arm/forearm/upper-leg/lower-leg, optionally head) using
//      tolerant, case-insensitive name matching plus the skeleton's own
//      hierarchy shape — never an exact bone-name string. Returns null the
//      moment any REQUIRED role can't be found (missing skin data entirely,
//      e.g. every existing preset in this repo today; or a skeleton that
//      just doesn't use a recognizable humanoid naming/shape) — callers
//      must treat null as "render today's static, unposed Clone", never a
//      partial bind (§9's explicit warning: a half-matched skeleton would
//      look worse than the current T-pose, not better).
//   2. buildPoseClip: given a resolved match, synthesizes a real
//      THREE.AnimationClip for one of this project's two authored poses
//      ("idle"/"sitting"). The clip's keyframe VALUES are computed per
//      model (not hand-authored against one specific rig) via a world-
//      space "aim" solve — see localQuatTowardWorldDirection's own comment
//      for why this is deliberately axis-convention-agnostic. Track NAMES
//      are the resolved skeleton's own bone names, so the resulting clip
//      binds correctly against any clone of that skeleton (SkeletonUtils
//      preserves bone names) via ordinary name-based AnimationMixer
//      binding — no per-model retargeting math, exactly §6/§9's finding.
//
// Deliberately NOT in scope (see the design doc's §6/§9 explicit
// recommendation against it): arbitrary/unknown skeleton support,
// cross-skeleton retargeting (SkeletonUtils.retarget), and per-model
// authored clips.

import { AnimationClip, Quaternion, QuaternionKeyframeTrack, Vector3 } from "three";
import type { Bone, Object3D } from "three";

export type PoseName = "idle" | "sitting";

type Role =
  | "hips"
  | "spine"
  | "head"
  | "leftUpperArm"
  | "leftForearm"
  | "rightUpperArm"
  | "rightForearm"
  | "leftUpperLeg"
  | "leftLowerLeg"
  | "rightUpperLeg"
  | "rightLowerLeg";

// Head is explicitly optional (design doc §9) — used only for a small idle
// sway if present; its absence never fails the compatibility check.
const REQUIRED_ROLES: readonly Role[] = [
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
];

export interface ResolvedPose {
  bones: Partial<Record<Role, Bone>>;
  /** World-space Y of the hips/root bone in the model's own REST pose
   * (before any pose is applied). SeatAvatar's sitting-anchor: folding the
   * legs for "sitting" moves the feet, so the standing rest pose's
   * feet-at-origin convention would float the character above the chair —
   * the hips are what should land at the seat's own height instead. */
  hipsRestWorldY: number;
}

// --- Role matching: tolerant by role, not by one exact bone-name string ---
// (design doc §9). The alias tokens below cover both the Mixamo-style
// naming the design doc anchors the convention on, and the
// Khronos glTF-Sample-Assets RiggedFigure naming this project's own
// committed test fixture actually uses (torso_joint/arm_joint/leg_joint/
// neck_joint) — both are real, freely-available rigs this repo's own due
// diligence (the design doc's §3/§6) already worked with directly.

const ARM_INCLUDE = ["arm"];
// "forearm"/"lowerarm" both already contain "arm" and are handled by the
// depth-based upper/lower split below, not by a separate alias — only
// non-arm-chain bones need excluding here.
const ARM_EXCLUDE = ["shoulder", "clavicle", "hand", "wrist", "finger", "thumb"];
const LEG_INCLUDE = ["leg", "thigh", "shin", "calf"];
const LEG_EXCLUDE = ["foot", "toe", "ankle"];
const SPINE_INCLUDE = ["spine", "chest", "torso", "back"];
const HEAD_INCLUDE = ["head", "neck", "skull"];

type Family = "arm" | "leg" | "spine" | "head" | null;

function includesAny(lower: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => lower.includes(token));
}

function familyOf(name: string): Family {
  const lower = name.toLowerCase();
  if (includesAny(lower, ARM_INCLUDE) && !includesAny(lower, ARM_EXCLUDE)) return "arm";
  if (includesAny(lower, LEG_INCLUDE) && !includesAny(lower, LEG_EXCLUDE)) return "leg";
  if (includesAny(lower, HEAD_INCLUDE)) return "head";
  if (includesAny(lower, SPINE_INCLUDE)) return "spine";
  return null;
}

/** Case-insensitive, tolerant of both "Left"/"Right" (Mixamo-style) and a
 * standalone "L"/"R" token bounded by underscores/dots/hyphens (RiggedFigure-
 * style: "arm_joint_L_1"). */
function sideOf(name: string): "left" | "right" | null {
  const lower = name.toLowerCase();
  if (lower.includes("left")) return "left";
  if (lower.includes("right")) return "right";
  if (/(^|[_.-])l([_.-]|$)/.test(lower)) return "left";
  if (/(^|[_.-])r([_.-]|$)/.test(lower)) return "right";
  return null;
}

function collectBones(root: Object3D): Bone[] {
  const bones: Bone[] = [];
  root.traverse((object) => {
    if ((object as Partial<Bone> & { isBone?: boolean }).isBone) bones.push(object as Bone);
  });
  return bones;
}

function hasSkinnedMesh(root: Object3D): boolean {
  let found = false;
  root.traverse((object) => {
    if ((object as { isSkinnedMesh?: boolean }).isSkinnedMesh) found = true;
  });
  return found;
}

/** The skeleton's own root joint — structurally, the one bone in the set
 * with no bone-parent within the set. This is deliberately NOT a name
 * lookup (design doc §6: real rigs don't agree on a "hips" string —
 * RiggedFigure's root is "torso_joint_1") — every real single-skeleton
 * humanoid rig has exactly one such bone, whatever it's named. */
function findSkeletonRoot(bones: readonly Bone[]): Bone | null {
  const set = new Set<Bone>(bones);
  const roots = bones.filter((bone) => !(bone.parent && set.has(bone.parent as Bone)));
  return roots.length === 1 ? roots[0] : null;
}

/** BFS depth (steps from the root) for every bone reachable from it — used
 * to split a matched "leg"/"arm" name family into upper/lower segments by
 * hierarchy position, since real exports (RiggedFigure) often don't encode
 * upper-vs-lower in the name at all (leg_joint_L_1 vs leg_joint_L_2). */
function computeDepths(root: Bone, bones: readonly Bone[]): Map<Bone, number> {
  const set = new Set<Bone>(bones);
  const childrenOf = new Map<Bone, Bone[]>();
  for (const bone of bones) {
    const parent = bone.parent as Bone | null;
    if (parent && set.has(parent)) {
      const list = childrenOf.get(parent) ?? [];
      list.push(bone);
      childrenOf.set(parent, list);
    }
  }
  const depths = new Map<Bone, number>([[root, 0]]);
  const queue: Bone[] = [root];
  while (queue.length > 0) {
    const current = queue.shift() as Bone;
    const depth = depths.get(current) ?? 0;
    for (const child of childrenOf.get(current) ?? []) {
      if (!depths.has(child)) {
        depths.set(child, depth + 1);
        queue.push(child);
      }
    }
  }
  return depths;
}

/**
 * The upfront compatibility check (design doc §9 point 3): cheap (a handful
 * of Set/string lookups over a few dozen bones at most), run once per
 * loaded model and memoized by callers — never per frame. Returns null the
 * moment any required role is missing; never a partial match.
 */
export function resolvePoseBones(root: Object3D): ResolvedPose | null {
  const bones = collectBones(root);
  if (bones.length === 0 || !hasSkinnedMesh(root)) return null;

  const hips = findSkeletonRoot(bones);
  if (!hips) return null;

  const depths = computeDepths(hips, bones);
  const candidates = bones.filter((bone) => bone !== hips && depths.has(bone));

  function bySideSorted(family: Family): Record<"left" | "right", Bone[]> {
    const result: Record<"left" | "right", Bone[]> = { left: [], right: [] };
    for (const bone of candidates) {
      if (familyOf(bone.name) !== family) continue;
      const side = sideOf(bone.name);
      if (!side) continue;
      result[side].push(bone);
    }
    result.left.sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0));
    result.right.sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0));
    return result;
  }

  const legs = bySideSorted("leg");
  const arms = bySideSorted("arm");

  const spine = candidates
    .filter((bone) => familyOf(bone.name) === "spine")
    .sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0))[0];

  // Most head-like = furthest from the hips among neck/head-family bones.
  const head = candidates
    .filter((bone) => familyOf(bone.name) === "head")
    .sort((a, b) => (depths.get(b) ?? 0) - (depths.get(a) ?? 0))[0];

  const resolved: Partial<Record<Role, Bone>> = {
    hips,
    spine,
    head,
    leftUpperLeg: legs.left[0],
    leftLowerLeg: legs.left[1],
    rightUpperLeg: legs.right[0],
    rightLowerLeg: legs.right[1],
    leftUpperArm: arms.left[0],
    leftForearm: arms.left[1],
    rightUpperArm: arms.right[0],
    rightForearm: arms.right[1],
  };

  for (const role of REQUIRED_ROLES) {
    if (!resolved[role]) return null;
  }

  hips.updateWorldMatrix(true, false);
  const hipsRestWorldY = hips.getWorldPosition(new Vector3()).y;

  return { bones: resolved, hipsRestWorldY };
}

// --- Clip synthesis --------------------------------------------------------

const POSE_DURATION_SECONDS = 4;

function boneWorldPosition(bone: Object3D, target = new Vector3()): Vector3 {
  bone.updateWorldMatrix(true, false);
  return bone.getWorldPosition(target);
}

function boneWorldQuaternion(bone: Object3D, target = new Quaternion()): Quaternion {
  bone.updateWorldMatrix(true, false);
  return bone.getWorldQuaternion(target);
}

function firstBoneChild(bone: Object3D): Object3D | null {
  return bone.children.find((child) => (child as { isBone?: boolean }).isBone) ?? null;
}

/**
 * The local quaternion that redirects `bone`'s REST "pointing direction"
 * (the world-space vector from the bone to its own first bone-child) to
 * `targetWorldDir`, expressed relative to `parentWorldQuat`.
 *
 * Deliberately axis-convention-agnostic: it never assumes which of a
 * bone's own local axes points "along" it (design doc §6's own finding —
 * even two closely-related sample rigs don't share one convention there).
 * It only uses each bone's REAL rest-pose world position and its parent's
 * world orientation, both generic/computable for any skeleton — so it
 * works identically regardless of which tool authored the rig.
 *
 * `parentWorldQuat` must be the parent's ACTUAL new (possibly already
 * re-posed) world quaternion, not necessarily its rest one. Critically,
 * "parent" here means `bone.parent` itself — buildPoseClip's own
 * `worldQuatOf` walks that REAL chain up to the hips, not a shortcut
 * through the nearest tracked ROLE ancestor; several real rigs (this
 * project's own RiggedFigure test fixture included — its arm bones'
 * actual parent is an untracked third torso joint, not the tracked
 * "spine" role one level up; Mixamo-style rigs have an analogous
 * untracked "Shoulder" bone) have at least one untracked bone sitting
 * between two tracked roles, and using the wrong parent quaternion here
 * silently rotates the result by whatever that untracked bone's own
 * orientation is — confirmed the hard way against a real GPU screenshot,
 * not just unit tests, during this module's own development.
 */
function localQuatTowardWorldDirection(bone: Bone, targetWorldDir: Vector3, parentWorldQuat: Quaternion): Quaternion {
  const child = firstBoneChild(bone);
  if (!child) return bone.quaternion.clone();

  const restDir = boneWorldPosition(child).sub(boneWorldPosition(bone));
  if (restDir.lengthSq() < 1e-10) return bone.quaternion.clone();
  restDir.normalize();
  const target = targetWorldDir.clone().normalize();

  const align = new Quaternion();
  if (restDir.dot(target) < -0.9999) {
    // Antiparallel: setFromUnitVectors can't pick a unique axis. None of
    // this module's authored targets are actually antiparallel to a real
    // humanoid rest pose — this is a defensive fallback, not a path this
    // ships against.
    const fallbackAxis = Math.abs(restDir.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const axis = fallbackAxis.clone().cross(restDir).normalize();
    align.setFromAxisAngle(axis, Math.PI);
  } else {
    align.setFromUnitVectors(restDir, target);
  }

  const newWorldQuat = align.multiply(boneWorldQuaternion(bone));
  return parentWorldQuat.clone().invert().multiply(newWorldQuat);
}

/** A small world-space axis tilt on top of a bone's rest orientation —
 * used for the optional idle head sway, which (unlike the corrective limb
 * poses) doesn't need a bone child to aim at, just a gentle nod. */
function localQuatWithWorldTilt(bone: Bone, axisWorld: Vector3, angleRad: number, parentWorldQuat: Quaternion): Quaternion {
  const tilt = new Quaternion().setFromAxisAngle(axisWorld, angleRad);
  const newWorldQuat = tilt.multiply(boneWorldQuaternion(bone));
  return parentWorldQuat.clone().invert().multiply(newWorldQuat);
}

function quaternionTrack(bone: Bone, quats: readonly Quaternion[], times: readonly number[]): QuaternionKeyframeTrack {
  const values: number[] = [];
  for (const quat of quats) values.push(quat.x, quat.y, quat.z, quat.w);
  return new QuaternionKeyframeTrack(`${bone.name}.quaternion`, times as number[], values);
}

/** left/right target vectors are authored with a fixed lateral MAGNITUDE
 * but a SIGN derived from the model's own rest pose (which side of the
 * hips the resolved "left" bone actually sits on) — robust to either
 * lateral (+X-is-left or -X-is-left) convention, rather than assuming one. */
function lateralSign(sideBone: Bone, hips: Bone): number {
  const sign = Math.sign(boneWorldPosition(sideBone).x - boneWorldPosition(hips).x);
  return sign === 0 ? 1 : sign;
}

/**
 * Synthesizes one of this project's two authored poses against an already-
 * resolved skeleton match. The resulting clip's track names are THIS
 * skeleton's own bone names, so — per §6's proof that AnimationClip tracks
 * bind by name — it plays correctly against any SkeletonUtils clone of the
 * same skeleton (names survive cloning), not just this exact Object3D.
 */
export function buildPoseClip(poseName: PoseName, pose: ResolvedPose): AnimationClip {
  const hips = pose.bones.hips as Bone;
  const spine = pose.bones.spine as Bone;
  const leftUpperArm = pose.bones.leftUpperArm as Bone;
  const rightUpperArm = pose.bones.rightUpperArm as Bone;
  const leftForearm = pose.bones.leftForearm as Bone;
  const rightForearm = pose.bones.rightForearm as Bone;
  const leftUpperLeg = pose.bones.leftUpperLeg as Bone;
  const rightUpperLeg = pose.bones.rightUpperLeg as Bone;
  const leftLowerLeg = pose.bones.leftLowerLeg as Bone;
  const rightLowerLeg = pose.bones.rightLowerLeg as Bone;
  const head = pose.bones.head ?? null;

  const armSide = lateralSign(leftUpperArm, hips);
  const legSide = lateralSign(leftUpperLeg, hips);

  const hipsWorldQuat = boneWorldQuaternion(hips);
  const tracks: QuaternionKeyframeTrack[] = [];

  // Bone -> the NEW local quaternion this pose gives it, filled in as each
  // bone below is computed. Real rigs commonly have UNTRACKED bones between
  // two tracked roles — e.g. RiggedFigure's own torso_joint_3 sits between
  // "spine" (torso_joint_2) and "leftUpperArm" (arm_joint_L_1); Mixamo-style
  // rigs have an analogous untracked "Shoulder" bone between Spine2 and
  // Arm. Naively using the nearest TRACKED ancestor's world quat as a
  // bone's parent reference is wrong whenever such an untracked bone sits
  // between them (confirmed the hard way: an earlier version of this
  // function did exactly that and produced an arm pointing roughly
  // sideways instead of down, caught by a real-GPU screenshot, not just
  // the unit tests — see this function's own git history). worldQuatOf
  // below walks the ACTUAL parent chain (bone.parent, not a role lookup)
  // up to the hips, using each already-computed override where one exists
  // and that bone's own REST local quaternion otherwise — correct
  // regardless of how many untracked bones sit in between.
  const newLocal = new Map<Bone, Quaternion>();
  function worldQuatOf(bone: Bone): Quaternion {
    if (bone === hips) return hipsWorldQuat.clone();
    const parent = bone.parent as Bone | null;
    const parentWorldQuat = parent ? worldQuatOf(parent) : hipsWorldQuat.clone();
    const localQuat = newLocal.get(bone) ?? bone.quaternion;
    return parentWorldQuat.multiply(localQuat);
  }

  function constantTrack(bone: Bone, quat: Quaternion): QuaternionKeyframeTrack {
    return quaternionTrack(bone, [quat, quat], [0, POSE_DURATION_SECONDS]);
  }

  // Spine: unchanged for "idle" (worldQuatOf falls through to its own REST
  // local quaternion below, since it's never added to `newLocal`); a mild
  // forward lean for "sitting" — a seated posture naturally isn't
  // bolt-upright. Local -Z is this project's established "forward"
  // convention (Chair.tsx / OrientationPreview's ForwardMarker), applied
  // here in the model's own pre-forwardOffsetDeg local frame so it
  // composes correctly with that separate, outer rotation regardless of
  // what forward correction (if any) the uploader configured.
  if (poseName === "sitting") {
    const spineChild = firstBoneChild(spine);
    if (spineChild) {
      const restDir = boneWorldPosition(spineChild).sub(boneWorldPosition(spine)).normalize();
      const leanTarget = restDir.clone().addScaledVector(new Vector3(0, 0, -1), 0.12).normalize();
      const spineLocal = localQuatTowardWorldDirection(spine, leanTarget, worldQuatOf(spine.parent as Bone));
      newLocal.set(spine, spineLocal);
      tracks.push(constantTrack(spine, spineLocal));
    }
  }

  // Arms: bring both down to the sides for EITHER pose — this is what
  // actually breaks a T-pose (design doc §9: "arms matter most for
  // breaking a T-pose"). A small outward/forward offset on top of "mostly
  // down" avoids the upper arm clipping straight into the torso mesh.
  const upperArmTarget = (sign: number) => new Vector3(sign * 0.28, -0.94, 0.06).normalize();
  const forearmTarget = (sign: number) => new Vector3(sign * 0.14, -0.98, 0.12).normalize();

  const leftUpperArmLocal = localQuatTowardWorldDirection(leftUpperArm, upperArmTarget(armSide), worldQuatOf(leftUpperArm.parent as Bone));
  newLocal.set(leftUpperArm, leftUpperArmLocal);
  const rightUpperArmLocal = localQuatTowardWorldDirection(
    rightUpperArm,
    upperArmTarget(-armSide),
    worldQuatOf(rightUpperArm.parent as Bone)
  );
  newLocal.set(rightUpperArm, rightUpperArmLocal);

  tracks.push(constantTrack(leftUpperArm, leftUpperArmLocal));
  tracks.push(constantTrack(rightUpperArm, rightUpperArmLocal));
  tracks.push(constantTrack(leftForearm, localQuatTowardWorldDirection(leftForearm, forearmTarget(armSide), worldQuatOf(leftUpperArm))));
  tracks.push(
    constantTrack(rightForearm, localQuatTowardWorldDirection(rightForearm, forearmTarget(-armSide), worldQuatOf(rightUpperArm)))
  );

  if (poseName === "sitting") {
    // Thighs roughly horizontal (hip bent ~90°) pointing toward the
    // model's own local -Z "forward", shins hanging back down toward the
    // floor (knee bent ~90°) — "legs matter most for a believable sitting
    // pose" (design doc §9).
    const upperLegTarget = (sign: number) => new Vector3(sign * 0.12, -0.22, -0.97).normalize();
    const lowerLegTarget = (sign: number) => new Vector3(sign * 0.05, -0.98, 0.16).normalize();

    const leftUpperLegLocal = localQuatTowardWorldDirection(leftUpperLeg, upperLegTarget(legSide), worldQuatOf(leftUpperLeg.parent as Bone));
    newLocal.set(leftUpperLeg, leftUpperLegLocal);
    const rightUpperLegLocal = localQuatTowardWorldDirection(
      rightUpperLeg,
      upperLegTarget(-legSide),
      worldQuatOf(rightUpperLeg.parent as Bone)
    );
    newLocal.set(rightUpperLeg, rightUpperLegLocal);

    tracks.push(constantTrack(leftUpperLeg, leftUpperLegLocal));
    tracks.push(constantTrack(rightUpperLeg, rightUpperLegLocal));
    tracks.push(
      constantTrack(leftLowerLeg, localQuatTowardWorldDirection(leftLowerLeg, lowerLegTarget(legSide), worldQuatOf(leftUpperLeg)))
    );
    tracks.push(
      constantTrack(rightLowerLeg, localQuatTowardWorldDirection(rightLowerLeg, lowerLegTarget(-legSide), worldQuatOf(rightUpperLeg)))
    );
  }

  // A genuinely looping idle sway on top of the corrective pose above —
  // design doc §7/§9: ship the loop, not a frozen frame (the measured
  // marginal AnimationMixer cost is negligible even at realistic NPC-token
  // counts). Optional: a conforming skeleton with no resolvable head bone
  // still gets the full corrective pose, just without the sway on top.
  if (head) {
    const headParentWorldQuat = (head.parent as Bone | null) ? worldQuatOf(head.parent as Bone) : hipsWorldQuat.clone();
    const amplitude = 0.045; // ~2.6 degrees — a subtle breathing/idle nod.
    const worldXAxis = new Vector3(1, 0, 0);
    const tiltedBack = localQuatWithWorldTilt(head, worldXAxis, -amplitude, headParentWorldQuat);
    const tiltedForward = localQuatWithWorldTilt(head, worldXAxis, amplitude, headParentWorldQuat);
    tracks.push(quaternionTrack(head, [tiltedBack, tiltedForward, tiltedBack], [0, POSE_DURATION_SECONDS / 2, POSE_DURATION_SECONDS]));
  }

  return new AnimationClip(poseName, POSE_DURATION_SECONDS, tracks);
}
