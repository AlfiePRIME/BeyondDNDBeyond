"use client";

import { Component, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  getEffectiveSeat,
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
import {
  WhiteboardPlane,
  type WhiteboardDebugState,
  type WhiteboardGridPoint,
  type WhiteboardHandle,
  type WhiteboardHistoryState,
  type WhiteboardTileData,
  type WhiteboardTileUpdate,
  type WhiteboardTool,
} from "./WhiteboardPlane";
import {
  DEFAULT_WHITEBOARD_BRUSH_SIZE,
  DEFAULT_WHITEBOARD_COLOR,
  DEFAULT_WHITEBOARD_HEIGHT,
  type WhiteboardBrushSize,
} from "./whiteboardMath";

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
// Turn camera: an automatically-offered better vantage on the viewing
// player's own combat turn (see GameTableSceneProps.turnCameraActive's own
// doc comment for the full gating story — cameraMode/orbit-vs-seat/dismiss/
// chair-drag deferral all live in GameRoom.tsx; this file's only job is
// "what does the improved angle actually look like"). Keeps the exact same
// angular direction from LOOK_TARGET the seat's own normal camera already
// uses (seating.ts's seatAtAngle placement), so the improved view still
// favors the player's own side of the table — just extends that same ray
// further out (more of the tabletop fits in the same fov) and up (a more
// top-down look, matching the brief's own "slightly higher, more top-down"
// framing) rather than picking a fresh, unrelated vantage.
const TURN_CAMERA_SETBACK_BONUS = 2.2;
const TURN_CAMERA_HEIGHT_BONUS = 2.4;

/**
 * Derives the improved "your turn" camera position from a seat's own
 * already-EFFECTIVE cameraPosition (i.e. whatever applySeatOffset already
 * resolved it to — includes any persisted or in-progress chair-drag offset,
 * per the project owner's explicit "derive from the actual current
 * position, not the static default" call), never seating.ts's raw
 * per-angle default directly. Pure function of that one point (plus the
 * fixed LOOK_TARGET every seat's camera already looks at) so it needs no
 * extra seat/table plumbing beyond what this file already threads through.
 */
function computeTurnCameraPosition(
  seatCameraPosition: readonly [number, number, number]
): [number, number, number] {
  const dx = seatCameraPosition[0] - LOOK_TARGET[0];
  const dz = seatCameraPosition[2] - LOOK_TARGET[2];
  const horizontalDistance = Math.hypot(dx, dz);
  // Degenerate case (camera already directly above the look target) is
  // never actually reachable via seatAtAngle's own fixed CAMERA_SETBACK,
  // but guarded anyway the same defensive way seating.ts's own
  // outwardFromCenter guards a zero-distance point: no horizontal
  // direction to extend along, so just add height.
  if (horizontalDistance < 1e-6) {
    return [seatCameraPosition[0], seatCameraPosition[1] + TURN_CAMERA_HEIGHT_BONUS, seatCameraPosition[2]];
  }
  const scale = (horizontalDistance + TURN_CAMERA_SETBACK_BONUS) / horizontalDistance;
  return [
    LOOK_TARGET[0] + dx * scale,
    seatCameraPosition[1] + TURN_CAMERA_HEIGHT_BONUS,
    LOOK_TARGET[2] + dz * scale,
  ];
}

// ---------------------------------------------------------------------------
// Seated look-around: a seated viewer can nudge where their own camera
// LOOKS — "turning their head" — using the arrow keys, independent of
// wherever `cameraPosition` currently is (plain seat default, the turn
// camera's improved angle, or a previously-persisted chair-drag offset —
// never a LIVE in-progress one; the camera deliberately holds still for the
// whole drag gesture, see the "Movable chairs" block comment above). This is
// PURELY a rotation of the lookAt direction; it never touches camera
// position, which stays entirely owned by the seat/turn-camera/chair-drag
// logic elsewhere in this file (computeTurnCameraPosition above,
// applySeatOffset, getEffectiveSeat).
//
// Composition with the turn camera (the explicit judgment call the brief
// asked for): look-around stays available, unmodified, while the turn
// camera's improved angle is active. computeTurnCameraPosition only ever
// changes WHERE the camera sits, never LOOK_TARGET — the turn camera is
// still fundamentally a seat-mode view looking at the same table center,
// just from a repositioned vantage — so the exact same "rotate away from
// the straight-at-LOOK_TARGET direction" offset applies unmodified whether
// `cameraPosition` currently holds the plain seat default or the improved
// turn-camera position. There's also a practical case for it: surveying the
// battlefield by looking around is exactly the kind of thing a player wants
// to do on their OWN turn, so suppressing it right when the turn camera
// activates would be actively unhelpful. It's disabled only where the brief
// explicitly calls for it — orbit mode (OrbitControls already provides free
// look there via mouse drag) and whenever this viewer has no seat of their
// own to look around from (the fallback camera).
// ---------------------------------------------------------------------------
const LOOK_AROUND_YAW_SPEED = 1.4; // rad/s of yaw while an arrow key is held
const LOOK_AROUND_PITCH_SPEED = 0.9; // rad/s of pitch while an arrow key is held
// Bounded well short of a full turn — "a player can't spin all the way
// around" — and the pitch bound is deliberately modest: every seat's own
// base look angle (LOOK_TARGET vs. CAMERA_EYE_HEIGHT/CAMERA_SETBACK,
// seating.ts) is already tilted down toward the table, so even this
// generous-feeling head-tilt range never reaches far enough to look through
// the floor, and never tilts up far enough to leave the room's own ceiling-
// less skybox looking like a mistake.
const LOOK_AROUND_MAX_YAW = (65 * Math.PI) / 180;
const LOOK_AROUND_MAX_PITCH = (18 * Math.PI) / 180;
// No further arrow-key input for this long smoothly eases the look
// direction back to dead-center on LOOK_TARGET.
const LOOK_AROUND_IDLE_MS = 30_000;
// Exponential-ease time constant for the recenter itself (frame-rate
// independent via useFrame's own `delta`) — chosen so the ease is clearly
// gradual (a couple of seconds to visually settle), never an instant snap,
// matching the same "smooth, not a snap" requirement the held-key rotation
// itself already satisfies by directly integrating a fixed angular rate.
const LOOK_AROUND_RECENTER_TAU = 0.9;
// Arbitrary distance for the lookAt point projected along the rotated
// look direction — only the DIRECTION this produces matters for orienting
// the camera; three.js's Object3D.lookAt has no notion of "how far away"
// beyond that.
const LOOK_AROUND_TARGET_DISTANCE = 10;

/** Same "don't hijack a keypress meant for a text field" guard MapEditor.tsx's
 * own undo/redo shortcut already uses (`event.target`, not
 * document.activeElement — for a window-level listener, a KeyboardEvent's
 * target IS whatever element currently has real focus) — reused verbatim
 * here for consistency rather than a second, differently-shaped check. The
 * concrete bug this exists for: a naive keydown listener bound straight to
 * the arrow keys also fires while the user is typing in the DM's notes, a
 * chat box, or any dropdown elsewhere on the page — hijacking a keypress
 * that should move a text cursor instead of rotating the camera. `.closest`
 * (rather than checking `target` itself) also catches a contenteditable
 * region's own descendant nodes, not just its own root element. */
function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]") !== null;
}

