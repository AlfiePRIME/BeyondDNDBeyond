"use client";

import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Clone, OrbitControls, PerspectiveCamera, RoundedBox, useGLTF } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { Box3, Vector3 } from "three";
import type { Object3D } from "three";
import { LEG, TABLE_TOP, TABLE_SURFACE_Y, TABLE_TOP_JOIN_DEPTH } from "./table";
import {
  computeCampaignSeatLayout,
  seatEllipseSemiAxes,
  type CameraMode,
  type Seat,
  type SeatMember,
} from "./seating";
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
// World origin is the COMBINED two-table footprint's own center (both
// tables sit symmetrically astride it — see CombinedTable below), so this
// stays the right look target/fallback-camera anchor completely unchanged
// by the doubled table; only its distance needed re-tuning (10.5/7.5 →
// 13/10) so the fallback view (used whenever the current user has no seat
// of their own) still comfortably frames the larger, roughly-square
// combined surface instead of sitting proportionally too close to it.
const FALLBACK_CAMERA_POSITION: readonly [number, number, number] = [0, 13, 10];

// The directional light's shadow-camera frustum must cover every
// shadow-casting seat/chair around the table — whose furthest possible
// anchor point is the seating ellipse's OWN semi-axes (seatEllipseSemiAxes,
// seating.ts's real seat-fit formula, not a hand-copied guess), so this
// stays correct even if a later prompt changes the ellipse's fit again.
// CHAIR_SHADOW_MARGIN covers a real chair model's own physical width/depth
// beyond its point anchor, plus headroom for an avatar sitting in it — the
// DM's book/private dice tray both sit much closer to center than any
// chair (GameRoom.tsx's dmBookPosition/dmPrivateTrayPosition), so they
// never actually govern this bound. Symmetric on all four sides: a
// directional light's orthographic shadow camera has no reason to favor
// one axis over another.
const { semiX: SHADOW_SEAT_SEMI_X, semiZ: SHADOW_SEAT_SEMI_Z } = seatEllipseSemiAxes();
const CHAIR_SHADOW_MARGIN = 1.5;
const SHADOW_FRUSTUM_EXTENT = Math.ceil(Math.max(SHADOW_SEAT_SEMI_X, SHADOW_SEAT_SEMI_Z) + CHAIR_SHADOW_MARGIN);

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
 * model (there's only ever one URL, table.glb, so no per-instance URL to
 * key a reset on — this same component is instantiated twice, once per
 * physical table in CombinedTable below, each with its own independent
 * boundary/Suspense so one table's load failure can't take the other
 * down). */
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

/**
 * The full physical surface the project owner asked for: two independent
 * copies of the same table (model, fallback, and legs alike — Table above),
 * offset along Z by exactly half of TABLE_TOP_JOIN_DEPTH each way so their
 * long (width) edges — the TOP SURFACES specifically, not the wider leg
 * stance — meet precisely at the world-origin seam with no gap. table.ts's
 * TABLE_TOP_JOIN_DEPTH's own doc comment has the full story: table.glb's
 * leg feet splay out wider than the tabletop slab itself, so offsetting by
 * half of TABLE_TOP.depth (this file's original approach) flushed the WIDE
 * leg feet while leaving a visible gap between the NARROWER tabletop
 * surfaces — the actual bug a real deployed look caught. Using
 * TABLE_TOP_JOIN_DEPTH instead means the two tables' leg geometry now
 * clips through each other underneath (explicitly fine per the project
 * owner — nobody sees under the table) in exchange for a genuinely
 * continuous, gap-free playing surface on top, which is what actually
 * matters. table.ts's COMBINED_TABLE_TOP (used for the seating ellipse
 * fit, unchanged) deliberately still uses the wider TABLE_TOP.depth-based
 * footprint — chairs need to clear the full leg stance, not just the
 * visible top, so that generous number remains the right one for seating/
 * clearance purposes even though the tables now sit slightly closer
 * together than COMBINED_TABLE_TOP's own depth would suggest.
 *
 * Nothing here depends on which instance renders "first" — every position
 * anchored to a specific spot on this combined surface (the live map's
 * group below, DiceTumble's default shared-tray corner, GameRoom's
 * dmBookPosition/dmPrivateTrayPosition) targets the SEAM/origin itself, per
 * the project owner's explicit call to keep the map (and everything
 * anchored the same way) centered on the seam rather than flush against
 * either table — a repositioning of where that single-table-sized surface
 * sits, not a rescale of it (mapFit.ts's computeTableMapMetrics is
 * completely untouched).
 */
