import type { TerrainType } from "@/rules-engine";
import type { GroundType, LightLevel, MapCell, WaterFlowDirection } from "@/data-access";
import type { MapSurfaceCell } from "@/scene-3d";

export interface CellState {
  elevation: number;
  terrain: TerrainType;
  light: LightLevel;
  /** Ground type (the post-roadmap ground-types addition) — the same
   * always-present shape as `terrain`/`light`; "default" is the
   * sparse-storage default. Independent of `terrain`: painting one never
   * touches the other. */
  ground: GroundType;
  /** Flow direction authored on a water cell (the water-terrain addition) —
   * meaningful only when `ground === "water"`; null on every other cell,
   * including a water cell nobody ever picked a direction for. Reset to
   * null automatically whenever a cell is repainted to any OTHER ground
   * type (see applyTool's "ground" branch) — the same "a stale value
   * doesn't linger once its precondition no longer holds" reasoning the
   * pit tool's un-pit-resets-elevation branch already established below.
   * Purely decorative: nothing here or in the rules engine ever reads it. */
  waterFlow: WaterFlowDirection | null;
}

export const DEFAULT_CELL: CellState = {
  elevation: 0,
  terrain: "normal",
  light: "bright",
  ground: "default",
  waterFlow: null,
};

// Editor-side sculpting bounds, not a schema constraint: negative elevation
// would render as a hole through the ground plane, and ten steps is already
// a 50 ft cliff at the rules-engine's 5 ft per step.
export const MAX_ELEVATION = 10;

// Pits and falling (docs/design/pits-and-falling.md §8): the ONE sculpt
// path allowed to push elevation negative — the ordinary raise/lower
// tools' floor-at-0 clamp below is untouched. Chosen at exactly the SRD's
// own fall-damage cap (200 ft / 40 steps at this app's 5 ft/step): depth
// beyond it changes nothing mechanically (fallDamageDiceCount is already
// capped there), so there is nothing to gain by permitting a deeper pit.
export const MIN_PIT_ELEVATION_STEPS = -40;

export type EditorTool =
  | "elevation"
  | "pit"
  | "terrain"
  | "light"
  | "ground"
  | "object"
  | "generate"
  | "transition"
  | "light-source"
  | "concealed-pit";

/** The paint-a-cell tools. "object" is excluded because it routes through
 * the discrete place/select/move flow, never through applyTool; "generate"
 * because its drag defines a selection rectangle, not per-cell edits;
 * "transition", "light-source", and "concealed-pit" because their clicks
 * pick a cell for a form (a link origin / a fixed light anchor / a hidden
 * trap's real depth), editing nothing in the visible overlay directly. */
export type SculptTool = Exclude<
  EditorTool,
  "object" | "generate" | "transition" | "light-source" | "concealed-pit"
>;

/** applyTool's two elevation branches. Formerly two separate EditorTool
 * values ("raise"/"lower") the DM switched between; now the single
 * "elevation" EditorTool covers both, and the caller (MapEditor.tsx's
 * handlePaintCell) picks the direction per click from the mouse button
 * (left raises, right lowers) instead of from which tool is selected. */
export type ElevationDirection = "raise" | "lower";

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
      ground: row.ground_type,
      waterFlow: row.water_flow_direction,
    });
  }
  return overlay;
}

/** Returns `current` (same reference) when the tool would change nothing,
 * so callers can skip dirty-marking no-op paints.
 *
 * `tool` is `ElevationDirection` in place of the old "raise"/"lower"
 * EditorTool values — same two branches, same clamping, just no longer
 * required to equal the currently-selected tool.
 *
 * `waterFlowBrush` defaults to "south" so every pre-water call site
 * (including this module's own tests) keeps compiling and behaving
 * unchanged without passing a sixth argument — it only ever matters when
 * `groundBrush === "water"`, the one case that actually reads it. */