type ArrowDirection = "up" | "down" | "left" | "right";

function arrowKeyDirection(key: string): ArrowDirection | null {
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  return null;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Scratch vectors for the look-around useFrame below, reused per frame —
// same convention as the chairDrag*/ownChair* scratch objects just below.
const lookAroundBaseDir = new Vector3();
const lookAroundTarget = new Vector3();

// ---------------------------------------------------------------------------
// Movable chairs (drag gesture): a player may grab and drag their OWN chair
// (never another member's, never the DM's throne — see draggableUserId
// below) anywhere near the table arrangement. An earlier version of this
// feature made the player's own seated camera follow live during the
// gesture; the project owner reported that as disorienting ("still moves
// the camera... please make this stop whilst moving objects") and asked
// for it to be removed outright, so the camera now holds perfectly still
// for the whole gesture and only settles once, after the drop, to wherever
// the chair actually ends up (seatCameraPosition below reads through
// getEffectiveSeat/seatOffsets — the last PERSISTED position — never the
// live in-progress one). Reuses this same file's existing press-drag-release
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
// Freeze bug fix (critical, confirmed via real Playwright reproduction —
// see verify-seat-avatar-render-loop.mjs): this component MUST be memoized,
// and every callback it hands to SeatAvatar/the drag mesh MUST be its own
// stable useCallback, not an inline arrow created fresh per render.
//
// Root cause, traced end to end: SeatAvatar's own AvatarModel
// (SeatAvatar.tsx) reports its measured size via
// `useEffect(() => { onMeasureDebug?.(...) }, [sizeY, scale, onMeasureDebug])`
// — so a FRESH onMeasureDebug reference re-fires that effect even though
// sizeY/scale never changed. Before this fix, TableSeat built that closure
// inline in its own JSX (`onMeasureDebug={(m) => onAvatarMeasureDebug(seat
// .member.user_id, m)}`) with no memo boundary at all, so every single
// render of GameTableScene — triggered by ANY GameRoom state change
// whatsoever, e.g. clicking the "Free camera" toggle, or literally any
// other button — created a brand new closure, re-firing that effect, which
// called GameRoom's handleAvatarMeasureDebug, which (see its own doc
// comment) unconditionally created a new state object every call. That new
// state object re-rendered GameRoom, cascading right back through
// GameTableScene into an unmemoized TableSeat again — a genuine,
// unconditional infinite render loop with no possible exit, pegging the
// main thread and hard-freezing the tab. It only manifests for a seat whose
// member actually has a real avatar_url (SeatAvatar renders a static
// PlaceholderAvatar — no AvatarModel, no effect — for a memberless avatar),
// which is exactly why no existing verify-*.mjs script or this codebase's
// own automated tests (none of their synthetic test users ever set an
// avatar) had ever hit it, despite it firing on literally any click in a
// REAL game room where a real player customized their avatar.
//
// The `memo()` wrapper alone is not sufficient by itself: the OLD call site
// below (`seats.map(...)`) also built `onDragPointerDown` inline per seat
// for whichever single seat is this viewer's own draggable one, which would
// keep defeating the memo comparison for exactly that one seat. Fixed by
// handing TableSeat the stable, top-level handleChairPointerDown callback
// directly (GameTableScene's own useCallback, keyed off `[seats, layout
// .seats, camera, gl]`) and letting TableSeat itself bind its own seat's
// user_id via a local useCallback — the same shape onAvatarPoseDebug/
// onAvatarMeasureDebug already used. A useCallback'd closure stays
// REFERENTIALLY STABLE across re-renders of the same component instance
// whenever its own inputs haven't changed, regardless of whether the outer
// memo() bail succeeds — real defense in depth, not just a performance
// nicety, since it independently breaks the loop even if some future prop
// destabilizes TableSeat's own memo comparison again.
const TableSeat = memo(function TableSeat({
  seat,
  onAvatarPoseDebug,
  onAvatarMeasureDebug,
  draggable = false,
  onChairPointerDown,
}: {
  seat: Seat;
  /** Verification-only pass-through to SeatAvatar's onPoseDebug — see
   * GameTableSceneProps.onAvatarPoseDebug's doc comment. */
  onAvatarPoseDebug?: (userId: string, compatible: boolean) => void;
  /** Verification-only pass-through to SeatAvatar's onMeasureDebug — see
   * GameTableSceneProps.onAvatarMeasureDebug's doc comment. */
  onAvatarMeasureDebug?: (userId: string, measurement: { sizeY: number; scale: number }) => void;
  /** True only for the CURRENT viewer's own player seat (GameTableScene's
   * own draggableUserId) — the movable-chair prompt's explicit "a player can
   * drag their own chair... cannot drag another player's chair or the DM's
   * chair." Enforced here by simply never rendering the grab handle at all
   * for anyone else's seat — there's no gesture to intercept, not a runtime
   * permission check a determined client could route around. */
  draggable?: boolean;
  /** The raw, seat-agnostic handler (GameTableScene's own stable
   * handleChairPointerDown) — TableSeat binds this exact seat's own
   * user_id itself, below, rather than the caller pre-binding a fresh
   * closure per seat per render (see this component's own top doc comment
   * for why that distinction is load-bearing, not stylistic). */
  onChairPointerDown?: (userId: string, event: ThreeEvent<PointerEvent>) => void;
}) {
  const userId = seat.member.user_id;
  const handlePoseDebug = useCallback(
    (compatible: boolean) => onAvatarPoseDebug?.(userId, compatible),
    [onAvatarPoseDebug, userId]
  );
  const handleMeasureDebug = useCallback(
    (measurement: { sizeY: number; scale: number }) => onAvatarMeasureDebug?.(userId, measurement),
    [onAvatarMeasureDebug, userId]
  );
  const handleDragPointerDown = useCallback(
    (event: ThreeEvent<PointerEvent>) => onChairPointerDown?.(userId, event),
    [onChairPointerDown, userId]
  );
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
          onPoseDebug={onAvatarPoseDebug ? handlePoseDebug : undefined}
          onMeasureDebug={onAvatarMeasureDebug ? handleMeasureDebug : undefined}
        />
      </group>
      {draggable ? (
        <mesh position={[0, CHAIR_DRAG_HANDLE_Y, 0]} onPointerDown={handleDragPointerDown}>
          <boxGeometry args={CHAIR_DRAG_HIT_BOX} />
          {/* opacity-0, not visible={false} — an invisible mesh is skipped
              by the raycaster, which would defeat the hit box entirely
              (DmBookProp's own precedent). */}
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ) : null}
    </group>
  );
});

