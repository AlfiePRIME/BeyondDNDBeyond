"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { CanvasTexture, DoubleSide, Plane, Raycaster, SRGBColorSpace, Vector2, Vector3 } from "three";
import type { Camera } from "three";
import {
  cellKey,
  ERASER_WIDTH_CELLS,
  gridPointToPixel,
  PEN_WIDTH_CELLS,
  pixelToGridPoint,
  planeSizeWorldUnits,
  sampleSegmentCells,
  TILE_PX,
  worldToPixel,
} from "./whiteboardMath";

/**
 * The DM-only annotation layer (docs/design/whiteboard-drawing-layer.md).
 * Prompt 2 built the rendering, toolset, and draw-mode interaction below;
 * Prompt 3 (§11) layered persistence and cross-client sync on top — see
 * this file's own "Persistence and cross-client sync" doc-comment section
 * further down for that half.
 *
 * Two separate meshes sharing one transform (the design's own §7.1), not one
 * mesh with conditionally-attached handlers:
 *
 * 1. The always-mounted VISIBLE plane — a `CanvasTexture`-mapped mesh, no
 *    pointer handlers ever, rendered for every viewer (DM and players alike)
 *    regardless of whether draw mode is on. This is MapSurface.tsx's own
 *    `CanvasTexture` technique (its condition/death-save/concentration
 *    badges), generalized from "cached, built once per static label" to "one
 *    instance per open map, mutated in place and re-uploaded via
 *    `texture.needsUpdate = true`" on every draw tick.
 * 2. The conditionally-MOUNTED invisible hit-plane — `{interactive ? (<mesh
 *    .../>) : null}`, the exact `ObjectMarker` hit-box precedent
 *    (MapSurface.tsx), NOT `CellBlock`'s "always-mounted, conditionally-
 *    attached-handlers" variant: the visible drawing must always render for
 *    everyone, while only the DM's own interactive hit-surface should exist
 *    at all, and only while draw mode is on. When `interactive` is false this
 *    element simply isn't in the tree, so r3f's raycaster never sees it and
 *    every other pointer gesture on the table (token select/move, object
 *    interaction, chair drag, camera orbit) is completely unaffected — no
 *    other code needs to know this component exists.
 *
 * In-memory data model: one composite `<canvas>` + `CanvasTexture` per map
 * this client has drawn on THIS session (a `Map<mapId, MapWhiteboardState>`,
 * lazily populated — the badgeTextureCache/deathBadgeTextureCache lazy-
 * memoization precedent in MapSurface.tsx, instance-scoped via a ref instead
 * of module-scoped, so it can't leak across a client-side navigation to a
 * DIFFERENT campaign room). Per-map independence (the owner's decision) falls
 * out of this for free: switching which map is live looks up (or creates)
 * that map's own entry, never touching any other map's canvas/tiles/undo
 * stack. `MapWhiteboardState.tiles` is already a sparse `Map<"x,y", tile
 * canvas>` — the exact per-cell raster-tile shape
 * docs/design/whiteboard-drawing-layer.md §4.4 designs for `map_whiteboard_tiles`
 * — populated at every stroke-end by cropping the composite canvas (§4.1),
 * exactly the shape Prompt 3's persistence layer (below) encodes
 * (`tile.toDataURL("image/png")`) and upserts, with no restructuring of
 * this component's own drawing/undo mechanics needed to add that.
 *
 * Persistence and cross-client sync (docs/design/whiteboard-drawing-layer.md
 * §5, Prompt 3) are layered on TOP of this exact same in-memory model, not a
 * restructuring of it: `initialTiles` hydrates a freshly-created map's own
 * composite canvas from whatever GameRoom already fetched
 * (listWhiteboardTiles, via the per-viewer map bundle every map switch
 * already re-fetches — this component stays data-access-free per this
 * codebase's module boundary, so it only ever receives already-decoded
 * plain data, never a SupabaseClient); `onTilesPersist`/`onClearPersist`
 * fire with the exact same per-cell change list a stroke/undo/redo/clear
 * already computes for its own in-memory tile store, so GameRoom can
 * upsert/delete `map_whiteboard_tiles` rows and broadcast
 * WHITEBOARD_TILES_CHANGED_EVENT/WHITEBOARD_CLEARED_EVENT with the
 * already-durable value (the HANDOUT_EVENT persist-then-broadcast shape);
 * `onLocalStroke{Start,Point,End}` fire from the identical pointer handlers
 * that already drive local drawing, purely so GameRoom can additionally
 * stream them over the ephemeral DICE_ROLLED_EVENT-shaped live tier: this
 * component never touches the realtime channel itself, it just reports what
 * it already knows the instant it knows it. `applyRemoteStroke*`/
 * `applyTileChanges`/`loadTiles`/`clearRemote` (the imperative handle) are
 * the RECEIVING side of both tiers — a remote stroke's points are drawn
 * through the exact same `drawSegment` primitive the local pointer handlers
 * use (§5.1's own "one shared pure function, two callers"), never a second
 * rendering path.
 */

export type WhiteboardTool = "pen" | "eraser";

/** A durable per-cell tile as already-decoded plain data — the exact shape
 * @/data-access's WhiteboardTile has, structurally, but declared fresh here
 * rather than imported: scene-3d stays data-access-free (the
 * MapSurfaceGroundType precedent), so this component only ever receives
 * data GameRoom has already fetched/decoded, never a SupabaseClient of its
 * own. `tilePng` is a plain base64-encoded PNG (no `data:` prefix) — this
 * component prefixes it itself wherever it needs an actual `Image` source. */
export interface WhiteboardTileData {
  x: number;
  y: number;
  tilePng: string;
}

