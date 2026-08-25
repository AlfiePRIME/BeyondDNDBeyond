import type { TerrainType } from "@/rules-engine";
import {
  deleteMapThumbnailFile,
  setMapThumbnail,
  uploadMapThumbnailFile,
  type SupabaseClient,
} from "@/data-access";
import { cellKey, DEFAULT_CELL, type CellState } from "../[mapId]/edit/lib/cellGrid";

// Same palette and lerp inputs as MapSurface's cellColor so a thumbnail and
// the real 3D render agree visually — mirrored rather than imported because
// that function is module-private and three.js-typed, and pulling a WebGL
// library into a plain 2D canvas would be absurd for four hex constants.
const NORMAL_BASE = "#463a70";
const NORMAL_HIGH = "#cfc4ff";
const DIFFICULT_BASE = "#a85a24";
const DIFFICULT_HIGH = "#ffd9a0";

// tokens.css --surface, the app's darkest backdrop — reads as the void
// around the map, like the editor's own scene background.
const BACKDROP = "#060012";

const CELL_GAP_RATIO = 0.08;
const TARGET_SIZE = 320;

// three's Color.lerp runs in its linear working color space (ColorManagement
// is on by default in this three version), not on raw sRGB bytes — these are
// its exact transfer functions, replicated so every elevation step lands on
// the identical hex cellColor produces.
function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

function linearToSrgb(c: number): number {
  return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055;
}

function hexToLinearRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [
    srgbToLinear(((value >> 16) & 0xff) / 255),
    srgbToLinear(((value >> 8) & 0xff) / 255),
    srgbToLinear((value & 0xff) / 255),
  ];
}

export function thumbnailCellColor(terrain: TerrainType, elevation: number): string {
  // A void cell has no floor: it paints as the backdrop itself, so in the
  // snapshot it reads exactly like the space around the map — absent, the
  // same way the 3D render draws nothing for it. Elevation is meaningless
  // on a cell with no floor, so it never lightens.
  if (terrain === "void") return BACKDROP;
  const [base, high] =
    terrain === "difficult" ? [DIFFICULT_BASE, DIFFICULT_HIGH] : [NORMAL_BASE, NORMAL_HIGH];
  const t = Math.min(elevation * 0.11, 0.66);
  const from = hexToLinearRgb(base);
  const to = hexToLinearRgb(high);
  const bytes = from.map((channel, i) => {
    const srgb = linearToSrgb(channel + (to[i] - channel) * t);
    return Math.round(Math.min(Math.max(srgb * 255, 0), 255));
  });
  return `#${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Top-down snapshot of a map's terrain as a PNG Blob: one flat rectangle
 * per cell on an off-screen 2D canvas — deliberately not a WebGL capture.
 * Elevation shows as the same per-step lightening the 3D render uses (which
 * exists there precisely so heights read from directly overhead), so a
 * flat-projection thumbnail loses no information the palette encodes.
 */
export function renderMapThumbnail(
  gridWidth: number,
  gridHeight: number,
  overlay: ReadonlyMap<string, CellState>
): Promise<Blob> {
  const cellPx = Math.max(4, Math.round(TARGET_SIZE / Math.max(gridWidth, gridHeight)));
  const gap = cellPx * CELL_GAP_RATIO;

  const canvas = document.createElement("canvas");
  canvas.width = gridWidth * cellPx;
  canvas.height = gridHeight * cellPx;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Could not create a 2D canvas context."));

  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const state = overlay.get(cellKey(x, y)) ?? DEFAULT_CELL;
      ctx.fillStyle = thumbnailCellColor(state.terrain, state.elevation);
      ctx.fillRect(x * cellPx + gap / 2, y * cellPx + gap / 2, cellPx - gap, cellPx - gap);
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not export the thumbnail canvas."));
    }, "image/png");
  });
}

/**
 * Render → upload → point thumbnail_ref at the new object, returning its
 * path. The previous object (if any) is removed only after the ref moves
 * off it, and its failure is swallowed — a stale orphan in the bucket is
 * harmless, whereas failing the caller's save over cleanup would not be.
 */
export async function captureMapThumbnail(
  supabase: SupabaseClient,
  map: { id: string; grid_width: number; grid_height: number; thumbnail_ref: string | null },
  overlay: ReadonlyMap<string, CellState>
): Promise<string> {
  const blob = await renderMapThumbnail(map.grid_width, map.grid_height, overlay);
  const path = await uploadMapThumbnailFile(supabase, map.id, blob);
  await setMapThumbnail(supabase, map.id, path);
  if (map.thumbnail_ref) {
    try {
      await deleteMapThumbnailFile(supabase, map.thumbnail_ref);
    } catch {
      // Orphaned object only; the ref already points at the new snapshot.
    }
  }
  return path;
}
