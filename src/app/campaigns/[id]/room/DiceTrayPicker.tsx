"use client";

import { useRef, useState } from "react";
import { Button, ChoiceCard, TextInput } from "@/ui-components";
import {
  createCustomAsset,
  getMapAssetSignedUrl,
  setForwardOffsetDeg,
  uploadMapAssetFile,
  type DiceTrayModelPreference,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { validateGlbFile } from "@/app/lib/validate-glb";
import { ModelOrientationStep } from "@/app/ModelOrientationStep";
import { PERSONAL_TRAY_RADIUS } from "@/scene-3d";
import type { PaletteAsset } from "../maps/[mapId]/edit/lib/assetUrl";
import styles from "./room.module.css";

export interface DiceTrayPickerProps {
  campaignId: string;
  /** DM-only, the exact AssetPalette.tsx `canUpload` gate: only the DM may
   * add a NEW custom model to the campaign's own asset library
   * (asset_library's INSERT RLS, 0015) — but every member, DM or not, may
   * still PICK from whatever's already there (or the default). */
  canUpload: boolean;
  /** Every custom (non-preset) asset currently in the campaign's library —
   * a generic pool shared with map-object placement, not a dice-tray-only
   * list (asset_library has no "kind" column); any of them can double as a
   * personal tray's own look. */
  customAssets: PaletteAsset[];
  /** The caller's OWN currently-stored preference. */
  preference: DiceTrayModelPreference;
  onChange: (preference: DiceTrayModelPreference) => void;
  /** Surfaces the last failed save attempt, if any — the same
   * "hidden-mirror-free, plain error paragraph" convention every other
   * panel error in this file already uses. */
  error: string | null;
  /** Fired once a new custom asset has actually been created, so the
   * caller can append it to its own asset list immediately (see
   * GameRoom.tsx's assetList/handleAssetUploaded). */
  onAssetUploaded: (asset: PaletteAsset) => void;
}

/**
 * A member's own personal-dice-tray-appearance picker, embedded in the Dice
 * panel (DiceLogPanel) — every campaign member sees and can use this
 * (selecting is never DM-gated: seeing everyone else's tray choice is
 * already table-public roster data, same as an avatar pick), while the
 * upload control that ADDS a brand new custom model to the campaign's
 * library is DM-only, reusing AssetPalette.tsx's own exact upload pipeline
 * (validateGlbFile → ModelOrientationStep's rotate-and-confirm step →
 * uploadMapAssetFile/createCustomAsset → setForwardOffsetDeg) so a
 * dice-tray model upload behaves identically to a map-prop one in every
 * way that matters (validation, size limit, orientation calibration).
 */
export function DiceTrayPicker({
  campaignId,
  canUpload,
  customAssets,
  preference,
  onChange,
  error,
  onAssetUploaded,
}: DiceTrayPickerProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [addedName, setAddedName] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileChosen(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    setUploadError(null);
    setAddedName(null);
    setBusy(true);
    const result = await validateGlbFile(file, "dice trays");
    if (!result.ok) {
      setUploadError(result.message);
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setPendingFile(file);
  }

  async function completeUpload(forwardOffsetDeg: number) {
    const file = pendingFile;
    if (!file) return;
    setPendingFile(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const path = await uploadMapAssetFile(supabase, campaignId, file);
      const created = await createCustomAsset(supabase, {
        campaignId,
        name,
        modelRef: path,
      });
      await setForwardOffsetDeg(supabase, path, forwardOffsetDeg);
      // Resolve a loadable URL for the freshly-created row the same way
      // resolvePaletteAssets does for every custom asset, so the caller's
      // own asset list (and this picker's grid, fed from that same list)
      // can render it immediately without a reload.
      const url = await getMapAssetSignedUrl(supabase, path, 6 * 60 * 60).catch(() => null);
      onAssetUploaded({ ...created, url, forwardOffsetDeg });
      setAddedName(created.name);
      setName("");
    } catch {
      setUploadError("Couldn't upload that model — try again.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const isDefault = preference.source === "default";

  return (
    <div className={styles.diceTraySection} data-testid="dice-tray-picker">
      <span className={styles.diceSectionLabel}>My dice tray</span>
      <div className={styles.diceTrayGrid} role="group" aria-label="Dice tray model">
        <ChoiceCard
          title="Default"
          meta="Felt tray"
          selected={isDefault}
          onClick={() => onChange({ source: "default", assetId: null })}
          data-testid="dice-tray-choice-default"
        />
        {customAssets.map((asset) => (
          <ChoiceCard
            key={asset.id}
            title={asset.name}
            meta="Custom"
            selected={preference.source === "custom" && preference.assetId === asset.id}
            onClick={() => onChange({ source: "custom", assetId: asset.id })}
            data-testid={`dice-tray-choice-${asset.id}`}
          />
        ))}
      </div>

      {canUpload ? (
        <>
          <div className={styles.diceTrayUploadForm}>
            <TextInput
              label="Model name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Carved oak tray"
              disabled={busy}
              className={styles.diceTrayNameField}
              data-testid="dice-tray-upload-name"
            />
            <Button
              size="sm"
              variant="teal"
              disabled={busy || !name.trim()}
              onClick={() => fileInputRef.current?.click()}
              data-testid="dice-tray-upload-button"
            >
              {busy ? "Uploading…" : "Upload .glb"}
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".glb,model/gltf-binary"
            aria-label="Upload a custom dice tray model"
            className={styles.hiddenFileInput}
            disabled={busy}
            onChange={(event) => handleFileChosen(event.target.files)}
          />
          <p className={styles.hint}>Custom tray models: binary glTF (.glb), max 10MB.</p>
          {uploadError ? (
            <p role="alert" className={styles.errorText} data-testid="dice-tray-upload-error">
              {uploadError}
            </p>
          ) : null}
          {addedName ? (
            <p role="status" className={styles.savedText}>
              {addedName} added — pick it above to use it.
            </p>
          ) : null}
        </>
      ) : null}

      {error ? (
        <p role="alert" className={styles.errorText} data-testid="dice-tray-preference-error">
          {error}
        </p>
      ) : null}

      {pendingFile ? (
        <ModelOrientationStep
          file={pendingFile}
          normalize={{ kind: "maxDimension", targetSize: PERSONAL_TRAY_RADIUS * 2 }}
          onDone={(forwardOffsetDeg) => void completeUpload(forwardOffsetDeg)}
        />
      ) : null}
    </div>
  );
}