/** One cell's own persisted-tier UPDATE — `tilePng: null` means the cell
 * was fully erased and its row should be deleted entirely (the sparse-
 * storage convention this whole feature uses throughout). The
 * WHITEBOARD_TILES_CHANGED_EVENT payload shape, and also exactly what a
 * stroke-commit/undo/redo already computes for its own in-memory tile
 * store — onTilesPersist/applyTileChanges both use this one shape for
 * "what changed" in either direction (outgoing to GameRoom for persistence,
 * incoming from GameRoom for a receiver's own resync). */
export interface WhiteboardTileUpdate {
  x: number;
  y: number;
  tilePng: string | null;
}

/** A continuous grid-space point, the live-tier wire unit (§5.2) — NOT raw
 * TILE_PX pixels, so the wire format never has to change if TILE_PX itself
 * is later tuned. See whiteboardMath.ts's pixelToGridPoint/gridPointToPixel. */
export interface WhiteboardGridPoint {
  u: number;
  v: number;
}

export interface WhiteboardHandle {
  undo(): void;
  redo(): void;
  clear(): void;
  /** Live-tier receiver (§5.1) — draws a REMOTE stroke's own points through
   * the identical drawSegment primitive local pointer events use. Strokes
   * are tracked by `strokeId` so multiple concurrent remote strokes (e.g. a
   * second DM window drawing at the same time) never cross-contaminate each
   * other's "last point" bookkeeping. */
  applyRemoteStrokeStart(strokeId: string, tool: WhiteboardTool, color: string, point: WhiteboardGridPoint): void;
  applyRemoteStrokePoints(strokeId: string, points: readonly WhiteboardGridPoint[]): void;
  /** A receiver that missed the matching start (joined mid-stroke) simply
   * has nothing tracked for this id — a harmless no-op, since the
   * persisted tier's own applyTileChanges call at stroke-end always
   * corrects the final pixels regardless (§5.1's own "never a wrong FINAL
   * state" guarantee). */
  applyRemoteStrokeEnd(strokeId: string): void;
  /** Persisted-tier receiver (§5.1) — applies already-durable per-cell
   * changes (a stroke-end broadcast, or another client's undo/redo) without
   * touching THIS client's own undo/redo stack, which per §5.4 only ever
   * records what THIS device itself drew. */
  applyTileChanges(changes: readonly WhiteboardTileUpdate[]): void;
  /** Full resync (§5.3) — rebuilds the composite canvas and tile store from
   * scratch against exactly this list, dropping anything not listed here.
   * Used for reconnect recovery; the identical function also runs (via
   * `initialTiles`) on ordinary initial load/map-switch hydration. */
  loadTiles(tiles: readonly WhiteboardTileData[]): void;
  /** WHITEBOARD_CLEARED_EVENT receiver — wipes this client's own canvas/tile
   * store without pushing a local undo entry (this is someone ELSE's clear,
   * already durable; per §5.4 this device's own undo stack only records
   * what THIS device did). */
  clearRemote(): void;
}

export interface WhiteboardHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

/** Verification-only — see WhiteboardPlaneProps.onDebug's own doc comment. */
export interface WhiteboardDebugState {
  /** Every cell key ("x,y") currently carrying ink, i.e. the sparse tile
   * store's own key set — a real screenshot can show a drawn line, but only
   * this mirror can tell a Playwright script "did the eraser genuinely
   * remove that cell's tile, or just paint over it" (the same "WebGL has no
   * DOM of its own" reasoning as every other onXDebug prop in this codebase). */
  tileKeys: readonly string[];
}

