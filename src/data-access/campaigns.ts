import type { SupabaseClient } from "@supabase/supabase-js";
import type { Character } from "./characters";

export interface Campaign {
  id: string;
  name: string;
  creator: string;
  invite_code: string;
  session_active: boolean;
  /** Real start time of the CURRENTLY OPEN session (Chat & Summary B6) — set
   * by startSession on every successful start (fresh or reclaimed), left
   * untouched by pauseSession/resumeSession so a break never resets or
   * splits the window, and cleared back to null by endSession. Null means
   * "no session currently open" — never started, or already ended. A
   * session's AI-summary window is [session_started_at as read at end time,
   * "now" at that same moment), regardless of any pauses in between. */
  session_started_at: string | null;
  live_map: string | null;
  house_rules: string | null;
  /** Strict (default) hard-blocks over-budget actions/movement in combat;
   * Freeform only tracks and displays usage (Prompt 53). */
  action_economy_strict: boolean;
  /** Purely cosmetic 3D-table lighting preset (Phase 2 of the Game Room
   * ambiance plan) — unrelated to the per-cell vision/light-level system. */
  day_night_mode: DayNightMode;
  /** Current campaign weather (Weather & Enemies C1), the day/night-mode
   * shape exactly: a plain campaigns column, DM-only at the RLS layer via
   * the same blanket UPDATE policy. Only 'clear' and 'fog' render anything
   * as of C1 — rain/thunderstorm/firestorm/acid_storm are reserved values
   * later prompts (C2-C4) build their own visual effects on top of.
   * 'cloudy' (migration 0079_cloudy_weather.sql) is a later addition: a
   * purely atmospheric overcast sky (GameTableScene's CloudLayer), with
   * zero effect on ground-level visibility or fog — see that migration's
   * own comment for the full 'cloudy' vs 'fog' distinction. */
  weather_kind: WeatherKind;
  /** Only meaningful for 'firestorm'/'acid_storm' (C4): whether the DM's
   * periodic-damage timer is armed for the current weather. Always false
   * (and inert) for every other weather_kind, including this prompt's own
   * 'clear'/'fog'. */
  weather_mechanical: boolean;
  /** Last time Weather & Enemies C4's periodic-damage timer actually
   * applied a tick (written only by the apply_weather_tick RPC, never
   * directly by setWeather) -- null before the first tick of the current
   * mechanical activation, or whenever setWeather has run since (it always
   * resets this to null, so a stale timestamp from an earlier activation
   * can never make a fresh one look "already due" -- see setWeather's own
   * doc comment). Not read anywhere on the client; purely apply_weather_
   * tick's own dedup bookkeeping (see migration 0071's comment for the
   * full design), included here since campaigns.* is one shared row shape. */
  weather_last_tick_at: string | null;
  created_at: string;
}

export type DayNightMode = "day" | "night";

export type WeatherKind = "clear" | "fog" | "cloudy" | "rain" | "thunderstorm" | "firestorm" | "acid_storm";

export type CampaignRole = "dm" | "player";

export interface CampaignMembership {
  role: CampaignRole;
  campaign: Campaign;
}

export async function listCampaignsForUser(
  supabase: SupabaseClient,
  userId: string
): Promise<CampaignMembership[]> {
  const { data, error } = await supabase
    .from("campaign_members")
    .select("role, campaign:campaigns(*)")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true });

  if (error) throw error;
  // Supabase's embedded-resource typing infers an array even for a
  // to-one relationship; campaign_id -> campaigns.id is one-to-one here.
  return (data ?? []) as unknown as CampaignMembership[];
}

/**
 * Creates a campaign and adds the creator as its DM. Returns the created
 * campaign (with its generated id and invite_code).
 *
 * Deliberately doesn't use .insert().select() for the campaign row — see
 * the README's "Database migrations" section on why INSERT...RETURNING
 * fails here (campaigns' SELECT policy needs the campaign_members row this
 * function inserts next, so RETURNING would run before that row exists).
 */
export async function createCampaign(
  supabase: SupabaseClient,
  params: { name: string; creatorId: string }
): Promise<Campaign> {
  const campaignId = crypto.randomUUID();

  const { error: campaignError } = await supabase
    .from("campaigns")
    .insert({ id: campaignId, name: params.name, creator: params.creatorId });
  if (campaignError) throw campaignError;

  const { error: memberError } = await supabase
    .from("campaign_members")
    .insert({ campaign_id: campaignId, user_id: params.creatorId, role: "dm" });
  if (memberError) throw memberError;

  const { data, error: fetchError } = await supabase
    .from("campaigns")
    .select()
    .eq("id", campaignId)
    .single();
  if (fetchError) throw fetchError;

  return data;
}

