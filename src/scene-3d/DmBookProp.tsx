"use client";

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Billboard, Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { CanvasTexture, Group, SRGBColorSpace, Vector3 } from "three";

// Palette mirrored from the app's design tokens (src/ui-components/tokens.css)
// and Chair.tsx's own re-mirroring precedent — scene-3d can't import CSS
// custom properties, and this file renders standalone from GameRoom's module
// scope, so constants are re-mirrored here rather than exported across the
// module boundary (the same reasoning Chair.tsx/MapSurface.tsx give for
// their own PURPLE/TEAL constants).
const PURPLE = "#9b00ff"; // --purple — the DM's own accent (DmChair's trim/finial)
const COVER_COLOR = "#4a2c19"; // leather-ish cover
const SPINE_COLOR = "#2c1a0e";
const PAGE_COLOR = "#ece0bd"; // cream parchment pages

const CLOSED_WIDTH = 0.46;
const CLOSED_DEPTH = 0.32;
const CLOSED_HEIGHT = 0.09;

const PAGE_LENGTH = 0.24;
const PAGE_DEPTH = 0.34;
const PAGE_THICKNESS = 0.014;
const PAGE_TILT_RAD = (28 * Math.PI) / 180;

const BASE_EMISSIVE = 1.2;
const HOVER_EMISSIVE = 2.6;

// A generously oversized invisible hit box (MapSurface's ObjectMarker/token
// hit-box precedent) — bigger than the visible book in either state, so
// clicking it doesn't require pixel-perfect aim at the modeled geometry.
const HIT_BOX: [number, number, number] = [0.66, 0.4, 0.56];

// The book's own effective circular floor-plane footprint for the movable-
// chair collision avoidance (GameRoom.tsx's resolveChairDrop obstacle list)
// — half of HIT_BOX's larger horizontal dimension (0.66), rounded up
// slightly for a small safety margin beyond the exact hit box itself, the
// same "generous, not exact" reasoning HIT_BOX was already built with.
export const DM_BOOK_FOOTPRINT_RADIUS = 0.35;

// How far above the book's base the Html panel's anchor sits — well clear
// of the open pages' peak (~0.11 at PAGE_TILT_RAD), and enough that the
// panel (DmBook.module.css's `.book`, a fixed-height `min(400px, 50vh)`
// floating card — see its own doc comment) visibly hovers above the book
// with a gap rather than centering right on top of it. That gap matters for
// more than looks: it keeps the book's own oversized-but-still-modest hit
// box exposed below the panel so a DM can click the physical book itself to
// close it again, not just the panel's in-content "✕ Close" button — AND
// keeps the panel's own tab row from riding up above the viewport's top
// edge, where clicking a tab would stop being possible at all (Playwright
// treats an element outside the viewport as un-actionable; a real user
// would just be unable to reach it with the mouse either).
//
// Re-tuned from 1.15 for the doubled table's re-tuned, further-back seated
// camera (seating.ts's CAMERA_SETBACK/CAMERA_EYE_HEIGHT): the book's
// on-screen vertical position barely moves with that camera change (it sits
// close enough to the look-target that the two roughly cancel out), but the
// available on-screen room ABOVE the book — where this fixed-360px panel
// has to fit, between the viewport's top edge and the book's own hit box —
// did not grow to match, and the original 1.15 already left barely any
// margin on either side (confirmed by measuring the ORIGINAL, single-table
// geometry directly: its tab row's center already sat a hair above the
// viewport's top edge, and its click clearance below the panel was real but
// modest). This value is the empirically-measured midpoint that splits the
// (unchanged, still narrow) total slack evenly between "tab row stays
// clearly on-screen" and "panel stays clearly clear of the book's own hit
// box" — verified directly via real getBoundingClientRect() measurements at
// this exact camera/book configuration, and then end to end against
// verify-dm-book.mjs's full open → tab-switch → close → reopen → close
// flow, not just a single click.
const HTML_ANCHOR_Y = 1.55;

const labelTextureCache = new Map<string, CanvasTexture>();
// Same cached 2D-canvas-texture technique as DiceTumble's resultBadgeTexture
// / MapSurface's condition badges — a handful of distinct short strings, so
// one texture per string costs nothing per frame and needs no font asset.
function labelTexture(label: string): CanvasTexture {
  let texture = labelTextureCache.get(label);
  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 72;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#16102a";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = PURPLE;
      context.lineWidth = 4;
      context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
      context.fillStyle = "#ede0ff";
      context.font = "bold 22px monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(label, canvas.width / 2, canvas.height / 2 + 2);
    }
    texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    labelTextureCache.set(label, texture);
  }
  return texture;
}

/** A closed, resting-flat hardcover: a plain cover slab, a darker spine
 * strip along one edge, and a DM-purple clasp — Chair.tsx's DmChair trim
 * precedent, so the book reads as the DM's own furniture even closed. */
