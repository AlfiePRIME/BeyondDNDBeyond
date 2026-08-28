"use client";

import { useRef, useState } from "react";
import { Button } from "@/ui-components";
import { setCharacterPawnModel, uploadCharacterPawnModelFile } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { validateGlbFile } from "@/app/lib/validate-glb";
import styles from "./sheet.module.css";

export interface PawnModelPickerProps {
  characterId: string;
  initialPawnModelRef: string | null;
}

/**
 * Pawn Customization P2: upload/replace/remove this specific character's
 * custom map-token model (character_pawns.pawn_model_ref, 0080) — the
 * AvatarPicker.tsx upload-and-save shape, minus the preset grid (there is
 * no curated preset library for a personal pawn model, only "none" or "your
 * own upload") and minus the rotate-and-confirm orientation step (a
 * deliberate, documented omission for this first pass — see this track's
 * own final report; PlacedObject already defaults forwardOffsetDeg to 0,
 * today's exact no-correction rendering, so nothing is broken by skipping
 * it, just not yet corrected for a model exported facing an unusual way).
 *
 * Renders only inside the sheet's owner-or-DM gated area (CharacterSheet's
 * own `canEdit`) — a non-owner/non-DM can never reach this page at all
 * (characters' own RLS 404s it first), so there is no separate "view only"
 * rendering to build here.
 */
export function PawnModelPicker({ characterId, initialPawnModelRef }: PawnModelPickerProps) {
  const [pawnModelRef, setPawnModelRef] = useState(initialPawnModelRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileChosen(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    setError(null);
    setSaved(null);
    setBusy(true);
    const result = await validateGlbFile(file, "custom pawn models");
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    try {
      const supabase = createBrowserSupabaseClient();
      const path = await uploadCharacterPawnModelFile(supabase, characterId, file);
      await setCharacterPawnModel(supabase, characterId, path);
      setPawnModelRef(path);
      setSaved("Model saved.");
    } catch {
      setError("Couldn't upload that model — try again.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleRemove() {
    setError(null);
    setSaved(null);
    setBusy(true);
    try {
      const supabase = createBrowserSupabaseClient();
      await setCharacterPawnModel(supabase, characterId, null);
      setPawnModelRef(null);
      setSaved("Model removed — this token now uses your account color.");
    } catch {
      setError("Couldn't remove the model — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.pawnPicker}>
      <p className={styles.pickerHint}>
        Upload a custom .glb model for this character&apos;s map token. It replaces the flat
        colored disc for every campaign member, on this character only — leave unset to use your
        own account color instead.
      </p>
      <div className={styles.pawnActions}>
        <Button
          variant="teal"
          size="sm"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          data-testid="pawn-model-upload-button"
        >
          {pawnModelRef ? "Replace model" : "Upload model"}
        </Button>
        {pawnModelRef ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void handleRemove()}
            data-testid="pawn-model-remove-button"
          >
            Remove model
          </Button>
        ) : null}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".glb,model/gltf-binary"
        aria-label="Upload a custom pawn model"
        className={styles.hiddenFileInput}
        disabled={busy}
        onChange={(event) => void handleFileChosen(event.target.files)}
        data-testid="pawn-model-file-input"
      />
      <p className={styles.uploadHint}>Custom models: binary glTF (.glb), max 10MB.</p>
      {error ? (
        <p role="alert" className={styles.errorText}>
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className={styles.savedText} data-testid="pawn-model-saved">
          {saved}
        </p>
      ) : null}
    </div>
  );
}
