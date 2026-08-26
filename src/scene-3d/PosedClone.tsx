"use client";

import { useEffect, useMemo, useRef } from "react";
import { Clone, useAnimations } from "@react-three/drei";
import type { AnimationClip } from "three";
import type { Group, Object3D } from "three";
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
  /** Verification-only: reports whether this specific model's skeleton
   * satisfied the supported bone-role convention (and is therefore
   * actually posed/animated) — the same "mirror render state into a
   * callback so a caller can expose it to Playwright" precedent as
   * DiceTumbleProps.onQueueChange / MapSurfaceProps.onTokenSlideDebug
   * (WebGL has no DOM for a test to inspect a skeleton directly). Omit it
   * (as most callers do) and nothing about rendering changes. */
  onCompatibilityChange?: (compatible: boolean) => void;
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
export function PosedClone({ scene, pose, scale, position, rotation, castShadow, onCompatibilityChange }: PosedCloneProps) {
  const resolved = useMemo(() => resolvePoseBones(scene), [scene]);
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
        object={scene}
        scale={scale}
        position={position as [number, number, number]}
        rotation={rotation as [number, number, number]}
        castShadow={castShadow}
      />
    );
  }

  return (
    <group ref={group} scale={scale} position={position as [number, number, number]} rotation={rotation as [number, number, number]}>
      <Clone object={scene} castShadow={castShadow} />
    </group>
  );
}