export interface WhiteboardPlaneProps {
  /** Keys this component's own per-map cache — see this file's own top doc
   * comment. Never sent anywhere; purely a local cache key. */
  mapId: string;
  gridWidth: number;
  gridHeight: number;
  /** The SAME fitted cellSize MapSurface itself renders this map's cells at
   * (mapFit.ts's computeTableMapMetrics on the live table) — required so
   * this plane's world footprint and coordinate math line up with the real
   * grid underneath it, pixel for pixel. */
  cellSize: number;
  /** This plane's own absolute world-space Y (TABLE_SURFACE_Y +
   * whiteboardHeight, computed once by GameTableScene, the single source of
   * truth for that constant) — needed only for the window-level pointer-move
   * continuation's own math-plane raycast (planePointFromClientXY below);
   * the hit-mesh's own R3F pointer events never need it since `event.point`
   * is already given in world space by three.js's raycaster. */
  worldY: number;
  /** True only for the DM's own client while draw mode is toggled on — gates
   * ONLY the invisible hit-plane (see this file's own top doc comment). */
  interactive: boolean;
  tool: WhiteboardTool;
  /** Meaningless while `tool === "eraser"` (destination-out compositing only
   * uses the drawn shape's alpha coverage, never its RGB) but harmless to
   * pass through unconditionally — one code path for both tools. */
  color: string;
  /** Fires on every start/end of an in-progress stroke — the
   * onChairDraggingChange precedent (GameTableScene.tsx), which
   * GameTableScene uses to additionally disable OrbitControls while
   * drawing: OrbitControls binds its own native pointer listeners on the
   * canvas, independent of r3f's synthetic per-mesh dispatch, so this
   * hit-plane's own `event.stopPropagation()` alone would NOT stop a
   * simultaneous camera orbit in free-camera mode without this. */
  onDrawingChange?: (drawing: boolean) => void;
  /** Real (not verification-only) callback: mirrors the active map's own
   * undo/redo stack sizes so a DOM toolbar elsewhere (MapPanel.tsx) can
   * enable/disable its Undo/Redo buttons — this component owns the actual
   * stacks; nothing outside it ever reads or mutates them directly except
   * through the imperative handle below. */
  onHistoryChange?: (state: WhiteboardHistoryState) => void;
  /** Verification-only — see WhiteboardDebugState's own doc comment. Omitting
   * it changes nothing about how anything renders or draws. */
  onDebug?: (state: WhiteboardDebugState) => void;
  /** Verification-only: this plane's own world-space center, projected to
   * canvas-relative CSS pixels every frame it's actually on screen (or null
   * otherwise) — the exact `onOwnChairProjectedPosition` reasoning
   * (GameTableScene.tsx): a WebGL canvas has no DOM of its own for a
   * Playwright script to find a click target on, so this hands one back
   * directly instead of a blind scan. */
  onCenterProjectedPosition?: (point: [number, number] | null) => void;
  /** This map's own already-persisted tiles (listWhiteboardTiles, fetched by
   * GameRoom as part of the same per-viewer map bundle every load/switch
   * already re-fetches — see the per-map cache's own hydration effect
   * below) — hydrates a freshly-created MapWhiteboardState exactly once,
   * the instant this exact (mapId, gridWidth, gridHeight) combination is
   * first seen this session. Never re-applied on a later re-render with the
   * same already-hydrated state (a `hydrated` flag on the state object
   * itself guards this), so it can never clobber this client's own
   * subsequent local edits or live/persisted-tier updates. */
  initialTiles?: readonly WhiteboardTileData[];
  /** Fires at the very start of a LOCAL stroke (pointerdown), before any
   * drawing — purely so GameRoom can kick off the live-tier ephemeral
   * broadcast stream (§5.1/§5.2). This component never touches the
   * realtime channel itself. */
  onLocalStrokeStart?: (mapId: string, info: { strokeId: string; tool: WhiteboardTool; color: string; point: WhiteboardGridPoint }) => void;
  /** Fires once per point of an in-progress LOCAL stroke, after
   * onLocalStrokeStart's own first point — GameRoom is responsible for any
   * batching/send-interval decision (§5.2's "on the order of every 30-50ms"
   * — an app-layer, not a rendering-layer, concern), so every point is
   * reported immediately here regardless of wire cadence. */
  onLocalStrokePoint?: (mapId: string, strokeId: string, point: WhiteboardGridPoint) => void;
  onLocalStrokeEnd?: (mapId: string, strokeId: string) => void;
  /** Fires once a LOCAL stroke/undo/redo produces a definitive new per-cell
   * state (§5.1's persisted tier) — GameRoom upserts/deletes
   * map_whiteboard_tiles and broadcasts WHITEBOARD_TILES_CHANGED_EVENT with
   * this exact already-durable payload, the HANDOUT_EVENT shape. */
  onTilesPersist?: (mapId: string, changes: readonly WhiteboardTileUpdate[]) => void;
  /** Fires once a LOCAL clear actually wiped something (doClear's own
   * "nothing to clear — no pointless empty entry" guard also suppresses
   * this) — GameRoom deletes every map_whiteboard_tiles row for this map
   * and broadcasts WHITEBOARD_CLEARED_EVENT. */
  onClearPersist?: (mapId: string) => void;
}

interface UndoEntry {
  /** Cell key -> that cell's own tile canvas immediately BEFORE this entry's
   * action touched it, or null if the cell had no ink at all. Undoing draws
   * these bytes back; the CURRENT tile at the moment of undo becomes the
   * paired redo entry's own snapshot (see doUndo below) — symmetric with no
   * separate "after" bookkeeping needed while a stroke is still in progress. */
  cells: ReadonlyMap<string, HTMLCanvasElement | null>;
}

/** One in-progress REMOTE stroke's own bookkeeping (the live tier's
 * receiving side) — deliberately separate from StrokeSession below (which
 * is this client's own LOCAL in-progress stroke): a client can be receiving
 * a remote stroke while never drawing one itself at all (every player), or
 * even while ALSO mid-stroke itself (a second DM window), so the two must
 * never share state. Keyed by strokeId so multiple concurrent remote
 * strokes can't cross-contaminate each other's own "last point". */
interface RemoteStrokeState {
  tool: WhiteboardTool;
  color: string;
  lastPixel: { x: number; y: number } | null;
  /** Every cell this in-progress remote stroke has painted so far — the
   * exact same `sampleSegmentCells`-driven bookkeeping StrokeSession.touched
   * keeps for a LOCAL stroke (see applyStrokePoint), needed here for the
   * identical reason: debugOf's own tileKeys mirror is sourced from
   * `state.tiles` (the sparse PERSISTED tile cache), which a live-tier
   * remote stroke deliberately never touches — cell attribution only
   * happens at persist time (§4.1/§5.1). Without this, a Playwright script
   * (or any other observer) would see NO evidence of a remote stroke's own
   * already-rendered pixels until the persisted tier's tiles-changed
   * broadcast lands at stroke-end, even though the ink is genuinely already
   * on screen — this is purely a verification-visibility fix, not a
   * behavior change: the actual composite canvas was already correct. */
  touched: Set<string>;
}

interface MapWhiteboardState {
  gridWidth: number;
  gridHeight: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  /** Sparse per-cell raster tiles — see this file's own top doc comment. */
  tiles: Map<string, HTMLCanvasElement>;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** Guards initialTiles' own hydration to exactly once per state object —
   * see WhiteboardPlaneProps.initialTiles's own doc comment. */
  hydrated: boolean;
  /** Every currently in-progress REMOTE stroke this client is receiving —
   * see RemoteStrokeState's own doc comment. */
  remoteStrokes: Map<string, RemoteStrokeState>;
}

/** A new action forks history — the redo branch is discarded — and the
 * oldest entry falls off once the cap is exceeded. Mirrors the map editor's
 * own `lib/history.ts` HISTORY_LIMIT/pushEntry semantics in SPIRIT only: a
 * deliberately separate constant/implementation, not a shared import — the
 * whiteboard's own undo/redo is a completely independent stack, per the
 * project owner's explicit decision (docs/design/whiteboard-drawing-layer.md's
 * own driving brief), never sharing state, a module, or a keyboard shortcut
 * with the map editor's. */