function ClosedBook({ hovered }: { hovered: boolean }) {
  return (
    <group>
      <mesh position={[0, CLOSED_HEIGHT / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[CLOSED_WIDTH, CLOSED_HEIGHT, CLOSED_DEPTH]} />
        <meshStandardMaterial color={COVER_COLOR} roughness={0.6} />
      </mesh>
      <mesh position={[-CLOSED_WIDTH / 2 + 0.02, CLOSED_HEIGHT / 2 + 0.006, 0]} castShadow>
        <boxGeometry args={[0.04, CLOSED_HEIGHT + 0.012, CLOSED_DEPTH]} />
        <meshStandardMaterial color={SPINE_COLOR} roughness={0.7} />
      </mesh>
      <mesh position={[0.1, CLOSED_HEIGHT + 0.007, 0]}>
        <boxGeometry args={[0.035, 0.014, CLOSED_DEPTH * 0.75]} />
        <meshStandardMaterial
          color={PURPLE}
          emissive={PURPLE}
          emissiveIntensity={hovered ? HOVER_EMISSIVE : BASE_EMISSIVE}
        />
      </mesh>
    </group>
  );
}

/** One page half, hinged at the spine (local origin) and tilted up and
 * outward by PAGE_TILT_RAD — a plain flat box rotated about Z so its inner
 * edge stays pinned at the hinge while its outer edge lifts, the same
 * hinge-via-group-rotation technique GameTableScene/Chair use for anything
 * that pivots from a fixed edge. */
function OpenPage({ side }: { side: 1 | -1 }) {
  return (
    <group rotation={[0, 0, side * PAGE_TILT_RAD]}>
      <mesh position={[side * (PAGE_LENGTH / 2), PAGE_THICKNESS / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[PAGE_LENGTH, PAGE_THICKNESS, PAGE_DEPTH]} />
        <meshStandardMaterial color={PAGE_COLOR} roughness={0.5} />
      </mesh>
    </group>
  );
}

/** The open state: two page halves forming a shallow "V" (each tilted
 * PAGE_TILT_RAD up from flat), a spine ridge covering the hinge seam, and
 * the same DM-purple ribbon draped from the spine for visual continuity
 * with the closed cover's clasp. */
function OpenBook({ hovered }: { hovered: boolean }) {
  return (
    <group>
      <OpenPage side={1} />
      <OpenPage side={-1} />
      <mesh position={[0, 0.05, 0]} castShadow>
        <boxGeometry args={[0.03, 0.1, PAGE_DEPTH]} />
        <meshStandardMaterial color={SPINE_COLOR} roughness={0.7} />
      </mesh>
      <mesh position={[0.012, 0.07, PAGE_DEPTH / 2 + 0.008]}>
        <boxGeometry args={[0.02, 0.12, 0.014]} />
        <meshStandardMaterial
          color={PURPLE}
          emissive={PURPLE}
          emissiveIntensity={hovered ? HOVER_EMISSIVE : BASE_EMISSIVE}
        />
      </mesh>
    </group>
  );
}

/** A brief, billboarded hover tooltip (DiceTumble's ResultBadge canvas-
 * texture technique) — the discoverability nice-to-have: a literal 3D prop
 * the DM has to notice is easy to miss next to the old floating tab, so
 * hovering it (even before the first click) surfaces a short label
 * confirming what it is and what clicking does. depthTest disabled so it's
 * never occluded by the book's own geometry directly beneath it. */
function HoverLabel({ text }: { text: string }) {
  return (
    <Billboard position={[0, 0.34, 0]}>
      <mesh>
        <planeGeometry args={[0.56, 0.13]} />
        <meshBasicMaterial map={labelTexture(text)} transparent depthTest={false} />
      </mesh>
    </Billboard>
  );
}

// Scratch vectors reused every frame (Html.js's own v1-v4 precedent) rather
// than allocating fresh Vector3s each call.
const objectPos = new Vector3();
const cameraPos = new Vector3();
const delta = new Vector3();
const forward = new Vector3();

export interface DmBookPropProps {
  /** World position for the book's base, at table-surface height — see
   * GameRoom.tsx's dmBookPosition, derived the same way as the private dice
   * tray's position (computeSeatLayout's DM seat) but offset to a spot that
   * doesn't overlap it. */
  position: readonly [number, number, number];
  /** Yaw — GameRoom passes the DM's own seat rotationY so the book sits at
   * the same angle as the rest of the DM's furniture (Chair.tsx/TableSeat's
   * convention); defaults to 0 for any caller that doesn't have a seat yet. */
  rotationY?: number;
  open: boolean;
  onToggleOpen: () => void;
  /** The book's real page content — GameRoom passes `<DmBook .../>` (its
   * full, unchanged prop-driven Enemies/DM Controls/Notes/Lore/Day-Night
   * tabs) here. Taken as children rather than imported directly so scene-3d
   * never needs to depend on the app layer (the module-boundary rule in
   * eslint.config.mjs — app depends on scene-3d, never the reverse) or know
   * DmBook's own prop shape. Rendered inside a non-perspective-transformed
   * `<Html transform={false}>` only while `open`. */
  children?: ReactNode;
  /** Fires with this client's current canvas-relative CSS-pixel projection
   * of the book's anchor point (or null once it's behind the camera) —
   * purely a testability hook (verify-dm-book.mjs has no other way to find
   * a WebGL mesh's on-screen position to click), the same "mirror
   * WebGL-only state into something a test can read" reasoning as
   * DiceTumble's onQueueChange / GameRoom's hidden debug divs. Not read by
   * DmBookProp itself. Only fires when the projected point actually moves
   * by more than half a pixel, so it costs nothing once the camera settles
   * — the seat camera is static outside orbit mode (GameTableScene's
   * PerspectiveCamera), so in practice this fires once on mount and again
   * only on resize or a camera-mode switch. */
  onProjectedPosition?: (point: [number, number] | null) => void;
}

/**
 * The DM's book, modeled as a real object on the table (Phase 5 of the Game
 * Room ambiance/tools plan) — replacing DmBook.tsx's old plain 2D
 * screen-fixed overlay with an actual procedural prop built from three.js
 * JSX primitives (Chair.tsx's precedent: plain box/cylinder assemblies, no
 * external asset), rendered as a sibling of GameTableScene inside the
 * Game Room's `<Canvas>`. Owns only the physical book (closed/open geometry,
 * the click target, hover feedback) and the `<Html>` anchor — the actual
 * page content is `children`, controlled state (`open`/`onToggleOpen`) is
 * GameRoom's, exactly like DiceTumble's imperative-handle/controlled-prop
 * split.
 *
 * Clicking the book (an oversized invisible hit box over the visible
 * geometry, MapSurface's ObjectMarker/token hit-box pattern) toggles
 * `open` via `onToggleOpen` — GameRoom mounts/unmounts the real page
 * content (`children`) in step with that, so a closed book has zero DOM
 * footprint, matching the old collapsed-tab behavior's "nothing to find in
 * the DOM" property for a non-DM client (this whole component still only
 * ever mounts for the DM at all).
 */
export function DmBookProp({
  position,
  rotationY = 0,
  open,
  onToggleOpen,
  children,
  onProjectedPosition,
}: DmBookPropProps) {
  const [hovered, setHovered] = useState(false);
  const groupRef = useRef<Group>(null);
  const { camera, size } = useThree();
  const lastReported = useRef<[number, number] | null>(null);

  useFrame(() => {
    if (!onProjectedPosition) return;
    const group = groupRef.current;
    if (!group) return;
    camera.updateMatrixWorld();
    group.updateWorldMatrix(true, false);
    objectPos.setFromMatrixPosition(group.matrixWorld);
    cameraPos.setFromMatrixPosition(camera.matrixWorld);
    delta.copy(objectPos).sub(cameraPos);
    camera.getWorldDirection(forward);
    const behindCamera = delta.angleTo(forward) > Math.PI / 2;
    if (behindCamera) {
      if (lastReported.current !== null) {
        lastReported.current = null;
        onProjectedPosition(null);
      }
      return;
    }
    const screen = objectPos.clone().project(camera);
    const x = (screen.x * size.width) / 2 + size.width / 2;
    const y = -((screen.y * size.height) / 2) + size.height / 2;
    const last = lastReported.current;
    if (!last || Math.abs(last[0] - x) > 0.5 || Math.abs(last[1] - y) > 0.5) {
      lastReported.current = [x, y];
      onProjectedPosition([x, y]);
    }
  });

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onToggleOpen();
  };

  return (
    <group ref={groupRef} position={position as [number, number, number]} rotation={[0, rotationY, 0]}>
      {open ? <OpenBook hovered={hovered} /> : <ClosedBook hovered={hovered} />}
      <mesh
        position={[0, HIT_BOX[1] / 2, 0]}
        onPointerDown={handlePointerDown}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
      >
        <boxGeometry args={HIT_BOX} />
        {/* opacity-0 rather than visible={false}: an invisible mesh is
            skipped by the raycaster, which would defeat the hit box
            (MapSurface's ObjectMarker precedent). */}
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {hovered ? <HoverLabel text={open ? "Close the DM's book" : "Open the DM's book"} /> : null}
      {open ? (
        <Html
          position={[0, HTML_ANCHOR_Y, 0]}
          center
          transform={false}
          zIndexRange={[500, 0]}
          pointerEvents="auto"
        >
          {children}
        </Html>
      ) : null}
    </group>
  );
}
