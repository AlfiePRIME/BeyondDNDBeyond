"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoxGeometry, EdgesGeometry, MOUSE, SRGBColorSpace, TextureLoader, type Texture } from "three";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import {
  EDITOR_MAP_METRICS,
  MapSurface,
  type MapSurfaceCell,
  type MapSurfaceObject,
} from "./MapSurface";

// Palette mirrored from the app's design tokens (src/ui-components/tokens.css)
// — same hex-mirroring reasoning as GameTableScene.
const ROOM_BG = "#0d0520"; // --surface2
const PURPLE = "#9b00ff"; // --purple
const TEAL = "#1ec8c8"; // --teal
const GROUND = "#1a1338";

const CELL_SIZE = EDITOR_MAP_METRICS.cellSize;

// Tall enough to stay visible around max-elevation terrain (10 steps at
// 0.35 world units each, on a 0.14 slab).
const REGION_MARKER_HEIGHT = 10 * EDITOR_MAP_METRICS.elevationStepHeight + 0.4;

// Sandwiched between the editor's ground disc (-0.02) and the cell blocks'
// bottoms (0): far enough from both to never z-fight, and always UNDER the
// grid so painted cells are never occluded by the guide art.
const REFERENCE_IMAGE_Y = -0.01;

/** The DM's uploaded battle-map guide art, already resolved to a loadable
 * URL by the app layer. x/y are grid-cell units from the grid's center;
 * scale multiplies the image's fitted-to-grid base size. */
export interface EditorReferenceImage {
  url: string;
  x: number;
  y: number;
  scale: number;
}

// Editor-exclusive by design, which is why this lives here and not in
// MapSurface: MapSurface is shared with GameTableScene, and a reference
// image must be STRUCTURALLY impossible to render on the player-facing
// table — the table has no prop for it, so there is nothing to leak.
function ReferenceImagePlane({
  image,
  gridWidth,
  gridHeight,
}: {
  image: EditorReferenceImage;
  gridWidth: number;
  gridHeight: number;
}) {
  const [texture, setTexture] = useState<Texture | null>(null);
  useEffect(() => {
    let disposed = false;
    new TextureLoader().load(image.url, (loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      loaded.colorSpace = SRGBColorSpace;
      setTexture(loaded);
    });
    return () => {
      disposed = true;
      setTexture((previous) => {
        previous?.dispose();
        return null;
      });
    };
  }, [image.url]);

  if (!texture) return null;
  const art = texture.image as { width: number; height: number };
  // Contain-fit at scale 1: the image's larger relative dimension spans the
  // grid exactly, so a fresh upload lands roughly aligned with the grid the
  // DM will sculpt over (MapSurface centers the grid on the origin).
  const fit = Math.min((gridWidth * CELL_SIZE) / art.width, (gridHeight * CELL_SIZE) / art.height);
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[image.x * CELL_SIZE, REFERENCE_IMAGE_Y, image.y * CELL_SIZE]}
    >
      <planeGeometry args={[art.width * fit * image.scale, art.height * fit * image.scale]} />
      {/* Basic material, tone mapping off: the guide art should read as the
          DM's original image, not as a lit surface tinted by the room rig. */}
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

/** A DM-selected rectangle of cells, in grid coordinates. */
export interface EditorRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The selected-region marker: a teal edge outline plus a faint fill so the
// rectangle reads from any camera angle without hiding the cells inside it.
function RegionMarker({
  region,
  gridWidth,
  gridHeight,
}: {
  region: EditorRegion;
  gridWidth: number;
  gridHeight: number;
}) {
  const spanX = region.width * CELL_SIZE;
  const spanZ = region.height * CELL_SIZE;
  const centerX = (region.x + region.width / 2 - 0.5) * CELL_SIZE - ((gridWidth - 1) / 2) * CELL_SIZE;
  const centerZ =
    (region.y + region.height / 2 - 0.5) * CELL_SIZE - ((gridHeight - 1) / 2) * CELL_SIZE;
  const edges = useMemo(() => {
    const box = new BoxGeometry(spanX, REGION_MARKER_HEIGHT, spanZ);
    const geometry = new EdgesGeometry(box);
    box.dispose();
    return geometry;
  }, [spanX, spanZ]);
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <group position={[centerX, REGION_MARKER_HEIGHT / 2, centerZ]}>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={TEAL} transparent opacity={0.85} depthWrite={false} />
      </lineSegments>
      <mesh>
        <boxGeometry args={[spanX, REGION_MARKER_HEIGHT, spanZ]} />
        <meshBasicMaterial color={TEAL} transparent opacity={0.06} depthWrite={false} />
      </mesh>
    </group>
  );
}

