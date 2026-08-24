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
 * Signed download URL for a custom avatar object. The avatars bucket is
 * private (getPublicUrl would 400), so reads go through a signed URL minted
 * under the caller's session — the bucket's RLS lets any authenticated user
 * read any avatar object. Known limitation: the URL expires after
 * `expiresInSeconds` with no refresh; long-lived Game Room tabs past that
 * window fall back to the placeholder until reload.
 */
export async function getAvatarSignedUrl(
  supabase: SupabaseClient,
  path: string,
  expiresInSeconds: number
): Promise<string> {
  const { data, error } = await supabase.storage
    .from("avatars")
    .createSignedUrl(path, expiresInSeconds);

  if (error) throw error;
  return data.signedUrl;
}

/**
 * Fires `handler` with the new row whenever any profile row is updated,
 * from any client/tab/device — a postgres_changes subscription on the
 * profiles table (added to the supabase_realtime publication in migration
 * 0012), not the realtime module's campaign-scoped presence/broadcast bus.
 * That distinction is why it lives here: presence only reflects clients
 * actively connected to a specific channel, but "the /account page in some
 * other tab changed a row everyone is looking at" is a database-level
 * concern, and data-access owns the Supabase touchpoints.
 */
export function subscribeToProfileChanges(
  supabase: SupabaseClient,
  handler: (profile: Pick<Profile, "id" | "display_name" | "avatar_source" | "avatar_ref">) => void
): () => void {
  let removed = false;
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;

  void (async () => {
    // The browser client loads its session asynchronously — subscribing
    // before the access token reaches the realtime socket joins as the anon
    // role, and the authenticated-only profiles RLS policy then silently
    // filters out every change event. Applying the token explicitly first
    // makes the subscription's claims deterministic.
    const { data } = await supabase.auth.getSession();
    if (removed) return;
    if (data.session) await supabase.realtime.setAuth(data.session.access_token);
    if (removed) return;

    // Random topic suffix so this never collides with (or gets deduped
    // against) another subscription on the same client.
    channel = supabase
      .channel(`profile-changes:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "profiles" },
        (payload) => handler(payload.new as Profile)
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
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
