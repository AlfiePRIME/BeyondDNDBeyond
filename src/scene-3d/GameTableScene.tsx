"use client";

import {
  Component,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Clone, OrbitControls, PerspectiveCamera, RoundedBox, useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { Box3, DoubleSide, Plane, Raycaster, SRGBColorSpace, TextureLoader, Vector2, Vector3 } from "three";
import type { Camera, Group, Object3D, Texture } from "three";
import { LEG, TABLE_TOP, TABLE_SURFACE_Y, TABLE_TOP_JOIN_DEPTH } from "./table";
import {
  applySeatOffset,
  clampToTableArrangement,
  computeCampaignSeatLayout,
  getEffectiveSeat,
  PLAYER_CHAIR_FRONTAGE,
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
import { DEFAULT_NAME_LABEL_COLOR, SeatNameLabel } from "./SeatNameLabel";
// DM tray drag: only needed to size the tray's own invisible grab-handle hit
// box proportionally to its real footprint (PERSONAL_TRAY_RADIUS) — no
// circular import risk, DiceTumble.tsx does not import anything from this
// file.
import { PERSONAL_TRAY_RADIUS } from "./DiceTumble";
import {
  MapSurface,
  mapCellOffsets,
  type MapSurfaceCell,
  type MapSurfaceObject,
  type MapSurfaceToken,
} from "./MapSurface";
// Live-room object placement/move (see the "Live-room object placement
// preview + move-drag" section below): only needed to size the new
// placement-preview/drag ghost and grab handle proportionally to the SAME
// real footprint every placed object itself renders at — no circular import
// risk, PlacedObject.tsx does not import anything from this file.
import { PLACED_OBJECT_SIZE } from "./PlacedObject";
import { computeTableMapMetrics } from "./mapFit";
import { computeMapArtFit } from "./mapArtFit";
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
import { WeatherParticles, type WeatherParticlesDebugState } from "./WeatherParticles";
import { CloudLayer } from "./CloudLayer";

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

/** Every campaign weather value (Weather & Enemies C1, widened with
 * 'cloudy' by migration 0079_cloudy_weather.sql) — mirrors
 * data-access/campaigns.ts's own WeatherKind (a separate, independently-
 * declared identical union, same DayNightMode-vs-DayNightMode split already
 * established above: this file's own type is the scene's local vocabulary,
 * not an import from data-access, so scene-3d never depends on it). Only
 * 'fog' affects this file's own fog composition (resolveSceneFog below) —
 * 'rain'/'thunderstorm'/'firestorm'/'acid_storm' are C2-C4's own separate
 * overlay effects layered on TOP of this scene (Droplets, lightning,
 * particles); 'cloudy' is CloudLayer's own overhead sky-dressing effect
 * (see its doc comment for the full 'cloudy' vs 'fog' distinction) and,
 * like every kind besides 'fog', renders identically to 'clear' here. */
export type WeatherKind = "clear" | "fog" | "cloudy" | "rain" | "thunderstorm" | "firestorm" | "acid_storm";

/** Weather's own fog (Weather & Enemies C1), used only when weatherKind is
 * 'fog' — deliberately NOT tied to either day/night preset's roomBg color
 * (unlike their own fog, which always matches the room background so it
 * reads as "the void fades to black/purple at distance" rather than a real
 * weather effect): a distinct neutral grey-white mist. Pulled much closer
 * than either preset's own fogNear/fogFar (day 16/34, night 12/28) so the
 * haze is unmistakable well within normal seated/orbit viewing distance,
 * not just a faint tint at the horizon — see resolveSceneFog's own doc
 * comment for the exact composition rule with day/night. */
const WEATHER_FOG_PRESET = {
  color: "#9aa0ad",
  near: 3,
  far: 15,
} as const;

/**
 * Composes day/night's own fog (DAY_NIGHT_PRESETS) with weather's fog: the
 * exact rule from Weather & Enemies C1's own Notes — when weatherKind is
 * 'fog', weather's fog near/far/color completely overrides day/night's own;
 * for every other weatherKind (including 'clear', and every kind C1 doesn't
 * render anything for yet), day/night's own fog stands exactly as it always
 * has, so there's no fighting over fog values and zero regression to
 * today's rendering. A pure function of the two enum inputs, with no scene
 * state of its own, so callers outside the R3F tree (GameRoom.tsx's hidden
 * weather-state debug mirror) can call it directly for a real fog-value
 * read rather than needing anything off the live WebGL scene. */
export function resolveSceneFog(
  dayNightMode: DayNightMode,
  weatherKind: WeatherKind
): { color: string; near: number; far: number } {
  if (weatherKind === "fog") {
    return { color: WEATHER_FOG_PRESET.color, near: WEATHER_FOG_PRESET.near, far: WEATHER_FOG_PRESET.far };
  }
  const lighting = DAY_NIGHT_PRESETS[dayNightMode];
  return { color: lighting.roomBg, near: lighting.fogNear, far: lighting.fogFar };
}

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

/** Projects a raw pointer event's canvas-relative client coordinates onto a
 * horizontal plane at world height `planeY` (see the block comment above) —
 * null only if the ray is parallel to that plane (looking exactly along the
 * horizon), in which case callers simply skip that update and keep whatever
 * position they already had.
 *
 * `planeY` defaults to 0 — the floor every dragged CHAIR travels along — so
 * every pre-existing call site (all of which omit it) is byte-for-byte
 * unchanged. DM tray drag (below) is the one caller that passes a non-zero
 * height: the tray sits at table-surface height, not the floor, and
 * DmBookProp.tsx's own `floorPointAtHeight` establishes why that distinction
 * matters for a prop that isn't the floor-anchored chair this raycast was
 * originally built for — raycasting the FLOOR plane for an object that
 * actually sits much higher up would make its drag track the cursor at the
 * wrong rate (a low, near-horizon floor-plane intersection is far more
 * sensitive to camera angle than one much closer to the camera's own
 * height). Reused (not re-implemented a third time) rather than duplicated
 * the way DmBookProp.tsx duplicates it: that file is a separate component
 * with no existing raycast helper of its own to extend, while this one
 * already has this exact helper right here in the same module. */
function floorPointFromClientXY(
  camera: Camera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  planeY = 0
): { x: number; z: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  chairDragNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  chairDragRaycaster.setFromCamera(chairDragNdc, camera);
  // Plane: normal·point + constant = 0, normal = (0,1,0) ⇒ point.y =
  // -constant — set fresh per call (DmBookProp.tsx's own floorPointAtHeight
  // precedent) since this scratch plane is shared across every call site.
  chairDragPlane.constant = -planeY;
  const hit = chairDragRaycaster.ray.intersectPlane(chairDragPlane, chairDragHit);
  return hit ? { x: chairDragHit.x, z: chairDragHit.z } : null;
}

// ---------------------------------------------------------------------------
// Chair/tray drag feel: bug report (a) — "dragging a chair or a personal
// dice tray moves so fast and weirdly you can't see where it will end up."
// Root cause confirmed by inspection, not guesswork: floorPointFromClientXY
// above raycasts the pointer against a near-flat, near-horizon plane every
// single call with NO smoothing, and handleMove (below) feeds that raw hit
// straight into setLocalChairOverride immediately, every pointermove event.
// Near the horizon a perspective-camera raycast against a flat plane is
// wildly non-linear — a couple of screen pixels of mouse motion can sweep
// meters of world space — and there was previously zero visual feedback
// showing WHERE the drop would land until the chair actually snapped there.
//
// A personal dice tray (seating.ts's computeMemberTrayPosition) has no
// separate drag gesture of its own at all — confirmed by inspection of
// DiceTumble.tsx/PlacedObject.tsx (neither wires up any pointer handler) and
// GameRoom.tsx (ConnectedMemberDiceTray's own `trayPosition` prop is a pure
// derived value, `memberTrayPositions`, fed by `liveSeatOffsets` — the
// PERSISTED seatOffsets Map with this exact scene's own live, in-progress
// chair offset patched on top via onLiveChairOffset). In other words: "drag
// your personal dice tray" and "drag your own chair" are the SAME gesture —
// a tray simply rides along next to whichever chair it's anchored to,
// there's no independent tray-drag entry point to separately fix. Calming
// THIS one gesture (the only one that exists) is what the bug report for
// both objects actually needs.
//
// Two independent, additive changes below, both scoped to purely-local,
// per-client visual state (never touching the RAW target itself, which
// stays exactly as precise and immediate as before — still needed for
// clamping/collision math, the live tray-follow offset, and the final
// committed drop):
//   1. A translucent ghost/preview ring (ChairDragGhost) rendered at the RAW
//      drag target for the whole gesture, continuously, so the destination
//      is visible in real time before release — MapSurface.tsx's own
//      established "ghost" convention (ObjectMarker's `ghost` prop: a
//      translucent PURPLE wireframe for a not-yet-committed placement),
//      reused here as a flat ring (a floor position, not a placed 3D prop)
//      rather than inventing a new visual language.
//   2. The DRAGGED chair's own RENDERED position (TableSeat's `smoothed`
//      prop below) eases toward that same raw target via a per-frame
//      exponential decay instead of snapping to it on every pointermove —
//      decoupled entirely from the raw target itself, which keeps updating
//      at full precision underneath. The COMMITTED position on release is
//      always the precise raw target (chairDragSessionRef.latestOffset,
//      unchanged) — only the DURING-drag visual motion is smoothed, and it
//      resnaps to the exact final value the instant the gesture ends (see
//      TableSeat's own `smoothed` prop wiring: the plain JSX position
//      binding resumes control immediately on release, overriding whatever
//      the smoothing left it at).
// ---------------------------------------------------------------------------

// Exponential-ease time constant (seconds), same "frame-rate independent
// via useFrame's own delta" shape as LOOK_AROUND_RECENTER_TAU above, but
// FAR faster: that one is a leisurely multi-second drift back to center
// once idle, while this one has to stay visually GLUED to a cursor that's
// actively, continuously moving. Chosen by eyeballing a real recording of a
// live drag (this project's established "never assume a number, check a
// real screenshot/recording" pattern): 0.06 reads as a noticeably calmer,
// continuous glide toward the cursor's target rather than a raw teleport
// every pointermove tick, while still catching up to a stopped cursor in
// well under a fifth of a second — nowhere near long enough to read as
// "laggy" or disconnected from the pointer.
const CHAIR_DRAG_RENDER_SMOOTHING_TAU = 0.06;

// The ghost ring's own footprint — sized to roughly the real player chair's
// own frontage-as-a-circle proxy (seating.ts's PLAYER_CHAIR_FRONTAGE, the
// same circle-proxy convention maxSeatCapacity/resolveChairDrop already use
// for a chair's effective footprint) rather than an arbitrary round number,
// so the ring reads as "this is roughly where the chair itself will sit",
// not a disconnected decoration. Only ever shown for a PLAYER's own chair
// (draggableUserId never resolves to the DM's throne), so the smaller
// player frontage — not DM_CHAIR_FRONTAGE — is the right one to size it to.
const CHAIR_DRAG_GHOST_RADIUS = PLAYER_CHAIR_FRONTAGE / 2 + 0.1;
// A thin annulus, not a filled disc — "a thin ring" per the brief, and it
// reads more clearly as a floor marker/outline than a solid shape would.
const CHAIR_DRAG_GHOST_THICKNESS = 0.06;
// Just above the floor mesh (GameTableScene's own y=0 circleGeometry) so the
// ring never z-fights it, while staying visually flush with the ground
// (unlike a chair/avatar, this is a flat floor marker, not a 3D prop).
const CHAIR_DRAG_GHOST_Y = 0.02;

/** The translucent "you'll land here" ring — rendered for the ENTIRE
 * duration of an active chair drag at the RAW (unsmoothed) drag target,
 * continuously (every frame, via useFrame, imperatively — same "mutate an
 * Object3D's own position directly rather than round-trip through React
 * state 60x/second" convention as this file's look-around/own-chair-
 * projection debug loops), so the destination is visible in real time
 * before release. `targetRef` is mutated directly by the window
 * "pointermove" handler below (handleMove) — this component only ever
 * READS it, never writes it, so there's exactly one place that ever decides
 * what the raw target actually is. `onDebug` mirrors this ring's own actual
 * rendered position (or null once it unmounts) — WebGL has no DOM of its
 * own for a script to otherwise confirm a real ghost mesh exists in the
 * scene graph at all, the same reasoning as every other onXDebug prop in
 * this file. */
function ChairDragGhost({
  targetRef,
  onDebug,
}: {
  targetRef: RefObject<{ x: number; z: number } | null>;
  onDebug?: (position: readonly [number, number, number] | null) => void;
}) {
  const groupRef = useRef<Group>(null);
  const lastReported = useRef<[number, number, number] | null>(null);
  useFrame(() => {
    const group = groupRef.current;
    const target = targetRef.current;
    if (!group || !target) return;
    group.position.set(target.x, CHAIR_DRAG_GHOST_Y, target.z);
    if (!onDebug) return;
    const last = lastReported.current;
    if (!last || Math.abs(last[0] - target.x) > 1e-4 || Math.abs(last[2] - target.z) > 1e-4) {
      const next: [number, number, number] = [target.x, CHAIR_DRAG_GHOST_Y, target.z];
      lastReported.current = next;
      onDebug(next);
    }
  });
  // Reports this ring's own disappearance the instant it unmounts (the
  // gesture ended) — a script polling `onDebug`'s mirror sees a real,
  // unambiguous null the moment the ghost is actually gone, not just a
  // stale last-known position.
  useEffect(() => {
    return () => onDebug?.(null);
  }, [onDebug]);
  return (
    <group ref={groupRef}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry
          args={[CHAIR_DRAG_GHOST_RADIUS - CHAIR_DRAG_GHOST_THICKNESS, CHAIR_DRAG_GHOST_RADIUS, 32]}
        />
        <meshBasicMaterial color={PURPLE} transparent opacity={0.45} toneMapped={false} side={DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

// An oversized invisible grab handle over a draggable chair — DmBookProp's
// own HIT_BOX precedent (bigger than the visible model, so grabbing it
// doesn't need pixel-perfect aim), sized to comfortably enclose a player
// chair plus its seated avatar (Chair.tsx's PLAYER_CHAIR_HEIGHT is 2.5) so a
// drag can be grabbed anywhere on the chair's silhouette, not just its base.
const CHAIR_DRAG_HIT_BOX: [number, number, number] = [1.1, 2.8, 1.1];
const CHAIR_DRAG_HANDLE_Y = 1.4;

// The Y sampled by the own-chair screen-projection debug callback (below).
// Used to be a DELIBERATELY different height from CHAIR_DRAG_HANDLE_Y
// above (2.6, picked to stay inside the old seated camera's 50°-vertical-FOV
// under the OLD behind-the-chair camera formula, where 1.4 alone projected
// below the viewport for some party sizes). That reasoning no longer
// applies now that the seated camera sits IN FRONT of a player's own chair
// (seating.ts's CAMERA_FORWARD_INSET, the bug-report fix) — a real,
// verified, unavoidable consequence being that the chair now sits OUTSIDE
// the seated camera's forward view ENTIRELY (see seating.ts's own doc
// comment for the full geometric reasoning), so there is no longer a
// single well-defined "seated view" angle to tune a projection height
// against at all: seeing (and clicking) a player's own chair now genuinely
// requires manually orbiting the camera to some ARBITRARY resulting angle
// first (scripts/db/lib/orbitToOwnChair.mjs), not the one fixed,
// well-understood seated framing this constant's old reasoning assumed.
// Reusing CHAIR_DRAG_HANDLE_Y directly — the exact same point the real
// clickable hit box is centered on — sidesteps needing to reason about any
// particular camera angle at all: wherever the hit box itself is actually
// visible, this projection is now guaranteed to report that same point
// exactly, not merely "close enough" to it.
const CHAIR_DRAG_PROJECTION_Y = CHAIR_DRAG_HANDLE_Y;

// Scratch vectors for the own-chair screen-projection debug callback below
// (verification-only — DmBookPropProps.onProjectedPosition's own "WebGL has
// no DOM of its own for a test to find a click target" reasoning), reused
// per frame the same way as the chairDrag* scratch objects above.
const ownChairPoint = new Vector3();
const ownChairCameraPos = new Vector3();
const ownChairForward = new Vector3();
const ownChairDelta = new Vector3();

// DM tray drag ("the dm cant move their dive tray" [sic] bug report): an
// independent drag gesture scoped to the DM's own PERSONAL DICE TRAY only —
// never the DM's throne (that stays fixed, exactly as before; draggableUserId
// above is still restricted to role === "player" and is completely untouched
// by any of this) and never a player's own tray (a player's tray keeps
// riding along with their draggable chair exactly as before — this gesture
// is additive, not a replacement). The CHAIR_DRAG_HIT_BOX precedent, sized
// down to this much smaller prop's own real footprint (PERSONAL_TRAY_RADIUS,
// DiceTumble.tsx) instead of a seated chair-plus-avatar silhouette — bigger
// than the tray on every side so a grab doesn't need pixel-perfect aim, the
// same "generous, not exact" hit-box reasoning every other grab handle in
// this codebase (CHAIR_DRAG_HIT_BOX, DmBookProp's own HIT_BOX) already uses.
const DM_TRAY_DRAG_HIT_BOX: [number, number, number] = [
  PERSONAL_TRAY_RADIUS * 2 + 0.3,
  0.5,
  PERSONAL_TRAY_RADIUS * 2 + 0.3,
];
// Centered a little above the tray's own low rim (DiceTumble.tsx's
// TRAY_RIM_HEIGHT is 0.075) so the hit box comfortably straddles the whole
// visible prop, tumbling dice included, without needing to reach all the way
// down to the felt floor itself.
const DM_TRAY_DRAG_HANDLE_Y = 0.22;

// Scratch vectors for the DM-tray screen-projection debug callback below —
// the ownChairPoint/ownChairCameraPos/ownChairForward/ownChairDelta
// precedent immediately above, kept as its own separate set (rather than
// reused) since a future refactor to run both projections inside the same
// useFrame callback should never have to reason about one call site's
// mutation leaking into the other's.
const dmTrayProjPoint = new Vector3();
const dmTrayProjCameraPos = new Vector3();
const dmTrayProjForward = new Vector3();
const dmTrayProjDelta = new Vector3();

// ---------------------------------------------------------------------------
// Live-room object placement preview + move-drag ("It is not easy to move
// objects or place them mid game" — the project owner's own bug report).
// Reuses the chair/DM-tray drag gestures' own proven shape verbatim — the
// SAME floorPointFromClientXY raycast, the SAME "grab, see a ghost track the
// cursor for the whole gesture, drop it" flow, the SAME oversized invisible
// grab-handle hit box — generalized from a continuous (x, z) target to a
// GRID CELL target: map_objects.x/y are integers (createMapObject/
// updateMapObject), so unlike a chair or a personal tray this preview is
// cell-quantized, not free-floating. Two gestures share this machinery:
//   1. Placement preview — while LiveObjectsPanel has an asset armed
//      (GameRoom's placingAssetId), hovering the table (no press needed)
//      shows the ghost at the cell the cursor is currently over, using a
//      canvas-scoped "pointermove" listener (armed-but-not-yet-pressed has
//      no drag session to survive leaving the canvas, unlike a real drag).
//   2. Move-drag — grabbing the ONE object LiveObjectsPanel currently has
//      selected for editing (draggableObjectId, reusing that existing
//      selection rather than adding a second one) and dragging it shows the
//      SAME ghost tracking the cursor; releasing commits the new cell via
//      onObjectDragEnd, which GameRoom.tsx resolves (elevation, void/
//      occupied validation — handlePlaceLiveObject's own checks, reused)
//      into a moveMapObject call.
// Mutually exclusive by construction (GameRoom never arms a NEW placement
// and offers an EXISTING object to drag at the same time), so both gestures
// safely share one ghost-target ref/component and one debug mirror below.
// ---------------------------------------------------------------------------

/** Nearest valid grid cell for a raw floor-plane hit, clamped to the map's
 * own bounds — a raycast landing just past an edge cell (or, on a
 * degenerate ray, whatever stale point floorPointFromClientXY last
 * returned) still resolves to something a caller can validate/place at,
 * rather than an out-of-range index nothing downstream expects. */
function nearestCellFromFloorPoint(
  point: { x: number; z: number },
  gridWidth: number,
  gridHeight: number,
  cellSize: number
): { x: number; y: number } {
  const { offsetX, offsetZ } = mapCellOffsets(gridWidth, gridHeight, cellSize);
  const cellX = Math.round((point.x + offsetX) / cellSize);
  const cellY = Math.round((point.z + offsetZ) / cellSize);
  return {
    x: Math.min(Math.max(cellX, 0), gridWidth - 1),
    y: Math.min(Math.max(cellY, 0), gridHeight - 1),
  };
}

// Sized as a fraction of the map's own cellSize, matching MapSurface's own
// ObjectMarker `ghost` box exactly (PLACED_OBJECT_SIZE at 0.7 scale, HIT_BOX_
// HEIGHT — a private constant of that file, 0.9 — at the same 0.7 scale) so
// this preview reads as the SAME "not-yet-committed placement" visual
// language as the hidden-object ghost MapSurface already renders, not a
// second, differently-proportioned box. Duplicated here (not imported)
// because that box lives inside ObjectMarker, a private, unexported
// component of MapSurface.tsx — the WhiteboardPlane.tsx
// planePointFromClientXY precedent for "a small, self-contained duplicate
// beats reaching into another component's own private internals".
const OBJECT_GHOST_SIZE_RATIO = PLACED_OBJECT_SIZE * 0.7;
const OBJECT_GHOST_HEIGHT_RATIO = 0.9 * 0.7;

/** The translucent "it will land here"/"drop it here" box — MapSurface's own
 * ObjectMarker `ghost` convention, reused for a preview that (unlike a real
 * placed object) has no asset model loaded yet. Rendered imperatively from
 * `cellRef` every frame (ChairDragGhost's own "mutate an Object3D's own
 * position directly rather than round-trip through React state 60x/second"
 * convention) — shared by BOTH gestures described above, since only one is
 * ever active on a given client at a time. `onDebug` mirrors the ghost's own
 * current target CELL (or null while inactive) — WebGL has no DOM of its own
 * for a script to otherwise confirm where this preview actually landed, the
 * onChairDragGhostDebug precedent, in grid-cell terms since that's the unit
 * this feature actually reasons in. */
function MapObjectPreviewGhost({
  cellRef,
  cellSize,
  offsetX,
  offsetZ,
  baseY,
  onDebug,
}: {
  cellRef: RefObject<{ x: number; y: number } | null>;
  cellSize: number;
  offsetX: number;
  offsetZ: number;
  baseY: number;
  onDebug?: (cell: { x: number; y: number } | null) => void;
}) {
  const groupRef = useRef<Group>(null);
  const lastReported = useRef<{ x: number; y: number } | null>(null);
  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const cell = cellRef.current;
    if (!cell) {
      group.visible = false;
      if (onDebug && lastReported.current) {
        lastReported.current = null;
        onDebug(null);
      }
      return;
    }
    group.visible = true;
    group.position.set(cell.x * cellSize - offsetX, baseY, cell.y * cellSize - offsetZ);
    const last = lastReported.current;
    if (onDebug && (!last || last.x !== cell.x || last.y !== cell.y)) {
      lastReported.current = cell;
      onDebug(cell);
    }
  });
  useEffect(() => {
    return () => onDebug?.(null);
  }, [onDebug]);
  const boxSize = cellSize * OBJECT_GHOST_SIZE_RATIO;
  const boxHeight = cellSize * OBJECT_GHOST_HEIGHT_RATIO;
  return (
    <group ref={groupRef} visible={false}>
      <mesh position={[0, boxHeight / 2, 0]}>
        <boxGeometry args={[boxSize, boxHeight, boxSize]} />
        <meshBasicMaterial wireframe color={PURPLE} transparent opacity={0.5} depthWrite={false} />
      </mesh>
    </group>
  );
}

// The move-drag grab handle's own footprint: a real placed object's hit box
// is PLACED_OBJECT_SIZE square at HIT_BOX_HEIGHT (0.9, MapSurface's own
// private constant) tall, scaled by cellSize — this handle is rendered
// OUTSIDE that scaled group (a plain sibling mesh in raw world units, the
// DM_TRAY_DRAG_HIT_BOX precedent), so its own args below multiply by cellSize
// directly. Oversized by OBJECT_DRAG_HANDLE_OVERSIZE — "bigger than the real
// target so a grab doesn't need pixel-perfect aim" (CHAIR_DRAG_HIT_BOX/
// DM_TRAY_DRAG_HIT_BOX's own reasoning) AND so it reliably wins raycasting
// priority over the object's own, smaller, coincidentally-positioned
// selectable trigger hit box (MapSurface's ObjectMarker) whenever both exist
// on the same object — a larger box's near face sits closer to the camera,
// so r3f's per-mesh raycasting hits this one first.
const OBJECT_DRAG_HANDLE_OVERSIZE = 1.3;

// Scratch vector for the object-drag grab handle's own screen-projection
// debug callback below — the ownChairPoint/dmTrayProjPoint precedent, kept
// as its own dedicated scratch object for the identical "one call site's
// mutation should never leak into another's" reasoning.
const objectDragHandleProjPoint = new Vector3();
const objectDragHandleProjCameraPos = new Vector3();
const objectDragHandleProjForward = new Vector3();
const objectDragHandleProjDelta = new Vector3();

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
 * together than COMBINED_TABLE_TOP's own depth would suggest. Anything that
 * DOES need the real visible surface instead (the live map's own fit,
 * mapFit.ts) uses table.ts's separate COMBINED_TABLE_VISIBLE_TOP — see that
 * constant's own doc comment for how its depth is derived and verified
 * directly against the real model's own vertices (twice-corrected now, after
 * two real regressions from getting this exact number wrong).
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
  smoothed = false,
  onRenderPositionDebug,
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
  /** Chair/tray drag feel: true only for the CURRENT viewer's own seat WHILE
   * an active drag session is in progress on this client (never for any
   * other seat — nobody else's chair can ever be mid-drag here, draggable's
   * own doc comment above). This seat's own outer group's position is
   * always driven imperatively (never a JSX `position` prop — see the
   * useFrame below for why): while `smoothed` is true it eases toward
   * `seat.position` (the still-fully-precise raw target) via exponential
   * decay (CHAIR_DRAG_RENDER_SMOOTHING_TAU) instead of snapping straight to
   * it — see the "Chair/tray drag feel" block comment above
   * `floorPointFromClientXY` for the full reasoning. The instant this flips
   * back to false (drag ends), the very next frame snaps the group directly
   * to the exact final `seat.position` — no lagging tail after release. */
  smoothed?: boolean;
  /** Verification-only: this seat's own ACTUAL rendered Three.js position,
   * reported every frame it genuinely changes — see
   * GameTableSceneProps.onOwnChairRenderPositionDebug's own doc comment for
   * why this needs to be read straight off the live object rather than
   * inferred from `seat.position` (the two deliberately diverge while
   * `smoothed` is true). */
  onRenderPositionDebug?: (userId: string, position: [number, number, number]) => void;
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
  const seatGroupRef = useRef<Group>(null);
  const lastReportedRenderPosition = useRef<[number, number, number] | null>(null);
  // Chair/tray drag feel: this seat's own group NEVER takes `position` from
  // a plain JSX prop (deliberately — see below) — this single useFrame is
  // the ONLY thing that ever sets it, every frame, for every seat, whether
  // or not a drag is in progress. While `smoothed`, it eases toward
  // `seat.position` (the still-fully-precise raw target) via exponential
  // decay instead of snapping straight to it; otherwise it snaps directly,
  // byte-for-byte the old plain-JSX-binding behavior. A conditional JSX
  // `position` PROP (present sometimes, absent others) was tried and
  // rejected: react-three-fiber's own prop-diffing resets a REMOVED prop to
  // its three.js constructor default (a fresh Vector3(0,0,0)) rather than
  // leaving the current value alone — exactly the "HMR-safe prop removal"
  // behavior R3F documents — which would teleport the chair to the origin
  // the instant `smoothed` first flips true. Never including `position` in
  // this group's JSX props AT ALL (imperative-only, always) sidesteps that
  // landmine entirely, for every seat uniformly, not just the draggable
  // one. No mount-order flash results: r3f's own frame loop always runs
  // every subscribed useFrame callback before its next gl.render() call, so
  // a freshly-mounted seat's very first PAINTED frame already reflects this
  // callback's own position write, never three.js's blank (0,0,0) default.
  useFrame((_, delta) => {
    const group = seatGroupRef.current;
    if (!group) return;
    if (smoothed) {
      const eased = 1 - Math.exp(-delta / CHAIR_DRAG_RENDER_SMOOTHING_TAU);
      group.position.x += (seat.position[0] - group.position.x) * eased;
      group.position.z += (seat.position[2] - group.position.z) * eased;
      group.position.y = seat.position[1];
    } else {
      group.position.set(seat.position[0], seat.position[1], seat.position[2]);
    }
    if (!onRenderPositionDebug) return;
    const last = lastReportedRenderPosition.current;
    const { x, y, z } = group.position;
    if (!last || Math.abs(last[0] - x) > 1e-4 || Math.abs(last[1] - y) > 1e-4 || Math.abs(last[2] - z) > 1e-4) {
      const next: [number, number, number] = [x, y, z];
      lastReportedRenderPosition.current = next;
      onRenderPositionDebug(userId, next);
    }
  });
  return (
    <group ref={seatGroupRef} rotation={[0, seat.rotationY, 0]}>
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
      {/* Name Labels: "so people know who is who" — every seated member,
          DM's throne included, gets an always-visible floating label above
          their own chair. Skipped entirely for a member with no display
          name yet (an incomplete profile — isProfileComplete's own
          definition) rather than rendering an empty/placeholder label. A
          direct child of THIS group (not a separately-positioned sibling)
          so it rides along with the imperative position/rotation this
          group already carries — see SeatNameLabel's own doc comment for
          why that placement is load-bearing, not stylistic. */}
      {seat.member.display_name ? (
        <SeatNameLabel
          userId={userId}
          displayName={seat.member.display_name}
          color={seat.member.name_label_color ?? DEFAULT_NAME_LABEL_COLOR}
          size={seat.member.name_label_size ?? "medium"}
          role={seat.member.role}
        />
      ) : null}
    </group>
  );
});

