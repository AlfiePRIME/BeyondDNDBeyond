import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Sound Effects SP2: admin-uploaded replacements for one of src/audio's
 * SOUND_KEYS registry values — see 0084_sound_overrides.sql's own header
 * comment for the full RLS/storage reasoning. This module deliberately does
 * NOT import `SoundKey` from "@/audio": data-access is the DB layer other
 * feature modules (including @/audio's own resolveSoundUrl) build on top
 * of, not one that reaches back up into them, so `soundKey` is typed as a
 * plain `string` here — the actual valid-key set is enforced one layer
 * down, at the database, by 0084's CHECK constraint. Every real caller
 * (soundManager.ts, the admin settings UI) passes a concrete value straight
 * out of @/audio's own SOUND_KEYS/ALL_SOUND_KEYS.
 */
export interface SoundOverride {
  sound_key: string;
  /** A storage object path in the sound-overrides bucket. Combine with
   * getSoundOverridePublicUrl to get a fetchable URL. */
  storage_ref: string;
  updated_at: string;
}

const SOUND_OVERRIDES_BUCKET = "sound-overrides";

/**
 * Every currently-set override, keyed by sound_key — open to any
 * authenticated user (0084's SELECT policy), since every connected client,
 * not just admins, must be able to resolve playback URLs. The admin
 * settings page's own "Sound Effects" section uses this for its initial
 * render; soundManager.ts's resolveSoundUrl uses the narrower
 * getSoundOverride below instead (one key at a time, on every real
 * playback call — see that function's own doc comment for why this is
 * never cached).
 */
export async function listSoundOverrides(supabase: SupabaseClient): Promise<SoundOverride[]> {
  const { data, error } = await supabase.from("sound_overrides").select();
  if (error) throw error;
  return (data ?? []) as SoundOverride[];
}

/**
 * One key's override row, or null if none is set (the "fall back to SP1's
 * baked default" case — the overwhelmingly common one). This is the exact
 * query soundManager.ts's resolveSoundUrl runs fresh on every single real
 * playback call — a live pointer, deliberately never cached across calls
 * here (matching this session's monster-template-override/map-art "always
 * re-resolve, don't cache forever" convention), so an admin's upload or
 * reset takes effect on the very next playSound/startLoop with no other
 * plumbing anywhere.
 */
export async function getSoundOverride(supabase: SupabaseClient, soundKey: string): Promise<SoundOverride | null> {
  const { data, error } = await supabase.from("sound_overrides").select().eq("sound_key", soundKey).maybeSingle();
  if (error) throw error;
  return (data as SoundOverride | null) ?? null;
}

/**
 * A plain, unauthenticated-fetchable public URL for a stored override
 * file. The sound-overrides bucket (0084) is `public = true` specifically
 * so this works with soundManager.ts's bare `fetch(url)` — no Supabase
 * client, no auth header, no expiry — unlike every other storage-backed URL
 * in this codebase (all minted via short-lived createSignedUrl reads
 * instead; see character_pawns.ts's getCharacterPawnSignedUrl doc comment
 * for that precedent). Pure string templating under the hood
 * (`getPublicUrl` makes no network call), so this is safe to call as often
 * as needed.
 */
export function getSoundOverridePublicUrl(supabase: SupabaseClient, storageRef: string): string {
  return supabase.storage.from(SOUND_OVERRIDES_BUCKET).getPublicUrl(storageRef).data.publicUrl;
}

/**
 * Uploads a replacement file for one sound key and upserts its DB row —
 * admin-only, enforced by both 0084's storage RLS and its sound_overrides
 * RLS (a non-admin's call here fails at the storage upload step already).
 * Every upload gets a FRESH, uniquely-named object
 * (`{soundKey}/{uuid}.{ext}`, the map-art precedent) rather than a fixed
 * path replaced in place — see 0084's own storage_ref column comment for
 * why a reused path is the wrong shape here (soundManager.ts's bufferCache
 * is keyed by URL string for the whole page lifetime). Re-uploading for a
 * key that already has an override therefore leaves the previous object
 * orphaned in storage, the same accepted posture
 * campaign_monster_template_overrides' own doc comment describes for its
 * previously-linked custom asset.
 */
export async function setSoundOverride(supabase: SupabaseClient, soundKey: string, file: File): Promise<SoundOverride> {
  const rawExt = file.name.includes(".") ? file.name.split(".").pop() : undefined;
  const ext = rawExt && /^[a-zA-Z0-9]+$/.test(rawExt) ? rawExt.toLowerCase() : "bin";
  const path = `${soundKey}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(SOUND_OVERRIDES_BUCKET)
    .upload(path, file, { contentType: file.type || "audio/mpeg", upsert: false });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from("sound_overrides")
    .upsert({ sound_key: soundKey, storage_ref: path, updated_at: new Date().toISOString() }, { onConflict: "sound_key" })
    .select()
    .single();
  if (error) throw error;
  return data as SoundOverride;
}

/**
 * Removes a key's override row ("reset to default") — admin-only via
 * 0084's DELETE policy. soundManager.ts's very next real playback call for
 * this key falls straight back to SP1's baked default file; the
 * now-unreferenced storage object is left in place rather than requiring a
 * second admin-only delete-from-storage call (same orphan-is-fine posture
 * as setSoundOverride's re-upload case above).
 */
export async function deleteSoundOverride(supabase: SupabaseClient, soundKey: string): Promise<void> {
  const { error } = await supabase.from("sound_overrides").delete().eq("sound_key", soundKey);
  if (error) throw error;
}
