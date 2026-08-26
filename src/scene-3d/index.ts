// Public entry point for the scene-3d module. React Three Fiber scene code —
// the table, seating, avatars, live map rendering, tokens, vision masking.
export const MODULE_NAME = "scene-3d" as const;

export {
  GameTableScene,
  type GameTableSceneProps,
  type TableLiveMap,
  type DayNightMode,
} from "./GameTableScene";
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
export { PlacedObject } from "./PlacedObject";
export { DiceTumble, type DiceTumbleHandle, type DiceTumbleProps, type DiceTumbleSpec } from "./DiceTumble";
// Phase 5: the DM's book as a real 3D prop (replacing DmBook.tsx's old
// screen-fixed 2D overlay) — see DmBookProp.tsx's doc comment for why it
// takes the page content as `children` rather than importing DmBook itself.
export { DmBookProp, type DmBookPropProps } from "./DmBookProp";
export {
  computeSeatLayout,
  seatEllipseSemiAxes,
  type CameraMode,
  type Seat,
  type SeatMember,
} from "./seating";
// Phase 3: GameRoom derives the DM's private dice tray position from the
// DM's own seat, in table-surface-relative terms — the one table constant
// the app layer needs, alongside the seat layout itself.
// COMBINED_TABLE_TOP (the two-table combined footprint) is exported too — a
// later prompt's seating-capacity generalization needs these exact numbers
// for its own capacity math.
export { TABLE_SURFACE_Y, COMBINED_TABLE_TOP } from "./table";