/** The currently-live map, already resolved to renderable form by the app
 * layer (dense cells, viewer-appropriate object flags, loadable URLs). */
export interface TableLiveMap {
  /** The map's own row id — used only to key the whiteboard drawing layer's
   * per-map in-memory cache (WhiteboardPlane.tsx), so switching which map is
   * live never shows one map's ink over another's. Nothing else here reads
   * it; every other field is unchanged from before the whiteboard feature. */
  id: string;
  gridWidth: number;
  gridHeight: number;
  cells: readonly MapSurfaceCell[];
  objects: readonly MapSurfaceObject[];
  tokens: readonly MapSurfaceToken[];
  /** This map's own already-persisted whiteboard tiles (docs/design/
   * whiteboard-drawing-layer.md §5.3) — fetched by GameRoom as part of the
   * same per-viewer map bundle every load/switch already re-fetches, and
   * passed straight through to WhiteboardPlane's own `initialTiles` prop to
   * hydrate its composite canvas. Defaults to an empty array for any
   * existing caller that hasn't been updated (none currently) — never
   * required for TableLiveMap's own core meaning, which predates the
   * whiteboard feature. */
  whiteboardTiles?: readonly WhiteboardTileData[];
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
  /** Verification-only: mirrors each seated member's own loaded avatar
   * model's measured bounding-box height and derived scale factor — same
   * reasoning as onAvatarPoseDebug, used to confirm/rule out an intermittent
   * mis-scaling race. Omitting it changes nothing about how avatars render. */
  onAvatarMeasureDebug?: (userId: string, measurement: { sizeY: number; scale: number }) => void;
  /** Verification-only pass-through to MapSurface's onObjectPoseDebug —
   * see its own doc comment. */
  onObjectPoseDebug?: (id: string, compatible: boolean) => void;
  /** Verification-only pass-through to MapSurface's onObjectMeasureDebug —
   * see its own doc comment. */
  onObjectMeasureDebug?: (id: string, measurement: { maxDim: number; scale: number }) => void;
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
   * whenever it genuinely changes. Camera-follow-during-drag was removed
   * (project owner's explicit ask — see the "Movable chairs" block comment
   * above), so this now exists to let a real Playwright drag simulation
   * prove the NEGATIVE directly — that this value never fires again (and
   * the camera position stays byte-for-byte identical) for the ENTIRE
   * duration of an active chair drag — rather than trusting
   * seatCameraPosition's own getEffectiveSeat-based derivation by inference
   * alone. Still fires normally for every other legitimate camera change
   * (seat mode switch, turn camera, a drag's post-drop settle). Not read by
   * GameTableScene itself. */
  onOwnCameraDebug?: (position: readonly [number, number, number]) => void;
  /** Turn camera: fires whenever THIS viewer's own chair-drag session
   * starts or stops. Not verification-only like onOwnChairProjectedPosition/
   * onOwnCameraDebug above — GameRoom.tsx mirrors it into its own state so
   * it can defer showing/applying the improved "your turn" camera (or the
   * orbit-mode offer to switch to it) until an in-progress drag actually
   * finishes, per the project owner's confirmed "don't fight an
   * already-in-progress drag" call. Only ever reflects the current viewer's
   * own draggable chair — nobody else's chair can ever start a drag session
   * on this client (draggableUserId's own single-seat restriction, above),
   * so there's no per-user keying to do here. */
  onChairDraggingChange?: (dragging: boolean) => void;
  /** Turn camera: true means "the viewing player's own combat turn is
   * active, they're in seat mode, and nothing currently suppresses it"
   * (isDraggingChair aside — this file re-checks that itself; see
   * turnCameraApplied's own comment below for why). GameRoom.tsx computes
   * this whole gate itself — it alone knows whose combat turn is active,
   * owns cameraMode, and tracks the offer/dismiss state — so this file's
   * only remaining job is "what does the improved angle actually look
   * like" (computeTurnCameraPosition above), derived from this seat's own
   * EFFECTIVE cameraPosition (post chair-drag-offset), never a static
   * default. Absent/false renders byte-for-byte this prompt's pre-existing
   * seated camera, exactly like every other optional prop here defaults to
   * "unchanged behavior". */
  turnCameraActive?: boolean;
  /** Fires on every genuine change to this scene's own internal
   * localChairOverride (its own doc comment below) — every single
   * "pointermove" tick of an active drag, and once more (with `null`) the
   * instant it clears (release, or the `seatOffsets` prop itself catching
   * up). This is what lets the app layer's own derived state (GameRoom.tsx's
   * memberTrayPositions) track a chair LIVE while it's being dragged, not
   * just once the drag ends and the persist-then-broadcast round trip
   * catches up — deliberately the ONE place a live in-progress offset still
   * flows anywhere (a personal dice tray following its owner's chair mid-
   * drag is a wanted, harmless side effect the project owner never asked to
   * change; only the CAMERA's own live tracking was). Only ever fires for
   * `currentUserId`'s own seat — nothing else can ever be mid-drag on this
   * client (draggableUserId's own doc comment). */
  onLiveChairOffset?: (override: { userId: string; offset: SeatOffset } | null) => void;
  /** Verification-only: this client's own look-around yaw/pitch offset (see
   * the "Seated look-around" block comment above), in radians, fired
   * whenever it genuinely changes — the same "WebGL has no DOM of its own
   * for a test to inspect a camera's orientation directly" reasoning as
   * onOwnCameraDebug, generalized from position to look direction. Not read
   * by GameTableScene itself; changes nothing about how anything renders or
   * rotates. */
  onLookAroundDebug?: (state: { yaw: number; pitch: number }) => void;
  /** Whiteboard drawing layer (docs/design/whiteboard-drawing-layer.md,
   * Prompt 2): true only for the DM's own client while draw mode is toggled
   * on in MapPanel.tsx — gates ONLY WhiteboardPlane's own invisible hit-plane
   * (the always-mounted VISIBLE plane renders for every viewer regardless,
   * so players see the DM's ink with no separate toggle of their own). */
  whiteboardInteractive?: boolean;
  /** DM-adjustable Y offset (world units) above the tabletop the whiteboard
   * plane floats at — a plain numeric slider in MapPanel.tsx, not a 3D drag
   * handle (docs/design/whiteboard-drawing-layer.md §6: no TransformControls
   * precedent exists anywhere in this codebase). */
  whiteboardHeight?: number;
  whiteboardTool?: WhiteboardTool;
  whiteboardColor?: string;
  whiteboardBrushSize?: WhiteboardBrushSize;
  /** Real (not verification-only) callback: mirrors the active map's own
   * whiteboard undo/redo stack sizes up to MapPanel.tsx's toolbar so it can
   * enable/disable its Undo/Redo buttons. */
  onWhiteboardHistoryChange?: (state: WhiteboardHistoryState) => void;
  /** Verification-only pass-through to WhiteboardPlane's own onDebug — see
   * its doc comment (the onTokenSlideDebug "WebGL has no DOM of its own"
   * precedent). Omitting it changes nothing about how anything renders or
   * draws. */
  onWhiteboardDebug?: (state: WhiteboardDebugState) => void;
  /** Verification-only pass-through to WhiteboardPlane's own
   * onCenterProjectedPosition — see its doc comment. */
  onWhiteboardCenterProjectedPosition?: (point: [number, number] | null) => void;
  /** Registers (or clears, on unmount) this client's whiteboard imperative
   * handle — undo()/redo()/clear() — the registerDiceTumbleRef precedent,
   * simplified to a single instance since only one whiteboard is ever
   * mounted at a time (one per live map, not one per member). Passed
   * straight through as WhiteboardPlane's own `ref` — a plain callback prop
   * is already exactly the shape a React ref callback needs. */
  onWhiteboardHandleReady?: (handle: WhiteboardHandle | null) => void;
  /** Persistence and live sync (docs/design/whiteboard-drawing-layer.md §5,
   * Prompt 3) — straight pass-throughs to WhiteboardPlane's own identically-
   * named props/imperative-handle methods; see WhiteboardPlane.tsx's own
   * doc comments for what each one means. GameTableScene stays a pure
   * pass-through here (no data-access, no realtime channel) — GameRoom.tsx
   * is the actual orchestrator for all of it. */
  onWhiteboardLocalStrokeStart?: (
    mapId: string,
    info: { strokeId: string; tool: WhiteboardTool; color: string; brushSize: WhiteboardBrushSize; point: WhiteboardGridPoint }
  ) => void;
  onWhiteboardLocalStrokePoint?: (mapId: string, strokeId: string, point: WhiteboardGridPoint) => void;
  onWhiteboardLocalStrokeEnd?: (mapId: string, strokeId: string) => void;
  onWhiteboardTilesPersist?: (mapId: string, changes: readonly WhiteboardTileUpdate[]) => void;
  onWhiteboardClearPersist?: (mapId: string) => void;
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
  onAvatarMeasureDebug,
  onObjectPoseDebug,
  onObjectMeasureDebug,
  seatOffsets = EMPTY_SEAT_OFFSETS,
  onChairDragEnd,
  onOwnChairProjectedPosition,
  onOwnCameraDebug,
  onChairDraggingChange,
  turnCameraActive = false,
  onLiveChairOffset,
  onLookAroundDebug,
  whiteboardInteractive = false,
  whiteboardHeight = DEFAULT_WHITEBOARD_HEIGHT,
  whiteboardTool = "pen",
  whiteboardColor = DEFAULT_WHITEBOARD_COLOR,
  whiteboardBrushSize = DEFAULT_WHITEBOARD_BRUSH_SIZE,
  onWhiteboardHistoryChange,
  onWhiteboardDebug,
  onWhiteboardCenterProjectedPosition,
  onWhiteboardHandleReady,
  onWhiteboardLocalStrokeStart,
  onWhiteboardLocalStrokePoint,
  onWhiteboardLocalStrokeEnd,
  onWhiteboardTilesPersist,
  onWhiteboardClearPersist,
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
  // Turn camera: mirrors isDraggingChair out to GameRoom.tsx (see
  // onChairDraggingChange's own doc comment) — fires exactly on the two
  // real transitions (drag starts, drag ends), never every render, since
  // the effect only re-runs when isDraggingChair itself actually changes
  // value.
  useEffect(() => {
    onChairDraggingChange?.(isDraggingChair);
  }, [isDraggingChair, onChairDraggingChange]);
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

  // Reports localChairOverride's own value upward on every genuine change —
  // see GameTableSceneProps.onLiveChairOffset's own doc comment for why:
  // this is the ONE piece of this scene's purely-local drag state the app
  // layer has no other way to observe live (onOwnCameraDebug/
  // onOwnChairProjectedPosition below already cover the seated camera and
  // the screen projection, but neither hands back the raw offset a
  // consumer like a personal dice tray's own position derivation actually
  // needs).
  useEffect(() => {
    onLiveChairOffset?.(localChairOverride);
  }, [localChairOverride, onLiveChairOffset]);

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
  // Camera-follow-during-drag REMOVED (project owner's explicit ask:
  // dragging your own chair — or watching your tray shift alongside it —
  // must never move the camera while the drag is in progress). `mySeat`
  // above reads through `seats`, which is intentionally live during an
  // active drag (localChairOverride) so the CHAIR MESH itself still tracks
  // the cursor smoothly — but `seatCameraPosition` deliberately reads
  // through `layout`/`seatOffsets` instead (getEffectiveSeat, seating.ts),
  // which only ever reflects the last PERSISTED offset, never the local,
  // still-in-progress one. The practical effect: the seated camera holds
  // perfectly still for the ENTIRE gesture (press through release), and
  // only settles once — to wherever the chair actually ends up — after
  // GameRoom.tsx's persist-then-broadcast round trip lands a new
  // `seatOffsets` prop. That single post-drop settle is deliberately kept:
  // it's the same "your camera sits wherever your chair currently is"
  // invariant every OTHER seat position change (a page load, another
  // client's earlier drag) already produces, and nothing in the bug report
  // asked for that to change — only the LIVE, mid-gesture tracking Prompt 4b
  // added is being removed here.
  const myPersistedSeat = currentUserId ? getEffectiveSeat(layout, currentUserId, seatOffsets) : null;
  const seatCameraPosition = myPersistedSeat ? myPersistedSeat.cameraPosition : FALLBACK_CAMERA_POSITION;
  // Turn camera: GameRoom.tsx's turnCameraActive prop already encodes the
  // camera-mode/dismiss/drag gating (see that prop's own doc comment), but
  // `isDraggingChair` is re-checked directly here rather than trusted
  // solely via the onChairDraggingChange mirror above — that callback fires
  // one render AFTER the state change lands here, so a parent reacting to
  // it is necessarily one frame behind. Checking the authoritative local
  // state directly instead closes that gap completely, guaranteeing the
  // turn camera never applies mid-drag even for a single frame (moot for
  // camera-follow itself now that it's gone, but the turn camera's own
  // "never fight an in-progress drag" contract still needs this).
  const turnCameraApplied = turnCameraActive && cameraMode === "seat" && mySeat !== undefined && !isDraggingChair;
  const cameraPosition = turnCameraApplied ? computeTurnCameraPosition(seatCameraPosition) : seatCameraPosition;

  // Seated look-around: eligible whenever this viewer is actually seated in
  // seat mode — deliberately NOT further gated on turnCameraApplied/
  // isDraggingChair (see the "Seated look-around" block comment above for
  // why composing with the turn camera is the right call; a chair drag is a
  // MOUSE gesture and this is a KEYBOARD one, so the two simply don't
  // conflict either way).
  const lookAroundEligible = cameraMode === "seat" && mySeat !== undefined;

  // Which arrow key(s) are CURRENTLY held — read every frame inside
  // useFrame below, never itself driving a re-render (a naive React state
  // flag flipped 60x/sec while a key is held would be a lot of needless
  // renders for a value nothing in this component's own render output
  // depends on).
  const lookAroundKeysRef = useRef<Record<ArrowDirection, boolean>>({
    up: false,
    down: false,
    left: false,
    right: false,
  });
  // The look-around's own accumulated offset (radians) from the seat's
  // straight-at-LOOK_TARGET direction — refs, not state, mutated once per
  // frame inside useFrame rather than driving a render every frame.
  const lookAroundYawRef = useRef(0);
  const lookAroundPitchRef = useRef(0);
  // performance.now() of the most recent frame where an arrow key was
  // genuinely acted on — null means "already at rest", which never needs
  // recentering since there's nothing left to recenter.
  const lookAroundLastInputRef = useRef<number | null>(null);
  // Verification-only debug mirror — see onLookAroundDebug's own doc
  // comment on GameTableSceneProps.
  const lastLookAroundDebug = useRef<{ yaw: number; pitch: number } | null>(null);

  // Arrow-key listeners for the look-around gesture. Registered on
  // `window` (same as the chair-drag/ruler pointer listeners above) rather
  // than on the canvas, since a KeyboardEvent only ever reaches whatever
  // element currently has DOM focus — the canvas itself is rarely, if
  // ever, the focused element in this app. `isTypingTarget` (above) is the
  // explicit guard against the concrete bug the brief calls out: a naive
  // listener bound straight to these keys would also fire while the user
  // is typing in the DM's notes, a chat box, or any dropdown elsewhere on
  // the page, hijacking a keypress that should move a text cursor instead
  // of rotating the camera. That guard is re-checked on EVERY keydown
  // (including OS auto-repeat while a key stays held — each repeat is
  // dispatched to whatever element currently has focus, not frozen to
  // whatever had focus at the initial press), so focus moving into a text
  // field mid-hold immediately stops the rotation too, not just a fresh
  // press starting one.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const direction = arrowKeyDirection(event.key);
      if (!direction) return;
      if (isTypingTarget(event.target)) {
        // Let the field's own normal text-cursor behavior proceed
        // completely unimpeded (no preventDefault) — and if this key was
        // already held from before focus moved into the field, stop
        // treating it as held so a stray, still-physically-down key can't
        // keep rotating the camera behind a field the user is now typing
        // into.
        lookAroundKeysRef.current[direction] = false;
        return;
      }
      if (!lookAroundEligible) return;
      // Prevents the page itself from scrolling on an unmodified arrow
      // key — the same reason a naive listener would otherwise be a
      // problem, just from the other direction (this key genuinely IS for
      // the camera right now).
      event.preventDefault();
      lookAroundKeysRef.current[direction] = true;
    }
    function handleKeyUp(event: KeyboardEvent) {
      const direction = arrowKeyDirection(event.key);
      if (!direction) return;
      lookAroundKeysRef.current[direction] = false;
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [lookAroundEligible]);

