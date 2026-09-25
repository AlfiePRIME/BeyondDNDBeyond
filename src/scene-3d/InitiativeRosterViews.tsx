"use client";

import { Component, Suspense, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { PerspectiveCamera, View, useGLTF } from "@react-three/drei";
import { Box3, Vector3, type Group, type Object3D } from "three";
import { ModelInstance } from "./ModelInstance";
import { RollingDie } from "./DiceTumble";

/**
 * The initiative roster's 3D: ONE WebGL canvas that draws into every row's
 * model and die slot through drei <View>s (browsers cap live WebGL contexts,
 * so a canvas per row wouldn't scale). It must cover the whole viewport:
 * View culls a slot as "offscreen" by comparing its page position against
 * the canvas's height, which assumes the canvas starts at the top-left —
 * a canvas inside the roster card silently dropped every lower row.
 * The DOM layout (names, totals, buttons) lives in the app layer.
 */
export function RosterCanvas({ eventSource }: { eventSource: RefObject<HTMLElement | null> }) {
  return (
    <Canvas
      eventSource={eventSource as RefObject<HTMLElement>}
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 1 }}
      dpr={[1, 2]}
    >
      <View.Port />
    </Canvas>
  );
}

const MODEL_HEIGHT = 1;

function NormalizedModel({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  const { scale, offset } = useMemo(() => {
    const box = new Box3().setFromObject(scene as Object3D);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const s = size.y > 1e-3 ? MODEL_HEIGHT / size.y : 1;
    return { scale: s, offset: [-center.x * s, -box.min.y * s, -center.z * s] as [number, number, number] };
  }, [scene]);
  const turntable = useRef<Group>(null);
  useFrame((_, delta) => {
    if (turntable.current) turntable.current.rotation.y += delta * 0.6;
  });
  return (
    <group ref={turntable}>
      <ModelInstance object={scene} scale={scale} position={offset} />
    </group>
  );
}

/** A broken/missing model shouldn't take the roster down — show nothing. */
class ModelErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** A slowly turning character/creature model, framed head to toe. */
export function RosterModelSlot({ modelUrl, className }: { modelUrl: string; className?: string }) {
  return (
    <View className={className}>
      <PerspectiveCamera makeDefault position={[0, 0.6, 2.3]} fov={32} onUpdate={(c) => c.lookAt(0, 0.5, 0)} />
      <ambientLight intensity={1.4} />
      <directionalLight position={[2, 3, 2]} intensity={2} />
      <ModelErrorBoundary>
        <Suspense fallback={null}>
          <NormalizedModel url={modelUrl} />
        </Suspense>
      </ModelErrorBoundary>
    </View>
  );
}

/** A d20 that tumbles in its own little tray and lands on `result`. */
export function RosterDieSlot({ rollId, result, className }: { rollId: string; result: number; className?: string }) {
  return (
    <View className={className}>
      <PerspectiveCamera makeDefault position={[0, 0.78, 0.34]} fov={34} onUpdate={(c) => c.lookAt(0, 0.05, 0)} />
      <ambientLight intensity={1.2} />
      <directionalLight position={[1, 3, 2]} intensity={2.2} />
      <RollingDie key={rollId} rollId={rollId} sides={20} result={result} scale={0.3} showBadge={false} />
    </View>
  );
}
