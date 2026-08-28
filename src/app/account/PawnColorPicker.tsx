"use client";

import { useState } from "react";
import { setDefaultPawnColor } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import styles from "./account.module.css";

export interface PawnColorPickerProps {
  userId: string;
  initialColor: string;
}

// A handful of hues that stay distinct against both the app's own token
// palette (tokens.css) and each other — the current TEAL default, plus a
// few more so a player who wants their OWN color still has an easy one-click
// pick before reaching for the free-form picker. Deliberately NOT the same
// values as ALLEGIANCE_COLOR's hostile/neutral hues (#ff3b3b/#ff9a3c) —
// picking either of those as your own party token's color would make it
// hard to tell your pawn apart from a hostile/neutral one at a glance, the
// exact confusion this feature's own color/allegiance interaction reasoning
// is trying to avoid.
const PRESET_COLORS = ["#1ec8c8", "#cc55ff", "#3ddc68", "#ede0ff", "#ffd23f", "#5aa9ff"];

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
