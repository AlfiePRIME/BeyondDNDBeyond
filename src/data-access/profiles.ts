import type { SupabaseClient } from "@supabase/supabase-js";

export interface Profile {
  id: string;
  display_name: string | null;
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
