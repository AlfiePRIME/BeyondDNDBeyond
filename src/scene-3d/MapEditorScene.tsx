"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { BoxGeometry, EdgesGeometry, MOUSE } from "three";
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

// Tall enough to stay visible around max-elevation terrain (10 steps at
// 0.35 world units each, on a 0.14 slab).
const REGION_MARKER_HEIGHT = 10 * EDITOR_MAP_METRICS.elevationStepHeight + 0.4;

/** A DM-selected rectangle of cells, in grid coordinates. */
export interface EditorRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The selected-region marker: a teal edge outline plus a faint fill so the
// rectangle reads from any camera angle without hiding the cells inside it.
function RegionMarker({
  region,
  gridWidth,
  gridHeight,
}: {
  region: EditorRegion;
  gridWidth: number;
  gridHeight: number;
}) {
  const spanX = region.width * CELL_SIZE;
  const spanZ = region.height * CELL_SIZE;
  const centerX = (region.x + region.width / 2 - 0.5) * CELL_SIZE - ((gridWidth - 1) / 2) * CELL_SIZE;
  const centerZ =
    (region.y + region.height / 2 - 0.5) * CELL_SIZE - ((gridHeight - 1) / 2) * CELL_SIZE;
  const edges = useMemo(() => {
    const box = new BoxGeometry(spanX, REGION_MARKER_HEIGHT, spanZ);
    const geometry = new EdgesGeometry(box);
    box.dispose();
    return geometry;
  }, [spanX, spanZ]);
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <group position={[centerX, REGION_MARKER_HEIGHT / 2, centerZ]}>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={TEAL} transparent opacity={0.85} depthWrite={false} />
      </lineSegments>
      <mesh>
        <boxGeometry args={[spanX, REGION_MARKER_HEIGHT, spanZ]} />
        <meshBasicMaterial color={TEAL} transparent opacity={0.06} depthWrite={false} />
      </mesh>
    </group>
  );
}

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
   * Fired when a left-button stroke ends (pointer released anywhere) — lets
   * the caller finalize stroke-scoped state, e.g. turning the cells touched
   * during a generate-tool drag into a selected region.
   */
  onStrokeEnd?: () => void;
  /**
   * Parallel to onPaintCell but fired only on the initial press, never while
   * dragging across cells — object placement/move are discrete deliberate
   * actions, not strokes, so a drag must not scatter or relocate objects.
   */
  onCellClick?: (x: number, y: number) => void;
  /** A selected rectangle of cells to highlight (the generate-area region);
   * null/absent renders no marker. */
  region?: EditorRegion | null;
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
  onStrokeEnd,
  onCellClick,
  region,
  objects,
  selectedObjectId,
  onSelectObject,
}: MapEditorSceneProps) {
  const onPaintCellRef = useRef(onPaintCell);
  const onStrokeEndRef = useRef(onStrokeEnd);
  const onCellClickRef = useRef(onCellClick);
  const onSelectObjectRef = useRef(onSelectObject);
  useEffect(() => {
    onPaintCellRef.current = onPaintCell;
    onStrokeEndRef.current = onStrokeEnd;
    onCellClickRef.current = onCellClick;
    onSelectObjectRef.current = onSelectObject;
  }, [onPaintCell, onStrokeEnd, onCellClick, onSelectObject]);

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
      if (!paintingRef.current) return;
      paintingRef.current = false;
      onStrokeEndRef.current?.();
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

      {region ? <RegionMarker region={region} gridWidth={gridWidth} gridHeight={gridHeight} /> : null}
    </>
  );
}