const HISTORY_LIMIT = 50;

function createMapWhiteboardState(gridWidth: number, gridHeight: number): MapWhiteboardState {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, gridWidth) * TILE_PX;
  canvas.height = Math.max(1, gridHeight) * TILE_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable — cannot build the whiteboard's composite canvas");
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return {
    gridWidth,
    gridHeight,
    canvas,
    ctx,
    texture,
    tiles: new Map(),
    undoStack: [],
    redoStack: [],
    hydrated: false,
    remoteStrokes: new Map(),
  };
}

/** Looks up (or lazily creates) `mapId`'s own cached state, rebuilding it
 * from scratch if the grid's own dimensions changed since it was cached
 * (e.g. the DM grew this map's grid in the editor while it happened to be
 * live) — disposing the stale texture first so switching maps repeatedly
 * never leaks GPU resources. */
function getOrCreateMapState(
  cache: Map<string, MapWhiteboardState>,
  mapId: string,
  gridWidth: number,
  gridHeight: number
): MapWhiteboardState {
  const existing = cache.get(mapId);
  if (existing && existing.gridWidth === gridWidth && existing.gridHeight === gridHeight) return existing;
  if (existing) existing.texture.dispose();
  const created = createMapWhiteboardState(gridWidth, gridHeight);
  cache.set(mapId, created);
  return created;
}

function cropTile(source: HTMLCanvasElement, x: number, y: number): HTMLCanvasElement {
  const tile = document.createElement("canvas");
  tile.width = TILE_PX;
  tile.height = TILE_PX;
  const ctx = tile.getContext("2d");
  if (ctx) ctx.drawImage(source, x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX, 0, 0, TILE_PX, TILE_PX);
  return tile;
}

/** Real transparency, not a painted-over hack: scans the cropped tile's own
 * alpha channel directly, so a fully-erased cell is detected as blank and
 * dropped from the sparse tile map entirely (§4.4's "a row exists only for a
 * cell that actually has ink on it"), regardless of what color ink used to
 * be there. */
