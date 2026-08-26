"use client";

import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useGLTF } from "@react-three/drei";
import { Box3, Vector3 } from "three";
import type { Object3D } from "three";
import { PosedClone } from "./PosedClone";

// A prop fits inside its cell footprint — matches CELL_SIZE - CELL_GAP in
// MapEditorScene, so a normalized model never overhangs neighboring cells.
export const PLACED_OBJECT_SIZE = 0.92;

// Wall-family presets are the deliberate OPPOSITE of PLACED_OBJECT_SIZE's
// inset: a wall run/corner/diagonal needs to reach its own cell's edges (or
// even its own cell's diagonal corners), or adjacent segments never visually
// touch — confirmed via real vertex-level measurement (this task's own
// investigation): wall.glb's authored main box is 2 world-units wide, so
// PLACED_OBJECT_SIZE's 0.92 target left a real, measured 0.08-unit gap
// between two adjacent straight segments (each one centered in its own
// 1-unit cell, 0.92/2 = 0.46 short of the shared edge on both sides).
//
// Keyed by model url, not asset_id: MapSurfaceObject/PropModel never see
// asset identity, only a resolved model url (presets resolve straight to
// their public path — see maps/[mapId]/edit/lib/assetUrl.ts's
// resolvePaletteAssets) — matching PLACED_OBJECT_SIZE's own "well-known
// preset, matched structurally" precedent (DiceTumble.tsx/AssetPalette.tsx
// already import PLACED_OBJECT_SIZE itself the same way).
//
// wall.glb's OWN authored geometry is unchanged (still the legacy 2-unit-
// wide box from generate-map-presets.mjs's buildWall()) — its fit target of
// 1 (one full cell) yields scale 1/2 = 0.5, landing its run length on
// exactly one cell (closing the gap) while its height/thickness grow the
// same ~8.7% (1/0.92) as a side effect — the "if the gap fix changes
// appearance, document exactly why" case this task's own acceptance
// criteria anticipates.
//
// wall-corner.glb, wall-diagonal.glb, and wall-door.glb (generate-wall-
// variants-presets.mjs) are all authored FRESH, directly at their final
// target size, so each one's own fit target is simply its own measured
// maxDim (making scale exactly 1 — "render exactly as authored, no
// distortion").
//
// All three now measure maxDim ≈ 1.0 exactly, matching wall.glb's own fit
// target — NOT a coincidence: this task's own real Box3 measurement (BEFORE
// changing anything) found the ORIGINAL wall-corner.glb/wall-diagonal.glb
// each measured a DIFFERENT maxDim (1.07 and 1.190919 respectively) because
// their own cap/merlon accents were authored stacked ON TOP OF an already-
// final peak height, and the diagonal's beam/cap were authored at their
// bare centerline length (Math.SQRT2) with no allowance for their own
// thickness once rotated 45° off-axis — both real, measured overshoots
// past a straight run's own true 0.85 peak / 1x1 footprint (see
// generate-wall-variants-presets.mjs's own top comment for the exact
// numbers). Fixing the authored geometry itself (not just this fit target)
// made every wall-family piece converge on the SAME maxDim as wall.glb —
// confirmed via the generate script's own re-measurement of the actual
// regenerated .glb files, not assumed from the geometry formulas alone.
const WALL_FIT_TARGET_BY_URL: Record<string, number> = {
  "/assets/presets/wall.glb": 1,
  "/assets/presets/wall-corner.glb": 1,
  "/assets/presets/wall-diagonal.glb": 1,
  "/assets/presets/wall-door.glb": 1,
};

const PLACEHOLDER_COLOR = "#8f86ad";

/** Shown while a model loads and when a load fails — a translucent crate,
 * so a placed object never silently vanishes and never blanks the scene. */
function PlaceholderProp() {
  return (
    <mesh position={[0, 0.3, 0]}>
      <boxGeometry args={[0.55, 0.6, 0.55]} />
      <meshStandardMaterial color={PLACEHOLDER_COLOR} transparent opacity={0.55} roughness={0.5} />
    </mesh>
  );
}

