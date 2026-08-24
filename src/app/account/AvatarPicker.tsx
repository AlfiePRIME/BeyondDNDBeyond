"use client";

import { useRef, useState } from "react";
import { ChoiceCard } from "@/ui-components";
import { setProfileAvatar, uploadAvatarFile, type AvatarSource } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { AVATAR_PRESETS } from "./avatar-presets";
import { validateAvatarGlb } from "./validate-glb";
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

  async function handleUpload(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const result = await validateAvatarGlb(file);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const supabase = createBrowserSupabaseClient();
      const path = await uploadAvatarFile(supabase, userId, file);
      await setProfileAvatar(supabase, userId, { source: "custom", ref: path });
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
        onChange={(event) => handleUpload(event.target.files)}
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
    </div>
  );
}
