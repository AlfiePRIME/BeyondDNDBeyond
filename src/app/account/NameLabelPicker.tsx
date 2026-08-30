"use client";

import { useState } from "react";
import { Select } from "@/ui-components";
import { setNameLabelColor, setNameLabelSize, type NameLabelSize } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { PRESET_COLORS } from "./PawnColorPicker";
import styles from "./account.module.css";

export interface NameLabelPickerProps {
  userId: string;
  initialColor: string;
  initialSize: NameLabelSize;
}

const SIZE_OPTIONS: { value: NameLabelSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

/**
 * Name Labels (0100): sets the signed-in user's own account-wide floating
 * name-label color/size — the label GameTableScene renders above THIS
 * user's own seat at the table, in every campaign ("can we please add
 * username above the characters in their chairs so people know who is
 * who" — the project owner's own explicit ask). The PawnColorPicker.tsx
 * shape exactly for color (the SAME reused PRESET_COLORS swatch row plus a
 * free-form native color input, saving immediately on pick/change, no
 * separate Save button), plus a Select dropdown for size using the
 * DisplayNameForm/AvatarPicker account-page field convention.
 *
 * Size is a closed 3-step preset (Select, not a raw numeric input) —
 * 0100_name_label.sql's own migration doc comment has the reasoning: an
 * unbounded numeric value would let a user pick something absurd (0, or
 * 10000) that visibly breaks the seated table's own layout for every OTHER
 * connected client looking at that user's seat, not just their own view.
 *
 * Deliberately NOT a free-form CSS/HTML field: the project owner's own
 * first, looser idea ("apply effects to their names or even css/html") was
 * explicitly narrowed away in their very next message to just size and
 * color. Rendering one user's arbitrary attacker-controlled markup into
 * every OTHER connected user's page would be a genuine stored-XSS
 * vector — a firm scope boundary, not a simplification of convenience.
 */
export function NameLabelPicker({ userId, initialColor, initialSize }: NameLabelPickerProps) {
  const [color, setColor] = useState(initialColor);
  const [size, setSize] = useState<NameLabelSize>(initialSize);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function saveColor(next: string) {
    setColor(next);
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await setNameLabelColor(createBrowserSupabaseClient(), userId, next);
      setSaved(true);
    } catch {
      setError("Couldn't save your name label color — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSize(next: NameLabelSize) {
    setSize(next);
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await setNameLabelSize(createBrowserSupabaseClient(), userId, next);
      setSaved(true);
    } catch {
      setError("Couldn't save your name label size — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.picker}>
      <div className={styles.colorSwatchRow}>
        {PRESET_COLORS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={styles.colorSwatch}
            // A shared (not per-preset-unique) testid — this picker's own
            // swatch row reuses PawnColorPicker.tsx's exact colorSwatch CSS
            // class, so a bare class selector in a verify script would
            // ambiguously match BOTH pickers' buttons; this disambiguates
            // without needing a separate CSS class of its own.
            data-testid="name-label-color-swatch"
            data-selected={color.toLowerCase() === preset.toLowerCase()}
            style={{ background: preset }}
            aria-label={`Use ${preset} as your name label color`}
            aria-pressed={color.toLowerCase() === preset.toLowerCase()}
            disabled={busy}
            onClick={() => void saveColor(preset)}
          />
        ))}
        <label className={styles.colorInputWrap} aria-label="Choose a custom name label color">
          <input
            type="color"
            value={color}
            className={styles.colorInput}
            disabled={busy}
            onChange={(event) => void saveColor(event.target.value)}
            data-testid="name-label-color-custom-input"
          />
        </label>
      </div>
      <Select
        label="Name label size"
        value={size}
        disabled={busy}
        onChange={(event) => void saveSize(event.target.value as NameLabelSize)}
        data-testid="name-label-size-select"
      >
        {SIZE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {error ? (
        <p role="alert" className={styles.errorText}>
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className={styles.savedText} data-testid="name-label-saved">
          Name label saved.
        </p>
      ) : null}
    </div>
  );
}
