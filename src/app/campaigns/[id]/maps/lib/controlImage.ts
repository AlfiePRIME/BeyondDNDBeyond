// The real, production control-image exporter for map art generation — the
// structural conditioning signal fed to ComfyUI/FLUX.2's ReferenceLatent
// node (docs/map-art-generation-research.md, E1's research spike). Ported
// from that spike's own throwaway PoC
// (scripts/poc/map-art-generation/controlImage.mjs) against this app's REAL
// MapCell/CellState types instead of the PoC's hand-built fixture shapes —
// same palette, same tuning, same precedence rules; only the runtime (real
// TS types, a real PNG encoder) changed. Do not re-derive the palette here;
// see the research doc §5 for why each value is what it is before touching
// HUE_BY_CATEGORY.
//
// Deliberately a SEPARATE module from thumbnail.ts's renderMapThumbnail, not
// a flag on it — their purposes diverge structurally, not cosmetically:
//   1. Flat, evenly-spaced, high-saturation hues per category instead of
//      thumbnail.ts's muted palette (chosen there for visual parity with
//      MapSurface's 3D render) — a conditioning image's job is to be
//      maximally *distinguishable* per category, not pretty.
//   2. Discrete elevation lightness BANDS instead of thumbnail.ts's
//      continuous lerp — sharp bands give the diffusion model a crisp
//      region boundary to key off (a terrace edge), where a smooth gradient
//      would blur across a step change in the target output.
//   3. Zero inter-cell gap — thumbnail.ts's CELL_GAP_RATIO exists for a
//      graph-paper UI aesthetic; a gap of backdrop color between every
//      single cell would read to the model as a fixed mosaic-grid texture
//      baked into the whole image, which real terrain isn't. Same-category
//      neighbors merge into one solid region here; only an actual category
//      change produces a boundary.
//
// Precedence for picking a cell's base hue mirrors thumbnailCellColor
// exactly (same order of checks, real values just replaced): void first (no
// floor at all, regardless of ground/terrain), then ground when it's not
// 'default' (a ground type is purely a floor color and overrides the
// terrain-driven hazard/chasm hues), then terrain-driven (normal/difficult/
// pit) on 'default' ground.
//
// water_flow_direction is intentionally NOT rendered here, matching the E1
// spike exactly: cellGrid.ts's own CellState doc comment calls it "purely
// decorative — nothing here or in the rules engine ever reads it", and the
// spike's real, live-tested renderer never consulted it either. Nothing
// about walls/objects (map_objects) feeds this signal — the void terrain
// IS the wall signal; placed objects/tokens are a separate concern E1 never
// exercised and this port doesn't invent new scope for.
import type { GroundType } from "@/data-access";
import type { TerrainType } from "@/rules-engine";
import { cellKey, DEFAULT_CELL, type CellState } from "../[mapId]/edit/lib/cellGrid";
import { encodeRgbPng } from "./png";

// FLUX's own latent-size step (16px). Control images are sized to a
// 1024px long edge, rounded up to a multiple of 16 — matches the E1 spike's
// buildMapArtWorkflow expectation that the empty latent and the encoded
// reference latent share identical canvas dimensions.
const TARGET_LONG_EDGE = 1024;

/** The exact category set thumbnailCellColor's own precedence rule can
 * produce, minus the muted-palette distinction: void, any real non-default
 * ground type, or a non-void terrain type. 12 hue-carrying members (every
 * GroundType but 'default', plus 'normal'/'difficult'/'pit') plus 'void'. */
export type ControlImageCategory = "void" | Exclude<GroundType, "default"> | Exclude<TerrainType, "void">;

// 12 categories that carry a hue (everything except void, which is hue-less
// near-black). NOT evenly spaced — an earlier live test against the real
// ComfyUI instance (docs/map-art-generation-research.md §5.2) used a naive
// even 30-degree wheel with water/stone/pit as three consecutive slots
// (210/240/270), and the model visibly bled watery texture onto the stone
// dais next to it: hue distance alone doesn't prevent the model from
// reading two "cool blue/violet family" regions as thematically related,
// even 30-60 degrees apart. water here instead gets an isolated
// ~140-degree buffer (nothing else placed between 140 and 280) with the
// other 11 categories sharing the remaining arc at their own near-even
// spacing (§5.3) — deliberately unequal, but the specific inequality is
// evidence-based, not arbitrary. Do not "fix" this back to even spacing.
const HUE_BY_CATEGORY: Record<Exclude<ControlImageCategory, "void">, number> = {
  water: 210, // blue — isolated, see comment above
  pit: 300, // violet (chasm) — 90 degrees clear of water, was 60
  normal: 320, // magenta-pink: generic default-ground floor
  stone: 340, // pink — 130 degrees clear of water, was 30
  difficult: 0, // hazard: red
  rock: 20, // red-orange
  path: 40, // orange
  sand: 60, // yellow
  swamp: 80, // yellow-green, murky
  grass: 100, // green
  forest: 120, // green
  dense_forest: 140, // teal-green — 70 degrees clear of water
};

// void: no floor at all — categorically different from every hue-carrying
// type at any lightness, not just "very dark". Kept saturation-free so it
// can never collide with a deeply-shadowed version of a real category.
const VOID_RGB: readonly [number, number, number] = [10, 10, 10];

const SATURATION = 0.82;

/** RGB, 0-255 per channel. */
export type Rgb = readonly [number, number, number];

