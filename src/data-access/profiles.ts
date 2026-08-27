import type { SupabaseClient } from "@supabase/supabase-js";

/** Disambiguates avatar_ref: a preset id from the generated manifest, or a
 * storage object path in the avatars bucket. */
export type AvatarSource = "preset" | "custom";

/**
 * One Game Room panel's persisted layout (Phase B of the UI overhaul) — the
 * only shape stored inside ui_preferences.panelLayout. Position is always
 * the panel's top-left corner in viewport pixels; `collapsed` hides the
 * panel's body while its header/drag-handle stays visible.
 */
export interface PanelLayoutEntry {
  x: number;
  y: number;
  collapsed: boolean;
}

/**
 * profiles.ui_preferences' only schema (0040) — schemaless jsonb otherwise,
 * the behavior_config/roll_log.breakdown convention: the app layer defines
 * the real shape, not the database. `panelLayout` is keyed by the stable
 * panel ids DraggablePanel/GameRoom use (see
 * src/app/campaigns/[id]/room/DraggablePanel.tsx's PanelId) — deliberately
 * NOT namespaced per-campaign, so a user's layout follows them into every
 * campaign and session. A key may be absent (never dragged/collapsed yet);
 * DraggablePanel's layout context supplies that panel's hardcoded default
 * in that case.
 */
export interface UiPreferences {
  panelLayout: Record<string, PanelLayoutEntry>;
}

export interface Profile {
  id: string;
  display_name: string | null;
  avatar_source: AvatarSource | null;
  avatar_ref: string | null;
  created_at: string;
  ui_preferences: UiPreferences;
  /** AI Backend & Admin D1 — deployment-wide app-admin flag, gating
   * app_settings (0072). Auto-granted, never auto-revoked; see
   * maybeGrantAdmin below. */
  is_admin: boolean;
}

export async function getProfile(supabase: SupabaseClient, userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select()
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  if (data) await maybeGrantAdmin(supabase, userId, data);
  return data;
}

// Per-request cache of the calling session's own user, keyed by SupabaseClient
// instance (never by user id — see the module-header comment on
// createServerSupabaseClient/createBrowserSupabaseClient: a client is always
// fresh-per-request, never a shared singleton, so a WeakMap keyed on the
// instance itself cannot leak one user's identity into another request; it's
// simply garbage-collected once that request's client goes out of scope).
// This exists purely so getProfile's admin check (below) costs one auth
// round trip per request, not one per profile fetched — the Game Room roster
// (room/page.tsx) calls getProfile once per campaign member in a loop, all
// against the same client instance.
const sessionUserCache = new WeakMap<
  SupabaseClient,
  Promise<{ id: string; email: string | null } | null>
>();

function getSessionUserCached(supabase: SupabaseClient) {
  let cached = sessionUserCache.get(supabase);
  if (!cached) {
    // getUser() specifically, NOT getSession(): this file's own realtime
    // subscriptions below use getSession() for propagating the access token
    // to the realtime socket, which is fine there (no authorization decision
    // is being made — the token is just being handed to the socket that will
    // itself enforce RLS). This call instead GATES a privilege grant, in
    // server-side code — Supabase's own guidance is explicit that
    // getSession() must never be trusted for an authorization decision on
    // the server, since it only decodes the locally-stored JWT without
    // asking the Auth server to confirm it's genuine; getUser() does that
    // round trip. The extra network call is deliberately accepted here for
    // that reason, mitigated by the cache above.
    cached = supabase.auth.getUser().then(({ data }) =>
      data.user ? { id: data.user.id, email: data.user.email ?? null } : null
    );
    sessionUserCache.set(supabase, cached);
  }
  return cached;
}

