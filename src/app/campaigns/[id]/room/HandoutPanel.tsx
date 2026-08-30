"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Badge, Button, TextInput } from "@/ui-components";
import { isImageHandout, type RoomHandout } from "./handout-url";
import styles from "./room.module.css";

const HANDOUT_ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";

const MIN_SCALE = 1;
const MAX_SCALE = 6;
// Tuned so one physical wheel "notch" (deltaY ~100) is a comfortable ~14%
// step, and a trackpad's much smaller continuous deltas still feel smooth
// rather than jumpy — an exponential curve (vs. a linear add) keeps the
// SAME notch feeling like the same relative zoom whether it lands near
// MIN_SCALE or near MAX_SCALE.
const WHEEL_ZOOM_SPEED = 0.0015;

interface LightboxTransform {
  scale: number;
  x: number;
  y: number;
}

const IDLE_TRANSFORM: LightboxTransform = { scale: MIN_SCALE, x: 0, y: 0 };

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Fullscreen zoom/pan viewer for one already-resolved handout image. Takes
 * only the `src` the caller is already rendering in its own normal
 * (already-authorized) `<img>` — this never fetches or signs anything of
 * its own, so it can't leak a handout the current viewer couldn't already
 * see: the handouts SELECT RLS (0020) and the handouts bucket's own RLS
 * (0022) already gated whether `src` exists at all by the time this opens.
 *
 * Interaction model mirrors this codebase's own existing camera-control
 * vocabulary (MapEditorScene's OrbitControls: wheel to zoom, drag to pan)
 * rather than inventing a new one — there's no prior 2D image pan/zoom
 * widget in this codebase to match instead.
 */
function HandoutLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [transform, setTransform] = useState<LightboxTransform>(IDLE_TRANSFORM);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // Pointer Events unify mouse/touch/pen: a single active pointer drags
  // (once zoomed in), two active pointers pinch — no separate touch-event
  // wiring needed for real pinch-to-zoom on a touchscreen.
  const activePointers = useRef(new Map<number, { x: number; y: number }>());
  const dragOrigin = useRef<{ startX: number; startY: number; fromX: number; fromY: number } | null>(null);
  const pinchOrigin = useRef<{ distance: number; scale: number } | null>(null);

  /** Keeps a zoomed image from being dragged so far that it leaves the
   * viewport with nothing to look at — clamped against the image's own
   * pre-transform (layout) size, which `offsetWidth`/`offsetHeight` still
   * report correctly since a CSS `transform` never affects layout. */
  const clampTransform = useCallback((next: LightboxTransform): LightboxTransform => {
    const image = imageRef.current;
    const container = containerRef.current;
    if (!image || !container) return next;
    const scaledWidth = image.offsetWidth * next.scale;
    const scaledHeight = image.offsetHeight * next.scale;
    const maxX = Math.max(0, (scaledWidth - container.clientWidth) / 2);
    const maxY = Math.max(0, (scaledHeight - container.clientHeight) / 2);
    return { scale: next.scale, x: clampNumber(next.x, -maxX, maxX), y: clampNumber(next.y, -maxY, maxY) };
  }, []);

  // Escape-to-close, background scroll lock, and focus management — the
  // same conventions as ui-components/Modal.tsx's own open effect, PLUS one
  // addition Modal doesn't need: this lightbox can be opened from INSIDE
  // the "DM reveals a handout" Modal (HandoutContent renders inside both).
  // That Modal has its own independent `document`-level Escape listener, so
  // without the capture-phase + stopPropagation below, one Escape press
  // would fire BOTH listeners and close the lightbox AND the modal beneath
  // it in one keystroke. Capture-phase listeners always run before bubble-
  // phase ones regardless of mount order, so stopping propagation here
  // reliably closes just the topmost layer, leaving a second Escape to
  // close the modal behind it.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    containerRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    }
    document.addEventListener("keydown", onKeyDown, { capture: true });

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown, { capture: true });
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  // A native, non-passive listener: React's own onWheel is passive by
  // default (matching the browser's default for scroll perf), so
  // event.preventDefault() inside a JSX handler would warn and silently do
  // nothing — this is the standard escape hatch for "this wheel gesture IS
  // the feature, not incidental page scroll."
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      setTransform((current) => {
        const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED);
        const nextScale = clampNumber(current.scale * factor, MIN_SCALE, MAX_SCALE);
        if (nextScale === MIN_SCALE) return clampTransform({ scale: nextScale, x: 0, y: 0 });
        // Re-narrowed explicitly: TS's control-flow narrowing of the outer
        // `if (!container) return` doesn't carry through this closure's own
        // nested setTransform updater — container is already guaranteed
        // non-null by that early return, which never changes for the
        // lifetime of this listener (it's a plain const).
        const rect = container!.getBoundingClientRect();
        // Zoom toward the cursor rather than the image center — the whole
        // point of this feature is inspecting ONE specific detail, so
        // whatever's under the cursor should stay under it as scale changes.
        const pointerX = event.clientX - rect.left - rect.width / 2;
        const pointerY = event.clientY - rect.top - rect.height / 2;
        const ratio = nextScale / current.scale;
        const nextX = pointerX - (pointerX - current.x) * ratio;
        const nextY = pointerY - (pointerY - current.y) * ratio;
        return clampTransform({ scale: nextScale, x: nextX, y: nextY });
      });
    }

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [clampTransform]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activePointers.current.size === 1) {
        dragOrigin.current = {
          startX: event.clientX,
          startY: event.clientY,
          fromX: transform.x,
          fromY: transform.y,
        };
        pinchOrigin.current = null;
      } else if (activePointers.current.size === 2) {
        const [a, b] = [...activePointers.current.values()];
        pinchOrigin.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: transform.scale };
        dragOrigin.current = null;
      }
    },
    [transform.x, transform.y, transform.scale]
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!activePointers.current.has(event.pointerId)) return;
      activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (activePointers.current.size >= 2 && pinchOrigin.current) {
        const [a, b] = [...activePointers.current.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const nextScale = clampNumber(
          pinchOrigin.current.scale * (distance / pinchOrigin.current.distance),
          MIN_SCALE,
          MAX_SCALE
        );
        setTransform((current) => clampTransform({ ...current, scale: nextScale }));
        return;
      }

      if (activePointers.current.size === 1 && dragOrigin.current) {
        // Panning only actually moves anything once zoomed in — at scale 1
        // the image already fills its own contained box, so clampTransform
        // would immediately clamp any offset back to zero anyway; skipping
        // the state update entirely at scale 1 just avoids a no-op render.
        if (transform.scale <= MIN_SCALE) return;
        const dx = event.clientX - dragOrigin.current.startX;
        const dy = event.clientY - dragOrigin.current.startY;
        const origin = dragOrigin.current;
        setTransform((current) => clampTransform({ ...current, x: origin.fromX + dx, y: origin.fromY + dy }));
      }
    },
    [clampTransform, transform.scale]
  );

  const endPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    activePointers.current.delete(event.pointerId);
    if (activePointers.current.size < 2) pinchOrigin.current = null;
    if (activePointers.current.size === 0) dragOrigin.current = null;
  }, []);

  const handleOverlayMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) onClose();
    },
    [onClose]
  );

  return (
    <div
      ref={containerRef}
      className={styles.lightboxOverlay}
      data-testid="handout-fullscreen-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Fullscreen view of ${alt}`}
      tabIndex={-1}
      onMouseDown={handleOverlayMouseDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      <button
        type="button"
        className={styles.lightboxClose}
        onClick={onClose}
        data-testid="handout-fullscreen-close"
        aria-label="Close fullscreen image"
      >
        ×
      </button>
      {/* Signed Storage URLs are transient and can't be allowlisted for
          next/image's optimizer — same call as the panel's own thumbnail. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={false}
        className={styles.lightboxImage}
        data-testid="handout-fullscreen-image"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      />
      <p className={styles.lightboxHint} aria-hidden="true">
        Scroll or pinch to zoom · drag to pan · Esc to close
      </p>
    </div>
  );
}

/** A handout's actual content — inline for images, an open link for
 * documents. Shared between the panel list and the live-reveal modal.
 * An image is also the entry point into HandoutLightbox: clicking it opens
 * the SAME already-authorized `handout.url` full-screen with zoom/pan,
 * rather than this component fetching or signing anything new. */
export function HandoutContent({ handout }: { handout: RoomHandout }) {
  const [fullscreen, setFullscreen] = useState(false);

  if (!handout.url) return null;
  if (isImageHandout(handout)) {
    return (
      <>
        <button
          type="button"
          className={styles.revealedImageButton}
          onClick={() => setFullscreen(true)}
          aria-label={`View ${handout.title} fullscreen`}
          data-testid={`handout-image-button-${handout.id}`}
        >
          {/* Signed Storage URLs are transient and can't be allowlisted for
              next/image's optimizer — same call as MapPanel's revealed images. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={handout.url}
            alt={handout.title}
            className={styles.revealedImage}
            data-testid={`handout-image-${handout.id}`}
          />
        </button>
        {fullscreen && handout.url
          ? createPortal(
              <HandoutLightbox src={handout.url} alt={handout.title} onClose={() => setFullscreen(false)} />,
              document.body
            )
          : null}
      </>
    );
  }
  return (
    <a
      href={handout.url}
      target="_blank"
      rel="noreferrer"
      className={styles.handoutLink}
      data-testid={`handout-link-${handout.id}`}
    >
      Open handout ↗
    </a>
  );
}

/**
 * The Game Room's handout side panel: every campaign handout for the DM
 * (with reveal/hide/delete and an upload form), only already-revealed ones
 * for players — that filtering is the handouts SELECT RLS (0020), not
 * client-side logic. Mirrors MapPanel's DM-vs-player gating pattern.
 */
export function HandoutPanel({
  isDM,
  handouts,
  busy,
  error,
  onCreate,
  onToggleReveal,
  onDelete,
}: {
  isDM: boolean;
  handouts: RoomHandout[];
  busy: boolean;
  error: string | null;
  onCreate: (title: string, file: File) => void;
  onToggleReveal: (handout: RoomHandout) => void;
  onDelete: (handout: RoomHandout) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleSubmit() {
    if (!title.trim() || !file) return;
    onCreate(title.trim(), file);
    setCreating(false);
    setTitle("");
    setFile(null);
  }

  return (
    <aside className={styles.handoutPanel} data-testid="handout-panel">
      <span className={styles.panelLabel}>Handouts</span>

      {isDM ? (
        creating ? (
          <div className={styles.handoutForm} data-testid="handout-form">
            <TextInput
              label="Title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. The Baron's letter"
              disabled={busy}
              data-testid="handout-title-input"
            />
            <div className={styles.objectHeader}>
              <Button
                size="sm"
                variant="teal"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {file ? "Change file" : "Choose file"}
              </Button>
              {file ? <span className={styles.handoutFileName}>{file.name}</span> : null}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={HANDOUT_ACCEPT}
              aria-label="Upload a handout image or PDF"
              className={styles.hiddenFileInput}
              disabled={busy}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              data-testid="handout-file-input"
            />
            <p className={styles.hint}>PNG, JPEG, WebP, or PDF, max 10MB. Uploads start hidden.</p>
            <div className={styles.objectHeader}>
              <Button
                size="sm"
                variant="accent"
                disabled={busy || !title.trim() || !file}
                onClick={handleSubmit}
                data-testid="save-handout-button"
              >
                {busy ? "Uploading…" : "Add handout"}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.objectHeader}>
            <Button
              size="sm"
              variant="accent"
              disabled={busy}
              onClick={() => setCreating(true)}
              data-testid="create-handout-button"
            >
              + New handout
            </Button>
          </div>
        )
      ) : null}

      {handouts.length === 0 ? (
        <p className={styles.hint} data-testid="handout-list-empty">
          {isDM ? "No handouts yet — upload one to reveal later." : "Nothing revealed yet."}
        </p>
      ) : (
        handouts.map((handout) => (
          <div key={handout.id} className={styles.objectRow} data-testid={`handout-${handout.id}`}>
            <div className={styles.objectHeader}>
              <span className={styles.objectName}>{handout.title}</span>
              {isDM ? (
                <Badge
                  tone={handout.revealed ? "teal" : "purple"}
                  data-testid={`handout-state-${handout.id}`}
                >
                  {handout.revealed ? "Revealed" : "Hidden"}
                </Badge>
              ) : null}
            </div>
            {isDM ? (
              <div className={styles.objectHeader}>
                <Button
                  size="sm"
                  variant="teal"
                  disabled={busy}
                  onClick={() => onToggleReveal(handout)}
                  data-testid={`reveal-handout-${handout.id}`}
                >
                  {handout.revealed ? "Hide" : "Reveal"}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => onDelete(handout)}
                  data-testid={`delete-handout-${handout.id}`}
                >
                  Delete
                </Button>
              </div>
            ) : null}
            <HandoutContent handout={handout} />
          </div>
        ))
      )}

      {error ? (
        <p role="alert" className={styles.errorText} data-testid="handout-error">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