export interface MapEditorSceneProps {
  gridWidth: number;
  gridHeight: number;
  /** Full dense grid — one entry per cell; the caller overlays sparse
   * storage onto defaults before passing it in (scene-3d can't fetch). */
  cells: readonly MapSurfaceCell[];
  /**
   * Fired at most once per cell per stroke: for the left button (0), a
   * click or a drag sweeping across cells; for the right button (2), a
   * single click only — right-drag stays reserved for camera orbit, so it
   * never starts a paint stroke. `button` is the triggering
   * PointerEvent.button (0 or 2); what it means — raise vs. lower, or
   * nothing at all for tools that ignore the right button — is entirely
   * the caller's tool state, not the scene's.
   */
  onPaintCell?: (x: number, y: number, button: number) => void;
  /**
   * Fired when a left-button stroke ends (pointer released anywhere) — lets
   * the caller finalize stroke-scoped state, e.g. turning the cells touched
   * during a generate-tool drag into a selected region.
   */
  onStrokeEnd?: () => void;
  /**
   * Parallel to onPaintCell but fired only on the initial press, never while
   * dragging across cells — object placement/move are discrete deliberate
   * actions, not strokes, so a drag must not scatter or relocate objects.
   * The native pointer event is forwarded so callers can read modifier keys
   * (e.g. the object tool's Ctrl+click quick-place) without the scene
   * needing to know what any modifier means.
   */
  onCellClick?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
  /** A selected rectangle of cells to highlight (the generate-area region);
   * null/absent renders no marker. */
  region?: EditorRegion | null;
  /** Placed objects to render; absent/empty renders none. */
  objects?: readonly MapSurfaceObject[];
  selectedObjectId?: string | null;
  /** When provided, placed objects become click targets that intercept the
   * cell beneath; when absent they're inert and clicks fall through to the
   * cell, so sculpt tools still paint occupied cells. */
  onSelectObject?: (id: string) => void;
  /** The DM's guide art rendered under the grid; null/absent renders none.
   * Deliberately an editor-scene prop, NOT a MapSurface one — see
   * ReferenceImagePlane. */
  referenceImage?: EditorReferenceImage | null;
}

