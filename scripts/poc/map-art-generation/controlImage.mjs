// The E1 spike's actual deliverable #3: a real, separate control-image
// renderer tuned for diffusion conditioning, adapted from
// src/app/campaigns/[id]/maps/lib/thumbnail.ts's renderMapThumbnail (read
// in full before writing this) rather than folded into it as a flag.
//
// Three deliberate departures from renderMapThumbnail, each for a
// conditioning-specific reason documented inline below:
//   1. Flat, evenly-spaced, high-saturation hues per category instead of
//      thumbnail.ts's muted palette chosen for visual parity with
//      MapSurface's 3D render — a conditioning image's job is to be
//      maximally *distinguishable* per category, not pretty.
//   2. Discrete elevation lightness BANDS instead of thumbnail.ts's
//      continuous lerp — sharp bands give the diffusion model a crisp
//      region boundary to key off (a terrace edge), where a smooth
//      gradient would blur across a step change in target output.
//   3. Zero inter-cell gap — thumbnail.ts's CELL_GAP_RATIO exists for a
//      graph-paper UI aesthetic; a gap of backdrop color between every
//      single cell would read to the model as a fixed mosaic grid texture
//      baked into the whole image, which real terrain isn't. Same-category
//      neighbors merge into one solid region here; only an actual category
//      change produces a boundary.
//
// Precedence for picking a cell's base hue mirrors thumbnailCellColor
// exactly (same order of checks, real values just replaced): void first
// (no floor at all, regardless of ground/terrain), then ground when it's
// not 'default' (a ground type is purely a floor color and overrides the
// terrain-driven hazard/chasm hues), then terrain-driven (normal/
// difficult/pit) on 'default' ground.

const TARGET_LONG_EDGE = 1024;

// 12 categories that carry a hue (everything except void, which is
// hue-less near-black). NOT evenly spaced — an earlier live test on the
// real instance (docs/map-art-generation-research.md's "palette iteration"
// section) used a naive even 30-degree wheel with water/stone/pit as three
// consecutive slots (210/240/270), and the model visibly bled watery
// texture onto the stone dais next to it: hue distance alone doesn't
// prevent the model from reading two "cool blue/violet family" regions as
// thematically related, even 30-60 degrees apart. water here instead gets
// an isolated ~140-degree buffer (nothing else placed between 140 and
// 280) with the other 11 categories sharing the remaining arc at their own
// near-even spacing — deliberately unequal, but the specific inequality is
// evidence-based, not arbitrary.
const HUE_BY_CATEGORY = {
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
const VOID_RGB = [10, 10, 10];

const SATURATION = 0.82;

// Four discrete elevation bands (cellGrid.ts's MAX_ELEVATION is 10) rather
// than thumbnailCellColor's continuous lerp — see module doc comment.
// Lightness rises with elevation, same direction thumbnailCellColor uses.
function lightnessForElevation(elevation) {
  const clamped = Math.max(elevation, 0); // pits' negative elevation floors at 0, same clamp thumbnailCellColor applies
  if (clamped <= 1) return 0.4;
  if (clamped <= 3) return 0.52;
  if (clamped <= 6) return 0.64;
  return 0.76;
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

/** Exported for the workflow doc / tests: the exact category a cell falls
 * into, applying the same void > ground > terrain precedence
 * thumbnailCellColor uses. */
export function controlImageCategory(state) {
  if (state.terrain === "void") return "void";
  if (state.ground !== "default") return state.ground;
  return state.terrain; // "normal" | "difficult" | "pit"
}

/** The tuned per-cell color this control-image variant uses — analogous to
 * thumbnailCellColor, but flat-banded and saturated per the module doc
 * comment instead of a continuous parity-with-3D-render lerp. */
export function controlImageCellColor(state) {
  const category = controlImageCategory(state);
  if (category === "void") return VOID_RGB;
  const hue = HUE_BY_CATEGORY[category];
  const lightness = lightnessForElevation(state.elevation);
  return hslToRgb(hue, SATURATION, lightness);
}

/**
 * Renders a grid+overlay to a flat RGB control image tuned for diffusion
 * conditioning. Mirrors renderMapThumbnail's per-cell-rectangle rasterizing
 * loop and DEFAULT_CELL fallback, sized toward TARGET_LONG_EDGE (rounded up
 * to a multiple of 16 — FLUX's own latent-size step) rather than
 * thumbnail.ts's 320px UI target, and with no inter-cell gap (see module
 * doc comment). Returns { width, height, rgb } — a flat Buffer, not a PNG;
 * callers encode it (png.mjs's encodeRgbPng) or hand it to a canvas.
 */
export function renderMapArtControlImage(gridWidth, gridHeight, overlay, defaultCell) {
  const rawCellPx = TARGET_LONG_EDGE / Math.max(gridWidth, gridHeight);
  const cellPx = Math.max(2, Math.round(rawCellPx));
  const rawWidth = gridWidth * cellPx;
  const rawHeight = gridHeight * cellPx;
  const width = Math.ceil(rawWidth / 16) * 16;
  const height = Math.ceil(rawHeight / 16) * 16;

  const rgb = Buffer.alloc(width * height * 3, 0);
  const colorCache = new Map();

  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const key = `${gx},${gy}`;
      const state = overlay.get(key) ?? defaultCell;
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
