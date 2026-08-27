"use client";

import { useEffect, useMemo, useRef } from "react";
import { Clone, useAnimations } from "@react-three/drei";
import { Color, Mesh, type Material } from "three";
import type { AnimationClip } from "three";
import type { Group, Object3D } from "three";
import { SkeletonUtils } from "three-stdlib";
import { buildPoseClip, resolvePoseBones, type PoseName } from "./pose";

export interface PosedCloneProps {
  /** The cached, shared glTF scene from useGLTF — never mutated here;
   * PosedClone clones it (via drei's Clone, SkeletonUtils-aware — see
   * SeatAvatar.tsx/PlacedObject.tsx's own comments) the same as every
   * other model renderer in this project. */
  scene: Object3D;
  pose: PoseName;
  scale: number;
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  castShadow?: boolean;
  /** Map Editor Batch A3: a '#rrggbb' hex string, or null/omitted for "no
   * tint" — see buildTintedScene's own doc comment below for how (and why)
   * this is applied. */
  tint?: string | null;
  /** Verification-only: reports whether this specific model's skeleton
   * satisfied the supported bone-role convention (and is therefore
   * actually posed/animated) — the same "mirror render state into a
   * callback so a caller can expose it to Playwright" precedent as
   * DiceTumbleProps.onQueueChange / MapSurfaceProps.onTokenSlideDebug
   * (WebGL has no DOM for a test to inspect a skeleton directly). Omit it
   * (as most callers do) and nothing about rendering changes. */
  onCompatibilityChange?: (compatible: boolean) => void;
}

/** Clones `material` and multiplies its base color by `tint` — a multiply,
 * never a flat replacement, so a textured material's own map (wood grain,
 * etc.) still shows through, just recolored, exactly like tinting a light
 * with a colored gel. Materials with no `color` property (rare in this
 * project's own presets/uploads, all MeshStandardMaterial) pass through
 * unmodified rather than throwing. */
function tintMaterial(material: Material, tint: Color): Material {
  const cloned = material.clone();
  if ("color" in cloned && cloned.color instanceof Color) {
    cloned.color = cloned.color.clone().multiply(tint);
  }
  return cloned;
}

/**
 * Map Editor Batch A3: a per-instance clone of `scene` with every mesh's
 * material(s) tinted — investigated first (this task's own real reading of
 * drei's Clone source, not assumed): drei's plain `<Clone object={scene}>`
 * (the path this file already used for every unrigged model, which is every
 * preset and every custom upload in this repo today) does NOT clone
 * materials at all unless its own `deep` prop is set — every placed
 * instance of the same asset shares the exact same THREE.Material objects
 * as the cached useGLTF scene. Mutating a shared material's color for one
 * placed chest would silently recolor every OTHER chest on the map (and the
 * cached scene itself). This function is the fix, applied ONLY when a tint
 * is actually set (see PosedClone's own untinted branch below, which is
 * byte-for-byte the pre-A3 code path — an untinted object's materials stay
 * exactly as shared as they always were, since nothing ever mutates them).
 *
 * SkeletonUtils.clone (not a plain Object3D.clone) so a rigged model's own
 * skin binding survives the same way drei's Clone already guarantees for
 * every OTHER model in this project — matching PosedClone's own existing
 * "SkeletonUtils-aware" precedent instead of inventing a second cloning
 * strategy.
 */
function buildTintedScene(scene: Object3D, tint: string): Object3D {
  const clone = SkeletonUtils.clone(scene);
  const tintColor = new Color(tint);
  clone.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    node.material = Array.isArray(node.material)
      ? node.material.map((material) => tintMaterial(material, tintColor))
      : tintMaterial(node.material, tintColor);
  });
  return clone;
}

/**
 * Shared posing capability for SeatAvatar (AvatarModel) and PlacedObject
 * (PropModel) — see docs/design/model-orientation-and-posing.md §9. Applies
 * one of this project's two named poses ("sitting"/"idle") ONLY to a model
 * whose skeleton satisfies the documented, tolerantly-matched bone-role
 * convention (pose.ts's resolvePoseBones); any other model — including
 * every unrigged asset in this repo today — renders through exactly the
 * same plain <Clone> today's static rendering already uses, unchanged,
 * never a partial bind and never a hard failure.
 */
export function PosedClone({ scene, pose, scale, position, rotation, castShadow, tint, onCompatibilityChange }: PosedCloneProps) {
  // Untinted (the overwhelming common case, and every call before A3)
  // passes `scene` straight through, unchanged — byte-for-byte the same
  // object every render, so nothing downstream (memoization, drei's own
  // Clone, resolvePoseBones) sees any different input at all. Only a tinted
  // instance pays for its own independent clone — see buildTintedScene's
  // own doc comment for why this can't just mutate scene's shared materials
  // in place.
  const renderScene = useMemo(() => (tint ? buildTintedScene(scene, tint) : scene), [scene, tint]);
  const resolved = useMemo(() => resolvePoseBones(renderScene), [renderScene]);
  const clip = useMemo(() => (resolved ? buildPoseClip(pose, resolved) : null), [resolved, pose]);
  const clips = useMemo<AnimationClip[]>(() => (clip ? [clip] : []), [clip]);

  const group = useRef<Group>(null);
  const { actions } = useAnimations(clips, group);

  useEffect(() => {
    onCompatibilityChange?.(resolved !== null);
  }, [resolved, onCompatibilityChange]);

  useEffect(() => {
    if (!clip) return;
    const action = actions[clip.name];
    action?.reset().fadeIn(0.3).play();
    return () => {
      action?.fadeOut(0.3);
    };
  }, [actions, clip]);

  if (!clip) {
    // No compatible skeleton (or no skin data at all — every current
    // preset in this repo) — exactly today's static, unposed rendering.
    // Never a partial bind (design doc §9).
    return (
      <Clone
        object={renderScene}
        scale={scale}
        position={position as [number, number, number]}
        rotation={rotation as [number, number, number]}
        castShadow={castShadow}
      />
    );
  }

  return (
    <group ref={group} scale={scale} position={position as [number, number, number]} rotation={rotation as [number, number, number]}>
      <Clone object={renderScene} castShadow={castShadow} />
    </group>
  );
}