// Four discrete elevation bands (cellGrid.ts's MAX_ELEVATION is 10) rather
// than thumbnailCellColor's continuous lerp — see module doc comment.
// Lightness rises with elevation, same direction thumbnailCellColor uses.
function lightnessForElevation(elevation: number): number {
  // Pits' negative elevation floors at 0, same clamp thumbnailCellColor
  // applies — a pit's elevation is a (possibly negative) floor depth, not
  // "how high up", so it never lightens past its lowest band.
  const clamped = Math.max(elevation, 0);
  if (clamped <= 1) return 0.4;
  if (clamped <= 3) return 0.52; // 3 of MAX_ELEVATION's 10 steps
  if (clamped <= 6) return 0.64; // 6 of MAX_ELEVATION's 10 steps
  return 0.76;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const [r1, g1, b1] =
    hp < 1
      ? [c, x(c, hp), 0]
      : hp < 2
        ? [x(c, hp), c, 0]
        : hp < 3
          ? [0, c, x(c, hp)]
          : hp < 4
            ? [0, x(c, hp), c]
            : hp < 5
              ? [x(c, hp), 0, c]
              : [c, 0, x(c, hp)];
  const m = l - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function x(c: number, hp: number): number {
  return c * (1 - Math.abs((hp % 2) - 1));
}

/** The exact category a cell falls into, applying the same void > ground >
 * terrain precedence thumbnailCellColor uses. Exported so buildLegendPrompt
 * (E1's PoC) and any future production prompt builder can classify a cell
 * with the identical rule the renderer itself uses, so a legend/description
 * can never mention a category that isn't really in the image. */
export function controlImageCategory(state: CellState): ControlImageCategory {
  if (state.terrain === "void") return "void";
  if (state.ground !== "default") return state.ground;
  return state.terrain; // "normal" | "difficult" | "pit"
}

/** The tuned per-cell color this control-image variant uses — analogous to
 * thumbnailCellColor, but flat-banded and saturated per the module doc
 * comment instead of a continuous parity-with-3D-render lerp. */
export function controlImageCellColor(state: CellState): Rgb {
  const category = controlImageCategory(state);
  if (category === "void") return VOID_RGB;
  const hue = HUE_BY_CATEGORY[category];
  const lightness = lightnessForElevation(state.elevation);
  return hslToRgb(hue, SATURATION, lightness);
}

export interface RenderedControlImage {
  width: number;
  height: number;
  /** Flat RGB pixel buffer, row-major, no padding, no alpha —
   * width * height * 3 bytes. */
  rgb: Buffer;
}

/**
 * Renders a map's real sparse cell overlay to a flat RGB control image
 * tuned for diffusion conditioning. Mirrors renderMapThumbnail's per-cell
 * rectangle rasterizing loop and DEFAULT_CELL fallback, sized toward
 * TARGET_LONG_EDGE (rounded up to a multiple of 16 — FLUX's own latent-size
 * step) rather than thumbnail.ts's 320px UI target, and with no inter-cell
 * gap (see module doc comment). Deterministic: the same grid dimensions and
 * overlay always produce byte-identical output — no randomness anywhere in
 * this path.
 *
 * `overlay` is exactly the shape `overlayFromRows(listMapCells(...))`
 * produces against a real map's stored `map_cells` rows — this function
 * never reads the database itself, so it works equally against real
 * production data or an in-memory overlay a caller builds for a test.
 */
export function renderMapArtControlImage(
  gridWidth: number,
  gridHeight: number,
  overlay: ReadonlyMap<string, CellState>,
  defaultCell: CellState = DEFAULT_CELL
): RenderedControlImage {
  const rawCellPx = TARGET_LONG_EDGE / Math.max(gridWidth, gridHeight);
  const cellPx = Math.max(2, Math.round(rawCellPx));
  const rawWidth = gridWidth * cellPx;
  const rawHeight = gridHeight * cellPx;
  const width = Math.ceil(rawWidth / 16) * 16;
  const height = Math.ceil(rawHeight / 16) * 16;

  const rgb = Buffer.alloc(width * height * 3, 0);
  const colorCache = new Map<string, Rgb>();

  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const state = overlay.get(cellKey(gx, gy)) ?? defaultCell;
      const cacheKey = `${controlImageCategory(state)}:${state.elevation}`;
      let color = colorCache.get(cacheKey);
      if (!color) {
        color = controlImageCellColor(state);
        colorCache.set(cacheKey, color);
      }
      const px0 = gx * cellPx;
      const py0 = gy * cellPx;
      for (let py = py0; py < py0 + cellPx && py < height; py++) {
        let offset = (py * width + px0) * 3;
        for (let px = px0; px < px0 + cellPx && px < width; px++) {
          rgb[offset] = color[0];
          rgb[offset + 1] = color[1];
          rgb[offset + 2] = color[2];
          offset += 3;
        }
      }
    }
  }

  return { width, height, rgb };
}

/**
 * renderMapArtControlImage, encoded straight to a PNG file buffer — the one
 * call a real generation pipeline (uploading to ComfyUI's `/upload/image`,
 * per the research doc §3) needs. Split from renderMapArtControlImage
 * itself so tests/callers that only care about the raw pixels (e.g.
 * pixel-level assertions) don't pay for PNG encoding.
 */
export function renderMapArtControlImagePng(
  gridWidth: number,
  gridHeight: number,
  overlay: ReadonlyMap<string, CellState>,
  defaultCell: CellState = DEFAULT_CELL
): Buffer {
  const { width, height, rgb } = renderMapArtControlImage(gridWidth, gridHeight, overlay, defaultCell);
  return encodeRgbPng(width, height, rgb);
}
