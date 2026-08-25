"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@/ui-components";
import { OrientationPreview, type ModelNormalize } from "@/scene-3d";
import styles from "./ModelOrientationStep.module.css";

export interface ModelOrientationStepProps {
  /** The candidate upload, not yet saved anywhere — the preview renders
   * straight from this File (via an object URL), so what the uploader sees
   * already matches the exact bytes about to be uploaded. */
  file: File;
  /** Which of AvatarModel's/PropModel's two normalization conventions this
   * upload will actually render under, so the preview matches. */
  normalize: ModelNormalize;
  /**
   * Called exactly once, with the forward_offset_deg to persist — 0 for
   * Skip (or dismissing the dialog any other way), or whatever the rotate
   * control currently reads for Confirm. Either way the caller is expected
   * to proceed with the upload immediately: per
   * docs/design/model-orientation-and-posing.md §8, this step is optional
   * to COMPLETE, not a gate on whether the upload happens at all — it only
   * ever changes what orientation gets saved alongside it.
   */
  onDone: (forwardOffsetDeg: number) => void;
}

const NUDGES = [-90, -45, -15, 15, 45, 90] as const;

function wrapDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Rotate-and-confirm upload step (model-orientation-and-posing.md §8): lets
 * an uploader preview their candidate .glb at the exact scale/recenter it
 * will render at, against a fixed ground-plane "forward" marker, and nudge
 * it in fixed 15°/45°/90° increments until the model's own front faces that
 * marker — simpler and more predictable to build/test than a free-drag
 * orbit gizmo, per the design doc, while OrientationPreview's own
 * OrbitControls still lets the uploader look the model over from any angle.
 *
 * Shared by AssetPalette.tsx's custom map-asset upload and AvatarPicker.tsx's
 * custom avatar upload — the two upload flows the design doc puts in scope
 * (§10 "Follow-up prompt A").
 */
export function ModelOrientationStep({ file, normalize, onDone }: ModelOrientationStepProps) {
  const [forwardOffsetDeg, setForwardOffsetDeg] = useState(0);
  const objectUrl = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => {
    return () => URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  function nudge(delta: number) {
    setForwardOffsetDeg((current) => wrapDeg(current + delta));
  }

  return (
    <Modal
      open
      // Dismissing (Escape/backdrop) behaves exactly like Skip — this step
      // must never block the upload it's attached to, so there's no third
      // "cancel the whole upload" outcome to wire up here.
      onClose={() => onDone(0)}
      title="Set forward direction"
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(0)} data-testid="orientation-skip">
            Skip (use default)
          </Button>
          <Button variant="teal" onClick={() => onDone(forwardOffsetDeg)} data-testid="orientation-confirm">
            Confirm
          </Button>
        </>
      }
    >
      <p className={styles.hint}>
        This is exactly how <strong>{file.name}</strong> will render. The teal arrow on the ground
        marks forward — rotate the model until its own front faces that arrow.
      </p>
      <div className={styles.canvasFrame} data-testid="orientation-preview">
        <OrientationPreview url={objectUrl} normalize={normalize} forwardOffsetDeg={forwardOffsetDeg} />
      </div>
      <div className={styles.rotateRow}>
        {NUDGES.map((delta) => (
          <Button
            key={delta}
            size="sm"
            variant="ghost"
            onClick={() => nudge(delta)}
            data-testid={`orientation-rotate-${delta < 0 ? "minus" : "plus"}-${Math.abs(delta)}`}
          >
            {delta > 0 ? `+${delta}°` : `${delta}°`}
          </Button>
        ))}
      </div>
      <p className={styles.readout} data-testid="orientation-degrees">
        {Math.round(forwardOffsetDeg)}°
      </p>
    </Modal>
  );
}