  // The look-around rotation itself — a separate useFrame from the
  // debug-reporting one below since the two are unrelated concerns (this
  // one actually drives the camera's orientation every frame; the other
  // only ever reports state outward for verification).
  useFrame((_, delta) => {
    if (!lookAroundEligible) {
      // Not eligible right now (orbit mode, or this viewer has no seat of
      // their own) — reset to centered so a LATER re-entry into seat mode
      // always starts from a known, non-stale look direction rather than
      // wherever an earlier session happened to leave it. OrbitControls
      // owns the camera's rotation entirely while in orbit mode (via its
      // own `target`), so this deliberately touches nothing about the
      // camera itself here.
      lookAroundYawRef.current = 0;
      lookAroundPitchRef.current = 0;
      lookAroundLastInputRef.current = null;
      if (onLookAroundDebug && lastLookAroundDebug.current !== null) {
        lastLookAroundDebug.current = null;
        onLookAroundDebug({ yaw: 0, pitch: 0 });
      }
      return;
    }

    const keys = lookAroundKeysRef.current;
    const yawInput = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const pitchInput = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
    const hasInput = yawInput !== 0 || pitchInput !== 0;

    if (hasInput) {
      lookAroundLastInputRef.current = performance.now();
      lookAroundYawRef.current = clampNumber(
        lookAroundYawRef.current + yawInput * LOOK_AROUND_YAW_SPEED * delta,
        -LOOK_AROUND_MAX_YAW,
        LOOK_AROUND_MAX_YAW
      );
      lookAroundPitchRef.current = clampNumber(
        lookAroundPitchRef.current + pitchInput * LOOK_AROUND_PITCH_SPEED * delta,
        -LOOK_AROUND_MAX_PITCH,
        LOOK_AROUND_MAX_PITCH
      );
    } else if (
      lookAroundLastInputRef.current !== null &&
      performance.now() - lookAroundLastInputRef.current >= LOOK_AROUND_IDLE_MS &&
      (lookAroundYawRef.current !== 0 || lookAroundPitchRef.current !== 0)
    ) {
      // 30 continuous seconds with no arrow-key input: smoothly ease back
      // to the default table-center look direction. An exponential ease
      // (frame-rate independent via `delta`), not an instant snap — the
      // same "smooth, not a snap" requirement the held-key rotation above
      // already satisfies by directly integrating a fixed angular rate
      // frame over frame rather than jumping to an end value.
      const eased = 1 - Math.exp(-delta / LOOK_AROUND_RECENTER_TAU);
      lookAroundYawRef.current *= 1 - eased;
      lookAroundPitchRef.current *= 1 - eased;
      if (Math.abs(lookAroundYawRef.current) < 1e-4) lookAroundYawRef.current = 0;
      if (Math.abs(lookAroundPitchRef.current) < 1e-4) lookAroundPitchRef.current = 0;
    }

    if (onLookAroundDebug) {
      const last = lastLookAroundDebug.current;
      const changed =
        !last ||
        Math.abs(last.yaw - lookAroundYawRef.current) > 1e-4 ||
        Math.abs(last.pitch - lookAroundPitchRef.current) > 1e-4;
      if (changed) {
        const next = { yaw: lookAroundYawRef.current, pitch: lookAroundPitchRef.current };
        lastLookAroundDebug.current = next;
        onLookAroundDebug(next);
      }
    }

    if (lookAroundYawRef.current === 0 && lookAroundPitchRef.current === 0) {
      // Already centered — plain lookAt(LOOK_TARGET), byte-for-byte the
      // pre-look-around behavior (and skips a wasted normalize/spherical
      // round-trip every single frame for the — by far — most common
      // case: nobody currently touching the arrow keys).
      camera.lookAt(...LOOK_TARGET);
      return;
    }

    // Rotate the look direction AWAY from LOOK_TARGET by the accumulated
    // yaw/pitch offset, entirely in spherical terms relative to the
    // camera's own CURRENT position (whichever of seat/turn-camera/
    // chair-drag positioning currently owns it) — never moving that
    // position itself.
    lookAroundBaseDir.set(
      LOOK_TARGET[0] - camera.position.x,
      LOOK_TARGET[1] - camera.position.y,
      LOOK_TARGET[2] - camera.position.z
    );
    const horizontal = Math.hypot(lookAroundBaseDir.x, lookAroundBaseDir.z);
    const baseYaw = Math.atan2(lookAroundBaseDir.x, lookAroundBaseDir.z);
    const basePitch = Math.atan2(lookAroundBaseDir.y, horizontal);
    const yaw = baseYaw + lookAroundYawRef.current;
    const pitch = basePitch + lookAroundPitchRef.current;
    const cosPitch = Math.cos(pitch);
    lookAroundTarget.set(
      camera.position.x + LOOK_AROUND_TARGET_DISTANCE * cosPitch * Math.sin(yaw),
      camera.position.y + LOOK_AROUND_TARGET_DISTANCE * Math.sin(pitch),
      camera.position.z + LOOK_AROUND_TARGET_DISTANCE * cosPitch * Math.cos(yaw)
    );
    camera.lookAt(lookAroundTarget);
  });

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