function CombinedTable() {
  const halfJoinDepth = TABLE_TOP_JOIN_DEPTH / 2;
  return (
    <>
      <group position={[0, 0, -halfJoinDepth]}>
        <Table />
      </group>
      <group position={[0, 0, halfJoinDepth]}>
        <Table />
      </group>
    </>
  );
}

// The Prompt 19 stool, then the cushion-disc-and-ring "dais" that replaced
// it, are both gone — a real chair (Chair.tsx) now carries the role's
// accent color via its own trim, so a separate floor ring in the same
// footprint would just be a redundant, competing signal.
function TableSeat({
  seat,
  onAvatarPoseDebug,
}: {
  seat: Seat;
  /** Verification-only pass-through to SeatAvatar's onPoseDebug — see
   * GameTableSceneProps.onAvatarPoseDebug's doc comment. */
  onAvatarPoseDebug?: (userId: string, compatible: boolean) => void;
}) {
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
        <SeatAvatar
          url={seat.member.avatar_url ?? null}
          forwardOffsetDeg={seat.member.avatar_forward_offset_deg ?? 0}
          onPoseDebug={
            onAvatarPoseDebug ? (compatible) => onAvatarPoseDebug(seat.member.user_id, compatible) : undefined
          }
        />
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
   * placement/move OR click-selected for the budget-aware move flow, so
   * the cells stay raycast-free the rest of the time (the Prompt 29
   * no-cell-handlers reasoning, now conditional on either gesture). */
  onCellClick?: (x: number, y: number) => void;
  /** Click on a selectable token — click-select-to-move (replaces the old
   * click-hold-drag gesture). The scene owns only the raw press (which
   * token; button-0 only, same guard the cell click path already applies);
   * the app layer owns the semantics — selecting it, computing/showing its
   * reachable cells, and what a later cell click does with the selection. */
  onTokenClick?: (tokenId: string) => void;
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
  /** Verification-only: fires whenever a seated member's skeleton-based
   * posing (docs/design/model-orientation-and-posing.md §9) resolves
   * compatible/incompatible — same reasoning as onTokenSlideDebug (WebGL
   * has no DOM of its own for a test to inspect a skeleton directly).
   * Omitting it changes nothing about how avatars render or pose. */
  onAvatarPoseDebug?: (userId: string, compatible: boolean) => void;
  /** Verification-only pass-through to MapSurface's onObjectPoseDebug —
   * see its own doc comment. */
  onObjectPoseDebug?: (id: string, compatible: boolean) => void;
}