function isTileBlank(tile: HTMLCanvasElement): boolean {
  const ctx = tile.getContext("2d");
  if (!ctx) return true;
  const { data } = ctx.getImageData(0, 0, tile.width, tile.height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}

/** The pen/eraser's own stroke width in canvas pixels — shared by
 * `drawSegment` (the actual `ctx.lineWidth`) and `applyStrokePoint` (how far
 * the drawn ink can bleed past a sampled centerline point into a neighboring
 * cell — see `sampleSegmentCells`'s own `halfWidthPx` doc comment). One
 * function so the two can never drift apart and under/over-report which
 * cells a stroke actually touched relative to what it actually painted. */
function lineWidthPx(tool: WhiteboardTool): number {
  return (tool === "eraser" ? ERASER_WIDTH_CELLS : PEN_WIDTH_CELLS) * TILE_PX;
}

/** The one drawing primitive both the pen and the eraser use — the eraser is
 * a REAL raster `destination-out` compositing operation (the design's own
 * explicit call-out: "not a naive white-paint-over hack"), which removes
 * exactly the pixels the gesture passed over using nothing but the canvas 2D
 * API, restoring real transparency rather than painting a background color
 * on top. `from === null` draws a single dot — so a plain click with no drag
 * still leaves a mark, exactly like a real marker touched to a whiteboard. */
function drawSegment(
  state: MapWhiteboardState,
  tool: WhiteboardTool,
  color: string,
  from: { x: number; y: number } | null,
  to: { x: number; y: number }
): void {
  const ctx = state.ctx;
  const lineWidth = lineWidthPx(tool);
  ctx.save();
  ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  if (from) {
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  } else {
    ctx.arc(to.x, to.y, lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  state.texture.needsUpdate = true;
}

/** Clears then redraws exactly `tile`'s own bytes into cell (x, y)'s pixel
 * region — used by both undo and redo, in each direction, so restoring a
 * saved snapshot is always an exact, lossless overwrite rather than a blend
 * with whatever's currently there (a plain `drawImage` without the
 * preceding `clearRect` would leave `tile`'s own transparent pixels
 * showing through the CURRENT content instead of genuinely replacing it). */
function restoreTile(state: MapWhiteboardState, x: number, y: number, tile: HTMLCanvasElement | null): void {
  const px = x * TILE_PX;
  const py = y * TILE_PX;
  state.ctx.clearRect(px, py, TILE_PX, TILE_PX);
  if (tile) state.ctx.drawImage(tile, px, py);
  if (tile) state.tiles.set(cellKey(x, y), tile);
  else state.tiles.delete(cellKey(x, y));
}

function historyOf(state: MapWhiteboardState): WhiteboardHistoryState {
  return { canUndo: state.undoStack.length > 0, canRedo: state.redoStack.length > 0 };
}

/** Unions `state.tiles`' own persisted keys with every currently in-progress
 * REMOTE stroke's own touched cells (RemoteStrokeState.touched's own doc
 * comment explains why the latter is needed at all) — so a receiver's
 * debug mirror reflects what's genuinely visible on screen right now, live
 * tier included, not only whatever has made it into the persisted sparse
 * tile cache so far. */
function debugOf(state: MapWhiteboardState): WhiteboardDebugState {
  const keys = new Set(state.tiles.keys());
  for (const remote of state.remoteStrokes.values()) {
    for (const key of remote.touched) keys.add(key);
  }
  return { tileKeys: Array.from(keys) };
}

/** A cell's own tile canvas to the plain base64 PNG string the persisted
 * tier transmits/stores (WhiteboardTileUpdate/WhiteboardTileData's own
 * shape) — `toDataURL` is synchronous (unlike `toBlob`), which keeps the
 * stroke-commit/undo/redo paths below fully synchronous, matching every
 * other in-memory mutation in this file. */
function tileToBase64(tile: HTMLCanvasElement): string {
  const dataUrl = tile.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/** The inverse of tileToBase64 — decoding a PNG into actual pixels has no
 * synchronous browser API (unlike encoding via toDataURL), so every caller
 * of this (applyTileChangeOnState/loadTilesOnState below) is necessarily
 * async, which is fine: both only ever run in response to a network event
 * (a received broadcast, a reconnect refetch, a fresh map's own initial
 * hydration), never on the local per-pointer-move hot path. */
function loadTileImage(base64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("whiteboard tile image failed to decode"));
    img.src = `data:image/png;base64,${base64}`;
  });
}

/** Applies one persisted-tier change (a receiver's own copy of what
 * onTilesPersist already reported to GameRoom) to `state`'s composite
 * canvas/tile store — used by both applyTileChanges (an incremental
 * WHITEBOARD_TILES_CHANGED_EVENT) and loadTilesOnState (a full resync, one
 * call per tile). Deliberately never touches undoStack/redoStack: per §5.4,
 * undo is this DEVICE's own local history only, and this function is only
 * ever invoked for changes that happened somewhere else (another client's
 * stroke, or this exact client's OWN already-locally-applied stroke being
 * confirmed back — either way, re-recording it here would double up this
 * device's own undo stack for a change it may have already recorded, or
 * pollute it with a change it never made itself). */
async function applyTileChangeOnState(
  state: MapWhiteboardState,
  x: number,
  y: number,
  tilePng: string | null
): Promise<void> {
  const key = cellKey(x, y);
  const px = x * TILE_PX;
  const py = y * TILE_PX;
  if (tilePng === null) {
    state.ctx.clearRect(px, py, TILE_PX, TILE_PX);
    state.tiles.delete(key);
    state.texture.needsUpdate = true;
    return;
  }
  const img = await loadTileImage(tilePng);
  const tileCanvas = document.createElement("canvas");
  tileCanvas.width = TILE_PX;
  tileCanvas.height = TILE_PX;
  const tileCtx = tileCanvas.getContext("2d");
  if (tileCtx) tileCtx.drawImage(img, 0, 0);
  state.ctx.clearRect(px, py, TILE_PX, TILE_PX);
  state.ctx.drawImage(img, px, py);
  state.tiles.set(key, tileCanvas);
  state.texture.needsUpdate = true;
}

/** Full resync (§5.3's "rebuilds the composite canvas from scratch") —
 * wipes everything first so a cell that used to have ink but was
 * erased/undone while this client wasn't looking (disconnected, or hasn't
 * visited this map yet this session) never lingers as a stale leftover,
 * then redraws exactly the given list. Shared by initial-hydration
 * (`initialTiles`), map-switch hydration, and reconnect recovery — one
 * function, three call sites, per this whole feature's own "no special
 * rendering-side handling" design (§6). */
async function loadTilesOnState(state: MapWhiteboardState, tiles: readonly WhiteboardTileData[]): Promise<void> {
  state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
  state.tiles.clear();
  await Promise.all(tiles.map((tile) => applyTileChangeOnState(state, tile.x, tile.y, tile.tilePng)));
  state.texture.needsUpdate = true;
}

/** Live-tier receiver (§5.1) — draws a remote stroke's very first point
 * through the identical drawSegment primitive a local pointerdown uses.
 * Overwrites any stale same-id entry (a start received twice, or a
 * strokeId collision across an implausibly long session) rather than
 * erroring — a drawing feature has no reason to be fragile about a
 * duplicate network message. */
function applyRemoteStrokeStartOnState(
  state: MapWhiteboardState,
  strokeId: string,
  tool: WhiteboardTool,
  color: string,
  point: WhiteboardGridPoint
): void {
  const { pixelX, pixelY } = gridPointToPixel(point.u, point.v);
  const pixel = { x: pixelX, y: pixelY };
  const touched = new Set<string>();
  const halfWidthPx = lineWidthPx(tool) / 2;
  for (const cell of sampleSegmentCells(null, pixel, halfWidthPx)) touched.add(cellKey(cell.x, cell.y));
  drawSegment(state, tool, color, null, pixel);
  state.remoteStrokes.set(strokeId, { tool, color, lastPixel: pixel, touched });
}

/** A receiver that missed the matching start (joined mid-stroke) simply has
 * no tracked entry for this id — dropped silently, since the persisted
 * tier's own stroke-end broadcast always corrects the final pixels
 * regardless (§5.1's "never a wrong FINAL state" guarantee). */
function applyRemoteStrokePointsOnState(
  state: MapWhiteboardState,
  strokeId: string,
  points: readonly WhiteboardGridPoint[]
): void {
  const remote = state.remoteStrokes.get(strokeId);
  if (!remote) return;
  const halfWidthPx = lineWidthPx(remote.tool) / 2;
  for (const point of points) {
    const { pixelX, pixelY } = gridPointToPixel(point.u, point.v);
    const pixel = { x: pixelX, y: pixelY };
    for (const cell of sampleSegmentCells(remote.lastPixel, pixel, halfWidthPx)) remote.touched.add(cellKey(cell.x, cell.y));
    drawSegment(state, remote.tool, remote.color, remote.lastPixel, pixel);
    remote.lastPixel = pixel;
  }
}

function doUndo(state: MapWhiteboardState): WhiteboardTileUpdate[] {
  const entry = state.undoStack.pop();
  if (!entry) return [];
  const redoCells = new Map<string, HTMLCanvasElement | null>();
  const changes: WhiteboardTileUpdate[] = [];
  for (const [key, beforeTile] of entry.cells) {
    redoCells.set(key, state.tiles.get(key) ?? null);
    const [xs, ys] = key.split(",");
    restoreTile(state, Number(xs), Number(ys), beforeTile);
    changes.push({ x: Number(xs), y: Number(ys), tilePng: beforeTile ? tileToBase64(beforeTile) : null });
  }
  state.redoStack.push({ cells: redoCells });
  state.texture.needsUpdate = true;
  return changes;
}

function doRedo(state: MapWhiteboardState): WhiteboardTileUpdate[] {
  const entry = state.redoStack.pop();
  if (!entry) return [];
  const undoCells = new Map<string, HTMLCanvasElement | null>();
  const changes: WhiteboardTileUpdate[] = [];
  for (const [key, afterTile] of entry.cells) {
    undoCells.set(key, state.tiles.get(key) ?? null);
    const [xs, ys] = key.split(",");
    restoreTile(state, Number(xs), Number(ys), afterTile);
    changes.push({ x: Number(xs), y: Number(ys), tilePng: afterTile ? tileToBase64(afterTile) : null });
  }
  state.undoStack.push({ cells: undoCells });
  state.texture.needsUpdate = true;
  return changes;
}

/** Returns whether anything was actually cleared — `false` means "nothing
 * to clear", the caller's own signal not to bother persisting/broadcasting
 * a no-op clear. */
function doClear(state: MapWhiteboardState): boolean {
  if (state.tiles.size === 0) return false;
  const before = new Map(state.tiles);
  state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
  state.tiles.clear();
  state.undoStack.push({ cells: before });
  if (state.undoStack.length > HISTORY_LIMIT) state.undoStack.shift();
  state.redoStack = [];
  state.texture.needsUpdate = true;
  return true;
}

/** WHITEBOARD_CLEARED_EVENT receiver — the identical wipe doClear performs,
 * but never pushes a local undo entry (someone ELSE's clear, per
 * applyTileChangeOnState's own doc comment on why this file's
 * network-receiving functions never touch undoStack/redoStack). */
function clearRemoteState(state: MapWhiteboardState): void {
  state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
  state.tiles.clear();
  state.texture.needsUpdate = true;
}

/** One in-progress stroke's own mutable bookkeeping — captured at
 * pointerdown, mutated by every subsequent point (mesh press, then window
 * "pointermove"), and consumed once at "pointerup". */
interface StrokeSession {
  state: MapWhiteboardState;
  tool: WhiteboardTool;
  color: string;
  lastPixel: { x: number; y: number } | null;
  touched: Set<string>;
  /** Each newly-touched cell's own tile immediately before THIS stroke drew
   * on it — captured lazily, the first time a stroke reaches a given cell. */
  before: Map<string, HTMLCanvasElement | null>;
}

function applyStrokePoint(stroke: StrokeSession, pixelX: number, pixelY: number): void {
  const to = { x: pixelX, y: pixelY };
  const halfWidthPx = lineWidthPx(stroke.tool) / 2;
  for (const cell of sampleSegmentCells(stroke.lastPixel, to, halfWidthPx)) {
    const key = cellKey(cell.x, cell.y);
    if (!stroke.touched.has(key)) {
      stroke.touched.add(key);
      stroke.before.set(key, stroke.state.tiles.get(key) ?? null);
    }
  }
  drawSegment(stroke.state, stroke.tool, stroke.color, stroke.lastPixel, to);
  stroke.lastPixel = to;
}

function commitStroke(stroke: StrokeSession): WhiteboardTileUpdate[] {
  const changes: WhiteboardTileUpdate[] = [];
  for (const key of stroke.touched) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    const cropped = cropTile(stroke.state.canvas, x, y);
    const blank = isTileBlank(cropped);
    if (blank) stroke.state.tiles.delete(key);
    else stroke.state.tiles.set(key, cropped);
    changes.push({ x, y, tilePng: blank ? null : tileToBase64(cropped) });
  }
  stroke.state.undoStack.push({ cells: stroke.before });
  if (stroke.state.undoStack.length > HISTORY_LIMIT) stroke.state.undoStack.shift();
  stroke.state.redoStack = [];
  return changes;
}