export async function joinCampaignByInviteCode(
  supabase: SupabaseClient,
  inviteCode: string
): Promise<{ campaignId: string; campaignName: string }> {
  const { data, error } = await supabase
    .rpc("join_campaign_by_invite_code", { p_invite_code: inviteCode })
    .single();

  if (error) {
    if (error.message.includes("Invalid invite code")) {
      throw new Error("That invite code doesn't match any campaign.");
    }
    throw error;
  }

  const row = data as { result_campaign_id: string; result_campaign_name: string };
  return { campaignId: row.result_campaign_id, campaignName: row.result_campaign_name };
}

/**
 * DM-only, enforced by campaigns' UPDATE RLS policy (0011). Postgres
 * reports an RLS-blocked UPDATE as success with zero rows affected rather
 * than an error (verified against the local stack), so the affected count
 * is checked explicitly — a non-DM's attempt throws instead of silently
 * no-oping.
 */
export async function renameCampaign(
  supabase: SupabaseClient,
  campaignId: string,
  name: string
): Promise<void> {
  const { error, count } = await supabase
    .from("campaigns")
    .update({ name: name.trim() }, { count: "exact" })
    .eq("id", campaignId);

  if (error) throw error;
  if (count === 0) throw new Error("Only the campaign's DM can rename it.");
}

/**
 * DM-only, enforced by campaigns' DELETE RLS policy (0011) — same
 * zero-rows-affected detection as renameCampaign. Campaign-scoped rows
 * (campaign_members, characters, character_resources) go with it via the
 * existing ON DELETE CASCADE foreign keys.
 */
export async function deleteCampaign(supabase: SupabaseClient, campaignId: string): Promise<void> {
  const { error, count } = await supabase
    .from("campaigns")
    .delete({ count: "exact" })
    .eq("id", campaignId);

  if (error) throw error;
  if (count === 0) throw new Error("Only the campaign's DM can delete it.");
}

/**
 * Removes the caller's own membership row. Players only: campaign_members'
 * DELETE policy (0011) blocks a DM from leaving — that would orphan the
 * campaign with zero DMs — so a DM transfers the role first or deletes the
 * campaign. Zero rows affected means the caller is the DM (or not a member
 * at all).
 */
