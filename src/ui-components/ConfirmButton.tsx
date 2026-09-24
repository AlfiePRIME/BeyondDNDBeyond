"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Button, type ButtonProps } from "./Button";

export interface ConfirmButtonProps extends Omit<ButtonProps, "onClick"> {
  /** Fired on the SECOND click, within `timeoutMs` of the first. */
  onConfirm: () => void;
  /** Label shown while armed. */
  confirmLabel?: string;
  timeoutMs?: number;
}

/**
 * A destructive action that needs two clicks: the first arms it (the label
 * switches to `confirmLabel` and the button turns red), the second — within
 * a few seconds — actually fires. Cheaper than a modal for quick table-side
 * actions like "Remove token" or "End combat", but still stops a stray click
 * from wiping something out.
 */
export function ConfirmButton({
  onConfirm,
  confirmLabel = "Confirm?",
  timeoutMs = 3500,
  children,
  variant,
  onBlur,
  ...rest
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (timerRef.current) clearTimeout(timerRef.current);
    if (armed) {
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    timerRef.current = setTimeout(() => setArmed(false), timeoutMs);
  };

  return (
    <Button
      {...rest}
      variant={armed ? "danger" : variant}
      onClick={handleClick}
      onBlur={(event) => {
        setArmed(false);
        onBlur?.(event);
      }}
      data-armed={armed ? "true" : undefined}
      aria-live="polite"
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}
