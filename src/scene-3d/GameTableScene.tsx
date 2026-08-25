"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OrbitControls, PerspectiveCamera, RoundedBox } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { LEG, TABLE_TOP, TABLE_SURFACE_Y } from "./table";
import { computeSeatLayout, type CameraMode, type Seat, type SeatMember } from "./seating";
import { SeatAvatar } from "./SeatAvatar";
import {
  MapSurface,
  type MapSurfaceCell,
  type MapSurfaceObject,
  type MapSurfaceToken,
} from "./MapSurface";
import { computeTableMapMetrics } from "./mapFit";

// Room ambiance pulls from the app's design tokens (see
// src/ui-components/tokens.css) — scene-3d can't import CSS custom
// properties, so the hex values are mirrored here.
const ROOM_BG = "#0d0520"; // --surface2
const PURPLE = "#9b00ff"; // --purple
const TEAL = "#1ec8c8"; // --teal

// The tabletop stays naturalistic dark walnut (not neon) so future maps and
// tokens rendered on top of it stay legible — the palette accents live in
// the room lighting instead.
const WOOD_TOP = "#5a4028";
const WOOD_LEG = "#42301c";

const CUSHION = "#2a2140";
const LOOK_TARGET = [0, TABLE_SURFACE_Y, 0] as const;
const FALLBACK_CAMERA_POSITION: readonly [number, number, number] = [0, 10.5, 7.5];

function TableLeg({ x, z }: { x: number; z: number }) {
  return (
    <mesh position={[x, LEG.height / 2, z]} castShadow>
      <cylinderGeometry args={[LEG.radius, LEG.radius * 1.35, LEG.height, 12]} />
      <meshStandardMaterial color={WOOD_LEG} roughness={0.8} />
    </mesh>
  );
}

// The Prompt 19 stool is gone — an avatar standing on a low dais with the
// role-colored ring around its feet reads cleaner than a model clipping
// through a stool.
function TableSeat({ seat }: { seat: Seat }) {
  const accent = seat.member.role === "dm" ? PURPLE : TEAL;
  return (
    <group position={seat.position} rotation={[0, seat.rotationY, 0]}>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <cylinderGeometry args={[0.5, 0.56, 0.04, 24]} />
        <meshStandardMaterial color={CUSHION} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.045, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.5, 0.028, 10, 40]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.7} />
      </mesh>
      <group position={[0, 0.04, 0]}>
        <SeatAvatar url={seat.member.avatar_url ?? null} />
      </group>
    </group>
  );
}

/** The currently-live map, already resolved to renderable form by the app
 * layer (dense cells, viewer-appropriate object flags, loadable URLs). */
export interface TableLiveMap {
  gridWidth: number;
  gridHeight: number;
  cells: readonly MapSurfaceCell[];
  objects: readonly MapSurfaceObject[];
  tokens: readonly MapSurfaceToken[];
}

export interface GameTableSceneProps {
  /** Ordered campaign member list — seat index is position in this list. */
  members?: readonly SeatMember[];
  currentUserId?: string | null;
  cameraMode?: CameraMode;
  /** Rendered as a miniature on the tabletop; null keeps the bare table. */
  liveMap?: TableLiveMap | null;
  /** Makes the map's selectable objects click targets (POI triggering). */
  onSelectMapObject?: (id: string) => void;
  /** Left-click on a map cell — provided only while a token is armed for
   * placement/move, so the cells stay raycast-free the rest of the time
   * (the Prompt 29 no-cell-handlers reasoning, now conditional). */
  onCellClick?: (x: number, y: number) => void;
  /** Press on a draggable token started a drag-to-move. The scene owns only
   * the gesture (which token, which cell is hovered, when the pointer
   * released); the app layer owns the semantics — origin cell, path cost,
   * committing the move. */
  onTokenDragStart?: (tokenId: string) => void;
  /** The cell the pointer is currently over during an active token drag. */
  onTokenDragOverCell?: (x: number, y: number) => void;
  /** Pointer released — the app commits at the last drag-over cell. */
  onTokenDragEnd?: () => void;
  /** Ruler mode: a bare cell press starts a measurement drag instead of
   * whatever onCellClick/token-grab would otherwise do — the two gestures
   * are mutually exclusive by construction, not by callback etiquette. */
  rulerActive?: boolean;
  /** Press on a cell started a measurement. Same gesture/semantics split as
   * the token-drag trio: the scene owns the press-drag-release mechanics,
   * the app layer owns what the two cells mean. */
  onRulerDragStart?: (x: number, y: number) => void;
  /** The cell the pointer is currently over during an active measurement. */
  onRulerDragOverCell?: (x: number, y: number) => void;
  /** Pointer released — the measurement is discarded, never committed. */
  onRulerDragEnd?: () => void;
}