export function MapEditorScene({
  gridWidth,
  gridHeight,
  cells,
  onPaintCell,
  onStrokeEnd,
  onCellClick,
  region,
  objects,
  selectedObjectId,
  onSelectObject,
  referenceImage,
}: MapEditorSceneProps) {
  const onPaintCellRef = useRef(onPaintCell);
  const onStrokeEndRef = useRef(onStrokeEnd);
  const onCellClickRef = useRef(onCellClick);
  const onSelectObjectRef = useRef(onSelectObject);
  useEffect(() => {
    onPaintCellRef.current = onPaintCell;
    onStrokeEndRef.current = onStrokeEnd;
    onCellClickRef.current = onCellClick;
    onSelectObjectRef.current = onSelectObject;
  }, [onPaintCell, onStrokeEnd, onCellClick, onSelectObject]);

  const paintingRef = useRef(false);
  // One application per cell per stroke: without this, a drag lingering on
  // a cell (or crossing it twice) would raise it repeatedly.
  const strokeRef = useRef<Set<string>>(new Set());

  const paint = useCallback((x: number, y: number, button: number) => {
    const key = `${x},${y}`;
    if (strokeRef.current.has(key)) return;
    strokeRef.current.add(key);
    onPaintCellRef.current?.(x, y, button);
  }, []);

  const handleDown = useCallback(
    (x: number, y: number, event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 0 && event.button !== 2) return;
      event.stopPropagation();
      if (event.button === 2) {
        // Ignore a right button that lands while a left-button stroke is
        // already in flight — sharing strokeRef/strokeChangesRef with an
        // in-progress drag would either let it repaint an already-touched
        // cell or prematurely close its history entry. Simultaneous
        // left+right buttons is a rare enough gesture that "ignored" is the
        // right answer, not "reconciled".
        if (paintingRef.current) return;
        // The right button never arms the drag-stroke below — that
        // gesture is OrbitControls' RIGHT: MOUSE.ROTATE (camera orbit), so
        // paintingRef must stay false and the window "pointerup" listener
        // (gated on it) will never fire onStrokeEnd for this click. Finalize
        // it here instead, synchronously, so a right click still becomes
        // its own one-cell undo/redo entry exactly like a left click/drag
        // does — same per-stroke dedupe too.
        strokeRef.current = new Set();
        paint(x, y, event.button);
        onStrokeEndRef.current?.();
        return;
      }
      paintingRef.current = true;
      strokeRef.current = new Set();
      paint(x, y, event.button);
      onCellClickRef.current?.(x, y, event);
    },
    [paint]
  );

  const handleSelectObject = useCallback((id: string) => {
    onSelectObjectRef.current?.(id);
  }, []);

  const handleOver = useCallback(
    (x: number, y: number, event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      if (!paintingRef.current) return;
      // paintingRef is only ever armed by a left-button down (above), so a
      // continued stroke is always the left-button action.
      paint(x, y, 0);
    },
    [paint]
  );

  // The stroke can end anywhere — off the grid, off the canvas — so the
  // pointerup listener lives on window, not on the meshes.
  useEffect(() => {
    const endStroke = () => {
      if (!paintingRef.current) return;
      paintingRef.current = false;
      onStrokeEndRef.current?.();
    };
    window.addEventListener("pointerup", endStroke);
    return () => window.removeEventListener("pointerup", endStroke);
  }, []);

  const span = Math.max(gridWidth, gridHeight) * CELL_SIZE;
  const cameraPosition = useMemo<[number, number, number]>(
    () => [0, span * 0.95 + 3, span * 0.55 + 2.5],
    [span]
  );

  return (
    <>
      <PerspectiveCamera makeDefault position={cameraPosition} fov={45} />
      {/* Left button is reserved for painting, so orbiting moves to the
          right button (pan on middle, zoom on wheel) — sculpting and camera
          control never fight over the same gesture. */}
      <OrbitControls
        target={[0, 0, 0]}
        mouseButtons={{ MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }}
        minDistance={3}
        maxDistance={span * 2.5 + 12}
        maxPolarAngle={Math.PI / 2 - 0.08}
      />

      <color attach="background" args={[ROOM_BG]} />

      <ambientLight color="#b9a6ff" intensity={0.7} />
      <directionalLight color="#ffe9c9" intensity={2.6} position={[8, 14, 6]} />
      <pointLight color={PURPLE} intensity={250} position={[-span, span * 0.5 + 4, -span]} distance={span * 6} />
      <pointLight color={TEAL} intensity={180} position={[span, span * 0.5 + 3, span]} distance={span * 6} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <circleGeometry args={[span * 1.6, 48]} />
        <meshStandardMaterial color={GROUND} roughness={0.95} />
      </mesh>

      {referenceImage ? (
        <ReferenceImagePlane
          image={referenceImage}
          gridWidth={gridWidth}
          gridHeight={gridHeight}
        />
      ) : null}

      <MapSurface
        gridWidth={gridWidth}
        gridHeight={gridHeight}
        cells={cells}
        objects={objects}
        selectedObjectId={selectedObjectId}
        onSelectObject={onSelectObject ? handleSelectObject : undefined}
        onCellPointerDown={handleDown}
        onCellPointerOver={handleOver}
      />

      {region ? <RegionMarker region={region} gridWidth={gridWidth} gridHeight={gridHeight} /> : null}
    </>
  );
}
