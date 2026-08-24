"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { MOUSE } from "three";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import {
  EDITOR_MAP_METRICS,
  MapSurface,
  type MapSurfaceCell,
  type MapSurfaceObject,
} from "./MapSurface";

// Palette mirrored from the app's design tokens (src/ui-components/tokens.css)
// — same hex-mirroring reasoning as GameTableScene.
const ROOM_BG = "#0d0520"; // --surface2
const PURPLE = "#9b00ff"; // --purple
const TEAL = "#1ec8c8"; // --teal
const GROUND = "#1a1338";

const CELL_SIZE = EDITOR_MAP_METRICS.cellSize;

export interface MapEditorSceneProps {
  gridWidth: number;
  gridHeight: number;
  /** Full dense grid — one entry per cell; the caller overlays sparse
   * storage onto defaults before passing it in (scene-3d can't fetch). */
  cells: readonly MapSurfaceCell[];
  /**
   * Fired at most once per cell per left-button stroke (a click, or a drag
   * sweeping across cells). What "painting" means — raise, lower, terrain —
   * is the caller's tool state, not the scene's.
   */
  onPaintCell?: (x: number, y: number) => void;
  /**
   * Parallel to onPaintCell but fired only on the initial press, never while
   * dragging across cells — object placement/move are discrete deliberate
   * actions, not strokes, so a drag must not scatter or relocate objects.
   */
  onCellClick?: (x: number, y: number) => void;
  /** Placed objects to render; absent/empty renders none. */
  objects?: readonly MapSurfaceObject[];
  selectedObjectId?: string | null;
  /** When provided, placed objects become click targets that intercept the
   * cell beneath; when absent they're inert and clicks fall through to the
   * cell, so sculpt tools still paint occupied cells. */
  onSelectObject?: (id: string) => void;
}

export function MapEditorScene({
  gridWidth,
  gridHeight,
  cells,
  onPaintCell,
  onCellClick,
  objects,
  selectedObjectId,
  onSelectObject,
}: MapEditorSceneProps) {
  const onPaintCellRef = useRef(onPaintCell);
  const onCellClickRef = useRef(onCellClick);
  const onSelectObjectRef = useRef(onSelectObject);
  useEffect(() => {
    onPaintCellRef.current = onPaintCell;
    onCellClickRef.current = onCellClick;
    onSelectObjectRef.current = onSelectObject;
  }, [onPaintCell, onCellClick, onSelectObject]);

  const paintingRef = useRef(false);
  // One application per cell per stroke: without this, a drag lingering on
  // a cell (or crossing it twice) would raise it repeatedly.
  const strokeRef = useRef<Set<string>>(new Set());

  const paint = useCallback((x: number, y: number) => {
    const key = `${x},${y}`;
    if (strokeRef.current.has(key)) return;
    strokeRef.current.add(key);
    onPaintCellRef.current?.(x, y);
  }, []);

  const handleDown = useCallback(
    (x: number, y: number, event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      paintingRef.current = true;
      strokeRef.current = new Set();
      paint(x, y);
      onCellClickRef.current?.(x, y);
    },
    [paint]
  );

  const handleSelectObject = useCallback((id: string) => {
    onSelectObjectRef.current?.(id);
  }, []);

  const handleOver = useCallback(
    (x: number, y: number, event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      if (!paintingRef.current) return;
      paint(x, y);
    },
    [paint]
  );

  // The stroke can end anywhere — off the grid, off the canvas — so the
  // pointerup listener lives on window, not on the meshes.
  useEffect(() => {
    const endStroke = () => {
      paintingRef.current = false;
    };
    window.addEventListener("pointerup", endStroke);
    return () => window.removeEventListener("pointerup", endStroke);
  }, []);

  const span = Math.max(gridWidth, gridHeight) * CELL_SIZE;
  const cameraPosition = useMemo<[number, number, number]>(
    () => [0, span * 0.95 + 3, span * 0.55 + 2.5],
    [span]
  );

  return (
    <>
      <PerspectiveCamera makeDefault position={cameraPosition} fov={45} />
      {/* Left button is reserved for painting, so orbiting moves to the
          right button (pan on middle, zoom on wheel) — sculpting and camera
          control never fight over the same gesture. */}
      <OrbitControls
        target={[0, 0, 0]}
        mouseButtons={{ MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }}
        minDistance={3}
        maxDistance={span * 2.5 + 12}
        maxPolarAngle={Math.PI / 2 - 0.08}
      />

      <color attach="background" args={[ROOM_BG]} />

      <ambientLight color="#b9a6ff" intensity={0.7} />
      <directionalLight color="#ffe9c9" intensity={2.6} position={[8, 14, 6]} />
      <pointLight color={PURPLE} intensity={250} position={[-span, span * 0.5 + 4, -span]} distance={span * 6} />
      <pointLight color={TEAL} intensity={180} position={[span, span * 0.5 + 3, span]} distance={span * 6} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <circleGeometry args={[span * 1.6, 48]} />
        <meshStandardMaterial color={GROUND} roughness={0.95} />
      </mesh>

      <MapSurface
        gridWidth={gridWidth}
        gridHeight={gridHeight}
        cells={cells}
        objects={objects}
        selectedObjectId={selectedObjectId}
        onSelectObject={onSelectObject ? handleSelectObject : undefined}
        onCellPointerDown={handleDown}
        onCellPointerOver={handleOver}
      />
    </>
  );
}