export function GameTableScene({
  members = [],
  currentUserId = null,
  cameraMode = "seat",
  liveMap = null,
  onSelectMapObject,
  onCellClick,
  onTokenDragStart,
  onTokenDragOverCell,
  onTokenDragEnd,
  rulerActive = false,
  onRulerDragStart,
  onRulerDragOverCell,
  onRulerDragEnd,
}: GameTableSceneProps) {
  const legX = TABLE_TOP.width / 2 - 0.45;
  const legZ = TABLE_TOP.depth / 2 - 0.45;

  const seats = useMemo(() => computeSeatLayout(members), [members]);
  const mapMetrics = useMemo(
    () => (liveMap ? computeTableMapMetrics(liveMap.gridWidth, liveMap.gridHeight) : null),
    [liveMap]
  );
  const mySeat = seats.find((seat) => seat.member.user_id === currentUserId);
  const cameraPosition = mySeat ? mySeat.cameraPosition : FALLBACK_CAMERA_POSITION;

  const handleCellPointerDown = useCallback(
    (x: number, y: number, event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      onCellClick?.(x, y);
    },
    [onCellClick]
  );

  // Same ref pattern as MapEditorScene: the window pointerup listeners below
  // must see the latest callbacks without re-subscribing per render.
  const onTokenDragStartRef = useRef(onTokenDragStart);
  const onTokenDragOverCellRef = useRef(onTokenDragOverCell);
  const onTokenDragEndRef = useRef(onTokenDragEnd);
  const onRulerDragStartRef = useRef(onRulerDragStart);
  const onRulerDragOverCellRef = useRef(onRulerDragOverCell);
  const onRulerDragEndRef = useRef(onRulerDragEnd);
  useEffect(() => {
    onTokenDragStartRef.current = onTokenDragStart;
    onTokenDragOverCellRef.current = onTokenDragOverCell;
    onTokenDragEndRef.current = onTokenDragEnd;
    onRulerDragStartRef.current = onRulerDragStart;
    onRulerDragOverCellRef.current = onRulerDragOverCell;
    onRulerDragEndRef.current = onRulerDragEnd;
  }, [onTokenDragStart, onTokenDragOverCell, onTokenDragEnd, onRulerDragStart, onRulerDragOverCell, onRulerDragEnd]);

  // State rather than a ref: cells only get pointer-over handlers (and the
  // orbit camera only releases the left button) while a drag is live, which
  // needs a render — the conditional-raycasting reasoning of onCellClick.
  const [dragging, setDragging] = useState(false);

  const handleTokenPointerDown = useCallback((tokenId: string) => {
    setDragging(true);
    onTokenDragStartRef.current?.(tokenId);
  }, []);

  const handleCellDragOver = useCallback((x: number, y: number, event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onTokenDragOverCellRef.current?.(x, y);
  }, []);

  // The ruler's press-drag-release mirrors the token drag exactly, tracked
  // as its own boolean so each gesture's drag-over reaches its own callback.
  const [measuring, setMeasuring] = useState(false);

  const handleRulerPointerDown = useCallback(
    (x: number, y: number, event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      setMeasuring(true);
      onRulerDragStartRef.current?.(x, y);
    },
    []
  );

  const handleRulerDragOver = useCallback((x: number, y: number, event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onRulerDragOverCellRef.current?.(x, y);
  }, []);

  // The release can land anywhere — off the map, off the canvas — so the
  // pointerup listener lives on window, same as the editor's stroke end.
  useEffect(() => {
    if (!dragging) return;
    const endDrag = () => {
      setDragging(false);
      onTokenDragEndRef.current?.();
    };
    window.addEventListener("pointerup", endDrag);
    return () => window.removeEventListener("pointerup", endDrag);
  }, [dragging]);

  useEffect(() => {
    if (!measuring) return;
    const endMeasure = () => {
      setMeasuring(false);
      onRulerDragEndRef.current?.();
    };
    window.addEventListener("pointerup", endMeasure);
    return () => window.removeEventListener("pointerup", endMeasure);
  }, [measuring]);

  return (
    <>
      {/* Keyed by mode so leaving orbit remounts the camera at the seat
          position/orientation instead of wherever orbiting dragged it. */}
      <PerspectiveCamera
        key={cameraMode}
        makeDefault
        position={cameraPosition as [number, number, number]}
        fov={mySeat ? 50 : 42}
        onUpdate={(camera) => camera.lookAt(...LOOK_TARGET)}
      />
      {cameraMode === "orbit" && (
        // Disabled mid-drag so grabbing a token (or sweeping the ruler)
        // doesn't also orbit the camera — OrbitControls checks enabled per
        // pointermove, so flipping it mid-gesture halts the rotation
        // immediately.
        <OrbitControls
          enabled={!dragging && !measuring}
          target={[...LOOK_TARGET]}
          minDistance={1.5}
          maxDistance={22}
          maxPolarAngle={Math.PI / 2 - 0.05}
        />
      )}

      <color attach="background" args={[ROOM_BG]} />
      <fog attach="fog" args={[ROOM_BG, 16, 34]} />

      <ambientLight color="#b9a6ff" intensity={0.55} />
      <directionalLight
        color="#ffe9c9"
        intensity={3.4}
        position={[5, 10, 3]}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
      />
      <pointLight color={PURPLE} intensity={300} position={[-9, 4, -6]} distance={40} />
      <pointLight color={TEAL} intensity={200} position={[9, 3.5, 6]} distance={40} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[24, 48]} />
        <meshStandardMaterial color="#1a1338" roughness={0.95} />
      </mesh>

      <RoundedBox
        args={[TABLE_TOP.width, TABLE_TOP.thickness, TABLE_TOP.depth]}
        radius={0.06}
        position={[0, LEG.height + TABLE_TOP.thickness / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={WOOD_TOP} roughness={0.72} />
      </RoundedBox>

      {liveMap && mapMetrics ? (
        // Nudged just above the tabletop so the map's base slab never
        // z-fights the wood.
        <group position={[0, TABLE_SURFACE_Y + 0.002, 0]}>
          <MapSurface
            gridWidth={liveMap.gridWidth}
            gridHeight={liveMap.gridHeight}
            cells={liveMap.cells}
            metrics={mapMetrics}
            objects={liveMap.objects}
            tokens={liveMap.tokens}
            gridOverlay
            // Ruler mode owns the pointer outright: a cell press measures
            // instead of placing/moving, POI objects go inert (their hit
            // boxes would otherwise swallow the press), and tokens lose
            // their grab hit boxes — so a press anywhere on the map falls
            // through to the cell beneath it.
            onSelectObject={rulerActive ? undefined : onSelectMapObject}
            onCellPointerDown={
              rulerActive
                ? handleRulerPointerDown
                : onCellClick
                  ? handleCellPointerDown
                  : undefined
            }
            onCellPointerOver={
              dragging ? handleCellDragOver : measuring ? handleRulerDragOver : undefined
            }
            onTokenPointerDown={
              !rulerActive && onTokenDragStart ? handleTokenPointerDown : undefined
            }
          />
        </group>
      ) : null}

      <TableLeg x={-legX} z={-legZ} />
      <TableLeg x={legX} z={-legZ} />
      <TableLeg x={-legX} z={legZ} />
      <TableLeg x={legX} z={legZ} />

      {seats.map((seat) => (
        <TableSeat key={seat.member.user_id} seat={seat} />
      ))}
    </>
  );
}
