"use client";

import { memo, useState } from "react";
import { Color } from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { TerrainType } from "@/rules-engine";
import { PlacedObject, PLACED_OBJECT_SIZE } from "./PlacedObject";

// Palette mirrored from the app's design tokens (src/ui-components/tokens.css)
// — same hex-mirroring reasoning as GameTableScene.
const PURPLE = "#9b00ff"; // --purple
const TEAL = "#1ec8c8"; // --teal

// Terrain reads by hue (cool slate = normal, warm amber = difficult), not
// just brightness — elevation already owns the light/dark axis below.
const NORMAL_BASE = "#463a70";
const NORMAL_HIGH = "#cfc4ff";
const DIFFICULT_BASE = "#a85a24";
const DIFFICULT_HIGH = "#ffd9a0";

const CELL_GAP_RATIO = 0.08;

// Stable stand-in for an absent onSelectObject — an inline fallback would be
// a fresh function every render and defeat ObjectMarker's memo.
const NOOP_SELECT = () => undefined;

/**
 * World-unit sizing for one rendered map: how big a cell is, how thick the
 * elevation-0 slab is, and how much height one elevation step adds. The
 * editor renders at the fixed unit metrics below; the game table computes a
 * fitted set per map (see mapFit.ts) so any grid lands on the same tabletop.
 */
export interface MapSurfaceMetrics {
  cellSize: number;
  baseHeight: number;
  elevationStepHeight: number;
}

export const EDITOR_MAP_METRICS: MapSurfaceMetrics = {
  cellSize: 1,
  baseHeight: 0.14,
  elevationStepHeight: 0.35,
};

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

export interface MapSurfaceCell {
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
  height: number;
  span: number;
  elevation: number;
  terrain: TerrainType;
  onDown?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
  onOver?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
}

// Memoized on primitive props so a single-cell edit re-renders one block,
// not the whole grid. Pointer handlers are attached only when the caller
// provides them — a handler-less mesh is skipped by r3f's raycaster, so the
// non-interactive table rendering pays no per-pointer-move cost.
const CellBlock = memo(function CellBlock({
  x,
  y,
  worldX,
  worldZ,
  height,
  span,
  elevation,
  terrain,
  onDown,
  onOver,
}: CellBlockProps) {
  const [hovered, setHovered] = useState(false);
  const interactive = Boolean(onDown ?? onOver);
  return (
    <mesh
      position={[worldX, height / 2, worldZ]}
      onPointerDown={onDown ? (event) => onDown(x, y, event) : undefined}
      onPointerOver={
        interactive
          ? (event) => {
              setHovered(true);
              onOver?.(x, y, event);
            }
          : undefined
      }
      onPointerOut={interactive ? () => setHovered(false) : undefined}
    >
      <boxGeometry args={[span, height, span]} />
      <meshStandardMaterial
        color={cellColor(terrain, elevation)}
        emissive={TEAL}
        emissiveIntensity={hovered ? 0.4 : 0}
        roughness={0.65}
      />
    </mesh>
  );
});

export interface MapSurfaceObject {
  id: string;
  x: number;
  y: number;
  /** The cell's current elevation in steps — the caller derives it from the
   * same overlay the cells render from, so props ride the sculpted surface. */
  elevation: number;
  /** Degrees around the vertical axis. */
  rotation: number;
  /** Loadable model URL, or null to render the placeholder prop. */
  url: string | null;
  /** false keeps this object inert even when onSelectObject is provided —
   * the live viewer uses it so only triggerable objects are click targets. */
  selectable?: boolean;
  /** Renders a hidden-object outline instead of the model — the DM's view
   * of an object that players currently can't see at all. */
  ghost?: boolean;
  /** Shows an activation beacon above the model (a switched-on object). */
  active?: boolean;
}

interface ObjectMarkerProps {
  id: string;
  worldX: number;
  worldZ: number;
  topY: number;
  scale: number;
  rotation: number;
  url: string | null;
  selected: boolean;
  selectable: boolean;
  ghost: boolean;
  active: boolean;
  onSelect: (id: string, event: ThreeEvent<PointerEvent>) => void;
}

// The invisible hit box exists because raycasting against the glTF's own
// meshes makes thin or holey props (torch, door frame) nearly unclickable —
// the box gives every object a uniform, cell-sized click target.
const HIT_BOX_HEIGHT = 0.9;

// Beacon color mirrors DIFFICULT_HIGH's warm family on purpose: "switched
// on" needs to read against both the cool cell palette and any model color.
const BEACON_COLOR = "#ffbf47";

