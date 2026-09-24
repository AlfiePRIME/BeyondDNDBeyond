"use client";

import { forwardRef, useMemo } from "react";
import { Mesh, type Object3D } from "three";
import { SkeletonUtils } from "three-stdlib";

/**
 * A per-instance copy of a cached glTF scene, mounted as ONE <primitive>.
 *
 * Replaces drei's <Clone> everywhere in this project. drei's Clone rebuilds
 * every non-bone node as JSX but mounts a rigged model's Bone objects as
 * `<primitive object={bone}>` children of those NEW JSX nodes — which
 * re-parents each bone out of the memoized clone's own `children` array. On
 * the component's next render, `object.children.map(...)` no longer sees the
 * bones, React unmounts their primitives, and R3F removes them from the scene
 * entirely. A SkinnedMesh draws from its bones' matrixWorld, so from that
 * moment the rigged body freezes wherever it was while everything else on
 * the token (disc, HP bar, hitbox) keeps moving — the long-standing "custom
 * pawn model stops following its token after the first move" bug. Unrigged
 * models have no Bone children, which is why presets never showed it.
 *
 * SkeletonUtils.clone shares geometry and materials exactly like Clone did
 * (Object3D.clone never deep-copies those), so memory use is unchanged.
 */
export const ModelInstance = forwardRef<
  Object3D,
  {
    object: Object3D;
    /** Set when the caller already built its own private clone (e.g. a
     * tinted copy) — skips the second clone. */
    alreadyCloned?: boolean;
    castShadow?: boolean;
    receiveShadow?: boolean;
    scale?: number;
    position?: [number, number, number];
    rotation?: [number, number, number];
  }
>(function ModelInstance({ object, alreadyCloned, castShadow, receiveShadow, scale, position, rotation }, ref) {
  const instance = useMemo(() => {
    const copy = alreadyCloned ? object : SkeletonUtils.clone(object);
    copy.traverse((node) => {
      if ((node as Mesh).isMesh) {
        node.castShadow = !!castShadow;
        node.receiveShadow = !!receiveShadow;
      }
    });
    return copy;
  }, [object, alreadyCloned, castShadow, receiveShadow]);

  // Only forward transforms the caller actually set — an explicit
  // `undefined` would make R3F reset the instance's own transform.
  const transform: Record<string, unknown> = {};
  if (scale !== undefined) transform.scale = scale;
  if (position !== undefined) transform.position = position;
  if (rotation !== undefined) transform.rotation = rotation;
  return <primitive ref={ref} object={instance} {...transform} />;
});
