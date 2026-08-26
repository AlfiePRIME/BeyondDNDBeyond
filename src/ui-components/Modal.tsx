"use client";

import { useEffect, useEffectEvent, useId, useRef, type MouseEvent, type ReactNode } from "react";
import styles from "./ui.module.css";

export interface ModalProps {
  /** Controls visibility. The modal renders nothing when closed. */
  open: boolean;
  /** Called on Escape, backdrop click, or the × button. */
  onClose: () => void;
  /** Header label, rendered in the mono uppercase convention. */
  title: ReactNode;
  /** Optional footer row (typically Buttons), right-aligned. */
  footer?: ReactNode;
  children?: ReactNode;
}

/**
 * Controlled modal dialog. Fade-up entrance from the ported vocabulary,
 * purple glow chrome, Escape/backdrop dismissal, focus moved into the
 * dialog on open and restored on close.
 */
export function Modal({ open, onClose, title, footer, children }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // useEffectEvent always sees the latest onClose without onClose being a
  // dependency of the effect below — the effect itself should only re-run
  // on a genuine open transition (open going false→true, or mounting
  // already open), not whenever the caller passes a new onClose identity
  // (e.g. an inline onClose that's recreated on every keystroke in a
  // sibling input). Effect Events are only callable from inside an Effect,
  // which the Escape keydown listener registered below satisfies.
  const handleEscape = useEffectEvent(() => {
    onClose();
  });

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleEscape();
    };
    document.addEventListener("keydown", onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  const onOverlayMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className={styles.modalOverlay} onMouseDown={onOverlayMouseDown}>
      <div
        ref={dialogRef}
        className={styles.modalDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className={styles.modalHeader}>
          <span id={titleId} className={styles.modalTitle}>
            {title}
          </span>
          <button
            type="button"
            className={styles.modalClose}
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </header>
        <div className={styles.modalBody}>{children}</div>
        {footer ? <footer className={styles.modalFooter}>{footer}</footer> : null}
      </div>
    </div>
  );
}