/**
 * AI Backend & Admin D1's admin auto-grant. Runs inline on every getProfile
 * call — the natural, already-broadly-called place per that prompt's own
 * design note, since there's no centralized post-authentication hook
 * anywhere in this app (proxy.ts's middleware only refreshes sessions).
 *
 * Cheap and grant-only by construction:
 * - An already-admin row returns immediately — the ONLY work done for it is
 *   the `profile.is_admin` check itself, a true no-op.
 * - No ADMIN_EMAIL configured short-circuits identically, before ever
 *   touching the session.
 * - getProfile is also called for OTHER members' profiles (the Game Room
 *   roster) — the grant only ever applies when the CALLER's own session
 *   belongs to the exact row being fetched (`user.id === userId`), so
 *   fetching another member's profile can never mutate THEIR is_admin based
 *   on the caller's own session/email.
 * - Never revokes: this only ever flips is_admin from false to true, and the
 *   UPDATE itself is additionally scoped to `is_admin = false`, so it's a
 *   correct no-op even under a rare concurrent double call, and changing or
 *   unsetting ADMIN_EMAIL later can never strip a grant already made (this
 *   code path simply never runs for an already-admin row).
 * - A failure here is logged, not thrown: granting admin is a side effect
 *   layered onto a read, not getProfile's primary contract, so a transient
 *   auth/write failure shouldn't take down every page that calls getProfile.
 *
 * Known limitation, deliberately out of this prompt's scope: this relies on
 * profiles' existing self-row UPDATE policy (0001), which has no column-level
 * restriction, so it enforces "grant-only" and "correct email" in
 * application code rather than in Postgres — RLS has no visibility into this
 * Node process's ADMIN_EMAIL to enforce it independently. Closing that gap
 * would need either a service-role write path (deliberately deferred to D3
 * as this track's first use of service-role credentials in real application
 * code) or propagating ADMIN_EMAIL into Postgres config, both out of scope
 * for "schema, the auto-grant mechanism, and RLS only."
 */
async function maybeGrantAdmin(supabase: SupabaseClient, userId: string, profile: Profile): Promise<void> {
  if (profile.is_admin) return;
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!adminEmail) return;

  try {
    const user = await getSessionUserCached(supabase);
    if (!user || user.id !== userId) return;
    if (user.email?.trim().toLowerCase() !== adminEmail) return;

    const { error } = await supabase
      .from("profiles")
      .update({ is_admin: true })
      .eq("id", userId)
      .eq("is_admin", false);
    if (error) throw error;
    profile.is_admin = true;
  } catch (err) {
    console.error("[profiles] admin auto-grant check failed:", err);
  }
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
 * Overwrites the caller's whole ui_preferences document (Phase B) — a plain
 * column write through profiles' existing self-only UPDATE policy (0001),
 * the setProfileAvatar shape exactly. Whole-document replacement, not a
 * per-panel patch: DraggablePanel's layout context holds the full
 * panelLayout map in memory and calls this with the complete, already-
 * merged document, so there's no server-side merge to get wrong and no
 * lost-update risk between two panels' debounced writes racing.
 */
export async function setUiPreferences(
  supabase: SupabaseClient,
  userId: string,
  preferences: UiPreferences
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ ui_preferences: preferences })
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
 * Fires `handler` with the caller's OWN ui_preferences after any update to
 * it, from any tab/device/campaign — the subscribeToCampaignChanges shape
 * (row-filtered via `filter`, rather than subscribeToProfileChanges' filter-
 * everything-client-side approach, since a layout change has no roster to
 * cross-reference) rather than a broadcast: DraggablePanel's layout context
 * is mounted once in GameRoom, and a drag made in a DIFFERENT campaign's
 * room (or the account page, if one is ever added there) must still reach
 * this tab, which no campaign-scoped broadcast channel could ever do. Same
 * deterministic-claims setAuth dance as subscribeToProfileChanges/
 * subscribeToCampaignChanges — required so the subscription joins as the
 * authenticated role and profiles' SELECT policy doesn't silently drop
 * every event.
 */
export function subscribeToUiPreferencesChanges(
  supabase: SupabaseClient,
  userId: string,
  handler: (preferences: UiPreferences) => void
): () => void {
  let removed = false;
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;

  void (async () => {
    const { data } = await supabase.auth.getSession();
    if (removed) return;
    if (data.session) await supabase.realtime.setAuth(data.session.access_token);
    if (removed) return;

    channel = supabase
      .channel(`ui-preferences-changes:${userId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "profiles",
          filter: `id=eq.${userId}`,
        },
        (payload) => handler((payload.new as Profile).ui_preferences)
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
  // Re-wrapped as a Blob with the type we actually want — see
  // uploadMapAssetFile's identical comment in assets.ts: many OSes don't
  // register .glb, so the browser reports the raw File's own `.type` as
  // "application/octet-stream", and storage-js sends THAT rather than the
  // `contentType` option below, which the avatars bucket's MIME allowlist
  // then rejects.
  const glbBlob = new Blob([file], { type: "model/gltf-binary" });
  const { error } = await supabase.storage
    .from("avatars")
    .upload(path, glbBlob, { contentType: "model/gltf-binary", upsert: true });

  if (error) throw error;
  return path;
}
