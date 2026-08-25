"use client";

import { Component, Suspense, useMemo, type ReactNode } from "react";
import { Clone, useGLTF } from "@react-three/drei";
import { Box3, Vector3 } from "three";
import type { Object3D } from "three";

// A prop fits inside its cell footprint — matches CELL_SIZE - CELL_GAP in
// MapEditorScene, so a normalized model never overhangs neighboring cells.
export const PLACED_OBJECT_SIZE = 0.92;

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

function PropModel({ url, forwardOffsetDeg }: { url: string; forwardOffsetDeg: number }) {
  const { scene } = useGLTF(url);
  const { scale, offset } = useMemo(() => {
    const box = new Box3().setFromObject(scene as Object3D);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    // Guard against degenerate (flat/empty) models rather than dividing by ~0.
    const scale = maxDim > 1e-3 ? PLACED_OBJECT_SIZE / maxDim : 1;
    // Recenter on x/z and put the model's base on the cell surface regardless
    // of where the export placed its origin.
    const offset: [number, number, number] = [-center.x * scale, -box.min.y * scale, -center.z * scale];
    return { scale, offset };
  }, [scene]);

  // Clone (SkeletonUtils-aware) rather than rendering the cached scene
  // directly — two placed objects using the same asset would otherwise fight
  // over one Object3D, and useGLTF caches per URL. forwardOffsetDeg is the
  // asset's own stored correction (model_orientation, see
  // docs/design/model-orientation-and-posing.md §8) — an intrinsic Y
  // rotation applied here, independent of (and composing cleanly with) the
  // object's own placement `rotation` applied one level up by MapSurface's
  // ObjectMarker wrapper. 0 (the default for every asset with no stored row)
  // reproduces today's exact no-correction behavior.
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
}: {
  url: string | null;
  /** Stored forward-direction correction (degrees) — see
   * docs/design/model-orientation-and-posing.md §8. Defaults to 0 (no
   * correction), exactly today's behavior for every asset predating this
   * feature. */
  forwardOffsetDeg?: number;
}) {
  if (!url) return <PlaceholderProp />;
  return (
    <PropErrorBoundary url={url}>
      <Suspense fallback={<PlaceholderProp />}>
        <PropModel url={url} forwardOffsetDeg={forwardOffsetDeg} />
      </Suspense>
    </PropErrorBoundary>
  );
}
