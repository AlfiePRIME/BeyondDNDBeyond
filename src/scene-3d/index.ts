// Public entry point for the scene-3d module. React Three Fiber scene code —
// the table, seating, avatars, live map rendering, tokens, vision masking.
export const MODULE_NAME = "scene-3d" as const;

export { GameTableScene, type GameTableSceneProps, type TableLiveMap } from "./GameTableScene";
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
  type MapSurfaceObject,
  type MapSurfaceToken,
  type MapTokenAllegiance,
  type MapSurfaceMetrics,
} from "./MapSurface";
export { computeTableMapMetrics } from "./mapFit";
export { buildGridOverlayPositions } from "./gridOverlay";
export { PlacedObject } from "./PlacedObject";
export {
  computeSeatLayout,
  type CameraMode,
  type Seat,
  type SeatMember,
} from "./seating";
