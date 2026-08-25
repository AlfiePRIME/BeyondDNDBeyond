"use client";

import { Component, Suspense, useMemo, type ReactNode } from "react";
import { Clone, useGLTF } from "@react-three/drei";
import { Box3, Vector3 } from "three";
import type { Object3D } from "three";

// Matches the generated presets' natural height, so a custom upload of any
// raw size ends up the same stature as everyone else at the table. Exported
// so the account/campaign upload flows' rotate-and-confirm preview
// (ModelOrientationStep/OrientationPreview) normalizes a candidate avatar
// upload at the exact same scale it will actually render at.
export const AVATAR_HEIGHT = 1.7;

const PLACEHOLDER_COLOR = "#8f86ad";

/**
 * Rendered when a member has no avatar selected, while a model is still
 * loading, and when a load fails — a translucent "ghost" mannequin, so an
 * occupied seat never looks empty and never blanks the scene.
 */
function PlaceholderAvatar() {
  return (
    <group>
      <mesh position={[0, 0.75, 0]} castShadow>
        <capsuleGeometry args={[0.26, 0.75, 6, 16]} />
        <meshStandardMaterial color={PLACEHOLDER_COLOR} transparent opacity={0.55} roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.5, 0]} castShadow>
        <sphereGeometry args={[0.18, 16, 12]} />
        <meshStandardMaterial color={PLACEHOLDER_COLOR} transparent opacity={0.55} roughness={0.5} />
      </mesh>
    </group>
  );
}

function AvatarModel({ url, forwardOffsetDeg }: { url: string; forwardOffsetDeg: number }) {
  const { scene } = useGLTF(url);
  const { scale, offset } = useMemo(() => {
    const box = new Box3().setFromObject(scene as Object3D);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    // Guard against degenerate (flat/empty) models rather than dividing by ~0.
    const scale = size.y > 1e-3 ? AVATAR_HEIGHT / size.y : 1;
    // Recenter on x/z and put the model's feet on the ground regardless of
    // where the export placed its origin.
    const offset: [number, number, number] = [-center.x * scale, -box.min.y * scale, -center.z * scale];
    return { scale, offset };
  }, [scene]);

  // Clone (SkeletonUtils-aware) rather than rendering the cached scene
  // directly — two members with the same preset would otherwise fight over
  // one Object3D, and useGLTF caches per URL. forwardOffsetDeg is the
  // model's own stored correction (model_orientation, see
  // docs/design/model-orientation-and-posing.md §8) — an intrinsic Y
  // rotation applied here, independent of (and composing cleanly with) the
  // seat's own extrinsic rotationY applied one level up by GameTableScene's
  // TableSeat wrapper. 0 (the default for every avatar with no stored row)
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

interface AvatarErrorBoundaryProps {
  /** Remounts the boundary's children (retrying the load) when the URL changes. */
  url: string;
  children: ReactNode;
}

class AvatarErrorBoundary extends Component<AvatarErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(prevProps: AvatarErrorBoundaryProps): void {
    if (prevProps.url !== this.props.url && this.state.failed) this.setState({ failed: false });
  }

  render(): ReactNode {
    return this.state.failed ? <PlaceholderAvatar /> : this.props.children;
  }
}

export function SeatAvatar({
  url,
  forwardOffsetDeg = 0,
}: {
  url: string | null;
  /** Stored forward-direction correction (degrees) — see
   * docs/design/model-orientation-and-posing.md §8. Defaults to 0 (no
   * correction), exactly today's behavior for every avatar predating this
   * feature. */
  forwardOffsetDeg?: number;
}) {
  if (!url) return <PlaceholderAvatar />;
  return (
    <AvatarErrorBoundary url={url}>
      <Suspense fallback={<PlaceholderAvatar />}>
        <AvatarModel url={url} forwardOffsetDeg={forwardOffsetDeg} />
      </Suspense>
    </AvatarErrorBoundary>
  );
}
