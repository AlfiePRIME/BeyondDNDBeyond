import type { SupabaseClient } from "@supabase/supabase-js";

export interface Campaign {
  id: string;
  name: string;
  creator: string;
  invite_code: string;
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
 * Transfers the DM role to a different, existing member — a shared function
 * callable from anywhere authorized to initiate a handoff, not just the
 * Transfer DM UI button here. Prompt 22's lobby session-start flow calls
 * this same function later.
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