export async function leaveCampaign(
  supabase: SupabaseClient,
  campaignId: string,
  userId: string
): Promise<void> {
  const { error, count } = await supabase
    .from("campaign_members")
    .delete({ count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", userId);

  if (error) throw error;
  if (count === 0) {
    throw new Error("A DM can't leave their own campaign — transfer the DM role or delete it instead.");
  }
}

export interface CampaignMember {
  user_id: string;
  role: CampaignRole;
  display_name: string | null;
}

/**
 * Reusable "is this user the DM of this campaign" check — every DM-gated UI
 * or action in later prompts (map editor, initiative control, NPC tools,
 * the rule-override/action-economy controls, vision bypass, account page
 * campaign management, the lobby's session-start flow, narrative tools)
 * should call this rather than re-deriving DM status inline.
 */
export async function isDM(supabase: SupabaseClient, campaignId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("campaign_members")
    .select("role")
    .eq("campaign_id", campaignId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data?.role === "dm";
}

export async function listCampaignMembers(
  supabase: SupabaseClient,
  campaignId: string
): Promise<CampaignMember[]> {
  const { data, error } = await supabase
    .from("campaign_members")
    .select("user_id, role, profile:profiles(display_name)")
    .eq("campaign_id", campaignId)
    .order("joined_at", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => {
    const r = row as unknown as { user_id: string; role: CampaignRole; profile: { display_name: string | null } | null };
    return { user_id: r.user_id, role: r.role, display_name: r.profile?.display_name ?? null };
  });
}

/**
 * Marks the campaign's session as active and makes the caller its DM
 * (demoting the previous DM if that's someone else) — any member may call
 * this, unlike transferDM. Throws with the RPC's specific message when a
 * session is already in progress. `reclaimAbandoned` skips that guard: pass
 * it only after verifying via Realtime presence that the "active" session's
 * room is actually empty (a crashed last member leaves the flag stranded,
 * and Postgres can't see presence to clear it itself).
 */
export async function startSession(
  supabase: SupabaseClient,
  campaignId: string,
  options?: { reclaimAbandoned?: boolean }
): Promise<void> {
  const { error } = await supabase.rpc("start_session", {
    p_campaign_id: campaignId,
    p_reclaim_abandoned: options?.reclaimAbandoned ?? false,
  });
  if (error) throw error;
}

/**
 * DM-only (the RPC checks is_campaign_dm). Idempotent — ending an
 * already-ended session is a no-op, since the last-leaver courtesy cleanup
 * and an explicit End Session click can race.
 */
export async function endSession(supabase: SupabaseClient, campaignId: string): Promise<void> {
  const { error } = await supabase.rpc("end_session", { p_campaign_id: campaignId });
  if (error) throw error;
}

/**
 * DM-only (the RPC checks is_campaign_dm), Chat & Summary B6: a genuine
 * break, distinct from endSession — stops the same "live" signal endSession
 * stops (session_active), but leaves session_started_at untouched, so the
 * session's summary-eligible window keeps its original start and a pause
 * never triggers a summary. Idempotent: pausing an already-paused (or never
 * started) session is a no-op, not an error, matching endSession's own
 * race-tolerant convention.
 */
export async function pauseSession(supabase: SupabaseClient, campaignId: string): Promise<void> {
  const { error } = await supabase.rpc("pause_session", { p_campaign_id: campaignId });
  if (error) throw error;
}

/**
 * DM-only, the pauseSession counterpart: turns the live signal back on for
 * the SAME session (session_started_at is left exactly as pauseSession left
 * it) — a later endSession's summary still covers the entire span from the
 * original startSession call. Throws when there is no paused session to
 * resume (never started, or already properly ended via endSession).
 */
export async function resumeSession(supabase: SupabaseClient, campaignId: string): Promise<void> {
  const { error } = await supabase.rpc("resume_session", { p_campaign_id: campaignId });
  if (error) throw error;
}

/**
 * DM-only, enforced by campaigns' existing UPDATE RLS policy (0011) — same
 * zero-rows-affected detection as renameCampaign. House rules live directly
 * on campaigns (Prompt 32) rather than a separate table: the existing
 * member-readable SELECT policy and DM-only UPDATE policy already match
 * exactly what a single "visible to all, writable only by the DM" text field
 * needs.
 */
export async function setHouseRules(supabase: SupabaseClient, campaignId: string, houseRules: string): Promise<void> {
  const { error, count } = await supabase
    .from("campaigns")
    .update({ house_rules: houseRules }, { count: "exact" })
    .eq("id", campaignId);

  if (error) throw error;
  if (count === 0) throw new Error("Only the campaign's DM can update house rules.");
}

/**
 * Flips the campaign between Strict and Freeform action-economy
 * enforcement (Prompt 53) — the setHouseRules shape exactly: a plain
 * column write through campaigns' existing UPDATE RLS with the same
 * zero-rows-affected detection, DM-only at the UI layer per the
 * house_rules/live_map precedent. Live sync rides
 * subscribeToCampaignChanges below, not the room's broadcast channel.
 */
export async function setActionEconomyStrict(
  supabase: SupabaseClient,
  campaignId: string,
  strict: boolean
): Promise<void> {
  const { error, count } = await supabase
    .from("campaigns")
    .update({ action_economy_strict: strict }, { count: "exact" })
    .eq("id", campaignId);

  if (error) throw error;
  if (count === 0) throw new Error("Only the campaign's DM can change action-economy enforcement.");
}

/**
 * Flips the campaign's 3D-table lighting preset (Phase 2 of the Game Room
 * ambiance plan) — the setActionEconomyStrict/setHouseRules shape exactly:
 * a plain column write through campaigns' existing UPDATE RLS with the
 * same zero-rows-affected detection. No new policy needed: campaigns has a
 * single blanket UPDATE policy (0011, "the DM can update their campaign",
 * gated on is_campaign_dm) that already covers every column on the row,
 * this one included — confirmed directly against the running database
 * (verify-day-night-mode.mjs), not assumed. So despite the "DM-only is a
 * UI concern" framing on some of this file's older sibling functions, this
 * one is DM-only at BOTH layers, same as renameCampaign/setHouseRules: a
 * non-DM's direct write returns zero rows affected, same as theirs. Live
 * sync rides subscribeToCampaignChanges below, same as
 * action_economy_strict. Purely cosmetic: unrelated to the per-cell
 * vision/light-level system.
 */
export async function setDayNightMode(
  supabase: SupabaseClient,
  campaignId: string,
  mode: DayNightMode
): Promise<void> {
  const { error, count } = await supabase
    .from("campaigns")
    .update({ day_night_mode: mode }, { count: "exact" })
    .eq("id", campaignId);

  if (error) throw error;
  if (count === 0) throw new Error("Only the campaign's DM can change the table's lighting.");
}

/**
 * Sets the campaign's current weather (Weather & Enemies C1) — the
 * setDayNightMode shape exactly: a plain column write through campaigns'
 * existing UPDATE RLS (0011, DM-only) with the same zero-rows-affected
 * detection, no new policy needed. `mechanical` is only meaningful for
 * 'firestorm'/'acid_storm' (C4's periodic-damage toggle) but is always
 * written alongside `kind` — the DM's book presents both as one control, and
 * a stale mechanical flag left on from a previous firestorm should never
 * silently survive a switch to a weather kind it doesn't apply to. Live sync
 * rides subscribeToCampaignChanges below, same as day_night_mode.
 *
 * Also always resets weather_last_tick_at to null (C4) — every call here is
 * either a genuine weather CHANGE or an explicit mechanical on/off flip, and
 * either way the periodic-damage timer's "last applied" clock should start
 * clean: a stale timestamp surviving from an earlier activation (possibly
 * hours old) must never make a freshly re-armed timer look "overdue" for
 * apply_weather_tick, and a switch away from firestorm/acid_storm entirely
 * must leave nothing behind that a later switch BACK could pick back up.
 */
export async function setWeather(
  supabase: SupabaseClient,
  campaignId: string,
  kind: WeatherKind,
  mechanical: boolean
): Promise<void> {
  const { error, count } = await supabase
    .from("campaigns")
    .update({ weather_kind: kind, weather_mechanical: mechanical, weather_last_tick_at: null }, { count: "exact" })
    .eq("id", campaignId);

  if (error) throw error;
  if (count === 0) throw new Error("Only the campaign's DM can change the weather.");
}

/**
 * Resolves one tick of firestorm/acid_storm's optional periodic damage
 * (Weather & Enemies C4) via the apply_weather_tick RPC (migration 0071) —
 * the ONE authoritative path that ever advances weather_last_tick_at and
 * applies HP loss, so two nearly-simultaneous callers (the same DM open in
 * two tabs, a fresh page-reload's timer racing the tab it replaced) can
 * never double-apply a single tick; see the RPC's own migration comment for
 * the full design.
 *
 * DM-only (the RPC raises if the caller isn't the campaign's DM) — called
 * ONLY from GameRoom.tsx's own periodic-tick effect, itself gated on
 * currentUserIsDM, matching the existing DM-client-resolves-authoritatively
 * model already used for step-on triggers and concealed-pit fall damage
 * (handleTokenLanded). Returns the characters actually damaged — empty
 * when a tick wasn't due yet, or the weather stopped being mechanical
 * underneath the caller (the RPC re-checks the DB, not this client's own
 * possibly-stale React state). GameRoom treats a non-empty result as "a
 * real tick just landed": it refreshes its own character rows and pokes
 * every other connected client via the same COMBAT_EVENT broadcast fall
 * damage already uses, since apply_hp_delta's writes reach no
 * postgres_changes feed of their own.
 */
export async function applyWeatherTick(supabase: SupabaseClient, campaignId: string): Promise<Character[]> {
  const { data, error } = await supabase.rpc("apply_weather_tick", { p_campaign_id: campaignId });
  if (error) throw error;
  return (data ?? []) as Character[];
}

/**
 * Fires `handler` with the campaign's row after each UPDATE — the
 * subscribeToProfileChanges postgres_changes shape (campaigns joined the
 * supabase_realtime publication in 0034), row-filtered to this campaign,
 * visibility riding the members-only SELECT policy. Added for the
 * action-economy strictness toggle: every connected player must see a
 * mid-combat mode flip live, and no postgres_changes feed on campaigns
 * existed before (live_map changes travel by broadcast instead).
 */
export function subscribeToCampaignChanges(
  supabase: SupabaseClient,
  campaignId: string,
  handler: (campaign: Campaign) => void
): () => void {
  let removed = false;
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;

  void (async () => {
    // Same deterministic-claims dance as subscribeToRollLog: without the
    // explicit setAuth, the socket can join as anon and RLS silently
    // drops every event.
    const { data } = await supabase.auth.getSession();
    if (removed) return;
    if (data.session) await supabase.realtime.setAuth(data.session.access_token);
    if (removed) return;

    channel = supabase
      .channel(`campaign-changes:${campaignId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "campaigns",
          filter: `id=eq.${campaignId}`,
        },
        (payload) => handler(payload.new as Campaign)
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}

/**
 * Transfers the DM role to a different, existing member — DM-initiated
 * handoff only (the RPC rejects non-DM callers). The lobby's session-start
 * flow does NOT use this: startSession has member-level authorization and
 * promotes the caller, which is a different auth rule, not a handoff.
 */
export async function transferDM(
  supabase: SupabaseClient,
  campaignId: string,
  newDmUserId: string
): Promise<void> {
  const { error } = await supabase.rpc("transfer_dm", {
    p_campaign_id: campaignId,
    p_new_dm_user_id: newDmUserId,
  });
  if (error) throw error;
}
