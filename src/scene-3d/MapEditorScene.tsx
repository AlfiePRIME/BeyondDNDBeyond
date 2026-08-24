"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Color, MOUSE } from "three";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import type { TerrainType } from "@/rules-engine";

// Palette mirrored from the app's design tokens (src/ui-components/tokens.css)
// — same hex-mirroring reasoning as GameTableScene.
const ROOM_BG = "#0d0520"; // --surface2
const PURPLE = "#9b00ff"; // --purple
const TEAL = "#1ec8c8"; // --teal
const GROUND = "#1a1338";

// Terrain reads by hue (cool slate = normal, warm amber = difficult), not
// just brightness — elevation already owns the light/dark axis below.
const NORMAL_BASE = "#463a70";
const NORMAL_HIGH = "#cfc4ff";
const DIFFICULT_BASE = "#a85a24";
const DIFFICULT_HIGH = "#ffd9a0";

export const CELL_SIZE = 1;
const CELL_GAP = 0.08;
const BASE_HEIGHT = 0.14;
export const ELEVATION_STEP_HEIGHT = 0.35;

const colorCache = new Map<string, string>();

function cellColor(terrain: TerrainType, elevation: number): string {
  const key = `${terrain}:${elevation}`;
  let hex = colorCache.get(key);
  if (!hex) {
    const [base, high] =
      terrain === "difficult" ? [DIFFICULT_BASE, DIFFICULT_HIGH] : [NORMAL_BASE, NORMAL_HIGH];
    // Each step also lightens the block so distinct elevations stay
    // distinguishable even from directly overhead, where extruded height
    // alone is invisible.
    hex = `#${new Color(base).lerp(new Color(high), Math.min(elevation * 0.11, 0.66)).getHexString()}`;
    colorCache.set(key, hex);
  }
  return hex;
}

export interface MapEditorCell {
  x: number;
  y: number;
  elevation: number;
  terrain: TerrainType;
}

interface CellBlockProps {
  x: number;
  y: number;
  worldX: number;
  worldZ: number;
  elevation: number;
  terrain: TerrainType;
  onDown: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
  onOver: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
}

// Memoized on primitive props so a single-cell edit re-renders one block,
// not the whole grid.
const CellBlock = memo(function CellBlock({
  x,
  y,
  worldX,
  worldZ,
  elevation,
  terrain,
  onDown,
  onOver,
}: CellBlockProps) {
  const [hovered, setHovered] = useState(false);
  const height = BASE_HEIGHT + elevation * ELEVATION_STEP_HEIGHT;
  return (
    <mesh
      position={[worldX, height / 2, worldZ]}
      onPointerDown={(event) => onDown(x, y, event)}
      onPointerOver={(event) => {
        setHovered(true);
        onOver(x, y, event);
      }}
      onPointerOut={() => setHovered(false)}
    >
      <boxGeometry args={[CELL_SIZE - CELL_GAP, height, CELL_SIZE - CELL_GAP]} />
      <meshStandardMaterial
        color={cellColor(terrain, elevation)}
        emissive={TEAL}
        emissiveIntensity={hovered ? 0.4 : 0}
        roughness={0.65}
      />
    </mesh>
  );
});

export interface MapEditorSceneProps {
  gridWidth: number;
  gridHeight: number;
  /** Full dense grid — one entry per cell; the caller overlays sparse
   * storage onto defaults before passing it in (scene-3d can't fetch). */
  cells: readonly MapEditorCell[];
  /**
   * Fired at most once per cell per left-button stroke (a click, or a drag
   * sweeping across cells). What "painting" means — raise, lower, terrain —
   * is the caller's tool state, not the scene's.
   */
  onPaintCell?: (x: number, y: number) => void;
}

export function MapEditorScene({ gridWidth, gridHeight, cells, onPaintCell }: MapEditorSceneProps) {
  const onPaintCellRef = useRef(onPaintCell);
  useEffect(() => {
    onPaintCellRef.current = onPaintCell;
  }, [onPaintCell]);

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
    },
    [paint]
  );

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

  const offsetX = ((gridWidth - 1) / 2) * CELL_SIZE;
  const offsetZ = ((gridHeight - 1) / 2) * CELL_SIZE;

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

      {cells.map((cell) => (
        <CellBlock
          key={`${cell.x},${cell.y}`}
          x={cell.x}
          y={cell.y}
          worldX={cell.x * CELL_SIZE - offsetX}
          worldZ={cell.y * CELL_SIZE - offsetZ}
          elevation={cell.elevation}
          terrain={cell.terrain}
          onDown={handleDown}
          onOver={handleOver}
        />
      ))}
    </>
  );
}
