// Public entry point for the scene-3d module. React Three Fiber scene code —
// the table, seating, avatars, live map rendering, tokens, vision masking.
export const MODULE_NAME = "scene-3d" as const;

export {
  GameTableScene,
  type GameTableSceneProps,
  type TableLiveMap,
  type DayNightMode,
  type WeatherKind,
  resolveSceneFog,
} from "./GameTableScene";
// Weather & Enemies C4: verification-only debug payload for GameTableScene's
// onWeatherParticlesDebug pass-through — see WeatherParticles.tsx's own doc
// comment.
export { type WeatherParticlesDebugState } from "./WeatherParticles";
// Overhead cloud layer's own pure per-weatherKind appearance function — the
// resolveSceneFog precedent exactly, exported so GameRoom.tsx's own hidden
// weather debug mirror can report a real, exact cloud-preset read without
// needing anything off the live WebGL scene. See CloudLayer.tsx's own doc
// comment for the full palette and reasoning.
export { resolveCloudPreset, type CloudPreset } from "./CloudLayer";
export { type TokenSlidePhase } from "./useTokenSlide";
export {
  MapEditorScene,
  type MapEditorSceneProps,
  type EditorRegion,
  type EditorReferenceImage,
} from "./MapEditorScene";
// Map Editor Batch A7 (wall-mounted torches) — MapEditor.tsx's own
// hover/mount-resolution logic, and GameRoom.tsx's equivalent live-scene
// derivation, both need the same pure geometry.
export {
  resolveWallMountOffset,
  WALL_MOUNT_FACES,
  WALL_MOUNT_OFFSET,
  type WallMountHost,
  type WallMountFaceDeg,
} from "./wallMount";
export {
  MapSurface,
  type MapSurfaceProps,
  type MapSurfaceCell,
  type MapSurfaceLightLevel,
  type MapSurfaceVisibility,
  type MapSurfaceGroundType,
  type MapSurfaceWaterFlowDirection,
  type MapSurfaceObject,
  type MapSurfaceToken,
  type MapTokenAllegiance,
  type MapSurfaceMetrics,
  // Object Reveal Cards: the same worldX/worldZ offset formula
  // ObjectMarker's own invocation already uses, so GameRoom.tsx can place a
  // reveal card at IDENTICAL coordinates to the real object it's revealing
  // for, rather than a hand-copied duplicate of this formula.
  mapCellOffsets,
} from "./MapSurface";
export { computeTableMapMetrics } from "./mapFit";
export { buildGridOverlayPositions } from "./gridOverlay";
// Map Art Generation E5 — the reference-image feature's own contain-fit
// math (MapEditorScene.tsx's ReferenceImagePlane), factored out so
// GameTableScene's own MapArtPlane reuses it verbatim.
export { computeMapArtFit } from "./mapArtFit";
export { PlacedObject, PLACED_OBJECT_SIZE, isWallFamilyUrl, isBuildingPresetUrl } from "./PlacedObject";
// Avatar's own normalization target — exported for the account/campaign
// upload flows' rotate-and-confirm preview (OrientationPreview), which must
// normalize a candidate avatar upload at the exact scale it will actually
// render at.
export { AVATAR_HEIGHT } from "./SeatAvatar";
// The rotate-and-confirm upload step's live preview (see
// docs/design/model-orientation-and-posing.md §8) — used by
// AssetPalette.tsx's custom map-asset upload and AvatarPicker.tsx's custom
// avatar upload via the shared app-layer ModelOrientationStep wrapper.
export { OrientationPreview, type OrientationPreviewProps, type ModelNormalize } from "./OrientationPreview";
export {
  DiceTumble,
  type DiceFaceSettledInfo,
  type DiceTumbleHandle,
  type DiceTumbleProps,
  type DiceTumbleSpec,
  // One personal tray per connected member (replacing the old single
  // shared tray + DM-private-tray pair) — GameRoom.tsx mounts one of these
  // per member at seating.ts's computeMemberTrayPosition, sized by
  // PERSONAL_TRAY_SCALE/PERSONAL_TRAY_RADIUS; trayRadiusForScale is the one
  // real formula both this file and seating.ts's tray-spacing constants
  // derive from, so neither can silently drift from the other.
  trayRadiusForScale,
  PERSONAL_TRAY_SCALE,
  PERSONAL_TRAY_RADIUS,
} from "./DiceTumble";
// Phase 5: the DM's book as a real 3D prop (replacing DmBook.tsx's old
// screen-fixed 2D overlay) — see DmBookProp.tsx's doc comment for why it
// takes the page content as `children` rather than importing DmBook itself.
export {
  DmBookProp,
  type DmBookPropProps,
  // Same collision-avoidance reasoning as DiceTumble's own TRAY_RADIUS above.
  DM_BOOK_FOOTPRINT_RADIUS,
} from "./DmBookProp";
// Chat & Summary B3: the floating chat bubble above a seated member's own
// chair — GameRoom.tsx mounts one of these per currently-chatting member,
// the same Canvas-sibling pattern as DmBookProp above.
export { ChatBubble, type ChatBubbleProps } from "./ChatBubble";
// A triggered reveal_text/reveal_image behavior's own content, floating
// above the object's real spot on the table (replacing MapPanel.tsx's old
// flat inline paragraph/image) — GameRoom.tsx mounts one of these per
// currently-revealed object, ChatBubble's own Canvas-sibling pattern again.
export { ObjectRevealCard, type ObjectRevealCardProps } from "./ObjectRevealCard";
export {
  computeSeatLayout,
  computeCampaignSeatLayout,
  seatEllipseSemiAxes,
  applySeatOffset,
  getEffectiveSeat,
  computeMemberTrayPosition,
  HEAD_SQUARE_MEMBER_TRAY_FRACTION,
  APPENDED_TABLE_MEMBER_TRAY_FRACTION,
  resolveMemberTrayLayout,
  HEAD_SQUARE_SEAT_CAPACITY,
  SINGLE_TABLE_SEAT_CAPACITY,
  PLAYER_CHAIR_FRONTAGE,
  DM_CHAIR_FRONTAGE,
  // Movable chairs (drag gesture): GameTableScene.tsx uses the clamp/
  // reorient helpers live during a drag; GameRoom.tsx uses the full
  // resolveChairDrop (clamp + collision-avoidance nudge) as the final
  // authority once a drag ends — see seating.ts's own doc comments.
  CHAIR_DRAG_CLAMP_RADIUS,
  nearestTableCenter,
  clampToTableArrangement,
  rotationYTowardNearestTable,
  resolveChairDrop,
  type CameraMode,
  type Seat,
  type SeatMember,
  type SeatOffset,
  type CampaignSeatLayout,
  type CampaignSeat,
  type AppendedTable,
  type ChairObstacle,
  type MemberTraySeed,
} from "./seating";
// Phase 3: GameRoom derives the DM's private dice tray position from the
// DM's own seat, in table-surface-relative terms — the one table constant
// the app layer needs, alongside the seat layout itself.
// COMBINED_TABLE_TOP (the two-table combined footprint) is exported too —
// the dynamic-table-capacity generalization (computeCampaignSeatLayout
// above) needs these exact numbers for its own capacity math, and
// GameRoom.tsx mirrors the same call for its own DM-seat-relative prop
// positions.
export { TABLE_SURFACE_Y, COMBINED_TABLE_TOP } from "./table";
// Whiteboard drawing layer (docs/design/whiteboard-drawing-layer.md) —
// Prompt 2's rendering/toolset/draw-mode interaction plus Prompt 3's
// persistence/live-sync layered on top (initialTiles/onLocalStroke*/
// onTilesPersist/onClearPersist props, the applyRemoteStroke*/
// applyTileChanges/loadTiles/clearRemote imperative handle). WhiteboardPlane
// is wired into GameTableScene.tsx as a sibling of MapSurface; the
// height/color defaults and tool type are public so GameRoom.tsx (the
// toolbar's actual owner AND the realtime/persistence orchestrator) and
// MapPanel.tsx (the toggle/toolbar UI) can share them without redeclaring.
export {
  WhiteboardPlane,
  type WhiteboardPlaneProps,
  type WhiteboardHandle,
  type WhiteboardTool,
  type WhiteboardHistoryState,
  type WhiteboardDebugState,
  type WhiteboardTileData,
  type WhiteboardTileUpdate,
  type WhiteboardGridPoint,
} from "./WhiteboardPlane";
export {
  DEFAULT_WHITEBOARD_HEIGHT,
  MIN_WHITEBOARD_HEIGHT,
  MAX_WHITEBOARD_HEIGHT,
  WHITEBOARD_HEIGHT_STEP,
  DEFAULT_WHITEBOARD_COLOR,
  DEFAULT_WHITEBOARD_BRUSH_SIZE,
  type WhiteboardBrushSize,
} from "./whiteboardMath";
