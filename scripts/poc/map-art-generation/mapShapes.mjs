// Mirrors this app's real map-cell data shape and sparse-overlay
// reconstruction, so this PoC's fixtures and control-image renderer consume
// exactly the same contract the real app does — without pulling TypeScript
// path-aliased app modules (@/data-access, @/rules-engine) into a plain
// Node ESM script, which has no build step here.
//
// Source of truth, read in full for this spike:
//   src/data-access/maps.ts            (MapCell, GROUND_TYPES, LIGHT_LEVELS)
//   src/rules-engine/movement.ts       (TerrainType)
//   src/app/.../maps/[mapId]/edit/lib/cellGrid.ts
//     (CellState, DEFAULT_CELL, cellKey, overlayFromRows)
//
// This is the same "mirror rather than import" call thumbnail.ts itself
// already makes for MapSurface's palette (see its own top-of-file comment)
// — here forced by a runtime boundary (Node script vs. Next.js/TS app)
// instead of a module-privacy/dependency-weight one, but the same reasoning
// applies: a handful of literal values duplicated beats a real cross-runtime
// import for a throwaway script.

/** src/rules-engine/movement.ts:22 */
export const TERRAIN_TYPES = ["normal", "difficult", "void", "pit"];

/** src/data-access/maps.ts's GROUND_TYPES (verbatim) */
export const GROUND_TYPES = [
  "default",
  "grass",
  "rock",
  "forest",
  "dense_forest",
  "path",
  "sand",
  "swamp",
  "stone",
  "water",
];

/** cellGrid.ts's DEFAULT_CELL, as the CellState shape overlayFromRows produces. */
export const DEFAULT_CELL = {
  elevation: 0,
  terrain: "normal",
  light: "bright",
  ground: "default",
  waterFlow: null,
};

export function cellKey(x, y) {
  return `${x},${y}`;
}

/** cellGrid.ts's overlayFromRows, verbatim transform: MapCell[] -> sparse
 * Map<"x,y", CellState>. Fixtures below build MapCell[] rows (the real
 * storage shape); this is the same reconstruction step the real app runs
 * before handing an overlay to renderMapThumbnail. */
export function overlayFromRows(rows) {
  const overlay = new Map();
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

/** Builds one sparse MapCell row (map_id omitted — irrelevant to a
 * standalone overlay reconstruction), defaulting light_level/water_flow the
 * same way createPopulatedMap's NewMapCell does. */
export function cell(x, y, { elevation = 0, terrain = "normal", ground = "default", waterFlow = null } = {}) {
  return {
    x,
    y,
    elevation,
    terrain_type: terrain,
    light_level: "bright",
    ground_type: ground,
    water_flow_direction: waterFlow,
  };
}
