import type { SupabaseClient } from "@supabase/supabase-js";

// DM rule-override control (Prompt 52): a player flags an action blocked
// by a resource/rule restriction, the DM approves or denies it, and an
// approval lets that ONE action fire through its normal roll path before
// being marked consumed. The row is permission + audit trail ONLY — no
// function here (or anywhere) mutates character_resources as part of an
// override; whether a use is still consumed is a separate, explicit DM
// decision made through the existing resource controls.

export type ActionOverrideStatus = "pending" | "approved" | "denied" | "consumed";

export interface ActionOverride {
  id: string;
  campaign_id: string;
  character_id: string;
  requested_by: string;
  /** e.g. "Second Wind" or "Fire Bolt (1st-level slot)". */
  action_label: string;
  /** e.g. "No uses remaining" or "No 1st-level spell slots remaining". */
  reason: string;
  status: ActionOverrideStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

async function sessionUserId(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) throw new Error("Not signed in");
  return userId;
}

/**
 * Flags a blocked action to the DM — a plain insert under the
 * action_overrides INSERT policy (requested_by must be the caller, for a
 * character they own or, as the DM, any character in the campaign).
 */
export async function requestOverride(
  supabase: SupabaseClient,
  campaignId: string,
  characterId: string,
  actionLabel: string,
  reason: string
): Promise<ActionOverride> {
  const userId = await sessionUserId(supabase);
  const { data, error } = await supabase
    .from("action_overrides")
    .insert({
      campaign_id: campaignId,
      character_id: characterId,
      requested_by: userId,
      action_label: actionLabel,
      reason,
    })
    .select()
    .single();

  if (error) throw error;
  return data as ActionOverride;
}

/**
 * The DM's verdict on a pending flag — a plain update to approved/denied
 * plus resolved_by/resolved_at, gated DM-only (and pending-only) by the
 * "the DM resolves a pending override" policy. The explicit
 * status='pending' filter makes a raced double-resolve surface as "no row
 * updated" here rather than silently matching nothing at the RLS layer.
 */
export async function resolveOverride(
  supabase: SupabaseClient,
  overrideId: string,
  approved: boolean
): Promise<ActionOverride> {
  const userId = await sessionUserId(supabase);
  const { data, error } = await supabase
    .from("action_overrides")
    .update({
      status: approved ? "approved" : "denied",
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", overrideId)
    .eq("status", "pending")
    .select()
    .single();

  if (error) throw error;
  return data as ActionOverride;
}

/**
 * Marks an approval spent, once the bypassed action has actually fired.
 * Approved-only, requester-or-DM (the consume policy); the from-approved
 * gate lives in the policy's USING, and Postgres's qual recheck on the
 * locked row makes two racing consumes resolve to exactly one winner —
 * the loser (and any attempt on an already-consumed/denied row) matches
 * zero rows and rejects here, which the UI reads as "needs a fresh flag".
 * Deliberately does NOT touch character_resources — see the module note.
 */
export async function consumeOverride(
  supabase: SupabaseClient,
  overrideId: string
): Promise<ActionOverride> {
  const { data, error } = await supabase
    .from("action_overrides")
    .update({ status: "consumed" })
    .eq("id", overrideId)
    .eq("status", "approved")
    .select()
    .single();

  if (error) throw error;
  return data as ActionOverride;
}

/** Most recent first, the listRollLog arrangement. */
export async function listActionOverrides(
  supabase: SupabaseClient,
  campaignId: string,
  limit = 50
): Promise<ActionOverride[]> {
  const { data, error } = await supabase
    .from("action_overrides")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as ActionOverride[];
}

/**
 * Fires `handler` with each inserted OR updated override row in the
 * campaign — the subscribeToRollLog postgres_changes pattern (NOT the
 * Game Room's campaign-channel broadcast), for the same reason: the
 * character sheet page isn't on that channel, and flags/verdicts must
 * reach every open surface regardless of which page wrote them. Updates
 * matter as much as inserts here (approved/denied/consumed are all
 * transitions), hence event "*". Visibility rides the members-only SELECT
 * policy.
 */
export function subscribeToActionOverrides(
  supabase: SupabaseClient,
  campaignId: string,
  handler: (override: ActionOverride) => void
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
      .channel(`action-overrides:${campaignId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "action_overrides",
          filter: `campaign_id=eq.${campaignId}`,
        },
        (payload) => handler(payload.new as ActionOverride)
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}
