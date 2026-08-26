// Public entry point for the scene-3d module. React Three Fiber scene code —
// the table, seating, avatars, live map rendering, tokens, vision masking.
export const MODULE_NAME = "scene-3d" as const;

export {
  GameTableScene,
  type GameTableSceneProps,
  type TableLiveMap,
  type DayNightMode,
} from "./GameTableScene";
export { type TokenSlidePhase } from "./useTokenSlide";
export {
  MapEditorScene,
  type MapEditorSceneProps,
  type EditorRegion,
  type EditorReferenceImage,
} from "./MapEditorScene";
export {
  MapSurface,
  type MapSurfaceProps,
  type MapSurfaceCell,
  type MapSurfaceLightLevel,
  type MapSurfaceVisibility,
  type MapSurfaceObject,
  type MapSurfaceToken,
  type MapTokenAllegiance,
  type MapSurfaceMetrics,
} from "./MapSurface";
export { computeTableMapMetrics } from "./mapFit";
export { buildGridOverlayPositions } from "./gridOverlay";
export { PlacedObject, PLACED_OBJECT_SIZE } from "./PlacedObject";
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