// Map Art Generation E5: sits just beneath the floor cells' own bottom
// faces (which sit at this group's local y=0 — see MapSurface's own
// cells.map) and just above the bare tabletop (the map group itself is
// already nudged TABLE_SURFACE_Y + 0.002 above the real wood — see that
// group's own comment below) — the identical "sandwiched, never z-fights
// either neighbor" reasoning as the map editor's own REFERENCE_IMAGE_Y
// (MapEditorScene.tsx), just a smaller absolute offset since this table's
// own fitted cellSize (mapFit.ts) is typically well under the editor's
// fixed 1-unit cells.
const MAP_ART_PLANE_Y = -0.001;

/**
 * The live Game Room's own generated-art image plane — deliberately lives
 * here, not in MapSurface.tsx: MapSurface is shared with the map EDITOR
 * scene (MapEditorScene.tsx), and this feature is scoped to the live table
 * only (this prompt's own Task). Fitted with the exact contain-fit formula
 * the editor's own DM-positionable reference image already solved
 * (mapArtFit.ts's computeMapArtFit, factored out of that feature so both
 * reuse one implementation) — but always centered at scale 1, with no
 * DM-adjustable x/y/scale of its own: a map's accepted art is generated
 * from a control image sized directly off that map's real grid
 * (controlImage.ts), so it's expected to already closely match the grid's
 * aspect ratio, needing no manual placement.
 */
