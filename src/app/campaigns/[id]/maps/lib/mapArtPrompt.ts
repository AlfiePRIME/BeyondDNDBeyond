// Production prompt-building for map art generation (Map Art Generation
// E4) — ported from the E1 research spike's own
// scripts/poc/map-art-generation/workflow.mjs (buildLegendPrompt/
// LEGEND_LINES/ELEVATION_NOTE; see docs/map-art-generation-research.md §7).
// Deliberately lives here, in the app layer next to controlImage.ts, rather
// than in src/image-ai: it needs controlImageCategory and the real
// CellState/GroundType/TerrainType types to scan a map's actual cell data,
// which the architecturally-separate image-ai module (graph JSON in, PNG
// out — no map-data awareness) has no business depending on. src/image-ai's
// generateMapArt() only ever receives the FINISHED prompt string this
// produces.
import { controlImageCategory, type ControlImageCategory } from "./controlImage";
import { cellKey, type CellState } from "../[mapId]/edit/lib/cellGrid";

// One legend line per category, fixed to match controlImage.ts's actual
// HUE_BY_CATEGORY assignment — kept as plain material descriptions (not "the
// red region") so the wording survives if the exact hue numbers are retuned
// later without the prompt going stale. Ordered so a room's structural
// elements (walls, floor, hazards) are described before decorative ground
// dressing, roughly the order a DM would narrate a room.
const LEGEND_LINES: Record<ControlImageCategory, string> = {
  void: "Solid black areas are stone walls (or, outdoors, impassable rock/cliff) — opaque, no floor.",
  water: "Blue areas are water — a pool, pond, or lake.",
  pit: "Small violet/purple patches are dark bottomless pit holes in the floor.",
  normal: "Magenta-pink areas are plain unadorned floor.",
  difficult: "Bright red patches are a rubble/hazard strewn floor that's difficult to cross.",
  stone: "Pink/crimson areas are worked stone floor (flagstones).",
  rock: "Red-orange areas are bare natural rock ground.",
  path: "Orange/gold stripes are a worn dirt path.",
  sand: "Yellow areas are sandy ground.",
  swamp: "Olive/yellow-green areas are boggy swamp ground with reeds.",
  grass: "Green areas are open grass.",
  forest: "Saturated green areas are forest tree canopy seen from above.",
  dense_forest: "Teal-green areas are extra-dense forest canopy.",
};

// Lighter regions of the SAME hue are higher elevation (a step, terrace, or
// dais) than darker regions of that hue — stated once, generically, rather
// than as a per-map fact, since it's a fixed property of the control-image
// renderer's own encoding (controlImage.ts's lightnessForElevation).
const ELEVATION_NOTE =
  "Within any single-colored region, a visibly lighter patch of that same color is raised higher " +
  "(a step, ledge, terrace, or dais) than a darker patch of it — render that as an actual change in " +
  "height, not just a lighter floor tint.";

// The generic closing instruction used when NEITHER the DM's own style
// prompt NOR the admin's app_settings.comfyui_style_prompt default (E2) is
// set — the last-resort fallback, not the primary path.
const DEFAULT_STYLE_NOTE =
  "Render with realistic top-down textures appropriate to each material (stone flagstones, wood " +
  "grain, rippling water, loose rubble, grass, tree canopy, sand, reeds) and natural lighting, while " +
  "leaving every region's boundary exactly where the reference image has it.";

/**
 * Builds the positive prompt from the map's OWN data: scans which
 * categories the grid actually uses (via the exact same controlImageCategory
 * precedence controlImage.ts's renderer uses, so the description can never
 * mention a category that isn't really in the image) and emits one line per
 * category present, plus a fixed elevation note and a closing style
 * instruction.
 *
 * `styleNote` is the DM's own style prompt (or, if they left it blank, the
 * caller should already have substituted app_settings.comfyui_style_prompt
 * — E2's admin default — before calling this); `undefined`/blank falls back
 * to DEFAULT_STYLE_NOTE. This function itself performs no fallback lookup —
 * that's the generate-art Route Handler's job (it's the one with server-side
 * access to both the DM's request body and the admin config).
 *
 * Wording note (a real, live-tested finding — research doc §7): an earlier
 * version framed the reference image as a "layout key" to "reinterpret" and
 * told the model each area "marks" a material. That wording measurably
 * backfired — the model treated the input as an abstract reference chart and
 * redrew it as a four-quadrant collage of unrelated vignettes instead of one
 * coherent map, discarding the actual spatial layout it was conditioned on.
 * The fix (shipped below) is to assert the input IS already the map,
 * verbatim, and to explicitly forbid rearranging, duplicating, or tiling it.
 */
export function buildMapArtPrompt(
  gridWidth: number,
  gridHeight: number,
  overlay: ReadonlyMap<string, CellState>,
  defaultCell: CellState,
  styleNote?: string
): string {
  const present = new Set<ControlImageCategory>();
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const state = overlay.get(cellKey(x, y)) ?? defaultCell;
      present.add(controlImageCategory(state));
    }
  }

  const legend = (Object.entries(LEGEND_LINES) as [ControlImageCategory, string][])
    .filter(([category]) => present.has(category))
    .map(([, line]) => line);

  return [
    "The attached reference image IS the top-down floorplan of a real map: every flat-colored area " +
      "already has its final shape, size, and position. Repaint it in place as painted fantasy " +
      "tabletop RPG battle-map art — do not redesign, rearrange, resize, duplicate, or tile any " +
      "region, and do not split the scene into separate panels or vignettes. It stays one single " +
      "continuous top-down scene with the same framing and aspect ratio as the reference. Replace " +
      "each flat color with the real material it represents, using this key:",
    ...legend,
    ELEVATION_NOTE,
    styleNote?.trim() || DEFAULT_STYLE_NOTE,
  ].join("\n");
}
