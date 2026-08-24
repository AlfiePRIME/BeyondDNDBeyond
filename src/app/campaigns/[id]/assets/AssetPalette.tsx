"use client";

import { useRef, useState } from "react";
import { Button, ChoiceCard, SectionHeader, TextInput } from "@/ui-components";
import {
  createCustomAsset,
  uploadMapAssetFile,
  type MapAsset,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { validateGlbFile } from "@/app/lib/validate-glb";
import styles from "./assets.module.css";

export interface AssetPaletteProps {
  campaignId: string;
  initialAssets: MapAsset[];
  canUpload: boolean;
}

/**
 * Browsing view of every asset available to the campaign (placement onto
 * maps is a later prompt), plus the DM-only upload flow: validate the .glb
 * client-side, upload it to the map-assets bucket, then catalog it in
 * asset_library.
 */
export function AssetPalette({ campaignId, initialAssets, canUpload }: AssetPaletteProps) {
  const [assets, setAssets] = useState(initialAssets);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedName, setAddedName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    setError(null);
    setAddedName(null);
    setBusy(true);
    try {
      const result = await validateGlbFile(file, "map assets");
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const supabase = createBrowserSupabaseClient();
      const path = await uploadMapAssetFile(supabase, campaignId, file);
      const asset = await createCustomAsset(supabase, {
        campaignId,
        name,
        modelRef: path,
      });
      setAssets((current) => [...current, asset]);
      setAddedName(asset.name);
      setName("");
    } catch {
      setError("Couldn't upload that file — try again.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className={styles.palette}>
      <div className={styles.grid}>
        {assets.map((asset) => (
          <ChoiceCard
            key={asset.id}
            title={asset.name}
            meta={asset.source_type === "preset" ? "Built-in" : "Campaign upload"}
          />
        ))}
      </div>

      {canUpload ? (
        <div className={styles.uploadSection}>
          <SectionHeader eyebrow="DM tools" title="Upload a custom asset" />
          <div className={styles.uploadForm}>
            <TextInput
              label="Asset name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Throne"
              disabled={busy}
              className={styles.nameField}
            />
            <Button
              variant="teal"
              disabled={busy || !name.trim()}
              onClick={() => fileInputRef.current?.click()}
            >
              {busy ? "Uploading…" : "Choose .glb & upload"}
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".glb,model/gltf-binary"
            aria-label="Upload a custom map asset model"
            className={styles.hiddenFileInput}
            disabled={busy}
            onChange={(event) => handleUpload(event.target.files)}
          />
          <p className={styles.uploadHint}>Custom assets: binary glTF (.glb), max 10MB.</p>
          {error ? (
            <p role="alert" className={styles.errorText}>
              {error}
            </p>
          ) : null}
          {addedName ? (
            <p role="status" className={styles.savedText}>
              {addedName} added to the palette.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
