"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import styles from "./ui.module.css";

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Visible label, rendered in the mono uppercase convention. */
  label: ReactNode;
  /** Helper text below the input. */
  hint?: ReactNode;
  /** Error message; also switches the field into its error state. */
  error?: ReactNode;
}

/**
 * Labelled text input. The input content itself stays full-contrast
 * (--text on --surface2) — the neon treatment is confined to the border,
 * caret, and focus glow so typed values remain solidly legible.
 */
export function TextInput({ label, hint, error, id, className, ...rest }: TextInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  const classes = [styles.field, error ? styles.fieldError : undefined, className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <label className={styles.fieldLabel} htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className={styles.fieldInput}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {error ? (
        <span id={errorId} className={styles.fieldErrorText} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span id={hintId} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
