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

function PropModel({ url }: { url: string }) {
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
  // over one Object3D, and useGLTF caches per URL.
  return <Clone object={scene} scale={scale} position={offset} castShadow />;
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

export function PlacedObject({ url }: { url: string | null }) {
  if (!url) return <PlaceholderProp />;
  return (
    <PropErrorBoundary url={url}>
      <Suspense fallback={<PlaceholderProp />}>
        <PropModel url={url} />
      </Suspense>
    </PropErrorBoundary>
  );
}