export function GameTableScene({
  members = [],
  currentUserId = null,
  cameraMode = "seat",
  liveMap = null,
  onSelectMapObject,
  onCellClick,
  onTokenClick,
  rulerActive = false,
  onRulerDragStart,
  onRulerDragOverCell,
  onRulerDragEnd,
  dayNightMode = "day",
  onTokenSlideDebug,
  onAvatarPoseDebug,
  onObjectPoseDebug,
}: GameTableSceneProps) {
  const lighting = DAY_NIGHT_PRESETS[dayNightMode];

  const { seats, appendedTables } = useMemo(() => computeCampaignSeatLayout(members), [members]);
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

  // Same ref pattern as MapEditorScene: the ruler's window pointerup
  // listener below must see the latest callbacks without re-subscribing
  // per render.
  const onRulerDragStartRef = useRef(onRulerDragStart);
  const onRulerDragOverCellRef = useRef(onRulerDragOverCell);
  const onRulerDragEndRef = useRef(onRulerDragEnd);
  useEffect(() => {
    onRulerDragStartRef.current = onRulerDragStart;
    onRulerDragOverCellRef.current = onRulerDragOverCell;
    onRulerDragEndRef.current = onRulerDragEnd;
  }, [onRulerDragStart, onRulerDragOverCell, onRulerDragEnd]);

  // Click-select-to-move (replaces the old click-hold-drag gesture): a
  // single press is the whole gesture, so — unlike the ruler's own
  // press-drag-release below — there's no in-flight state to track here at
  // all; the app layer owns everything from "which token" onward.
  const handleTokenPointerDown = useCallback(
    (tokenId: string) => {
      onTokenClick?.(tokenId);
    },
    [onTokenClick]
  );

  // The ruler's press-drag-release is untouched by this prompt, tracked as
  // its own boolean so its drag-over reaches its own callback.
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
        // Disabled mid-measurement so sweeping the ruler doesn't also orbit
        // the camera — OrbitControls checks enabled per pointermove, so
        // flipping it mid-gesture halts the rotation immediately. Token
        // selection needs no such guard: it's a single press, not a
        // held-down drag, so there's never a moment where the camera would
        // fight it.
        <OrbitControls
          enabled={!measuring}
          target={[...LOOK_TARGET]}
          minDistance={1.5}
          // Re-tuned up from 22 (unchanged ratio over the old table's
          // seated-camera reach) for the doubled table — orbit must be able
          // to zoom out far enough to frame the FULL combined ~4.36×4.2
          // surface plus its now-further-out seats without the table
          // running off the edge of the view.
          maxDistance={26}
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
        // Re-tuned from a fixed ±8 box (SHADOW_FRUSTUM_EXTENT's own doc
        // comment) — derived from the real seat-fit ellipse plus a chair-
        // footprint margin, so it's provably sized to the doubled table's
        // actual seats/chairs rather than a number that happened to work
        // for the old, smaller one.
        shadow-camera-left={-SHADOW_FRUSTUM_EXTENT}
        shadow-camera-right={SHADOW_FRUSTUM_EXTENT}
        shadow-camera-top={SHADOW_FRUSTUM_EXTENT}
        shadow-camera-bottom={-SHADOW_FRUSTUM_EXTENT}
      />
      <pointLight color={PURPLE} intensity={lighting.purpleIntensity} position={[-9, 4, -6]} distance={40} />
      <pointLight color={TEAL} intensity={lighting.tealIntensity} position={[9, 3.5, 6]} distance={40} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[24, 48]} />
        <meshStandardMaterial color="#1a1338" roughness={0.95} />
      </mesh>

      <CombinedTable />

      {/* Extra plain single tables (never the head square's own two-table
          model), appended one per exceeded HEAD_SQUARE_SEAT_CAPACITY/
          SINGLE_TABLE_SEAT_CAPACITY threshold (seating.ts's
          computeCampaignSeatLayout) and lined up beside the fixed head
          square along table.ts's singleTableOffsetZ row — purely extra
          seating, so only bare <Table />, never <CombinedTable /> and never
          the live map (liveMap only ever renders on the head square,
          below). */}
      {appendedTables.map((table) => (
        <group key={table.index} position={[0, 0, table.offsetZ]}>
          <Table />
        </group>
      ))}

      {liveMap && mapMetrics ? (
        // Nudged just above the tabletop so the map's base slab never
        // z-fights the wood. x/z stay at the world origin — the seam
        // between the two tables (CombinedTable's own doc comment) — on
        // the project owner's explicit call to keep the live map's existing
        // single-table-sized fit (mapFit.ts's computeTableMapMetrics,
        // completely unchanged) centered on that seam, straddling both
        // tables equally, rather than pushed flush against either one.
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
            // instead of placing/moving/selecting, POI objects go inert
            // (their hit boxes would otherwise swallow the press), and
            // tokens lose their click hit boxes — so a press anywhere on
            // the map falls through to the cell beneath it.
            onSelectObject={rulerActive ? undefined : onSelectMapObject}
            onCellPointerDown={
              rulerActive
                ? handleRulerPointerDown
                : onCellClick
                  ? handleCellPointerDown
                  : undefined
            }
            onCellPointerOver={measuring ? handleRulerDragOver : undefined}
            onTokenPointerDown={
              !rulerActive && onTokenClick ? handleTokenPointerDown : undefined
            }
            onTokenSlideDebug={onTokenSlideDebug}
            onObjectPoseDebug={onObjectPoseDebug}
          />
        </group>
      ) : null}

      {seats.map((seat) => (
        <TableSeat key={seat.member.user_id} seat={seat} onAvatarPoseDebug={onAvatarPoseDebug} />
      ))}
    </>
  );
}
