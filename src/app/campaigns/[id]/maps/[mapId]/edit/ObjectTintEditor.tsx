"use client";

import { Button } from "@/ui-components";
import type { MapObject } from "@/data-access";
import styles from "./editor.module.css";

/**
 * Map Editor Batch A3: a fixed palette of tint swatches for the selected
 * object — clicking one applies immediately (no separate Save step, unlike
 * ObjectTagEditor/BehaviorEditor's draft-then-save shape: there's nothing to
 * type or get wrong here, so applying-on-click is simpler for the DM and
 * for the exact click-then-verify shape this feature's own acceptance
 * criteria describes). Works identically for a generated preset or a
 * DM-uploaded custom model — this component (and everything it calls) never
 * branches on asset source_type.
 *
 * Applied as a MULTIPLY against the model's own base color, uniformly
 * across every material on the model (see PosedClone.tsx's buildTintedScene
 * for the render-side implementation). This project's own preset generator
 * (generate-map-presets.mjs) never names its materials — a chest's wood
 * body and gold hinges/lock are built from distinct MeshStandardMaterial
 * instances with no stored name to pattern-match on, and a DM-uploaded
 * custom model can't be assumed to follow any naming convention at all — so
 * there is no reliable signal to exclude "the metal bits" by. Per this
 * prompt's own explicit allowance to make that judgment call: this pass
 * tints every material uniformly rather than inventing a fragile
 * name-based heuristic. Because it's a multiply (not a flat replacement), a
 * tinted chest's gold accents stay visibly brighter/more saturated than its
 * wood — recolored, not flattened to one solid color — which reads fine as
 * "this object got dyed/painted" (and doubles as the visual-variety knob
 * A8a's building presets are designed to lean on).
 */
const TINT_SWATCHES: readonly { hex: string; label: string }[] = [
  { hex: "#ff5c5c", label: "Red" },
  { hex: "#ff9f45", label: "Orange" },
  { hex: "#ffe066", label: "Yellow" },
  { hex: "#7ee08c", label: "Green" },
  { hex: "#45d1c7", label: "Teal" },
  { hex: "#5b8dff", label: "Blue" },
  { hex: "#b57bff", label: "Purple" },
  { hex: "#ff7ad1", label: "Pink" },
  { hex: "#f2f2f2", label: "White" },
  { hex: "#4a4a4a", label: "Charcoal" },
];

export function ObjectTintEditor({
  object,
  onSave,
}: {
  object: MapObject;
  onSave: (tint: string | null) => void;
}) {
  return (
    <>
      <span className={styles.toolbarLabel}>Tint</span>
      <div className={styles.tintSwatchGrid} data-testid="object-tint-swatches">
        {TINT_SWATCHES.map((swatch) => {
          const active = object.tint === swatch.hex;
          return (
            <button
              key={swatch.hex}
              type="button"
              className={active ? `${styles.tintSwatch} ${styles.tintSwatchActive}` : styles.tintSwatch}
              style={{ backgroundColor: swatch.hex }}
              title={swatch.label}
              aria-label={`Tint ${swatch.label}`}
              aria-pressed={active}
              onClick={() => onSave(swatch.hex)}
              data-testid={`object-tint-swatch-${swatch.hex.slice(1)}`}
            />
          );
        })}
      </div>
      <div className={styles.toolRow}>
        <Button
          size="sm"
          variant="ghost"
          disabled={object.tint === null}
          onClick={() => onSave(null)}
          data-testid="object-tint-clear"
        >
          Clear tint
        </Button>
        {object.tint ? (
          <span className={styles.selectedMeta} data-testid="object-tint-current">
            Current: {object.tint}
          </span>
        ) : null}
      </div>
    </>
  );
}