// The whole marker group scales uniformly with cell size, so a normalized
// prop keeps the same fit-inside-its-cell proportions at any footprint.
const ObjectMarker = memo(function ObjectMarker({
  id,
  worldX,
  worldZ,
  topY,
  scale,
  rotation,
  url,
  selected,
  selectable,
  ghost,
  active,
  onSelect,
}: ObjectMarkerProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <group
      position={[worldX, topY, worldZ]}
      rotation={[0, (rotation * Math.PI) / 180, 0]}
      scale={scale}
    >
      {ghost ? (
        <mesh position={[0, HIT_BOX_HEIGHT / 2, 0]}>
          <boxGeometry args={[PLACED_OBJECT_SIZE * 0.7, HIT_BOX_HEIGHT * 0.7, PLACED_OBJECT_SIZE * 0.7]} />
          <meshBasicMaterial wireframe color={PURPLE} transparent opacity={0.45} />
        </mesh>
      ) : (
        <PlacedObject url={url} />
      )}
      {active ? (
        <mesh position={[0, HIT_BOX_HEIGHT + 0.22, 0]}>
          <sphereGeometry args={[0.11, 16, 16]} />
          <meshBasicMaterial color={BEACON_COLOR} />
        </mesh>
      ) : null}
      {selectable ? (
        <mesh
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            onSelect(id, event);
          }}
          onPointerOver={(event) => {
            event.stopPropagation();
            setHovered(true);
          }}
          onPointerOut={() => setHovered(false)}
          position={[0, HIT_BOX_HEIGHT / 2, 0]}
        >
          <boxGeometry args={[PLACED_OBJECT_SIZE, HIT_BOX_HEIGHT, PLACED_OBJECT_SIZE]} />
          {/* opacity-0 rather than visible={false}: an invisible mesh is
              skipped by the raycaster, which would defeat the hit box. */}
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ) : null}
      {selected || (selectable && hovered) ? (
        <mesh position={[0, HIT_BOX_HEIGHT / 2, 0]}>
          <boxGeometry args={[PLACED_OBJECT_SIZE + 0.03, HIT_BOX_HEIGHT, PLACED_OBJECT_SIZE + 0.03]} />
          <meshBasicMaterial wireframe color={TEAL} transparent opacity={selected ? 0.9 : 0.3} />
        </mesh>
      ) : null}
    </group>
  );
});

export interface MapSurfaceProps {
  gridWidth: number;
  gridHeight: number;
  /** Full dense grid — one entry per cell; the caller overlays sparse
   * storage onto defaults before passing it in (scene-3d can't fetch). */
  cells: readonly MapSurfaceCell[];
  /** Defaults to the editor's unit metrics; the game table passes a fitted
   * set so the map lands on the physical tabletop's footprint. */
  metrics?: MapSurfaceMetrics;
  /** Placed objects to render; absent/empty renders none. */
  objects?: readonly MapSurfaceObject[];
  selectedObjectId?: string | null;
  /** When provided, placed objects become click targets that intercept the
   * cell beneath; when absent they're inert and clicks fall through to the
   * cell, so sculpt tools still paint occupied cells. */
  onSelectObject?: (id: string, event: ThreeEvent<PointerEvent>) => void;
  /** Raw per-cell pointer hooks — stroke semantics (paint dedup, click vs
   * drag) stay in the editor scene, not here. Omit both for an inert map. */
  onCellPointerDown?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
  onCellPointerOver?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
}

/**
 * The one shared renderer for a map's cell blocks and placed objects — the
 * full-screen editor and the miniature on the game table both draw through
 * this, wrapping it with their own camera/lighting/interaction context, so
 * the two contexts can't drift apart visually.
 */
export function MapSurface({
  gridWidth,
  gridHeight,
  cells,
  metrics = EDITOR_MAP_METRICS,
  objects,
  selectedObjectId,
  onSelectObject,
  onCellPointerDown,
  onCellPointerOver,
}: MapSurfaceProps) {
  const { cellSize, baseHeight, elevationStepHeight } = metrics;
  const offsetX = ((gridWidth - 1) / 2) * cellSize;
  const offsetZ = ((gridHeight - 1) / 2) * cellSize;
  const span = cellSize * (1 - CELL_GAP_RATIO);

  return (
    <>
      {cells.map((cell) => (
        <CellBlock
          key={`${cell.x},${cell.y}`}
          x={cell.x}
          y={cell.y}
          worldX={cell.x * cellSize - offsetX}
          worldZ={cell.y * cellSize - offsetZ}
          height={baseHeight + cell.elevation * elevationStepHeight}
          span={span}
          elevation={cell.elevation}
          terrain={cell.terrain}
          onDown={onCellPointerDown}
          onOver={onCellPointerOver}
        />
      ))}

      {objects?.map((object) => (
        <ObjectMarker
          key={object.id}
          id={object.id}
          worldX={object.x * cellSize - offsetX}
          worldZ={object.y * cellSize - offsetZ}
          topY={baseHeight + object.elevation * elevationStepHeight}
          scale={cellSize}
          rotation={object.rotation}
          url={object.url}
          selected={object.id === selectedObjectId}
          selectable={Boolean(onSelectObject) && object.selectable !== false}
          ghost={object.ghost ?? false}
          active={object.active ?? false}
          onSelect={onSelectObject ?? NOOP_SELECT}
        />
      ))}
    </>
  );
}
