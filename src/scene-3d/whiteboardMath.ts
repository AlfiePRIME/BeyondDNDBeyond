import { mapCellOffsets } from "./MapSurface";

/**
 * Whiteboard drawing layer (Prompt 2 of docs/design/whiteboard-drawing-layer.md)
 * — the pure, DOM/WebGL-free coordinate and constant math WhiteboardPlane.tsx
 * draws on. Split out into its own module (mirroring gridOverlay.ts/mapFit.ts's
 * own precedent) specifically so it's unit-testable with plain vitest: this
 * codebase's established convention for scene-3d is "pure geometry/math in a
 * `.ts` module, gets a `.test.ts`; the actual React Three Fiber component that
 * touches a real `<canvas>`/CanvasTexture does not" (no existing scene-3d
 * component test touches canvas/WebGL at all — see MapSurface.tsx's own
 * badge-texture code, which isn't unit tested either). The real interactive/
 * rendering behavior is verified by scripts/db/verify-whiteboard-drawing.mjs
 * (a real Playwright browser), not here.
 */

/** Per-cell raster resolution in pixels on the shared composite canvas — the
 * design spike's own §4.4 "open question," pinned here at implementation
 * time per its own guidance (64–128px range, tuned for legible strokes vs.
 * modest canvas size on an ordinary battle-map grid). */
export const TILE_PX = 96;

/** Pen/eraser stroke width, expressed as a fraction of one cell (the spike's
 * own §5.2 "resolution-independent" units) — multiplied by TILE_PX to get an
 * actual canvas lineWidth. The eraser is deliberately wider than the pen —
 * the ordinary whiteboard-eraser convention (easy to fully clear a stray
 * mark without many passes), not a precision tool. */
export const PEN_WIDTH_CELLS = 0.12;
export const ERASER_WIDTH_CELLS = 0.4;

/** DM-adjustable plane height (world units above the tabletop) — a plain
 * numeric range, not a 3D drag handle (see docs/design/whiteboard-drawing-layer.md
 * §6 for why). Default sits comfortably above a standing token's own head
 * height (TokenMarker's HP bar sits at 0.82 local units at cellSize=1) while
 * staying well clear of a seated camera's eye line. */
export const DEFAULT_WHITEBOARD_HEIGHT = 1.2;
export const MIN_WHITEBOARD_HEIGHT = 0.3;
export const MAX_WHITEBOARD_HEIGHT = 3;
export const WHITEBOARD_HEIGHT_STEP = 0.1;

/** A plain, legible "marker ink" default — bright enough to read against
 * every existing terrain/ground color in MapSurface's own palette. The real
 * color picker (a native `<input type="color">`) covers the rest of the
 * gamut; this is only ever the value it starts from. */
export const DEFAULT_WHITEBOARD_COLOR = "#ffffff";

/** One cell's own identity as a sparse-map key — mirrors the `cellKey(x, y)`
 * convention already used twice elsewhere in this codebase (the map editor's
 * `lib/cellGrid.ts`, reused by GameRoom.tsx for map_cells/seen-cells
 * lookups), redeclared here rather than imported since both existing copies
 * live under an app route's own lib folder and scene-3d stays decoupled from
 * the app layer (the MapSurfaceGroundType/data-access decoupling precedent,
 * generalized). */
export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * World (x, z) — in the SAME local coordinate space MapSurface's own cells
 * render in (see mapCellOffsets) — to a continuous pixel coordinate on the
 * shared `gridWidth * TILE_PX` by `gridHeight * TILE_PX` composite canvas.
 * Continuous (not floored to a cell): a stroke drawn along the returned
 * pixel path is pure pixel drawing with zero per-cell seams while the
 * gesture is in progress (docs/design/whiteboard-drawing-layer.md §4.1) —
 * flooring only happens afterward, in pixelToCell, purely for attributing
 * touched cells.
 */
export function worldToPixel(
  worldX: number,
  worldZ: number,
  gridWidth: number,
  gridHeight: number,
  cellSize: number
): { pixelX: number; pixelY: number } {
  const { offsetX, offsetZ } = mapCellOffsets(gridWidth, gridHeight, cellSize);
  // +0.5: offsetX/offsetZ center CELL coordinates (cell 0's center sits at
  // worldX = -offsetX), but pixel space wants cell 0 to span the whole
  // [0, TILE_PX) range — shifting by half a cell aligns pixel-grid cell
  // boundaries with the visual cell boundaries MapSurface itself renders.
  const u = (worldX + offsetX) / cellSize + 0.5;
  const v = (worldZ + offsetZ) / cellSize + 0.5;
  return { pixelX: u * TILE_PX, pixelY: v * TILE_PX };
}