function MapArtPlane({
  url,
  gridWidth,
  gridHeight,
  cellSize,
  onReadyChange,
}: {
  url: string;
  gridWidth: number;
  gridHeight: number;
  cellSize: number;
  /** Fires false the instant a fresh url starts loading (or this plane
   * unmounts because the map itself lost its art), then true once the real
   * texture has finished loading — GameTableScene gates MapSurface's own
   * mapArtActive on this so ordinary floor cells never flash transparent
   * before there's anything loaded underneath them (the ReferenceImagePlane
   * precedent's own "no texture yet -> render nothing" gate, generalized to
   * also drive a SIBLING component's rendering, not just this one).
   * `onReadyChange` must be a stable (useCallback'd) reference — it's a
   * real effect dependency below, the TableSeat/ObjectMarker convention
   * this whole file already follows for callbacks handed to a memoized or
   * effect-owning child. */
  onReadyChange?: (ready: boolean) => void;
}) {
  const [texture, setTexture] = useState<Texture | null>(null);
  useEffect(() => {
    let disposed = false;
    onReadyChange?.(false);
    new TextureLoader().load(url, (loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      loaded.colorSpace = SRGBColorSpace;
      setTexture(loaded);
      onReadyChange?.(true);
    });
    return () => {
      disposed = true;
      onReadyChange?.(false);
      setTexture((previous) => {
        previous?.dispose();
        return null;
      });
    };
  }, [url, onReadyChange]);

  if (!texture) return null;
  const art = texture.image as { width: number; height: number };
  const { planeWidth, planeHeight } = computeMapArtFit(gridWidth, gridHeight, cellSize, art.width, art.height);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, MAP_ART_PLANE_Y, 0]}>
      <planeGeometry args={[planeWidth, planeHeight]} />
      {/* Basic material, tone mapping off: the accepted art should read as
          the DM's actual generated image, not as a lit surface tinted by
          the room's own day/night lighting rig — the same reasoning
          MapEditorScene's own ReferenceImagePlane material uses. */}
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

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
  /** Map Art Generation E5: a signed, already-resolved URL for this map's
   * currently-accepted generated art (GameRoom.tsx resolves it via
   * getMapArtSignedUrl, the "already resolved to renderable form" rule this
   * whole interface's own doc comment states — scene-3d stays data-access-
   * free), or null/undefined when this map has no accepted art. Null
   * renders this map EXACTLY as before this feature: no image plane, no
   * transparent floor, no faint grid variant — see MapArtPlane and
   * MapSurfaceProps.mapArtActive's own doc comments for what turning it on
   * actually changes. */
  mapArtUrl?: string | null;
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
  /** Current campaign weather (Weather & Enemies C1); defaults to "clear" —
   * today's original, unchanged fog. Only 'fog' has any visual effect as of
   * this prompt (see resolveSceneFog); every other value renders identically
   * to 'clear' until C2-C4 add their own separate overlay effects. */
  weatherKind?: WeatherKind;
  /** Verification-only pass-through to WeatherParticles' own onDebug (C4) —
   * see its own doc comment for why: WebGL has no DOM of its own for a
   * script to confirm a real, kind-DISTINCT particle system (embers for
   * firestorm, a falling green haze for acid storm) is actually mounted,
   * without pixel-diffing a screenshot. Omitting it changes nothing about
   * what renders. */
  onWeatherParticlesDebug?: (state: WeatherParticlesDebugState | null) => void;
  /** Verification-only: mirrors whether generated map art is CURRENTLY
   * active for the live map — an accepted map_art row present (liveMap.
   * mapArtUrl set) AND its texture has actually finished loading (see
   * MapArtPlane's own onReadyChange), the exact moment ordinary floor
   * cells switch to the transparent-fill treatment. WebGL has no DOM of
   * its own for a test to confirm that render decision directly, the same
   * reasoning as every other onXDebug prop here. null while there's no
   * live map at all; otherwise a real boolean, momentarily false right
   * after a freshly-accepted art's texture starts loading and true once
   * it's ready. Omit it (as every real caller does today) and nothing
   * about how anything renders changes. */
  onMapArtDebug?: (state: { mapId: string; active: boolean } | null) => void;
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
  /** Verification-only pass-through to MapSurface's onTokenMeasureDebug
   * (Weather & Enemies C6) — see its own doc comment. */
  onTokenMeasureDebug?: (id: string, measurement: { maxDim: number; scale: number }) => void;
  /** Verification-only pass-through to MapSurface's onTokenTransformDebug
   * (bridges and stairs surface-height + tilt, extended with gridX/gridY
   * for the click-select-to-move pawn-model repro investigation) — see its
   * own doc comment. */
  onTokenTransformDebug?: (
    id: string,
    transform: { gridX: number; gridY: number; topY: number; pitchDeg: number; yawDeg: number }
  ) => void;
  /** Verification-only pass-through to MapSurface's onTokenModelWorldDebug
   * (click-select-to-move pawn-model repro investigation, re-opened) — see
   * its own doc comment. */
  onTokenModelWorldDebug?: (id: string, world: { x: number; y: number; z: number; yawDeg: number }) => void;
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
  /** Chair/tray drag feel, verification-only: this client's own draggable
   * chair's ACTUAL rendered Three.js position, fired whenever it genuinely
   * changes — same "only report real changes" shape as onOwnCameraDebug.
   * Deliberately diverges from seat-layout-state's own (raw, unsmoothed)
   * seat position for the whole duration of an active drag (TableSeat's own
   * `smoothed` easing — see the "Chair/tray drag feel" block comment above
   * `floorPointFromClientXY`), then converges back to it exactly the instant
   * the drag ends. null whenever this viewer has no draggable seat of their
   * own. WebGL has no DOM of its own for a script to otherwise read a live
   * object's actual position, the same reasoning as every other onXDebug
   * prop here. Not read by GameTableScene itself. */
  onOwnChairRenderPositionDebug?: (position: readonly [number, number, number] | null) => void;
  /** Chair/tray drag feel, verification-only: the translucent drag-preview
   * ring's own current world position while a chair drag is active on this
   * client (ChairDragGhost, above) — null whenever no drag is in progress,
   * i.e. the ring itself isn't mounted. Mirrors the exact raw, unsmoothed
   * drag target (the very value fed to setLocalChairOverride on every
   * pointermove) — proves both that a real ghost mesh exists in the scene
   * graph at all, and that it genuinely tracks the raw target, not some
   * smoothed or stale approximation of it. Not read by GameTableScene
   * itself. */
  onChairDragGhostDebug?: (position: readonly [number, number, number] | null) => void;
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
  /** DM tray drag ("the dm cant move their dive tray" [sic]): this viewer's
   * own resolved personal-tray world position — GameRoom.tsx's dmTrayPosition,
   * the computed default spot (memberTrayPositions' DM entry) PLUS any
   * persisted/live drag offset already folded in, the exact dmBookPosition
   * precedent. GameTableScene renders an invisible grab handle at this exact
   * spot whenever `dmTrayDraggable` is true — never used to render the tray
   * ITSELF (that's ConnectedMemberDiceTray/DiceTumble, a Canvas sibling of
   * this component in GameRoom.tsx; this is only the grab handle riding on
   * top of it). null/undefined renders no grab handle at all (no DM seated
   * yet — dmSeat is null). */
  dmTrayPosition?: readonly [number, number, number] | null;
  /** True only for the current viewer's OWN client while they are this
   * campaign's DM (GameRoom's own currentUserIsDM — the exact prop name that
   * file already uses for every other "am I the DM" check). Gates ONLY the
   * tray grab handle below; draggableUserId above (a player's own chair) is
   * completely independent of this and never affected by it. This does NOT
   * make the DM's own THRONE draggable — the project owner explicitly chose
   * NOT to extend chair/throne dragging to the DM, only to add this
   * separate, tray-only gesture. */
  dmTrayDraggable?: boolean;
  /** DM tray drag: fires continuously (every "pointermove" tick past
   * pointerdown) with the world-space (x, z) delta from wherever the drag
   * started — DmBookPropProps.onDragMove's own precedent, reused here
   * instead of duplicated as a separate component (see this file's own
   * handleDmTrayPointerDown for why the mechanics live here, next to the
   * proven chair-drag raycast/session machinery, rather than in a new
   * standalone file the way DmBookProp.tsx is). No rotation to carry along,
   * the same "a tray has no facing" reasoning DmTrayOffset (data-access)
   * documents. GameRoom.tsx adds this to whatever offset was already in
   * effect before the drag started to get this client's own live,
   * optimistic tray position. */
  onDmTrayDragMove?: (delta: { dx: number; dz: number }) => void;
  /** DM tray drag: fires once, on release, with the FINAL world-space
   * (x, z) delta from drag start — but only if the gesture actually moved
   * (ChairDragSession.moved's own "a plain click-and-release with no real
   * movement fires nothing" convention). Unlike DmBookProp's own onDragEnd,
   * there is no competing click gesture to fall back to here at all (this
   * file's own investigation, and the task this was built under, both
   * confirmed DiceTumble.tsx/ConnectedMemberDiceTray wire up no pointer
   * handlers of their own for the tray to conflict with) — a zero-movement
   * press-and-release simply does nothing, the same as a chair's own
   * ChairDragSession.moved gate. GameRoom.tsx's own onDmTrayDragEnd is where
   * this delta actually gets persisted (setDmTrayOffset) and broadcast. */
  onDmTrayDragEnd?: (delta: { dx: number; dz: number }) => void;
  /** Verification-only: this client's own draggable tray's current on-screen
   * projection (canvas-relative CSS pixels), or null while it isn't visible
   * or doesn't exist — the onOwnChairProjectedPosition/DmBookPropProps.
   * onProjectedPosition precedent, so a Playwright drag simulation has real
   * pixel coordinates to press down on and drag from. Not read by
   * GameTableScene itself. */
  onDmTrayProjectedPosition?: (point: [number, number] | null) => void;
  /** Live-room object placement preview (the DM ask: "not easy to... place
   * [objects] mid game"): true while an asset is armed for live placement
   * (LiveObjectsPanel/GameRoom's placingAssetId) — shows a translucent ghost
   * box at the pointer's current floor-cell projection, the exact
   * floorPointFromClientXY raycast the chair/DM-tray drags above already
   * use, generalized to "which grid cell is the ray over" (map_objects.x/y
   * are integers, so this preview is cell-quantized, not free-floating).
   * Only ever true on the DM's own client in practice (placingAssetId is
   * DM-only state), but GameRoom passes this with its own defense-in-depth
   * currentUserIsDM guard regardless. */
  placementPreviewActive?: boolean;
  /** Live-room move-drag (the DM ask: "not easy to move objects... mid
   * game"): the one object id currently eligible for a real grab-and-drag
   * gesture in the 3D scene — LiveObjectsPanel's own "Edit an object"
   * selection (editingObjectId), reused rather than adding a second
   * selection mechanism. Null renders no grab handle at all. GameRoom
   * suppresses this whenever a live placement, a token placement, or a
   * token's click-to-move is already in progress — the exact same mutual-
   * exclusion guard MapSurfaceObject.selectable's own gating already
   * applies, so a press on the table never has two competing answers for
   * "what does this mean". */
  draggableObjectId?: string | null;
  /** Fires once, on release, only if the drag actually moved at least once
   * (ChairDragSession.moved's own "a plain click-and-release with no real
   * movement fires nothing" convention) — the destination grid cell.
   * GameRoom.tsx resolves that cell's own elevation and validates it (void/
   * already-occupied) the exact same way handlePlaceLiveObject already does
   * for a brand-new placement, then calls the new moveMapObject data-access
   * function. */
  onObjectDragEnd?: (objectId: string, x: number, y: number) => void;
  /** Verification-only: the currently-draggable object's own grab-handle
   * screen projection — the onDmTrayProjectedPosition precedent (WebGL has
   * no DOM of its own for a Playwright drag simulation to find a press
   * point). Null whenever draggableObjectId is null, that object can't be
   * found, or it's off-screen/behind the camera. */
  onObjectDragHandleProjectedPosition?: (point: [number, number] | null) => void;
  /** Verification-only: the placement-preview/move-drag ghost's current
   * target cell, or null while neither gesture is active — the
   * onChairDragGhostDebug precedent, in grid-cell terms since that's the
   * unit both gestures actually reason in. */
  onObjectPreviewCellDebug?: (cell: { x: number; y: number } | null) => void;
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