// Window-level pointer-move/up continuation for an in-progress stroke — the
// exact shape GameTableScene.tsx's own chair-drag gesture already
// establishes ("the release can land anywhere... so the pointerup listener
// lives on window", and pointermove needs the SAME treatment here because a
// fast drag can carry the cursor off the hit-plane mesh's own on-screen
// footprint mid-gesture, which would otherwise silently strand `isDrawing`
// stuck true forever with no matching pointerup). Deliberately a small,
// self-contained duplicate of GameTableScene's own `floorPointFromClientXY`
// rather than an import: that helper raycasts a FIXED y=0 floor plane
// (chair-dragging is always a ground-plane gesture); this one needs an
// ARBITRARY, DM-adjustable height instead, and re-deriving that tiny
// (~10-line) helper here keeps this component fully self-contained rather
// than reaching into GameTableScene's own private module-level scratch
// objects for an unrelated gesture.
const whiteboardRaycaster = new Raycaster();
const whiteboardNdc = new Vector2();
const whiteboardHit = new Vector3();
const whiteboardPlaneNormal = new Vector3(0, 1, 0);
const whiteboardRaycastPlane = new Plane();

function planePointFromClientXY(
  camera: Camera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  planeY: number
): { x: number; z: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  whiteboardNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  whiteboardRaycaster.setFromCamera(whiteboardNdc, camera);
  // Plane equation normal·p + constant = 0, satisfied at y = planeY by
  // constant = -planeY.
  whiteboardRaycastPlane.set(whiteboardPlaneNormal, -planeY);
  const hit = whiteboardRaycaster.ray.intersectPlane(whiteboardRaycastPlane, whiteboardHit);
  return hit ? { x: whiteboardHit.x, z: whiteboardHit.z } : null;
}

