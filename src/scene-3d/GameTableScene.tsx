"use client";

import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Clone, OrbitControls, PerspectiveCamera, RoundedBox, useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { Box3, Plane, Raycaster, Vector2, Vector3 } from "three";
import type { Camera, Object3D } from "three";
import { LEG, TABLE_TOP, TABLE_SURFACE_Y, TABLE_TOP_JOIN_DEPTH } from "./table";
import {
  applySeatOffset,
  clampToTableArrangement,
  computeCampaignSeatLayout,
  rotationYTowardNearestTable,
  seatEllipseSemiAxes,
  type AppendedTable,
  type CameraMode,
  type CampaignSeat,
  type Seat,
  type SeatMember,
  type SeatOffset,
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

// ---------------------------------------------------------------------------
// Movable chairs (drag gesture): a player may grab and drag their OWN chair
// (never another member's, never the DM's throne — see draggableUserId
// below) anywhere near the table arrangement, with their own seated camera
// following live. Reuses this same file's existing press-drag-release
// pointer pattern (the ruler's own handleRulerPointerDown/handleRulerDragOver/
// window-"pointerup" trio just below) rather than inventing a new gesture
// shape: the scene owns the raw mechanics (which chair, where the pointer
// currently is), the app layer (GameRoom.tsx's onChairDragEnd) owns what a
// finished drag actually means — persistence, collision avoidance against
// obstacles this file has no idea about (other chairs, the dice tray, the
// DM's book), and broadcasting the result to every other client.
//
// Continuous world tracking (not the ruler's discrete per-cell hover) needs
// a genuine floor-plane raycast, not react-three-fiber's own per-mesh
// pointer events: those raycast against whatever's actually rendered, so
// the instant the cursor's SCREEN position crosses in front of the table (or
// another chair) on its way toward a further seat, an R3F pointer-move
// handler on a floor mesh would simply stop firing — a dead zone a dragged
// chair could never cross from plenty of ordinary seated-camera angles.
// Raycasting a plain MATHEMATICAL plane at y=0 (matching every seat's own
// "stool base on the floor" anchor — Seat's own doc comment) instead of any
// real mesh sidesteps that scene-occlusion problem entirely — the standard
// technique for a free "drag along the ground" gesture. Module-level scratch
// objects, reused across calls rather than reallocated — DmBookProp.tsx's
// own objectPos/cameraPos/delta/forward precedent for a WebGL-adjacent
// coordinate computation frequent enough to be worth not reallocating.
const chairDragPlane = new Plane(new Vector3(0, 1, 0), 0);
const chairDragRaycaster = new Raycaster();
const chairDragNdc = new Vector2();
const chairDragHit = new Vector3();

/** Projects a raw pointer event's canvas-relative client coordinates onto
 * the floor plane (see the block comment above) — null only if the ray is
 * parallel to that plane (looking exactly along the horizon), in which case
 * callers simply skip that update and keep whatever position they already
 * had. */
function floorPointFromClientXY(
  camera: Camera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number
): { x: number; z: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  chairDragNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  chairDragRaycaster.setFromCamera(chairDragNdc, camera);
  const hit = chairDragRaycaster.ray.intersectPlane(chairDragPlane, chairDragHit);
  return hit ? { x: chairDragHit.x, z: chairDragHit.z } : null;
}

// An oversized invisible grab handle over a draggable chair — DmBookProp's
// own HIT_BOX precedent (bigger than the visible model, so grabbing it
// doesn't need pixel-perfect aim), sized to comfortably enclose a player
// chair plus its seated avatar (Chair.tsx's PLAYER_CHAIR_HEIGHT is 2.5) so a
// drag can be grabbed anywhere on the chair's silhouette, not just its base.
const CHAIR_DRAG_HIT_BOX: [number, number, number] = [1.1, 2.8, 1.1];
const CHAIR_DRAG_HANDLE_Y = 1.4;

// The Y sampled by the own-chair screen-projection debug callback (below) —
// deliberately NOT the same as CHAIR_DRAG_HANDLE_Y above, despite both
// needing to land somewhere on the very same hit box. A seated first-person
// camera looks PAST its own seat toward the table center (LOOK_TARGET),
// never straight down at it, so a point at the chair's own vertical middle
// (1.4) sits right at — empirically, for some party sizes, just past — the
// bottom edge of the 50°-vertical-FOV seated view (verified directly against
// a live rendered scene: 1.4 projected to a Y coordinate below the viewport
// entirely). CAMERA_SETBACK/CAMERA_EYE_HEIGHT (seating.ts) are fixed
// constants shared by every seat regardless of party size or which table it
// lands on, so this isn't a one-off for a particular seat — every player's
// own chair has the exact same problem at that height. 2.6 (near the TOP of
// the same hit box, still safely inside its own [0, 2.8] Y range, so a real
// click there still lands on the identical mesh) was chosen by replaying
// this scene's own camera trigonometry (camera position, LOOK_TARGET, fov)
// for the real range of seat distances this table produces (the head
// square's ~3.37–3.48 semi-axes, an appended table's own ~3.48 near its
// end-cap seats) and picking a height with comfortable margin under the 25°
// half-FOV at every one of them (roughly 8–11° off-axis, vs. 1.4's
// razor-thin ~26° that clips some of them entirely).
const CHAIR_DRAG_PROJECTION_Y = 2.6;

// Scratch vectors for the own-chair screen-projection debug callback below
// (verification-only — DmBookPropProps.onProjectedPosition's own "WebGL has
// no DOM of its own for a test to find a click target" reasoning), reused
// per frame the same way as the chairDrag* scratch objects above.
const ownChairPoint = new Vector3();
const ownChairCameraPos = new Vector3();
const ownChairForward = new Vector3();
const ownChairDelta = new Vector3();

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
  draggable = false,
  onDragPointerDown,
}: {
  seat: Seat;
  /** Verification-only pass-through to SeatAvatar's onPoseDebug — see
   * GameTableSceneProps.onAvatarPoseDebug's doc comment. */
  onAvatarPoseDebug?: (userId: string, compatible: boolean) => void;
  /** True only for the CURRENT viewer's own player seat (GameTableScene's
   * own draggableUserId) — the movable-chair prompt's explicit "a player can
   * drag their own chair... cannot drag another player's chair or the DM's
   * chair." Enforced here by simply never rendering the grab handle at all
   * for anyone else's seat — there's no gesture to intercept, not a runtime
   * permission check a determined client could route around. */
  draggable?: boolean;
  onDragPointerDown?: (event: ThreeEvent<PointerEvent>) => void;
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
      {draggable ? (
        <mesh position={[0, CHAIR_DRAG_HANDLE_Y, 0]} onPointerDown={onDragPointerDown}>
          <boxGeometry args={CHAIR_DRAG_HIT_BOX} />
          {/* opacity-0, not visible={false} — an invisible mesh is skipped
              by the raycaster, which would defeat the hit box entirely
              (DmBookProp's own precedent). */}
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ) : null}
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
  /** This viewer's own visible chair offsets, keyed by user_id — scene-3d's
   * own SeatOffset (seating.ts), not data-access's structurally-identical
   * twin (the SeatMember/module-boundary convention already documented on
   * that type). Applied via applySeatOffset to every seat before it's ever
   * rendered — per that function's own doc comment, "where is this member
   * actually sitting right now" must have exactly one answer everywhere, so
   * this scene never reads a seat's raw computeCampaignSeatLayout position
   * directly. Absent/empty means nobody has moved their chair — every seat
   * renders at its computed default, byte-for-byte this prompt's pre-
   * existing behavior. */
  seatOffsets?: ReadonlyMap<string, SeatOffset>;
  /** Fires once a chair drag genuinely ends WITH real movement — a plain
   * click-and-release with no drag in between fires nothing at all, the
   * same "press-and-release in place is a grab, not a move" convention the
   * old token-drag gesture and the ruler both already use. Carries the
   * final position/orientation already clamped to CHAIR_DRAG_CLAMP_RADIUS
   * and re-oriented toward the nearest table (seating.ts's
   * clampToTableArrangement/rotationYTowardNearestTable — the same math the
   * live in-progress drag itself already used), expressed as an offset from
   * that seat's own computed default — but NOT yet nudged clear of other
   * chairs/the dice tray/the DM's book: this scene has no idea where those
   * are. GameRoom.tsx's own onChairDragEnd handler is the actual final
   * authority — it re-resolves through seating.ts's resolveChairDrop with
   * the real obstacle list, persists via setSeatOffset, and broadcasts the
   * (possibly further-nudged) result to every other client. Only ever
   * fires for `currentUserId`'s own seat — see draggableUserId below for why
   * nothing else can even start a drag to fire this. */
  onChairDragEnd?: (userId: string, offset: SeatOffset) => void;
  /** Verification-only: this client's own draggable chair's current on-
   * screen projection (canvas-relative CSS pixels), or null while it isn't
   * visible or doesn't exist — DmBookPropProps.onProjectedPosition's own
   * "WebGL has no DOM of its own for a test to find a click target"
   * reasoning, reused here so a Playwright drag simulation has real pixel
   * coordinates to press down on and drag from. Not read by GameTableScene
   * itself; changes nothing about how anything renders or drags. */
  onOwnChairProjectedPosition?: (point: [number, number] | null) => void;
  /** Verification-only: this client's own seated camera position, fired
   * whenever it genuinely changes — the direct proof for "that player's own
   * camera view updates live while dragging" rather than trusting
   * applySeatOffset's own cameraPosition translation by inference alone.
   * Not read by GameTableScene itself. */
  onOwnCameraDebug?: (position: readonly [number, number, number]) => void;
}

