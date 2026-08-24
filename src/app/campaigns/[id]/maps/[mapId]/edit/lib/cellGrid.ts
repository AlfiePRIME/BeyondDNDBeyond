import type { TerrainType } from "@/rules-engine";
import type { MapCell } from "@/data-access";
import type { MapEditorCell } from "@/scene-3d";

export interface CellState {
  elevation: number;
  terrain: TerrainType;
}

export const DEFAULT_CELL: CellState = { elevation: 0, terrain: "normal" };

// Editor-side sculpting bounds, not a schema constraint: negative elevation
// would render as a hole through the ground plane, and ten steps is already
// a 50 ft cliff at the rules-engine's 5 ft per step.
export const MAX_ELEVATION = 10;

export type EditorTool = "raise" | "lower" | "terrain";

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
    overlay.set(cellKey(row.x, row.y), { elevation: row.elevation, terrain: row.terrain_type });
  }
  return overlay;
}

/** Returns `current` (same reference) when the tool would change nothing,
 * so callers can skip dirty-marking no-op paints. */
export function applyTool(current: CellState, tool: EditorTool, brush: TerrainType): CellState {
  if (tool === "raise") {
    if (current.elevation >= MAX_ELEVATION) return current;
    return { ...current, elevation: current.elevation + 1 };
  }
  if (tool === "lower") {
    if (current.elevation <= 0) return current;
    return { ...current, elevation: current.elevation - 1 };
  }
  if (current.terrain === brush) return current;
  return { ...current, terrain: brush };
}

/** The full dense grid the scene renders: defaults everywhere, overlaid
 * with whatever sparse state exists. */
export function buildDenseCells(
  width: number,
  height: number,
  overlay: ReadonlyMap<string, CellState>
): MapEditorCell[] {
  const cells: MapEditorCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const state = overlay.get(cellKey(x, y)) ?? DEFAULT_CELL;
      cells.push({ x, y, elevation: state.elevation, terrain: state.terrain });
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
    return { map_id: mapId, x, y, elevation: state.elevation, terrain_type: state.terrain };
  });
}