/** One in-progress DM-tray drag's own fixed, per-session parameters — the
 * ChairDragSession precedent immediately above, adapted the way DmBookProp's
 * own drag session already adapts it for a single delta-tracked prop: no
 * grabOffsetX/Z (the tray is dragged by its DELTA from press to release, not
 * "where under the cursor was it grabbed"), no defaultRotationY/userId (only
 * ever the current DM's one tray, never keyed). Captured once at
 * "pointerdown" and read (never re-derived) by the window "pointermove"/
 * "pointerup" listeners for the rest of that same drag. */
interface DmTrayDragSession {
  startFloorX: number;
  startFloorZ: number;
  planeY: number;
  /** False for a plain click-and-release with no real movement in between —
   * see GameTableSceneProps.onDmTrayDragEnd's own doc comment for why that
   * fires nothing at all in this case. */
  moved: boolean;
  lastDelta: { dx: number; dz: number };
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
  weatherKind = "clear",
  onWeatherParticlesDebug,
  onMapArtDebug,
  onTokenSlideDebug,
  onAvatarPoseDebug,
  onAvatarMeasureDebug,
  onObjectPoseDebug,
  onObjectMeasureDebug,
  onTokenMeasureDebug,
  onTokenTransformDebug,
  onTokenModelWorldDebug,
  seatOffsets = EMPTY_SEAT_OFFSETS,
  onChairDragEnd,
  onOwnChairProjectedPosition,
  onOwnCameraDebug,
  onOwnChairRenderPositionDebug,
  onChairDragGhostDebug,
  onChairDraggingChange,
  turnCameraActive = false,
  onLiveChairOffset,
  dmTrayPosition = null,
  dmTrayDraggable = false,
  onDmTrayDragMove,
  onDmTrayDragEnd,
  onDmTrayProjectedPosition,
  placementPreviewActive = false,
  draggableObjectId = null,
  onObjectDragEnd,
  onObjectDragHandleProjectedPosition,
  onObjectPreviewCellDebug,
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
  const fog = useMemo(() => resolveSceneFog(dayNightMode, weatherKind), [dayNightMode, weatherKind]);
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