// Stable empty-Map default for GameTableSceneProps.seatOffsets — a fresh
// `new Map()` literal in the destructured default below would otherwise
// allocate (and, worse, compare unequal to itself across renders in any
// memo keyed on it) every single render for any caller that omits the prop.
const EMPTY_SEAT_OFFSETS: ReadonlyMap<string, SeatOffset> = new Map();

/** One in-progress chair drag's own fixed, per-session parameters —
 * captured once at "pointerdown" and read (never re-derived) by the window
 * "pointermove"/"pointerup" listeners for the rest of that same drag. */
interface ChairDragSession {
  userId: string;
  /** The grabbed point's own fixed offset from the chair's anchor at the
   * moment of the press — preserved through the whole drag so the chair
   * doesn't jump to re-center itself under the cursor the instant it's
   * grabbed (the ordinary "grab anywhere on it" drag convention). */
  grabOffsetX: number;
  grabOffsetZ: number;
  defaultPosition: readonly [number, number, number];
  defaultRotationY: number;
  /** False for a plain click-and-release with no real movement in between —
   * see GameTableSceneProps.onChairDragEnd's own doc comment for why that
   * fires nothing at all in this case. */
  moved: boolean;
  /** The latest resolved (clamped + re-oriented) offset — read directly off
   * this mutable session object on release rather than off React state,
   * since the window "pointerup" listener's own closure only ever sees
   * whatever state existed at the moment "pointerdown" registered it, not
   * later updates from "pointermove". */
  latestOffset: SeatOffset | null;
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
  seatOffsets = EMPTY_SEAT_OFFSETS,
  onChairDragEnd,
  onOwnChairProjectedPosition,
  onOwnCameraDebug,
}: GameTableSceneProps) {
  const lighting = DAY_NIGHT_PRESETS[dayNightMode];
  const { camera, gl, size } = useThree();

  const layout = useMemo(() => computeCampaignSeatLayout(members), [members]);
  const { appendedTables } = layout;

  // Movable chairs: only the CURRENT viewer's own PLAYER seat may ever be
  // dragged — never the DM's throne (out of scope for this prompt; the
  // brief's own repeated "a player's own chair" framing) and never another
  // member's chair (TableSeat below only ever renders a grab handle for
  // this exact user_id — see its own doc comment).
  const draggableUserId = useMemo(() => {
    const mine = layout.seats.find((seat) => seat.member.user_id === currentUserId);
    return mine && mine.member.role === "player" ? mine.member.user_id : null;
  }, [layout.seats, currentUserId]);

  const chairDragSessionRef = useRef<ChairDragSession | null>(null);
  const [isDraggingChair, setIsDraggingChair] = useState(false);
  // The seat currently overridden by purely LOCAL state — covers both the
  // live in-progress drag (updated every "pointermove", see the effect
  // below) and the brief window right after release before GameRoom.tsx's
  // own seatOffsets prop (its persist-then-broadcast round trip) catches up
  // to the value this same client just committed, so a chair never visibly
  // snaps backward to its pre-drag spot for that gap. Cleared the instant
  // `seatOffsets` itself changes at all (the effect just below it) — by
  // then the prop IS current, whatever it settled on (the raw dragged
  // value, or GameRoom.tsx's resolveChairDrop collision-nudged correction).
  const [localChairOverride, setLocalChairOverride] = useState<{ userId: string; offset: SeatOffset } | null>(
    null
  );
  // Render-time reset (not an effect) the moment `seatOffsets` itself
  // changes reference at all — GameRoom.tsx's own prevMembers/prevCharacters
  // precedent for "adjusting state when a prop changes" (react.dev's own
  // documented pattern for exactly this shape, and this codebase's
  // established convention for it — see GameRoom.tsx's own comment on
  // prevMembers for the fuller reasoning).
  const [prevSeatOffsets, setPrevSeatOffsets] = useState(seatOffsets);
  if (prevSeatOffsets !== seatOffsets) {
    setPrevSeatOffsets(seatOffsets);
    setLocalChairOverride(null);
  }

  // Ref-mirrored the same way onRulerDragStartRef/onRulerDragOverCellRef/
  // onRulerDragEndRef already are below: the window "pointermove"/"pointerup"
  // listeners are registered once per drag session (not re-subscribed every
  // render), so they need a way to see the LATEST appendedTables/callback
  // without going stale mid-drag.
  const appendedTablesRef = useRef<readonly AppendedTable[]>(appendedTables);
  useEffect(() => {
    appendedTablesRef.current = appendedTables;
  }, [appendedTables]);
  const onChairDragEndRef = useRef(onChairDragEnd);
  useEffect(() => {
    onChairDragEndRef.current = onChairDragEnd;
  }, [onChairDragEnd]);

  // Every seat, offset-applied — the one and only place this scene ever
  // reads a seat's position from (applySeatOffset's own doc comment: "never
  // a computed value in some call sites and an overridden one in others").
  // The currently-dragged (or just-released) seat renders from
  // localChairOverride instead of the `seatOffsets` prop — see that state's
  // own doc comment above for why.
  const seats = useMemo<CampaignSeat[]>(
    () =>
      layout.seats.map((seat) => {
        if (localChairOverride && localChairOverride.userId === seat.member.user_id) {
          return applySeatOffset(seat, localChairOverride.offset);
        }
        return applySeatOffset(seat, seatOffsets.get(seat.member.user_id));
      }),
    [layout.seats, seatOffsets, localChairOverride]
  );

  const handleChairPointerDown = useCallback(
    (userId: string, event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const currentSeat = seats.find((seat) => seat.member.user_id === userId);
      const defaultSeat = layout.seats.find((seat) => seat.member.user_id === userId);
      if (!currentSeat || !defaultSeat) return;
      const floorPoint = floorPointFromClientXY(camera, gl.domElement, event.clientX, event.clientY);
      if (!floorPoint) return;
      chairDragSessionRef.current = {
        userId,
        grabOffsetX: currentSeat.position[0] - floorPoint.x,
        grabOffsetZ: currentSeat.position[2] - floorPoint.z,
        defaultPosition: defaultSeat.position,
        defaultRotationY: defaultSeat.rotationY,
        moved: false,
        latestOffset: null,
      };
      setIsDraggingChair(true);
    },
    [seats, layout.seats, camera, gl]
  );

  // The drag's own continuation, mirroring the ruler's window-"pointerup"
  // precedent just below ("the release can land anywhere — off the map, off
  // the canvas — so the pointerup listener lives on window") — except this
  // gesture ALSO needs the pointer's live position between press and
  // release, not just its final one, so "pointermove" is subscribed here
  // too. Registered only while a drag is actually in progress, so an idle
  // table costs nothing extra.
  useEffect(() => {
    if (!isDraggingChair) return;
    const canvas = gl.domElement;
    function handleMove(event: PointerEvent) {
      const session = chairDragSessionRef.current;
      if (!session) return;
      const floorPoint = floorPointFromClientXY(camera, canvas, event.clientX, event.clientY);
      if (!floorPoint) return;
      const candidateX = floorPoint.x + session.grabOffsetX;
      const candidateZ = floorPoint.z + session.grabOffsetZ;
      const clamped = clampToTableArrangement(candidateX, candidateZ, appendedTablesRef.current);
      const rotationY = rotationYTowardNearestTable(clamped.x, clamped.z, appendedTablesRef.current);
      const offset: SeatOffset = {
        dx: clamped.x - session.defaultPosition[0],
        dz: clamped.z - session.defaultPosition[2],
        dRotationY: rotationY - session.defaultRotationY,
      };
      session.moved = true;
      session.latestOffset = offset;
      setLocalChairOverride({ userId: session.userId, offset });
    }
    function handleUp() {
      const session = chairDragSessionRef.current;
      chairDragSessionRef.current = null;
      setIsDraggingChair(false);
      if (session?.moved && session.latestOffset) {
        onChairDragEndRef.current?.(session.userId, session.latestOffset);
      }
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [isDraggingChair, camera, gl]);

  const mySeat = seats.find((seat) => seat.member.user_id === currentUserId);
  const cameraPosition = mySeat ? mySeat.cameraPosition : FALLBACK_CAMERA_POSITION;

  // Verification-only: this client's own seated camera position, reported
  // whenever it genuinely changes value (not every frame regardless — a
  // fresh array literal each render would otherwise look "changed" to a
  // naive reference check 60 times a second even while sitting still).
  // Lets a real drag simulation confirm the acceptance criterion directly —
  // "that player's own camera view updates live while dragging" — rather
  // than trusting applySeatOffset's own already-tested cameraPosition
  // translation by inference alone.
  const lastOwnCamera = useRef<readonly [number, number, number] | null>(null);
  // Verification-only: this client's own draggable chair's live screen
  // projection — DmBookProp's own useFrame/project-to-screen technique,
  // reused here (see onOwnChairProjectedPosition's own doc comment) rather
  // than duplicated as a shared hook, since exactly one call site needs it.
  const lastOwnChairScreen = useRef<[number, number] | null>(null);
  useFrame(() => {
    if (onOwnCameraDebug) {
      const last = lastOwnCamera.current;
      const changed =
        !last ||
        Math.abs(last[0] - cameraPosition[0]) > 1e-4 ||
        Math.abs(last[1] - cameraPosition[1]) > 1e-4 ||
        Math.abs(last[2] - cameraPosition[2]) > 1e-4;
      if (changed) {
        lastOwnCamera.current = cameraPosition;
        onOwnCameraDebug(cameraPosition);
      }
    }
    if (!onOwnChairProjectedPosition) return;
    const seat = draggableUserId ? seats.find((candidate) => candidate.member.user_id === draggableUserId) : undefined;
    if (!seat) {
      if (lastOwnChairScreen.current !== null) {
        lastOwnChairScreen.current = null;
        onOwnChairProjectedPosition(null);
      }
      return;
    }
    ownChairPoint.set(seat.position[0], seat.position[1] + CHAIR_DRAG_PROJECTION_Y, seat.position[2]);
    camera.updateMatrixWorld();
    ownChairCameraPos.setFromMatrixPosition(camera.matrixWorld);
    ownChairDelta.copy(ownChairPoint).sub(ownChairCameraPos);
    camera.getWorldDirection(ownChairForward);
    if (ownChairDelta.angleTo(ownChairForward) > Math.PI / 2) {
      if (lastOwnChairScreen.current !== null) {
        lastOwnChairScreen.current = null;
        onOwnChairProjectedPosition(null);
      }
      return;
    }
    ownChairPoint.project(camera);
    const x = (ownChairPoint.x * size.width) / 2 + size.width / 2;
    const y = -((ownChairPoint.y * size.height) / 2) + size.height / 2;
    const last = lastOwnChairScreen.current;
    if (!last || Math.abs(last[0] - x) > 0.5 || Math.abs(last[1] - y) > 0.5) {
      lastOwnChairScreen.current = [x, y];
      onOwnChairProjectedPosition([x, y]);
    }
  });

  const mapMetrics = useMemo(
    () => (liveMap ? computeTableMapMetrics(liveMap.gridWidth, liveMap.gridHeight) : null),
    [liveMap]
  );

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
        // Disabled mid-measurement (or mid-chair-drag) so sweeping the
        // ruler/dragging a chair doesn't also orbit the camera —
        // OrbitControls checks enabled per pointermove, so flipping it
        // mid-gesture halts the rotation immediately. Token selection needs
        // no such guard: it's a single press, not a held-down drag, so
        // there's never a moment where the camera would fight it.
        <OrbitControls
          enabled={!measuring && !isDraggingChair}
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
        <TableSeat
          key={seat.member.user_id}
          seat={seat}
          onAvatarPoseDebug={onAvatarPoseDebug}
          draggable={seat.member.user_id === draggableUserId}
          onDragPointerDown={
            seat.member.user_id === draggableUserId
              ? (event) => handleChairPointerDown(seat.member.user_id, event)
              : undefined
          }
        />
      ))}
    </>
  );
}