// Scratch vectors for the per-frame center-projection debug mirror below —
// the onOwnChairProjectedPosition precedent's own reused-scratch-object
// convention (GameTableScene.tsx), including its "behind the camera" test
// (an angle check against the camera's own forward direction, not a raw
// projected-NDC-z threshold — mirrored verbatim since that's the one already
// proven correct in this exact scene).
const centerWorldPoint = new Vector3();
const centerCameraPos = new Vector3();
const centerDelta = new Vector3();
const centerForward = new Vector3();

export const WhiteboardPlane = forwardRef<WhiteboardHandle, WhiteboardPlaneProps>(function WhiteboardPlane(
  {
    mapId,
    gridWidth,
    gridHeight,
    cellSize,
    worldY,
    interactive,
    tool,
    color,
    onDrawingChange,
    onHistoryChange,
    onDebug,
    onCenterProjectedPosition,
    initialTiles,
    onLocalStrokeStart,
    onLocalStrokePoint,
    onLocalStrokeEnd,
    onTilesPersist,
    onClearPersist,
  },
  ref
) {
  const { camera, gl, size } = useThree();

  // Per-instance cache, keyed by mapId — see this file's own top doc
  // comment for why this (not a module-level Map) is the right scope.
  const cacheRef = useRef<Map<string, MapWhiteboardState>>(new Map());
  const state = getOrCreateMapState(cacheRef.current, mapId, gridWidth, gridHeight);

  useEffect(
    () => () => {
      for (const cached of cacheRef.current.values()) cached.texture.dispose();
      cacheRef.current.clear();
    },
    []
  );

  // Ref-mirrored callbacks — the onRulerDragStartRef/onChairDragEndRef
  // precedent (GameTableScene.tsx): these fire from window-level event
  // listeners and the imperative handle below, neither of which re-subscribes
  // every render, so they need a way to see the LATEST callback without
  // going stale.
  const onHistoryChangeRef = useRef(onHistoryChange);
  const onDebugRef = useRef(onDebug);
  const onLocalStrokeStartRef = useRef(onLocalStrokeStart);
  const onLocalStrokePointRef = useRef(onLocalStrokePoint);
  const onLocalStrokeEndRef = useRef(onLocalStrokeEnd);
  const onTilesPersistRef = useRef(onTilesPersist);
  const onClearPersistRef = useRef(onClearPersist);
  useEffect(() => {
    onHistoryChangeRef.current = onHistoryChange;
    onDebugRef.current = onDebug;
    onLocalStrokeStartRef.current = onLocalStrokeStart;
    onLocalStrokePointRef.current = onLocalStrokePoint;
    onLocalStrokeEndRef.current = onLocalStrokeEnd;
    onTilesPersistRef.current = onTilesPersist;
    onClearPersistRef.current = onClearPersist;
  }, [onHistoryChange, onDebug, onLocalStrokeStart, onLocalStrokePoint, onLocalStrokeEnd, onTilesPersist, onClearPersist]);

  const reportHistory = useCallback((s: MapWhiteboardState) => onHistoryChangeRef.current?.(historyOf(s)), []);
  const reportDebug = useCallback((s: MapWhiteboardState) => onDebugRef.current?.(debugOf(s)), []);

  // Fires once whenever the ACTIVE map changes (a genuinely different cached
  // state object) — so a toolbar elsewhere immediately reflects whichever
  // map's own undo/redo/tiles this client just switched to, including one
  // this same client already drew on earlier this session.
  useEffect(() => {
    reportHistory(state);
    reportDebug(state);
  }, [state, reportHistory, reportDebug]);

  // Hydration (docs/design/whiteboard-drawing-layer.md §5.3) — fires once
  // per genuinely NEW state object (guarded by `state.hydrated`, not by
  // this effect's own dependency array, so a later re-render with a new
  // `initialTiles` array reference for the SAME already-hydrated map can
  // never clobber this client's own subsequent local edits or live/
  // persisted-tier updates). `initialTiles` is deliberately read directly
  // here rather than via a ref: this only ever needs the value current at
  // the moment a brand new state is created, exactly once.
  useEffect(() => {
    if (state.hydrated) return;
    state.hydrated = true;
    if (initialTiles && initialTiles.length > 0) {
      void loadTilesOnState(state, initialTiles).then(() => reportDebug(state));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally NOT reactive to initialTiles; see this effect's own doc comment above.
  }, [state, reportDebug]);

  useImperativeHandle(
    ref,
    () => ({
      undo() {
        const changes = doUndo(state);
        if (changes.length > 0) onTilesPersistRef.current?.(mapId, changes);
        reportHistory(state);
        reportDebug(state);
      },
      redo() {
        const changes = doRedo(state);
        if (changes.length > 0) onTilesPersistRef.current?.(mapId, changes);
        reportHistory(state);
        reportDebug(state);
      },
      clear() {
        const cleared = doClear(state);
        if (cleared) onClearPersistRef.current?.(mapId);
        reportHistory(state);
        reportDebug(state);
      },
      applyRemoteStrokeStart(strokeId, remoteTool, remoteColor, point) {
        applyRemoteStrokeStartOnState(state, strokeId, remoteTool, remoteColor, point);
        reportDebug(state);
      },
      applyRemoteStrokePoints(strokeId, points) {
        applyRemoteStrokePointsOnState(state, strokeId, points);
        reportDebug(state);
      },
      applyRemoteStrokeEnd(strokeId) {
        state.remoteStrokes.delete(strokeId);
      },
      applyTileChanges(changes) {
        void Promise.all(changes.map((change) => applyTileChangeOnState(state, change.x, change.y, change.tilePng))).then(
          () => reportDebug(state)
        );
      },
      loadTiles(tiles) {
        void loadTilesOnState(state, tiles).then(() => reportDebug(state));
      },
      clearRemote() {
        clearRemoteState(state);
        reportDebug(state);
      },
    }),
    [state, mapId, reportHistory, reportDebug]
  );

  const strokeRef = useRef<StrokeSession | null>(null);
  const strokeIdRef = useRef<string | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  // Mirrors isDrawing's own two real transitions out to GameTableScene (see
  // onDrawingChange's own doc comment) — the onChairDraggingChange
  // precedent's exact shape.
  useEffect(() => {
    onDrawingChange?.(isDrawing);
  }, [isDrawing, onDrawingChange]);

  const handlePointerDown = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const { pixelX, pixelY } = worldToPixel(event.point.x, event.point.z, gridWidth, gridHeight, cellSize);
      const stroke: StrokeSession = { state, tool, color, lastPixel: null, touched: new Set(), before: new Map() };
      applyStrokePoint(stroke, pixelX, pixelY);
      strokeRef.current = stroke;
      const strokeId = crypto.randomUUID();
      strokeIdRef.current = strokeId;
      onLocalStrokeStartRef.current?.(mapId, { strokeId, tool, color, point: pixelToGridPoint(pixelX, pixelY) });
      setIsDrawing(true);
    },
    [state, tool, color, gridWidth, gridHeight, cellSize, mapId]
  );

  useEffect(() => {
    if (!isDrawing) return;
    const canvas = gl.domElement;
    function handleMove(event: PointerEvent) {
      const stroke = strokeRef.current;
      const strokeId = strokeIdRef.current;
      if (!stroke || !strokeId) return;
      const point = planePointFromClientXY(camera, canvas, event.clientX, event.clientY, worldY);
      if (!point) return;
      const { pixelX, pixelY } = worldToPixel(point.x, point.z, gridWidth, gridHeight, cellSize);
      applyStrokePoint(stroke, pixelX, pixelY);
      onLocalStrokePointRef.current?.(mapId, strokeId, pixelToGridPoint(pixelX, pixelY));
    }
    function handleUp() {
      const stroke = strokeRef.current;
      const strokeId = strokeIdRef.current;
      strokeRef.current = null;
      strokeIdRef.current = null;
      setIsDrawing(false);
      if (stroke) {
        const changes = commitStroke(stroke);
        if (changes.length > 0) onTilesPersistRef.current?.(mapId, changes);
        if (strokeId) onLocalStrokeEndRef.current?.(mapId, strokeId);
        reportHistory(stroke.state);
        reportDebug(stroke.state);
      }
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [isDrawing, camera, gl, worldY, gridWidth, gridHeight, cellSize, mapId, reportHistory, reportDebug]);

  // Verification-only per-frame projection — the onOwnChairProjectedPosition
  // precedent, generalized to this plane's own fixed local-space center
  // (0, 0, 0), i.e. world (0, worldY, 0): unlike a dragged chair this point
  // never moves on its own, but the CAMERA does (seat switch, orbit,
  // chair-drag-follow), so it's still only meaningfully computed per frame,
  // not once.
  const lastCenterScreen = useRef<[number, number] | null>(null);
  useFrame(() => {
    if (!onCenterProjectedPosition) return;
    centerWorldPoint.set(0, worldY, 0);
    camera.updateMatrixWorld();
    centerCameraPos.setFromMatrixPosition(camera.matrixWorld);
    centerDelta.copy(centerWorldPoint).sub(centerCameraPos);
    camera.getWorldDirection(centerForward);
    if (centerDelta.angleTo(centerForward) > Math.PI / 2) {
      if (lastCenterScreen.current !== null) {
        lastCenterScreen.current = null;
        onCenterProjectedPosition(null);
      }
      return;
    }
    centerWorldPoint.project(camera);
    const x = (centerWorldPoint.x * size.width) / 2 + size.width / 2;
    const y = -((centerWorldPoint.y * size.height) / 2) + size.height / 2;
    const last = lastCenterScreen.current;
    if (!last || Math.abs(last[0] - x) > 0.5 || Math.abs(last[1] - y) > 0.5) {
      lastCenterScreen.current = [x, y];
      onCenterProjectedPosition([x, y]);
    }
  });

  const { width, height } = planeSizeWorldUnits(gridWidth, gridHeight, cellSize);

  return (
    <>
      {/* The always-mounted visible plane — no pointer handlers, ever, so
          r3f's own raycaster skips it entirely (the CellBlock "a
          handler-less mesh is skipped by r3f's raycaster" precedent) and it
          can never intercept a gesture meant for anything else on the
          table, regardless of interactive/drawMode state. Rotated flat the
          same way the floor circle mesh is (GameTableScene.tsx) — see
          whiteboardMath.ts's own worldToPixel doc comment for the exact
          coordinate derivation this rotation was chosen to match, pixel for
          pixel, with zero custom UV/flipY code needed (verified against
          three.js's own default PlaneGeometry UVs before writing this). */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={state.texture} transparent depthWrite={false} side={DoubleSide} />
      </mesh>
      {interactive ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} onPointerDown={handlePointerDown}>
          <planeGeometry args={[width, height]} />
          {/* opacity 0, not visible={false} — an invisible-via-`visible`
              mesh is what actually gets skipped by the raycaster, which
              would defeat the hit-plane entirely (the VoidCellPick/
              ObjectMarker hit-box precedent, MapSurface.tsx). */}
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
        </mesh>
      ) : null}
    </>
  );
});
