"use client";

import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Clone, OrbitControls, PerspectiveCamera, RoundedBox, useGLTF } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { Box3, Vector3 } from "three";
import type { Object3D } from "three";
import { LEG, TABLE_TOP, TABLE_SURFACE_Y } from "./table";
import { computeSeatLayout, type CameraMode, type Seat, type SeatMember } from "./seating";
import { SeatAvatar } from "./SeatAvatar";
import { Chair, SEAT_TOP_Y } from "./Chair";
import {
  MapSurface,
  type MapSurfaceCell,
  type MapSurfaceObject,
  type MapSurfaceToken,
} from "./MapSurface";
import { computeTableMapMetrics } from "./mapFit";
import type { TokenSlidePhase } from "./useTokenSlide";

// Room ambiance pulls from the app's design tokens (see
// src/ui-components/tokens.css) — scene-3d can't import CSS custom
// properties, so the hex values are mirrored here.
const PURPLE = "#9b00ff"; // --purple
const TEAL = "#1ec8c8"; // --teal

// The tabletop stays naturalistic dark walnut (not neon) so future maps and
// tokens rendered on top of it stay legible — the palette accents live in
// the room lighting instead.
const WOOD_TOP = "#5a4028";
const WOOD_LEG = "#42301c";

/** Day/night lighting presets (Phase 2 of the Game Room ambiance plan) —
 * purely cosmetic room mood, unrelated to the per-cell vision/light-level
 * system (map_cells.light). "day" is byte-for-byte the values this scene
 * shipped with before this preset existed, so switching this feature on
 * causes zero visual change until a DM actively toggles to Night.
 * "night" reuses the app's two darkest design tokens for the room
 * background/fog (rather than inventing new colors), cools and dims the
 * sun/ambient pair to a moonlight tone, and pushes both accent pointLights
 * up so the purple/teal pools read more dramatically against the darker
 * room. */
const DAY_NIGHT_PRESETS = {
  day: {
    roomBg: "#0d0520", // --surface2
    fogNear: 16,
    fogFar: 34,
    ambientColor: "#b9a6ff",
    ambientIntensity: 0.55,
    sunColor: "#ffe9c9",
    sunIntensity: 3.4,
    sunPosition: [5, 10, 3] as const,
    purpleIntensity: 300,
    tealIntensity: 200,
  },
  night: {
    roomBg: "#060012", // --surface, the app's darkest token
    fogNear: 12,
    fogFar: 28,
    ambientColor: "#5a6ad1", // cool moonlit violet-blue
    ambientIntensity: 0.22,
    sunColor: "#aebfff", // cool moonlight, vs. day's warm sunlight
    sunIntensity: 0.9,
    sunPosition: [5, 10, 3] as const,
    purpleIntensity: 460,
    tealIntensity: 320,
  },
} as const;

export type DayNightMode = keyof typeof DAY_NIGHT_PRESETS;

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

// The original fully-procedural table (a RoundedBox slab on four cylinder
// legs) — kept as the load-failure/loading-state fallback for the real
// table.glb model (see Table below) so a 404 or parse failure never leaves
// the room without a table to sit at.
function ProceduralTable() {
  const legX = TABLE_TOP.width / 2 - 0.45;
  const legZ = TABLE_TOP.depth / 2 - 0.45;
  return (
    <>
      <RoundedBox
        args={[TABLE_TOP.width, TABLE_TOP.thickness, TABLE_TOP.depth]}
        radius={0.06}
        position={[0, LEG.height + TABLE_TOP.thickness / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={WOOD_TOP} roughness={0.72} />
      </RoundedBox>
      <TableLeg x={-legX} z={-legZ} />
      <TableLeg x={legX} z={-legZ} />
      <TableLeg x={-legX} z={legZ} />
      <TableLeg x={legX} z={legZ} />
    </>
  );
}

const TABLE_URL = "/table/table.glb";
// The model's own long axis, as exported, is its local Z — not X — so it's
// rotated 90° about Y before rendering to land that long axis on the
// scene's X ("width"), matching every other convention here (seating's
// ellipse, the fallback camera position) that assumes the table is wider
// than it is deep. See table.ts's own comment on TABLE_TOP for the full
// bounding-box measurement this and TABLE_SURFACE_Y are both based on.
const TABLE_ROTATION_Y = Math.PI / 2;

/**
 * Loads and normalizes the real table model — SeatAvatar's scale-to-known-
 * height plus recenter-to-origin pattern again, except the "known height"
 * here is TABLE_SURFACE_Y (every other system's source of truth for where
 * the tabletop surface sits) rather than a fixed avatar height. Recentering
 * happens before the outer rotation, so it's computed in the model's own
 * unrotated local space and the rotation just spins the already-centered
 * result around the vertical axis through its own center.
 */
function TableModel() {
  const { scene } = useGLTF(TABLE_URL);
  const { scale, offset } = useMemo(() => {
    const box = new Box3().setFromObject(scene as Object3D);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const scale = size.y > 1e-3 ? TABLE_SURFACE_Y / size.y : 1;
    const offset: [number, number, number] = [-center.x * scale, -box.min.y * scale, -center.z * scale];
    return { scale, offset };
  }, [scene]);

  return (
    <group rotation={[0, TABLE_ROTATION_Y, 0]}>
      <Clone object={scene} scale={scale} position={offset} castShadow receiveShadow />
    </group>
  );
}

/** Falls back to the procedural table on a load/parse failure — same
 * reasoning as Chair.tsx's ChairErrorBoundary, but for the shared table
 * (there's only ever one, so no per-instance URL to key a reset on). */
class TableErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? <ProceduralTable /> : this.props.children;
  }
}