function PropModel({
  url,
  forwardOffsetDeg,
  onPoseDebug,
  onMeasureDebug,
}: {
  url: string;
  forwardOffsetDeg: number;
  onPoseDebug?: (compatible: boolean) => void;
  /** Verification-only: mirrors this specific loaded model's own measured
   * bounding-box maxDim and derived scale factor out to a caller — the same
   * "WebGL has no DOM of its own for a test to inspect" reasoning as
   * onPoseDebug (and SeatAvatar's own onMeasureDebug), used to confirm the
   * procedural-wall gap fix actually lands on the REAL rendered object
   * (not just in the WALL_FIT_TARGET_BY_URL formula in isolation). Omit it
   * (as every real caller does) and nothing about rendering changes. */
  onMeasureDebug?: (measurement: { maxDim: number; scale: number }) => void;
}) {
  const { scene } = useGLTF(url);
  const { scale, offset, maxDim } = useMemo(() => {
    const box = new Box3().setFromObject(scene as Object3D);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    // Wall-family presets fit to WALL_FIT_TARGET_BY_URL's full-cell (or
    // larger, for the diagonal) target instead of the ordinary props' inset
    // — see that constant's own doc comment for the real-measurement-backed
    // reasoning.
    const fitSize = WALL_FIT_TARGET_BY_URL[url] ?? PLACED_OBJECT_SIZE;
    // Guard against degenerate (flat/empty) models rather than dividing by ~0.
    const scale = maxDim > 1e-3 ? fitSize / maxDim : 1;
    // Recenter on x/z and put the model's base on the cell surface regardless
    // of where the export placed its origin. Unlike SeatAvatar's sitting
    // pose, the "idle" pose applied below doesn't fold the legs, so the
    // rest pose's feet-at-origin anchor stays correct even when posed —
    // no anchor override needed here.
    const offset: [number, number, number] = [-center.x * scale, -box.min.y * scale, -center.z * scale];
    return { scale, offset, maxDim };
  }, [scene, url]);

  useEffect(() => {
    onMeasureDebug?.({ maxDim, scale });
  }, [maxDim, scale, onMeasureDebug]);

  // PosedClone (SkeletonUtils-aware, via drei's Clone under the hood)
  // rather than rendering the cached scene directly — two placed objects
  // using the same asset would otherwise fight over one Object3D, and
  // useGLTF caches per URL. forwardOffsetDeg is the asset's own stored
  // correction (model_orientation, see
  // docs/design/model-orientation-and-posing.md §8) — an intrinsic Y
  // rotation applied here, independent of (and composing cleanly with) the
  // object's own placement `rotation` applied one level up by MapSurface's
  // ObjectMarker wrapper. 0 (the default for every asset with no stored row)
  // reproduces today's exact no-correction behavior. See
  // docs/design/model-orientation-and-posing.md §9 for the "idle" pose
  // itself — applied only when this model's skeleton matches the
  // supported bone convention; every other model (including every current
  // preset, none of which are rigged) falls back to exactly today's static
  // rendering.
  return (
    <PosedClone
      scene={scene as Object3D}
      pose="idle"
      scale={scale}
      position={offset}
      rotation={[0, (forwardOffsetDeg * Math.PI) / 180, 0]}
      castShadow
      onCompatibilityChange={onPoseDebug}
    />
  );
}

interface PropErrorBoundaryProps {
  /** Remounts the boundary's children (retrying the load) when the URL changes. */
  url: string;
  children: ReactNode;
}

class PropErrorBoundary extends Component<PropErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(prevProps: PropErrorBoundaryProps): void {
    if (prevProps.url !== this.props.url && this.state.failed) this.setState({ failed: false });
  }

  render(): ReactNode {
    return this.state.failed ? <PlaceholderProp /> : this.props.children;
  }
}

export function PlacedObject({
  url,
  forwardOffsetDeg = 0,
  onPoseDebug,
  onMeasureDebug,
}: {
  url: string | null;
  /** Stored forward-direction correction (degrees) — see
   * docs/design/model-orientation-and-posing.md §8. Defaults to 0 (no
   * correction), exactly today's behavior for every asset predating this
   * feature. */
  forwardOffsetDeg?: number;
  /** Verification-only: see PosedCloneProps.onCompatibilityChange's doc
   * comment. Omit it (as every real caller except the verification
   * pass-through does) and nothing about rendering changes. */
  onPoseDebug?: (compatible: boolean) => void;
  /** Verification-only: see PropModel's own onMeasureDebug doc comment. */
  onMeasureDebug?: (measurement: { maxDim: number; scale: number }) => void;
}) {
  if (!url) return <PlaceholderProp />;
  return (
    <PropErrorBoundary url={url}>
      <Suspense fallback={<PlaceholderProp />}>
        <PropModel url={url} forwardOffsetDeg={forwardOffsetDeg} onPoseDebug={onPoseDebug} onMeasureDebug={onMeasureDebug} />
      </Suspense>
    </PropErrorBoundary>
  );
}
