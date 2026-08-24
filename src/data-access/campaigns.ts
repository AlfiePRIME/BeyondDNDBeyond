import type { SupabaseClient } from "@supabase/supabase-js";

export interface Campaign {
  id: string;
  name: string;
  creator: string;
  invite_code: string;
  session_active: boolean;
  live_map: string | null;
  house_rules: string | null;
  created_at: string;
}

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
