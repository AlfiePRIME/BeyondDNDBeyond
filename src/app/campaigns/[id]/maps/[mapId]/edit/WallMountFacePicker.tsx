"use client";

import { useEffect, useEffectEvent, useRef, type MouseEvent } from "react";
import { Button } from "@/ui-components";
import { WALL_MOUNT_FACES, type WallMountFaceDeg } from "@/scene-3d";
import styles from "./editor.module.css";

export interface WallMountFacePickerProps {
  /** Screen-space (viewport pixel) anchor — the hover-in ThreeEvent's own
   * clientX/clientY, the exact QuickPlacePopover precedent for a click
   * (see that component's own doc comment): the pointer position at the
   * moment the DM's cursor entered the hovered wall IS the wall's own
   * screen position, no camera-projection math needed. */
  position: { x: number; y: number };
  /** Called with the picked face (0 or 180, see wallMount.ts's
   * WALL_MOUNT_FACES) — the caller places the torch AND closes this
   * picker. */
  onPick: (faceDeg: WallMountFaceDeg) => void;
  /** Called on Escape or a click outside the picker — no placement. */
  onClose: () => void;
}

/** Kept in sync with `.quickPlacePopover`'s own `width` in editor.module.css
 * — reused verbatim from QuickPlacePopover (Map Editor Batch A1): this is
 * the SAME floating-DOM-overlay shape, just with two fixed face buttons
 * instead of an asset grid, so it shares that component's CSS rather than
 * duplicating it. */
const POPOVER_WIDTH = 220;
const POPOVER_MARGIN = 12;

const FACE_LABEL: Record<WallMountFaceDeg, string> = {
  0: "Mount: near face",
  180: "Mount: far face",
};

/**
 * Wall-mounted torches (Map Editor Batch A7): hovering the Torch preset over
 * a placed wall-family object opens this at the hover point, mirroring the
 * two highlighted faces MapEditorScene's own WallMountFaceHighlights draws
 * in 3D. Picking a button mounts the torch flush to that face.
 *
 * The actual PICK deliberately happens through this DOM overlay rather than
 * making the two 3D highlight meshes themselves clickable: ObjectMarker's
 * own hit box already covers nearly the whole cell (PLACED_OBJECT_SIZE,
 * ~0.92 of it) and sits closer to the camera along most rays than anything
 * positioned at the SAME cell — two more raycast targets sharing that same
 * footprint would either lose to that hit box (never receiving the click at
 * all) or have to be positioned implausibly high above the model to win the
 * race, which reads worse than a small, unambiguous DOM menu right where
 * the DM is already looking. Matches this app's own QuickPlacePopover
 * precedent for "a 3D-scene interaction menu is still just an HTML overlay
 * positioned at the interaction point."
 *
 * Reuses QuickPlacePopover's exact dismissal shape (Modal.tsx's own proven
 * "click lands only when the event target IS the overlay itself" pattern,
 * not a document-level listener) for the identical reason: the native
 * pointerover that OPENS this (hovering the wall) must never be able to
 * immediately close it again.
 */
export function WallMountFacePicker({ position, onPick, onClose }: WallMountFacePickerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // useEffectEvent (QuickPlacePopover's own idiom) so this effect subscribes
  // once per mount rather than re-subscribing whenever the caller passes a
  // new onClose identity.
  const handleEscape = useEffectEvent(() => {
    onClose();
  });

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleEscape();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const onOverlayMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const left =
    typeof window === "undefined"
      ? position.x
      : Math.min(position.x, window.innerWidth - POPOVER_WIDTH - POPOVER_MARGIN);
  const top = typeof window === "undefined" ? position.y : Math.max(POPOVER_MARGIN, position.y);

  return (
    <div
      className={styles.quickPlaceOverlay}
      onMouseDown={onOverlayMouseDown}
      data-testid="wall-mount-overlay"
    >
      <div
        ref={dialogRef}
        className={styles.quickPlacePopover}
        style={{ left, top }}
        role="menu"
        aria-label="Mount torch on wall face"
        tabIndex={-1}
        data-testid="wall-mount-picker"
      >
        <span className={styles.toolbarLabel}>Mount torch on this wall</span>
        <div className={styles.toolRow}>
          {WALL_MOUNT_FACES.map((faceDeg) => (
            <Button
              key={faceDeg}
              size="sm"
              variant="teal"
              onClick={() => onPick(faceDeg)}
              data-testid={`wall-mount-face-${faceDeg}`}
            >
              {FACE_LABEL[faceDeg]}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
