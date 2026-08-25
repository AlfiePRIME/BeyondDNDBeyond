"use client";

import { useRef, useState } from "react";
import { ChoiceCard } from "@/ui-components";
import { setForwardOffsetDeg, setProfileAvatar, uploadAvatarFile, type AvatarSource } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { AVATAR_PRESETS } from "./avatar-presets";
import { validateGlbFile } from "@/app/lib/validate-glb";
import { ModelOrientationStep } from "@/app/ModelOrientationStep";
import { AVATAR_HEIGHT } from "@/scene-3d";
import styles from "./account.module.css";

export interface AvatarPickerProps {
  userId: string;
  initialSource: AvatarSource | null;
  initialRef: string | null;
}

/**
 * Preset grid + custom .glb upload, saving the choice to the signed-in
 * user's profile as it's made. Reused by the full Account page in
 * Prompt 15.
 */
export function AvatarPicker({ userId, initialSource, initialRef }: AvatarPickerProps) {
  const [selection, setSelection] = useState<{ source: AvatarSource; ref: string } | null>(
    initialSource && initialRef ? { source: initialSource, ref: initialRef } : null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Set once a chosen file passes validation, cleared once the
  // rotate-and-confirm step (ModelOrientationStep) resolves — see
  // completeUpload. Non-null is exactly "the modal is open".
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function choosePreset(presetId: string) {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await setProfileAvatar(createBrowserSupabaseClient(), userId, {
        source: "preset",
        ref: presetId,
      });
      setSelection({ source: "preset", ref: presetId });
      setSaved(true);
    } catch {
      setError("Couldn't save your avatar — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleFileChosen(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    const result = await validateGlbFile(file, "avatars");
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    // Hands off to the rotate-and-confirm step (model-orientation-and-
    // posing.md §8) — completeUpload runs once the uploader skips or
    // confirms a forward-direction offset.
    setPendingFile(file);
  }

  async function completeUpload(forwardOffsetDeg: number) {
    const file = pendingFile;
    if (!file) return;
    setPendingFile(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const path = await uploadAvatarFile(supabase, userId, file);
      await setProfileAvatar(supabase, userId, { source: "custom", ref: path });
      // MUST be an upsert, not an insert: uploadAvatarFile always writes to
      // the SAME fixed per-user path ({userId}/avatar.glb, upsert:true), so
      // a re-upload's orientation write reuses the exact key its
      // predecessor used. An insert here would leave the previous upload's
      // row in place, silently misapplied to this new model — see
      // 0043_model_orientation.sql's gotcha and setForwardOffsetDeg's own
      // doc comment.
      await setForwardOffsetDeg(supabase, path, forwardOffsetDeg);
      setSelection({ source: "custom", ref: path });
      setSaved(true);
    } catch {
      setError("Couldn't upload that file — try again.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className={styles.picker}>
      <div className={styles.presetGrid}>
        {AVATAR_PRESETS.map((preset) => (
          <ChoiceCard
            key={preset.id}
            title={preset.label}
            meta="Preset"
            selected={selection?.source === "preset" && selection.ref === preset.id}
            disabled={busy}
            onClick={() => choosePreset(preset.id)}
          />
        ))}
        <ChoiceCard
          title="Custom model"
          meta={selection?.source === "custom" ? "Your upload" : "Upload a .glb"}
          selected={selection?.source === "custom"}
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".glb,model/gltf-binary"
        aria-label="Upload a custom avatar model"
        className={styles.hiddenFileInput}
        disabled={busy}
        onChange={(event) => handleFileChosen(event.target.files)}
      />
      <p className={styles.uploadHint}>Custom models: binary glTF (.glb), max 10MB.</p>
      {error ? (
        <p role="alert" className={styles.errorText}>
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className={styles.savedText}>
          Avatar saved.
        </p>
      ) : null}
      {pendingFile ? (
        <ModelOrientationStep
          file={pendingFile}
          normalize={{ kind: "height", targetHeight: AVATAR_HEIGHT }}
          onDone={(forwardOffsetDeg) => void completeUpload(forwardOffsetDeg)}
        />
      ) : null}
    </div>
  );
}
