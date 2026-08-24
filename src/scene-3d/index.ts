// Public entry point for the scene-3d module. React Three Fiber scene code —
// the table, seating, avatars, live map rendering, tokens, vision masking.
export const MODULE_NAME = "scene-3d" as const;

export { GameTableScene, type GameTableSceneProps } from "./GameTableScene";
export {
  MapEditorScene,
  type MapEditorSceneProps,
  type MapEditorCell,
} from "./MapEditorScene";
export {
  computeSeatLayout,
  type CameraMode,
  type Seat,
  type SeatMember,
} from "./seating";
