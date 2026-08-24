import type { SupabaseClient } from "@supabase/supabase-js";

/** Disambiguates avatar_ref: a preset id from the generated manifest, or a
 * storage object path in the avatars bucket. */
export type AvatarSource = "preset" | "custom";

export interface Profile {
  id: string;
  display_name: string | null;
  avatar_source: AvatarSource | null;
  avatar_ref: string | null;
  created_at: string;
}

export async function getProfile(supabase: SupabaseClient, userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select()
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** A profile counts as "complete" once it has a non-empty display name. */
export function isProfileComplete(profile: Profile | null): boolean {
  return !!profile?.display_name?.trim();
}

export async function upsertProfile(
  supabase: SupabaseClient,
  userId: string,
  fields: { displayName: string }
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .upsert({ id: userId, display_name: fields.displayName.trim() });

  if (error) throw error;
}

export async function setProfileAvatar(
  supabase: SupabaseClient,
  userId: string,
  selection: { source: AvatarSource; ref: string }
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ avatar_source: selection.source, avatar_ref: selection.ref })
    .eq("id", userId);

  if (error) throw error;
}

/**
 * Uploads a custom avatar to the avatars bucket and returns the object path
 * to store as avatar_ref. One fixed path per user, replaced in place — a
 * player has exactly one custom avatar, and this avoids orphaned objects
 * accumulating on re-upload.
 */
export async function uploadAvatarFile(
  supabase: SupabaseClient,
  userId: string,
  file: File
): Promise<string> {
  const path = `${userId}/avatar.glb`;
  const { error } = await supabase.storage
    .from("avatars")
    .upload(path, file, { contentType: "model/gltf-binary", upsert: true });

  if (error) throw error;
  return path;
}
