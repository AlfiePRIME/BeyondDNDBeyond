"use client";

import { useEffect, useEffectEvent, useRef, type MouseEvent } from "react";
import { AssetPickerGrid } from "./AssetPickerGrid";
import type { PaletteAsset } from "./lib/assetUrl";
import styles from "./editor.module.css";

export interface QuickPlacePopoverProps {
  /** Screen-space (viewport pixel) anchor — the pointer event's clientX/
   * clientY at the moment the shortcut fired, so the popover opens exactly
   * where the DM clicked rather than somewhere derived from the cell's 3D
   * position (which would require projecting back through the camera for
   * no real benefit — the pointer position IS the clicked cell's screen
   * position). */
  position: { x: number; y: number };
  /** Same roster the sidebar Place-mode palette renders from — see
   * AssetPickerGrid's own doc comment on why this is never a second,
   * separately-curated list. */
  assets: readonly PaletteAsset[];
  /** Called with the picked asset's id. The caller is responsible for both
   * placing it AND closing the popover afterward (this component doesn't
   * assume picking always means closing — a future consumer might want a
   * picker that stays open, e.g. placing several objects in a row). */
  onPick: (assetId: string) => void;
  /** Called on Escape or a click outside the popover — no placement. */
  onClose: () => void;
}

/** Kept in sync with `.quickPlacePopover`'s own `width` in editor.module.css
 * — used only to keep the popover from opening partly off the right edge of
 * the viewport; the real rendered width is what actually determines the
 * box's footprint. */
const POPOVER_WIDTH = 220;
const POPOVER_MARGIN = 12;

/**
 * The Ctrl+click quick-place popup (Map Editor Batch A1): opens at the
 * clicked cell's screen position, listing the exact same asset roster as
 * the sidebar palette (AssetPickerGrid) instead of hardcoding a single
 * preset. Picking an asset places it in one motion; Escape or a click
 * anywhere outside dismisses with no placement.
 *
 * Dismissal reuses Modal.tsx's own proven shape — a full-viewport,
 * invisible overlay whose `onMouseDown` only fires `onClose` when the event
 * target IS the overlay itself (never a descendant) — rather than a
 * document-level "click outside" listener. That avoids the classic bug
 * where the SAME native click that opened the popover (Ctrl+click on the
 * canvas, which still bubbles to `document` after this component mounts)
 * would immediately close it again; because the overlay only exists in the
 * DOM once React commits this component's own render, it can never
 * intercept the click that caused that render in the first place.
 */
export function QuickPlacePopover({ position, assets, onPick, onClose }: QuickPlacePopoverProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // useEffectEvent (Modal.tsx's own idiom) so this effect subscribes once
  // per mount rather than re-subscribing whenever the caller passes a new
  // onClose identity.
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
      data-testid="quick-place-overlay"
    >
      <div
        ref={dialogRef}
        className={styles.quickPlacePopover}
        style={{ left, top }}
        role="menu"
        aria-label="Quick place asset"
        tabIndex={-1}
        data-testid="quick-place-popover"
      >
        <span className={styles.toolbarLabel}>Quick place</span>
        <AssetPickerGrid
          assets={assets}
          onPick={onPick}
          gridTestId="quick-place-asset-grid"
          cardTestIdPrefix="quick-place-asset"
          className={styles.quickPlacePopoverGrid}
        />
      </div>
    </div>
  );
}
