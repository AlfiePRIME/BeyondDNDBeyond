"use client";

import { Component, Suspense, useMemo, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { Clone, OrbitControls, useGLTF } from "@react-three/drei";
import { Box3, Vector3 } from "three";
import type { Object3D } from "three";

// Reuses the app's teal accent (src/ui-components/tokens.css) — scene-3d
// can't import CSS custom properties, same hex-mirroring reasoning as
// GameTableScene/MapSurface/Chair.
const TEAL = "#1ec8c8";
const GROUND_COLOR = "#2a2140";

/**
 * How to scale/recenter the candidate upload for preview — must match
 * whichever of AvatarModel's (SeatAvatar.tsx) or PropModel's
 * (PlacedObject.tsx) two normalization conventions the upload will actually
 * render under, so the rotate-and-confirm step (ModelOrientationStep) shows
 * exactly what the table/map will show.
 */
export type ModelNormalize =
  | { kind: "height"; targetHeight: number }
  | { kind: "maxDimension"; targetSize: number };

function normalizeModel(scene: Object3D, normalize: ModelNormalize): { scale: number; offset: [number, number, number] } {
  const box = new Box3().setFromObject(scene);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const scale =
    normalize.kind === "height"
      ? size.y > 1e-3
        ? normalize.targetHeight / size.y
        : 1
      : Math.max(size.x, size.y, size.z) > 1e-3
        ? normalize.targetSize / Math.max(size.x, size.y, size.z)
        : 1;
  // Recenter on x/z and put the model's lowest point at the local origin's
  // y=0 — the exact AvatarModel/PropModel convention, so the preview's feet/
  // base lands on this scene's ground plane the same way it will at the
  // table/on the map.
  const offset: [number, number, number] = [-center.x * scale, -box.min.y * scale, -center.z * scale];
  return { scale, offset };
}

function PreviewModel({
  url,
  normalize,
  forwardOffsetDeg,
}: {
  url: string;
  normalize: ModelNormalize;
  forwardOffsetDeg: number;
}) {
  const { scene } = useGLTF(url);
  const { scale, offset } = useMemo(() => normalizeModel(scene as Object3D, normalize), [scene, normalize]);

  return (
    <Clone
      object={scene}
      scale={scale}
      position={offset}
      rotation={[0, (forwardOffsetDeg * Math.PI) / 180, 0]}
      castShadow
    />
  );
}

// A flat arrow lying on the ground pointing along local -Z — this project's
// established "forward" convention (see Chair.tsx: "local -Z is the seat's
// facing direction"). Reference-only: fixed in the scene regardless of the
// uploader's rotate nudges, so it stays a stable target to rotate the model
// toward.
function ForwardMarker() {
  return (
    <group position={[0, 0.002, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -0.32]}>
        <planeGeometry args={[0.07, 0.45]} />
        <meshBasicMaterial color={TEAL} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, Math.PI]} position={[0, 0, -0.6]}>
        <coneGeometry args={[0.13, 0.2, 3]} />
        <meshBasicMaterial color={TEAL} />
      </mesh>
    </group>
  );
}

/** Falls back to an empty preview (no crash) if the candidate file somehow
 * fails to load a second time through drei's GLTFLoader — vanishingly
 * unlikely, since validateGlbFile already parsed these exact bytes with the
 * same loader before this step ever renders, but this step must never be
 * the thing that blocks an upload (see the design doc's §8 "never blocks an
 * upload" requirement) even in that pathological case. Skip/Confirm both
 * stay usable either way. */
class PreviewErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export interface OrientationPreviewProps {
  /** Object URL for the candidate upload (URL.createObjectURL(file)) — the
   * caller owns creating/revoking it. */
  url: string;
  normalize: ModelNormalize;
  /** Fully controlled — the parent owns the rotate-nudge state and passes
   * the current value down, the same controlled-prop convention MapSurface
   * uses for its own object rotations. */
  forwardOffsetDeg: number;
}

/**
 * Live preview for the upload rotate-and-confirm step
 * (docs/design/model-orientation-and-posing.md §8): renders the candidate
 * model with the exact scale/recenter math it will actually render under,
 * against a fixed ground-plane arrow marking "this way is forward", so the
 * uploader has a stable, correctly-scaled reference to rotate against.
 * OrbitControls lets the uploader look the model over from any angle while
 * deciding — it only orbits the camera, never the model's own stored
 * rotation.
 */
export function OrientationPreview({ url, normalize, forwardOffsetDeg }: OrientationPreviewProps) {
  return (
    <Canvas camera={{ position: [1.7, 1.4, 1.9], fov: 40 }} dpr={[1, 2]}>
      <ambientLight intensity={0.7} color="#b9a6ff" />
      <directionalLight position={[3, 5, 2]} intensity={1.8} />
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1, 32]} />
        <meshStandardMaterial color={GROUND_COLOR} roughness={0.9} />
      </mesh>
      <ForwardMarker />
      <PreviewErrorBoundary>
        <Suspense fallback={null}>
          <PreviewModel url={url} normalize={normalize} forwardOffsetDeg={forwardOffsetDeg} />
        </Suspense>
      </PreviewErrorBoundary>
      <OrbitControls enablePan={false} minDistance={0.8} maxDistance={5} target={[0, 0.4, 0]} />
    </Canvas>
  );
}