export function applyTool(
  current: CellState,
  tool: ElevationDirection | Exclude<SculptTool, "elevation">,
  brush: TerrainType,
  lightBrush: LightLevel,
  groundBrush: GroundType,
  waterFlowBrush: WaterFlowDirection = "south"
): CellState {
  if (tool === "raise") {
    if (current.elevation >= MAX_ELEVATION) return current;
    return { ...current, elevation: current.elevation + 1 };
  }
  if (tool === "lower") {
    if (current.elevation <= 0) return current;
    return { ...current, elevation: current.elevation - 1 };
  }
  if (tool === "pit") {
    // The one sculpt path that both deepens AND marks the terrain in a
    // single click — a pit's depth and its terrain_type are authored
    // together (docs/design/pits-and-falling.md §8), unlike ordinary
    // plateaus where raise/lower and the terrain brush are independent
    // axes. Floors at MIN_PIT_ELEVATION_STEPS, same shape as raise/lower's
    // own clamp, just far lower.
    if (current.elevation <= MIN_PIT_ELEVATION_STEPS) return current;
    return { ...current, elevation: current.elevation - 1, terrain: "pit" };
  }
  if (tool === "light") {
    if (current.light === lightBrush) return current;
    return { ...current, light: lightBrush };
  }
  if (tool === "ground") {
    // Water is the one ground brush that carries a second value along with
    // it — the currently-picked flow direction — so painting (or
    // re-painting, to change the direction of an already-water cell) water
    // sets both together in the same click, the pit tool's own
    // "one click authors two related fields" precedent. Painting any OTHER
    // ground brush clears a stale flow direction rather than leaving it
    // behind on a cell that's no longer water (this CellState's own doc
    // comment).
    if (groundBrush === "water") {
      if (current.ground === "water" && current.waterFlow === waterFlowBrush) return current;
      return { ...current, ground: "water", waterFlow: waterFlowBrush };
    }
    if (current.ground === groundBrush && current.waterFlow === null) return current;
    return { ...current, ground: groundBrush, waterFlow: null };
  }
  if (current.terrain === brush) return current;
  // Repainting a pit cell to any other terrain (the "un-pit" path — there is
  // no dedicated tool for it, just the ordinary terrain brush) resets its
  // elevation back to 0 rather than leaving a non-pit cell stuck at a
  // negative elevation: negative elevation is only ever meaningful paired
  // with terrain_type = 'pit' (see MIN_PIT_ELEVATION_STEPS's own comment
  // and the original cellGrid.ts design note this addition builds on — "
  // negative elevation would render as a hole through the ground plane").
  const elevation = brush !== "pit" && current.elevation < 0 ? 0 : current.elevation;
  return { ...current, terrain: brush, elevation };
}

/** The full dense grid the scene renders: defaults everywhere, overlaid
 * with whatever sparse state exists. Cells present in `preview` take that
 * state instead and are flagged so the scene can render them as
 * not-yet-committed. `includeLight` (the map EDITOR only) carries the
 * authored light level into the scene as an authoring tint — the Game
 * Room's table never passes it, so nothing about live-table rendering
 * changes here; actual illumination rendering is Prompt 56's job. `ground`
 * is NOT gated behind a flag like light: it's real appearance on both
 * surfaces, so it's carried unconditionally — but only when it differs from
 * "default", the same "only set truthy/non-default optional fields" style
 * `preview` already uses, so a plain unpainted cell produces the exact same
 * object shape it always has (nothing about a pre-ground-types map's
 * rendering changes, down to the object shape, not just the pixel).
 * `waterFlowDirection` follows the identical "carried unconditionally, only
 * when set" rule, further gated on `ground === "water"` — a flow direction
 * authored, then the cell repainted to a different ground type WITHOUT
 * going through applyTool's own clearing branch (a hand-built CellState,
 * e.g. in a test) still renders no arrow, matching the "meaningful only
 * alongside water" contract at the render layer too, not just the sculpt
 * layer. */
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
        ...(state.ground !== "default" ? { ground: state.ground } : {}),
        ...(state.ground === "water" && state.waterFlow
          ? { waterFlowDirection: state.waterFlow }
          : {}),
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
      ground_type: state.ground,
      water_flow_direction: state.waterFlow,
    };
  });
}