/** Continuous pixel coordinate to the (possibly out-of-grid-bounds, for a
 * gesture that drifts past the plane's edge) cell it falls in. */
export function pixelToCell(pixelX: number, pixelY: number): { x: number; y: number } {
  return { x: Math.floor(pixelX / TILE_PX), y: Math.floor(pixelY / TILE_PX) };
}

/**
 * Continuous pixel coordinate to the "grid-space" (u, v) units the live-tier
 * sync stream transmits over the wire (docs/design/whiteboard-drawing-layer.md
 * §5.2) — a plain `TILE_PX` division, so a point survives the trip to
 * another client's own canvas (built at that client's own TILE_PX, always
 * the same shared constant today, but never assumed to match by value) and
 * so the wire format never has to change if TILE_PX itself is later tuned.
 * The exact inverse of gridPointToPixel below.
 */
export function pixelToGridPoint(pixelX: number, pixelY: number): { u: number; v: number } {
  return { u: pixelX / TILE_PX, v: pixelY / TILE_PX };
}

/** The exact inverse of pixelToGridPoint — a received remote stroke point's
 * own (u, v) back to this client's local composite-canvas pixel space. */
export function gridPointToPixel(u: number, v: number): { pixelX: number; pixelY: number } {
  return { pixelX: u * TILE_PX, pixelY: v * TILE_PX };
}

/**
 * Every distinct cell a drawn segment from `from` (null for a stroke's very
 * first point, which has no prior segment) to `to` passes over, in pixel
 * space — accumulated into a stroke's own touched-cell set incrementally,
 * per docs/design/whiteboard-drawing-layer.md §4.1 ("trivial... at no extra
 * cost"). `halfWidthPx` is the drawn line's own half-width in pixels
 * (PEN_WIDTH_CELLS/ERASER_WIDTH_CELLS × TILE_PX / 2): a stroke isn't
 * infinitely thin, so a cell can receive real ink from a segment whose own
 * CENTERLINE never enters it — most visibly for the wider eraser brush
 * running close to a cell boundary — and a naive centerline-only sample
 * would then never crop that cell into the tile store, silently leaving
 * stray pixels behind after what should have been a clean erase. Each
 * sampled point along the segment therefore contributes every cell within
 * `halfWidthPx` of it (a small rectangular neighborhood, not just its own
 * cell), and consecutive samples are spaced at most `halfWidthPx` apart
 * along the segment itself (rather than a fixed half-tile step) — close
 * enough together that two neighboring samples' own neighborhoods always
 * overlap, leaving no gap anywhere along the stroke's actual painted
 * footprint. Over-including a cell that turns out to still be blank is
 * always harmless (the caller crops-then-isTileBlank-checks it and simply
 * finds nothing there); under-including one is the real, worse failure mode
 * this guards against.
 */
export function sampleSegmentCells(
  from: { x: number; y: number } | null,
  to: { x: number; y: number },
  halfWidthPx: number
): Array<{ x: number; y: number }> {
  const seen = new Set<string>();
  const cells: Array<{ x: number; y: number }> = [];
  const add = (px: number, py: number) => {
    const minCell = pixelToCell(px - halfWidthPx, py - halfWidthPx);
    const maxCell = pixelToCell(px + halfWidthPx, py + halfWidthPx);
    for (let x = minCell.x; x <= maxCell.x; x++) {
      for (let y = minCell.y; y <= maxCell.y; y++) {
        const key = cellKey(x, y);
        if (!seen.has(key)) {
          seen.add(key);
          cells.push({ x, y });
        }
      }
    }
  };
  if (!from) {
    add(to.x, to.y);
    return cells;
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const step = Math.max(1, halfWidthPx);
  const steps = Math.max(1, Math.ceil(distance / step));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    add(from.x + dx * t, from.y + dy * t);
  }
  return cells;
}

/** The plane mesh's own world-unit footprint — `gridWidth`/`gridHeight` cells
 * at `cellSize` each, exactly matching the grid MapSurface renders below it
 * (docs/design/whiteboard-drawing-layer.md §6: "nothing new to compute"). */
export function planeSizeWorldUnits(
  gridWidth: number,
  gridHeight: number,
  cellSize: number
): { width: number; height: number } {
  return { width: gridWidth * cellSize, height: gridHeight * cellSize };
}