  // Chair/tray drag feel, verification-only: TableSeat's own per-seat
  // onRenderPositionDebug callback (userId, position) filtered down to just
  // draggableUserId's own seat — the only one this scene ever smooths — then
  // handed straight to the app layer's onOwnChairRenderPositionDebug. A
  // stable top-level useCallback (not an inline arrow at the seats.map call
  // site below) for the exact same memoization reason TableSeat's own top
  // doc comment already documents for handleChairPointerDown.
  const handleOwnChairRenderPositionDebug = useCallback(
    (userId: string, position: [number, number, number]) => {
      if (userId !== draggableUserId) return;
      onOwnChairRenderPositionDebug?.(position);
    },
    [draggableUserId, onOwnChairRenderPositionDebug]
  );

  const chairDragSessionRef = useRef<ChairDragSession | null>(null);
  // Chair/tray drag feel: the ghost ring's own RAW target, mutated directly
  // by handleMove below on every pointermove tick (and seeded once at press
  // in handleChairPointerDown, so the ring starts in the right spot even
  // before the first pointermove arrives) — read only by ChairDragGhost's
  // own useFrame, never by React state, so updating it 60+ times a second
  // during a drag never itself triggers a re-render.
  const chairDragGhostTargetRef = useRef<{ x: number; z: number } | null>(null);
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
      chairDragGhostTargetRef.current = { x: currentSeat.position[0], z: currentSeat.position[2] };
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
      chairDragGhostTargetRef.current = { x: clamped.x, z: clamped.z };
      setLocalChairOverride({ userId: session.userId, offset });
    }
    function handleUp() {
      const session = chairDragSessionRef.current;
      chairDragSessionRef.current = null;
      chairDragGhostTargetRef.current = null;
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

  // DM tray drag ("the dm cant move their dive tray" [sic]): a wholly
  // separate drag session from the chair one above — completely independent
  // state, its own ref, never touching draggableUserId/chairDragSessionRef/
  // localChairOverride in any way. Mirrors DmBookProp.tsx's own drag-session
  // shape (delta-from-press, not grab-offset-from-anchor — there's only ever
  // one tray to drag, the DM's own) rather than the chair's, since this
  // gesture has the book's shape (one singular DM-owned prop), not the
  // per-seat chair's. Ref-mirrored callbacks (onDmTrayDragMoveRef/
  // onDmTrayDragEndRef) for the identical reason onChairDragEndRef exists
  // above: the window "pointermove"/"pointerup" listeners registered inside
  // handleDmTrayPointerDown below must see the LATEST callback, not whatever
  // was current at the moment the drag started.
  const dmTrayDragSessionRef = useRef<DmTrayDragSession | null>(null);
  const onDmTrayDragMoveRef = useRef(onDmTrayDragMove);
  useEffect(() => {
    onDmTrayDragMoveRef.current = onDmTrayDragMove;
  }, [onDmTrayDragMove]);
  const onDmTrayDragEndRef = useRef(onDmTrayDragEnd);
  useEffect(() => {
    onDmTrayDragEndRef.current = onDmTrayDragEnd;
  }, [onDmTrayDragEnd]);
  // Detaches whatever drag's own window listeners are currently attached, if
  // any — DmBookProp.tsx's own dragCleanupRef precedent: invoked both by
  // that same drag's own "pointerup" (the ordinary path) and by this
  // component's unmount cleanup below (the only extraordinary one: a drag
  // still in flight when this scene itself goes away, e.g. a live map switch
  // mid-drag).
  const dmTrayDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dmTrayDragCleanupRef.current?.(), []);

  // Registered SYNCHRONOUSLY inside the handler itself (DmBookProp.tsx's own
  // handlePointerDown precedent), not via a useEffect keyed off a React
  // "dragging" state flag — a state update's own effect-commit is
  // asynchronous, so a genuine zero-travel press-and-release could see
  // "pointerup" fire on window before an effect-gated listener ever attached
  // one, silently swallowing the release. There's no competing click gesture
  // on the tray to lose that way (unlike the book), but the same
  // synchronous-registration discipline still avoids ever leaking an
  // attached-but-never-detached listener from a missed release.
  const handleDmTrayPointerDown = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      if (!dmTrayPosition) return;
      const canvas = gl.domElement;
      const planeY = dmTrayPosition[1];
      const floorPoint = floorPointFromClientXY(camera, canvas, event.clientX, event.clientY, planeY);
      dmTrayDragSessionRef.current = {
        // A degenerate ray (looking exactly along the horizon — vanishingly
        // unlikely for this scene's own seated/orbit cameras) falls back to
        // the tray's own current world (x, z) rather than leaving this
        // session without a start point at all — DmBookProp.tsx's own
        // identical fallback.
        startFloorX: floorPoint?.x ?? dmTrayPosition[0],
        startFloorZ: floorPoint?.z ?? dmTrayPosition[2],
        planeY,
        moved: false,
        lastDelta: { dx: 0, dz: 0 },
      };

      function handleMove(moveEvent: PointerEvent) {
        const session = dmTrayDragSessionRef.current;
        if (!session) return;
        const point = floorPointFromClientXY(camera, canvas, moveEvent.clientX, moveEvent.clientY, session.planeY);
        if (!point) return;
        const delta = { dx: point.x - session.startFloorX, dz: point.z - session.startFloorZ };
        session.moved = true;
        session.lastDelta = delta;
        onDmTrayDragMoveRef.current?.(delta);
      }
      function handleUp() {
        const session = dmTrayDragSessionRef.current;
        dmTrayDragSessionRef.current = null;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        dmTrayDragCleanupRef.current = null;
        if (session?.moved) {
          onDmTrayDragEndRef.current?.(session.lastDelta);
        }
      }
      dmTrayDragCleanupRef.current = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [dmTrayPosition, camera, gl]
  );

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

  // DM tray drag, verification-only: this client's own draggable tray's live
  // screen projection — the onOwnChairProjectedPosition useFrame immediately
  // above, generalized from a seat to dmTrayPosition. A SEPARATE useFrame
  // subscription (not folded into the one above) deliberately: that one's
  // own early `return`s the moment there's no draggable chair seat would
  // otherwise skip this logic entirely for a DM with no player chair of
  // their own — keeping this independent means it always runs exactly when
  // its own inputs (dmTrayDraggable, dmTrayPosition) say it should, with no
  // coupling to the chair projection's own control flow.
  const lastDmTrayScreen = useRef<[number, number] | null>(null);
  useFrame(() => {
    if (!onDmTrayProjectedPosition) return;
    if (!dmTrayDraggable || !dmTrayPosition) {
      if (lastDmTrayScreen.current !== null) {
        lastDmTrayScreen.current = null;
        onDmTrayProjectedPosition(null);
      }
      return;
    }
    dmTrayProjPoint.set(dmTrayPosition[0], dmTrayPosition[1] + DM_TRAY_DRAG_HANDLE_Y, dmTrayPosition[2]);
    camera.updateMatrixWorld();
    dmTrayProjCameraPos.setFromMatrixPosition(camera.matrixWorld);
    dmTrayProjDelta.copy(dmTrayProjPoint).sub(dmTrayProjCameraPos);
    camera.getWorldDirection(dmTrayProjForward);
    if (dmTrayProjDelta.angleTo(dmTrayProjForward) > Math.PI / 2) {
      if (lastDmTrayScreen.current !== null) {
        lastDmTrayScreen.current = null;
        onDmTrayProjectedPosition(null);
      }
      return;
    }
    dmTrayProjPoint.project(camera);
    const x = (dmTrayProjPoint.x * size.width) / 2 + size.width / 2;
    const y = -((dmTrayProjPoint.y * size.height) / 2) + size.height / 2;
    const last = lastDmTrayScreen.current;
    if (!last || Math.abs(last[0] - x) > 0.5 || Math.abs(last[1] - y) > 0.5) {
      lastDmTrayScreen.current = [x, y];
      onDmTrayProjectedPosition([x, y]);
    }
  });

  const mapMetrics = useMemo(
    () => (liveMap ? computeTableMapMetrics(liveMap.gridWidth, liveMap.gridHeight) : null),
    [liveMap]
  );
  const mapOffsets = useMemo(
    () => (liveMap && mapMetrics ? mapCellOffsets(liveMap.gridWidth, liveMap.gridHeight, mapMetrics.cellSize) : null),
    [liveMap, mapMetrics]
  );

  // Live-room object placement preview + move-drag: the ghost's own current
  // target cell, mutated directly by handlePlacementHoverCell below (a real
  // per-cell hover event) and by the move-drag effect further down (never by
  // React state — MapObjectPreviewGhost's own doc comment) and read only by
  // that component's useFrame.
  const objectPreviewCellRef = useRef<{ x: number; y: number } | null>(null);

  // Placement preview: reuses MapSurface's own REAL per-cell onCellPointerOver
  // (the same discrete event onCellPointerDown/handleCellPointerDown already
  // resolves a commit through) rather than a manual floor-plane raycast —
  // deliberately NOT the chair/DM-tray drag's own floorPointFromClientXY
  // technique, despite the surface-level similarity. A manual raycast
  // against an INFINITE mathematical plane always resolves to SOME
  // clamped-into-bounds cell for literally any screen point, including ones
  // nowhere near the rendered map at all (pointing at the felt beyond the
  // grid, a chair, empty air) — confirmed by inspection: it would show a
  // confident-looking ghost for a point that a real click, resolved through
  // R3F's own mesh-based raycasting, never reaches at all, silently
  // breaking the ONE guarantee this feature exists to make ("see exactly
  // where it will land before clicking"). A real per-cell hover event only
  // ever fires for a cell that's ACTUALLY rendered and reachable — the same
  // mesh a subsequent click resolves through — so the ghost and the commit
  // can never disagree. (While an asset is armed, GameRoom's own objects
  // useMemo already forces every object's `selectable` to false — see its
  // own doc comment — so an occupied cell's floor is reachable for hover
  // exactly like an empty one, matching the click-time "already occupied"
  // error this same gesture already surfaces.) The move-drag gesture below
  // keeps the manual raycast: that one genuinely needs continuous,
  // occlusion-immune tracking across a HELD-DOWN drag, the chair-drag
  // precedent's own reasoning — a discrete hover-in event is the wrong
  // shape for that gesture, but exactly the right one for this one.
  const handlePlacementHoverCell = useCallback((x: number, y: number) => {
    objectPreviewCellRef.current = { x, y };
  }, []);
  useEffect(() => {
    if (!placementPreviewActive) objectPreviewCellRef.current = null;
  }, [placementPreviewActive]);

  // Move-drag: one in-progress drag's own fixed session, mirroring
  // ChairDragSession's own shape (captured once at press, read — never
  // re-derived — by the window "pointermove"/"pointerup" listeners below).
  const objectDragSessionRef = useRef<{
    objectId: string;
    moved: boolean;
    latestCell: { x: number; y: number };
  } | null>(null);
  const [isDraggingObject, setIsDraggingObject] = useState(false);
  const onObjectDragEndRef = useRef(onObjectDragEnd);
  useEffect(() => {
    onObjectDragEndRef.current = onObjectDragEnd;
  }, [onObjectDragEnd]);

  const handleObjectDragHandlePointerDown = useCallback(
    (object: MapSurfaceObject, event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      objectDragSessionRef.current = { objectId: object.id, moved: false, latestCell: { x: object.x, y: object.y } };
      objectPreviewCellRef.current = { x: object.x, y: object.y };
      setIsDraggingObject(true);
    },
    []
  );

  // The release can land anywhere — off the map, off the canvas — so the
  // pointerup (and, for the same reason, pointermove) listeners live on
  // window, the chair/ruler drag precedent.
  useEffect(() => {
    if (!isDraggingObject) return;
    const map = liveMap;
    const metrics = mapMetrics;
    if (!map || !metrics) return;
    const canvas = gl.domElement;
    // The map's own group sits at TABLE_SURFACE_Y + 0.002 (this file's own
    // <group> wrapping <MapSurface>) with zero x/z translation — so a
    // world-space floor-plane raycast needs THAT world height, not the
    // local-to-the-group baseHeight alone (the mistake would systematically
    // skew the resolved cell for any camera angle that isn't perfectly
    // top-down, exactly the perspective-raycast sensitivity
    // floorPointFromClientXY's own doc comment already warns about).
    const planeY = TABLE_SURFACE_Y + 0.002 + metrics.baseHeight;
    function handleMove(event: PointerEvent) {
      const session = objectDragSessionRef.current;
      if (!session) return;
      const point = floorPointFromClientXY(camera, canvas, event.clientX, event.clientY, planeY);
      if (!point) return;
      const cell = nearestCellFromFloorPoint(point, map!.gridWidth, map!.gridHeight, metrics!.cellSize);
      session.moved = true;
      session.latestCell = cell;
      objectPreviewCellRef.current = cell;
    }
    function handleUp() {
      const session = objectDragSessionRef.current;
      objectDragSessionRef.current = null;
      objectPreviewCellRef.current = null;
      setIsDraggingObject(false);
      if (session?.moved) {
        onObjectDragEndRef.current?.(session.objectId, session.latestCell.x, session.latestCell.y);
      }
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [isDraggingObject, liveMap, mapMetrics, camera, gl]);

  // The currently-draggable object's own row, if any — resolved once here
  // rather than re-found at each of the two JSX/useFrame call sites below
  // that both need it (the grab handle mesh, and its projected-position
  // debug).
  const draggableObject = useMemo(
    () => (draggableObjectId ? liveMap?.objects.find((object) => object.id === draggableObjectId) ?? null : null),
    [draggableObjectId, liveMap]
  );

  // Move-drag, verification-only: the draggable object's own grab-handle
  // live screen projection — the onOwnChairProjectedPosition/
  // onDmTrayProjectedPosition precedent immediately above, generalized from
  // a seat/tray to whichever object LiveObjectsPanel currently has selected
  // for editing. A SEPARATE useFrame subscription (not folded into either of
  // those) for the identical reason the DM-tray one is already its own: no
  // coupling to either gesture's own control flow.
  const lastObjectDragHandleScreen = useRef<[number, number] | null>(null);
  useFrame(() => {
    if (!onObjectDragHandleProjectedPosition) return;
    if (!draggableObject || !mapMetrics || !mapOffsets) {
      if (lastObjectDragHandleScreen.current !== null) {
        lastObjectDragHandleScreen.current = null;
        onObjectDragHandleProjectedPosition(null);
      }
      return;
    }
    const worldX = draggableObject.x * mapMetrics.cellSize - mapOffsets.offsetX;
    const worldZ = draggableObject.y * mapMetrics.cellSize - mapOffsets.offsetZ;
    const topY =
      TABLE_SURFACE_Y +
      0.002 +
      mapMetrics.baseHeight +
      draggableObject.elevation * mapMetrics.elevationStepHeight;
    const handleHeight = 0.9 * mapMetrics.cellSize * OBJECT_DRAG_HANDLE_OVERSIZE;
    objectDragHandleProjPoint.set(worldX, topY + handleHeight / 2, worldZ);
    camera.updateMatrixWorld();
    objectDragHandleProjCameraPos.setFromMatrixPosition(camera.matrixWorld);
    objectDragHandleProjDelta.copy(objectDragHandleProjPoint).sub(objectDragHandleProjCameraPos);
    camera.getWorldDirection(objectDragHandleProjForward);
    if (objectDragHandleProjDelta.angleTo(objectDragHandleProjForward) > Math.PI / 2) {
      if (lastObjectDragHandleScreen.current !== null) {
        lastObjectDragHandleScreen.current = null;
        onObjectDragHandleProjectedPosition(null);
      }
      return;
    }
    objectDragHandleProjPoint.project(camera);
    const x = (objectDragHandleProjPoint.x * size.width) / 2 + size.width / 2;
    const y = -((objectDragHandleProjPoint.y * size.height) / 2) + size.height / 2;
    const last = lastObjectDragHandleScreen.current;
    if (!last || Math.abs(last[0] - x) > 0.5 || Math.abs(last[1] - y) > 0.5) {
      lastObjectDragHandleScreen.current = [x, y];
      onObjectDragHandleProjectedPosition([x, y]);
    }
  });

  // Map Art Generation E5: true only once MapArtPlane's own texture has
  // actually finished loading — see its onReadyChange doc comment for why
  // this gate exists (avoids a flash of transparent floor with nothing
  // loaded underneath yet). Reset to false by MapArtPlane's own effect
  // cleanup whenever liveMap.mapArtUrl changes or clears, so switching to a
  // map with no art (or a fresh map mid-generation) never leaves a stale
  // `true` behind.
  const [mapArtReady, setMapArtReady] = useState(false);
  const handleMapArtReadyChange = useCallback((ready: boolean) => setMapArtReady(ready), []);
  const mapArtActive = Boolean(liveMap?.mapArtUrl) && mapArtReady;
  const liveMapId = liveMap?.id ?? null;
  // Verification-only mirror — see GameTableSceneProps.onMapArtDebug's own
  // doc comment. Keyed off the real primitives, not the whole `liveMap`
  // object (which changes reference on every token slide/vision update),
  // so this only actually fires on a genuine map-art state transition.
  useEffect(() => {
    onMapArtDebug?.(liveMapId ? { mapId: liveMapId, active: mapArtActive } : null);
  }, [liveMapId, mapArtActive, onMapArtDebug]);

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

      {/* Background stays day/night's own roomBg unconditionally — weather's
          fog (resolveSceneFog) only ever overrides the FOG args below, never
          the void color behind it; see resolveSceneFog's own doc comment
          for the full composition rule. */}
      <color attach="background" args={[lighting.roomBg]} />
      <fog attach="fog" args={[fog.color, fog.near, fog.far]} />

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

      {/* Weather & Enemies C4: firestorm/acid_storm's own particle overlay
          — a no-op for every other weatherKind (WeatherParticles returns
          null and reports onDebug(null)). Purely decorative; independent of
          weather_mechanical (GameRoom.tsx's own periodic-tick effect owns
          the damage side entirely). */}
      <WeatherParticles weatherKind={weatherKind} onDebug={onWeatherParticlesDebug} />

      {/* Overhead cloud layer — unlike WeatherParticles above, this has NO
          per-kind null branch: it renders for every weatherKind, including
          'clear' and 'fog' (see CloudLayer.tsx's own doc comment for why a
          conditional mount would be the wrong shape here, and for the full
          per-kind color/density/altitude palette and its reasoning). */}
      <CloudLayer weatherKind={weatherKind} />

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
            {/* Map Art Generation E5: rendered BEFORE MapSurface for
                readability only — three.js's own depth test (not JSX
                order) is what actually makes this show through the floor
                cells' transparent fill once mapArtActive engages them; an
                absent liveMap.mapArtUrl renders nothing at all, the
                pre-E5 rendering for every map with no accepted art. */}
            {liveMap.mapArtUrl ? (
              <MapArtPlane
                url={liveMap.mapArtUrl}
                gridWidth={liveMap.gridWidth}
                gridHeight={liveMap.gridHeight}
                cellSize={mapMetrics.cellSize}
                onReadyChange={handleMapArtReadyChange}
              />
            ) : null}
            <MapSurface
              gridWidth={liveMap.gridWidth}
              gridHeight={liveMap.gridHeight}
              cells={liveMap.cells}
              metrics={mapMetrics}
              objects={liveMap.objects}
              tokens={liveMap.tokens}
              gridOverlay
              mapArtActive={mapArtActive}
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
              onCellPointerOver={
                measuring
                  ? handleRulerDragOver
                  : placementPreviewActive
                    ? handlePlacementHoverCell
                    : undefined
              }
              onTokenPointerDown={
                !rulerActive && onTokenClick ? handleTokenPointerDown : undefined
              }
              onTokenSlideDebug={onTokenSlideDebug}
              onObjectPoseDebug={onObjectPoseDebug}
              onObjectMeasureDebug={onObjectMeasureDebug}
              onTokenMeasureDebug={onTokenMeasureDebug}
              onTokenTransformDebug={onTokenTransformDebug}
              onTokenModelWorldDebug={onTokenModelWorldDebug}
            />
            {/* Live-room move-drag: an invisible, oversized grab handle
                riding on top of whichever object LiveObjectsPanel currently
                has selected for editing — the DM_TRAY_DRAG_HIT_BOX precedent,
                rendered as a plain sibling mesh in this group's own local
                (== world x/z) coordinates rather than through MapSurface's
                own scaled ObjectMarker group, so it can never collide with
                — or need to reason about — that component's own selectable
                trigger hit box beyond simply being bigger than it. */}
            {draggableObject && mapOffsets ? (
              <mesh
                position={[
                  draggableObject.x * mapMetrics.cellSize - mapOffsets.offsetX,
                  mapMetrics.baseHeight +
                    draggableObject.elevation * mapMetrics.elevationStepHeight +
                    (0.9 * mapMetrics.cellSize * OBJECT_DRAG_HANDLE_OVERSIZE) / 2,
                  draggableObject.y * mapMetrics.cellSize - mapOffsets.offsetZ,
                ]}
                onPointerDown={(event) => handleObjectDragHandlePointerDown(draggableObject, event)}
              >
                <boxGeometry
                  args={[
                    PLACED_OBJECT_SIZE * mapMetrics.cellSize * OBJECT_DRAG_HANDLE_OVERSIZE,
                    0.9 * mapMetrics.cellSize * OBJECT_DRAG_HANDLE_OVERSIZE,
                    PLACED_OBJECT_SIZE * mapMetrics.cellSize * OBJECT_DRAG_HANDLE_OVERSIZE,
                  ]}
                />
                {/* opacity-0, not visible={false} — an invisible mesh is
                    skipped by the raycaster, which would defeat the hit box
                    entirely (CHAIR_DRAG_HIT_BOX/DM_TRAY_DRAG_HIT_BOX's own
                    precedent). */}
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            ) : null}
            {/* Live-room placement preview + move-drag: the shared ghost —
                see the "Live-room object placement preview + move-drag"
                block comment (above floorPointFromClientXY's own module) for
                the full reasoning. Always mounted whenever a live map
                exists (mapOffsets is non-null exactly when mapMetrics is) —
                cheap while idle, since it renders nothing visible until
                objectPreviewCellRef actually holds a cell. */}
            {mapOffsets ? (
              <MapObjectPreviewGhost
                cellRef={objectPreviewCellRef}
                cellSize={mapMetrics.cellSize}
                offsetX={mapOffsets.offsetX}
                offsetZ={mapOffsets.offsetZ}
                baseY={mapMetrics.baseHeight}
                onDebug={onObjectPreviewCellDebug}
              />
            ) : null}
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
          // Chair/tray drag feel: only ever true for the current viewer's
          // own seat, and only while their own drag session is active —
          // every other seat keeps snapping directly to its own
          // `seat.position`, byte-for-byte the pre-existing behavior.
          smoothed={seat.member.user_id === draggableUserId && isDraggingChair}
          onRenderPositionDebug={handleOwnChairRenderPositionDebug}
        />
      ))}
      {/* Chair/tray drag feel: the translucent "you'll land here" ring,
          mounted for the entire duration of an active chair drag — see the
          "Chair/tray drag feel" block comment above `floorPointFromClientXY`
          for the full reasoning. Only ever exists for THIS viewer's own
          seat (isDraggingChair can only ever be true for draggableUserId's
          own gesture), so there's no per-seat keying needed here. */}
      {isDraggingChair ? (
        <ChairDragGhost targetRef={chairDragGhostTargetRef} onDebug={onChairDragGhostDebug} />
      ) : null}
      {/* DM tray drag ("the dm cant move their dive tray" [sic]): an
          invisible grab handle riding on top of the DM's own personal tray
          (ConnectedMemberDiceTray/DiceTumble render the actual visible tray
          — a Canvas sibling of this whole component in GameRoom.tsx; this is
          only the pointer target). Rendered ONLY for the DM's own client
          (dmTrayDraggable) and only once dmSeat actually exists
          (dmTrayPosition non-null) — never for a player, whose own tray
          keeps its pre-existing chair-follow behavior completely unchanged
          with no grab handle of its own. This does NOT touch draggableUserId
          or TableSeat's own chair grab handle above in any way: the DM's
          throne still renders no grab handle at all, exactly as before. */}
      {dmTrayDraggable && dmTrayPosition ? (
        <mesh
          position={[dmTrayPosition[0], dmTrayPosition[1] + DM_TRAY_DRAG_HANDLE_Y, dmTrayPosition[2]]}
          onPointerDown={handleDmTrayPointerDown}
        >
          <boxGeometry args={DM_TRAY_DRAG_HIT_BOX} />
          {/* opacity-0, not visible={false} — an invisible mesh is skipped
              by the raycaster, which would defeat the hit box entirely
              (CHAIR_DRAG_HIT_BOX/DmBookProp's own precedent). */}
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ) : null}
    </>
  );
}