  // Whiteboard drawing layer: mirrors WhiteboardPlane's own in-progress-
  // stroke state (its `isDrawing`), purely so OrbitControls can be disabled
  // for the same reason `measuring`/`isDraggingChair` already disable it
  // below — OrbitControls binds its own native pointer listeners on the
  // canvas DOM element, independent of r3f's synthetic per-mesh event
  // dispatch, so a `stopPropagation()` on the whiteboard hit-plane's own
  // pointerdown does NOT by itself stop OrbitControls from ALSO treating the
  // same drag as a camera orbit while free-camera mode is active. Purely
  // internal wiring — WhiteboardPlane already exposes this via its own
  // onDrawingChange prop (the onChairDraggingChange precedent), so no new
  // prop needs to reach GameRoom.tsx for it.
  const [isWhiteboardDrawing, setIsWhiteboardDrawing] = useState(false);

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
          enabled={!measuring && !isDraggingChair && !isWhiteboardDrawing}
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
        <>
          {/* Nudged just above the tabletop so the map's base slab never
              z-fights the wood. x/z stay at the world origin — the seam
              between the two tables (CombinedTable's own doc comment) — on
              the project owner's explicit call to keep the live map's existing
              single-table-sized fit (mapFit.ts's computeTableMapMetrics,
              completely unchanged) centered on that seam, straddling both
              tables equally, rather than pushed flush against either one. */}
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
              onObjectMeasureDebug={onObjectMeasureDebug}
            />
          </group>
          {/* Whiteboard drawing layer (docs/design/whiteboard-drawing-layer.md,
              Prompt 2) — a SEPARATE group at its own DM-adjustable height,
              same x/z centering as the map's own group above (both sit at
              local x=0/z=0, so WhiteboardPlane's world→pixel math lines up
              with MapSurface's cells without any extra offset math). Always
              rendered whenever a live map is showing — the always-mounted
              visible plane costs nothing when blank and is what lets
              players see the DM's ink with no toggle of their own; only the
              invisible hit-plane is gated on whiteboardInteractive. */}
          <group position={[0, TABLE_SURFACE_Y + whiteboardHeight, 0]}>
            <WhiteboardPlane
              ref={onWhiteboardHandleReady}
              mapId={liveMap.id}
              gridWidth={liveMap.gridWidth}
              gridHeight={liveMap.gridHeight}
              cellSize={mapMetrics.cellSize}
              worldY={TABLE_SURFACE_Y + whiteboardHeight}
              interactive={whiteboardInteractive}
              tool={whiteboardTool}
              color={whiteboardColor}
              brushSize={whiteboardBrushSize}
              onDrawingChange={setIsWhiteboardDrawing}
              onHistoryChange={onWhiteboardHistoryChange}
              onDebug={onWhiteboardDebug}
              onCenterProjectedPosition={onWhiteboardCenterProjectedPosition}
              initialTiles={liveMap.whiteboardTiles}
              onLocalStrokeStart={onWhiteboardLocalStrokeStart}
              onLocalStrokePoint={onWhiteboardLocalStrokePoint}
              onLocalStrokeEnd={onWhiteboardLocalStrokeEnd}
              onTilesPersist={onWhiteboardTilesPersist}
              onClearPersist={onWhiteboardClearPersist}
            />
          </group>
        </>
      ) : null}

      {seats.map((seat) => (
        <TableSeat
          key={seat.member.user_id}
          seat={seat}
          onAvatarPoseDebug={onAvatarPoseDebug}
          onAvatarMeasureDebug={onAvatarMeasureDebug}
          draggable={seat.member.user_id === draggableUserId}
          // The stable top-level handler itself, not a per-seat closure
          // built here — see TableSeat's own top doc comment for why that
          // distinction is what actually keeps this memoized component's
          // props referentially stable across unrelated re-renders.
          onChairPointerDown={handleChairPointerDown}
        />
      ))}
    </>
  );
}
