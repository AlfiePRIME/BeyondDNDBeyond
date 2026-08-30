"use client";

import { useState } from "react";
import { setDefaultPawnColor } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import styles from "./account.module.css";

export interface PawnColorPickerProps {
  userId: string;
  initialColor: string;
}

// A broad spread of hues that stay distinct against both the app's own
// token palette (tokens.css) and each other — the original 6 (teal/purple/
// green/lavender/gold/blue) plus 8 more, so a player who wants their OWN
// color has a genuinely wide one-click spread to choose from before
// reaching for the free-form native picker (which already covers any color
// at all — this row is about convenience, not capability). Deliberately
// NONE of these sit in the ALLEGIANCE_COLOR hostile/neutral hue range
// (#ff3b3b's red / #ff9a3c's orange, roughly hue 0-40°) — picking a color
// that close would make it hard to tell your own party pawn apart from a
// hostile/neutral one at a glance, the exact confusion this feature's own
// color/allegiance interaction reasoning is trying to avoid.
//
// Exported so Name Labels' own NameLabelPicker.tsx can reuse this exact
// swatch row for its own (unrelated) color choice — a name label has no
// allegiance meaning at all, so the hue-avoidance reasoning above doesn't
// literally apply there, but "a broad, mutually-distinct spread of hues" is
// just as good a default swatch set for any per-account color picker in
// this app, and reusing one real list beats hand-copying a second one that
// could silently drift from it.
export const PRESET_COLORS = [
  "#1ec8c8", // teal
  "#cc55ff", // purple/magenta
  "#3ddc68", // green
  "#ede0ff", // pale lavender
  "#ffd23f", // amber/gold
  "#5aa9ff", // blue
  "#ff5fa2", // rose
  "#6c5ce7", // indigo
  "#4dd9e8", // bright cyan
  "#a8e063", // lime
  "#ff4fd8", // fuchsia
  "#7c93b3", // slate blue-gray
  "#f2f2f2", // silver
  "#4a4a52", // charcoal
];

/**
 * Pawn Customization P1: sets the signed-in user's account-wide default
 * MAP TOKEN color (profiles.default_pawn_color, 0079) — a preset swatch row
 * plus a free-form native color input, the AvatarPicker.tsx "preset grid +
 * custom option" shape applied to a color instead of a model. Saves
 * immediately on pick/change (no separate Save button), the AvatarPicker
 * preset-click precedent exactly.
 *
 * This is NOT the seated table avatar (AvatarPicker, avatar_source/
 * avatar_ref) — it colors the MAP TOKEN pawn instead (MapSurface.tsx's
 * TokenMarker), for characters that have no custom uploaded model.
 */
export function PawnColorPicker({ userId, initialColor }: PawnColorPickerProps) {
  const [color, setColor] = useState(initialColor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(next: string) {
    setColor(next);
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await setDefaultPawnColor(createBrowserSupabaseClient(), userId, next);
      setSaved(true);
    } catch {
      setError("Couldn't save your pawn color — try again.");
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
            data-selected={color.toLowerCase() === preset.toLowerCase()}
            style={{ background: preset }}
            aria-label={`Use ${preset} as your pawn color`}
            aria-pressed={color.toLowerCase() === preset.toLowerCase()}
            disabled={busy}
            onClick={() => void save(preset)}
          />
        ))}
        <label className={styles.colorInputWrap} aria-label="Choose a custom pawn color">
          <input
            type="color"
            value={color}
            className={styles.colorInput}
            disabled={busy}
            onChange={(event) => void save(event.target.value)}
            data-testid="pawn-color-custom-input"
          />
        </label>
      </div>
      {error ? (
        <p role="alert" className={styles.errorText}>
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className={styles.savedText} data-testid="pawn-color-saved">
          Pawn color saved.
        </p>
      ) : null}
    </div>
  );
}
