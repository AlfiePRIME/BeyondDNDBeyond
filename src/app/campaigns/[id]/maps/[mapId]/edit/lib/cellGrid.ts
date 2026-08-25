import type { TerrainType } from "@/rules-engine";
import type { LightLevel, MapCell } from "@/data-access";
import type { MapSurfaceCell } from "@/scene-3d";

export interface CellState {
  elevation: number;
  terrain: TerrainType;
  light: LightLevel;
}

export const DEFAULT_CELL: CellState = { elevation: 0, terrain: "normal", light: "bright" };

// Editor-side sculpting bounds, not a schema constraint: negative elevation
// would render as a hole through the ground plane, and ten steps is already
// a 50 ft cliff at the rules-engine's 5 ft per step.
export const MAX_ELEVATION = 10;

export type EditorTool =
  | "raise"
  | "lower"
  | "terrain"
  | "light"
  | "object"
  | "generate"
  | "transition"
  | "light-source";

/** The paint-a-cell tools. "object" is excluded because it routes through
 * the discrete place/select/move flow, never through applyTool; "generate"
 * because its drag defines a selection rectangle, not per-cell edits;
 * "transition" and "light-source" because their clicks pick a cell for a
 * form (a link origin / a fixed light anchor), editing nothing. */
export type SculptTool = Exclude<EditorTool, "object" | "generate" | "transition" | "light-source">;

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseCellKey(key: string): { x: number; y: number } {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

/** Sparse overlay from the stored rows — absent key means DEFAULT_CELL. */
export function overlayFromRows(rows: readonly MapCell[]): Map<string, CellState> {
  const overlay = new Map<string, CellState>();
  for (const row of rows) {
    overlay.set(cellKey(row.x, row.y), {
      elevation: row.elevation,
      terrain: row.terrain_type,
      light: row.light_level,
    });
  }
  return overlay;
}

/** Returns `current` (same reference) when the tool would change nothing,
 * so callers can skip dirty-marking no-op paints. */
export function applyTool(
  current: CellState,
  tool: SculptTool,
  brush: TerrainType,
  lightBrush: LightLevel
): CellState {
  if (tool === "raise") {
    if (current.elevation >= MAX_ELEVATION) return current;
    return { ...current, elevation: current.elevation + 1 };
  }
  if (tool === "lower") {
    if (current.elevation <= 0) return current;
    return { ...current, elevation: current.elevation - 1 };
  }
  if (tool === "light") {
    if (current.light === lightBrush) return current;
    return { ...current, light: lightBrush };
  }
  if (current.terrain === brush) return current;
  return { ...current, terrain: brush };
}

/** The full dense grid the scene renders: defaults everywhere, overlaid
 * with whatever sparse state exists. Cells present in `preview` take that
 * state instead and are flagged so the scene can render them as
 * not-yet-committed. `includeLight` (the map EDITOR only) carries the
 * authored light level into the scene as an authoring tint — the Game
 * Room's table never passes it, so nothing about live-table rendering
 * changes here; actual illumination rendering is Prompt 56's job. */
export function buildDenseCells(
  width: number,
  height: number,
  overlay: ReadonlyMap<string, CellState>,
  preview?: ReadonlyMap<string, CellState>,
  includeLight = false
): MapSurfaceCell[] {
  const cells: MapSurfaceCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const key = cellKey(x, y);
      const previewState = preview?.get(key);
      const state = previewState ?? overlay.get(key) ?? DEFAULT_CELL;
      cells.push({
        x,
        y,
        elevation: state.elevation,
        terrain: state.terrain,
        ...(includeLight ? { light: state.light } : {}),
        ...(previewState ? { preview: true } : {}),
      });
    }
  }
  return cells;
}

/** Rows for a batched save — only the cells touched this session. */
export function rowsForSave(
  mapId: string,
  overlay: ReadonlyMap<string, CellState>,
  dirty: ReadonlySet<string>
): MapCell[] {
  return [...dirty].map((key) => {
    const { x, y } = parseCellKey(key);
    const state = overlay.get(key) ?? DEFAULT_CELL;
    return {
      map_id: mapId,
      x,
      y,
      elevation: state.elevation,
      terrain_type: state.terrain,
      light_level: state.light,
    };
  });
}
