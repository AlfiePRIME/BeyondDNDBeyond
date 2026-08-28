"use client";

import { useEffect, useState } from "react";
import { ALL_SOUND_KEYS, getDebugSnapshot, playSound, subscribeDebugState, type SoundKey } from "@/audio";
import { deleteSoundOverride, setSoundOverride, type SoundOverride } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { Button } from "@/ui-components";
import styles from "./admin.module.css";

export interface SoundEffectsSectionProps {
  initialOverrides: SoundOverride[];
}

function toOverrideMap(overrides: SoundOverride[]): Partial<Record<SoundKey, SoundOverride>> {
  const map: Partial<Record<SoundKey, SoundOverride>> = {};
  for (const override of overrides) {
    map[override.sound_key as SoundKey] = override;
  }
  return map;
}

/**
 * Sound Effects SP2 — the admin-only "Sound Effects" section of /admin. One
 * row per @/audio registry key (ALL_SOUND_KEYS — never a second hardcoded
 * list of sound names), each with:
 *   - a "play current" preview, which calls the REAL playSound(key) from
 *     @/audio — the exact same resolution soundManager.ts's resolveSoundUrl
 *     uses during real gameplay, so this preview genuinely proves what a
 *     player would hear right now, not a separate ad-hoc lookup;
 *   - a file-upload control that replaces this key's override; and
 *   - a "reset to default" action (only shown once an override exists) that
 *     removes the override row, so the very next playback anywhere falls
 *     back to SP1's baked default file.
 *
 * Mutations go straight from this Client Component to Supabase
 * (setSoundOverride/deleteSoundOverride), the DiceTrayPicker.tsx/
 * uploadMapAssetFile direct-client-upload precedent this codebase already
 * established for DM/admin file replacement flows — not a Server Action.
 * RLS (0084_sound_overrides.sql) is the real enforcement layer: a non-admin
 * whose click somehow reached this code would still have both the storage
 * upload and the table write rejected.
 */
export function SoundEffectsSection({ initialOverrides }: SoundEffectsSectionProps) {
  const [overrides, setOverrides] = useState<Partial<Record<SoundKey, SoundOverride>>>(() =>
    toOverrideMap(initialOverrides)
  );
  const [pendingKey, setPendingKey] = useState<SoundKey | null>(null);
  const [errorByKey, setErrorByKey] = useState<Partial<Record<SoundKey, string>>>({});

  // The same hidden debug-mirror convention SoundControl.tsx (Sound Effects
  // SP1) established for the Game Room's top bar, mounted here too since
  // this page has no SoundControl of its own: lets a verify script read the
  // sound manager's own real play log (specifically, which URL a "play
  // current" click actually resolved and played — the override's storage
  // URL vs. SP1's baked default) rather than trusting the UI alone.
  const [debugSnapshot, setDebugSnapshot] = useState(() => getDebugSnapshot());
  useEffect(() => subscribeDebugState(() => setDebugSnapshot(getDebugSnapshot())), []);

  async function handleUpload(key: SoundKey, file: File) {
    setPendingKey(key);
    setErrorByKey((prev) => ({ ...prev, [key]: undefined }));
    try {
      const supabase = createBrowserSupabaseClient();
      const row = await setSoundOverride(supabase, key, file);
      setOverrides((prev) => ({ ...prev, [key]: row }));
    } catch (err) {
      setErrorByKey((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Upload failed." }));
    } finally {
      setPendingKey(null);
    }
  }

  async function handleReset(key: SoundKey) {
    setPendingKey(key);
    setErrorByKey((prev) => ({ ...prev, [key]: undefined }));
    try {
      const supabase = createBrowserSupabaseClient();
      await deleteSoundOverride(supabase, key);
      setOverrides((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (err) {
      setErrorByKey((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Reset failed." }));
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div data-testid="sound-effects-admin-section">
      <p className={styles.hint}>
        One row per sound effect. Uploading a file replaces what every connected player hears for that
        sound immediately — &quot;Reset to default&quot; removes the override and reverts to the
        built-in file.
      </p>
      <div className={styles.soundOverrideList} data-testid="sound-override-list">
        {ALL_SOUND_KEYS.map((key) => {
          const override = overrides[key];
          const isPending = pendingKey === key;
          const error = errorByKey[key];
          return (
            <div key={key} className={styles.soundOverrideRow} data-testid={`sound-override-row-${key}`}>
              <div className={styles.soundOverrideKey}>{key}</div>
              <div className={styles.soundOverrideStatus} data-testid={`sound-override-status-${key}`}>
                {override ? "Custom override" : "Using default"}
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={isPending}
                onClick={() => void playSound(key)}
                data-testid={`sound-override-play-${key}`}
              >
                Play current
              </Button>
              <input
                type="file"
                accept="audio/*"
                disabled={isPending}
                className={styles.soundOverrideFileInput}
                aria-label={`Upload a replacement sound for ${key}`}
                data-testid={`sound-override-file-input-${key}`}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void handleUpload(key, file);
                }}
              />
              {override ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={isPending}
                  onClick={() => void handleReset(key)}
                  data-testid={`sound-override-reset-${key}`}
                >
                  Reset to default
                </Button>
              ) : null}
              {error ? (
                <p role="alert" className={styles.errorText} data-testid={`sound-override-error-${key}`}>
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <div data-testid="sound-manager-debug" hidden>
        {JSON.stringify(debugSnapshot)}
      </div>
    </div>
  );
}