function Table() {
  return (
    <TableErrorBoundary>
      <Suspense fallback={<ProceduralTable />}>
        <TableModel />
      </Suspense>
    </TableErrorBoundary>
  );
}

useGLTF.preload(TABLE_URL);

// The Prompt 19 stool, then the cushion-disc-and-ring "dais" that replaced
// it, are both gone — a real chair (Chair.tsx) now carries the role's
// accent color via its own trim, so a separate floor ring in the same
// footprint would just be a redundant, competing signal.
function TableSeat({ seat }: { seat: Seat }) {
  return (
    <group position={seat.position} rotation={[0, seat.rotationY, 0]}>
      <Chair role={seat.member.role} />
      {/* Feet land on the chair's own seat pad, not the floor — SeatAvatar
          puts a model's feet at its own local origin (see its own
          comment), so this offset must track wherever the pad's top
          surface actually is. The DM's throne and the player chair are now
          independently-measured real models with their own real seat
          heights (Chair.tsx's SEAT_TOP_Y), so this is keyed per-role rather
          than one shared constant. */}
      <group position={[0, SEAT_TOP_Y[seat.member.role], 0]}>
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
  /** Cosmetic room-lighting preset (Phase 2 of the Game Room ambiance
   * plan); defaults to "day" — today's original, unchanged values. Has no
   * effect on the per-cell vision/light-level system. */
  dayNightMode?: DayNightMode;
  /** Verification-only pass-through to MapSurface's onTokenSlideDebug — see
   * its own doc comment. Purely a mirror of each token's slide animation
   * state; omitting it changes nothing about how tokens move or render. */
  onTokenSlideDebug?: (id: string, phase: TokenSlidePhase) => void;
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
  dayNightMode = "day",
  onTokenSlideDebug,
}: GameTableSceneProps) {
  const lighting = DAY_NIGHT_PRESETS[dayNightMode];

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

      <color attach="background" args={[lighting.roomBg]} />
      <fog attach="fog" args={[lighting.roomBg, lighting.fogNear, lighting.fogFar]} />

      <ambientLight color={lighting.ambientColor} intensity={lighting.ambientIntensity} />
      <directionalLight
        color={lighting.sunColor}
        intensity={lighting.sunIntensity}
        position={lighting.sunPosition}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
      />
      <pointLight color={PURPLE} intensity={lighting.purpleIntensity} position={[-9, 4, -6]} distance={40} />
      <pointLight color={TEAL} intensity={lighting.tealIntensity} position={[9, 3.5, 6]} distance={40} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[24, 48]} />
        <meshStandardMaterial color="#1a1338" roughness={0.95} />
      </mesh>

      <Table />

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
            onTokenSlideDebug={onTokenSlideDebug}
          />
        </group>
      ) : null}

      {seats.map((seat) => (
        <TableSeat key={seat.member.user_id} seat={seat} />
      ))}
    </>
  );
}
