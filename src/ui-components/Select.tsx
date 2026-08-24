"use client";

import { useId, type SelectHTMLAttributes, type ReactNode } from "react";
import styles from "./ui.module.css";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Visible label, rendered in the mono uppercase convention. */
  label: ReactNode;
  /** Helper text below the select. */
  hint?: ReactNode;
  /** Error message; also switches the field into its error state. */
  error?: ReactNode;
}

/**
 * Labelled select, styled to match TextInput (same field/fieldInput
 * classes) so a form mixing text inputs and dropdowns reads as one system.
 */
export function Select({ label, hint, error, id, className, children, ...rest }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const hintId = `${selectId}-hint`;
  const errorId = `${selectId}-error`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  const classes = [styles.field, error ? styles.fieldError : undefined, className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <label className={styles.fieldLabel} htmlFor={selectId}>
        {label}
      </label>
      <select
        id={selectId}
        className={styles.fieldInput}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      >
        {children}
      </select>
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
