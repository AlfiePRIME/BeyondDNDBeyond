import type { SupabaseClient } from "@supabase/supabase-js";

// Opportunity attacks (Prompt 54): the mover's client detects candidates
// right after a tracked move (the rules engine's computeOpportunityAttacks
// over positions/reach/reaction state the Game Room already holds) and
// records one row per qualifying hostile; the REACTOR's controller — the
// DM for an NPC, the owning player for a PC — resolves it as taken (the
// app fires a normal kind:"attack" roll and marks reaction_used) or
// declined (reaction left untouched). Its own table rather than a reuse
// of action_overrides: an override is a rule-bend permission grant with a
// DM-verdict step, this is a reactive attack offer resolved by the
// reactor's controller — the "exhaustion is distinct from on/off
// conditions" precedent — but the RLS/postgres_changes plumbing mirrors
// 0033's shape (see 0035_opportunity_attacks.sql).

export type OpportunityAttackStatus = "pending" | "taken" | "declined";

export interface OpportunityAttack {
  id: string;
  campaign_id: string;
  encounter_id: string;
  /** The combatant whose move provoked the attack — the swing's target. */
  mover_combatant_id: string;
  /** The hostile combatant offered the reaction. */
  reactor_combatant_id: string;
  status: OpportunityAttackStatus;
  created_at: string;
  resolved_at: string | null;
}

/**
 * Records one pending offer per qualifying reactor for a single provoking
 * move — a plain batch insert under the members-may-insert policy (any
 * member may be the mover; a spurious row grants the inserter nothing but
 * a declinable prompt for someone else). Returns the created rows; []
 * for an empty candidate list without touching the network.
 */
export async function createOpportunityAttacks(
  supabase: SupabaseClient,
  params: {
    campaignId: string;
    encounterId: string;
    moverCombatantId: string;
    reactorCombatantIds: readonly string[];
  }
): Promise<OpportunityAttack[]> {
  if (params.reactorCombatantIds.length === 0) return [];
  const { data, error } = await supabase
    .from("opportunity_attacks")
    .insert(
      params.reactorCombatantIds.map((reactorCombatantId) => ({
        campaign_id: params.campaignId,
        encounter_id: params.encounterId,
        mover_combatant_id: params.moverCombatantId,
        reactor_combatant_id: reactorCombatantId,
      }))
    )
    .select();

  if (error) throw error;
  return (data ?? []) as OpportunityAttack[];
}

/** Every offer in an encounter, oldest first — the prompt banners render
 * the still-pending subset in the order the moves happened. */
export async function listOpportunityAttacks(
  supabase: SupabaseClient,
  encounterId: string
): Promise<OpportunityAttack[]> {
  const { data, error } = await supabase
    .from("opportunity_attacks")
    .select()
    .eq("encounter_id", encounterId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw error;
  return (data ?? []) as OpportunityAttack[];
}

/**
 * Resolves a pending offer to taken or declined (+resolved_at) — a plain
 * update under the reactor's-controller policy (DM, or the owner of the
 * reactor combatant's character). The explicit status='pending' filter is
 * the resolveOverride arrangement: a raced double-resolve (or a
 * non-controller's attempt, which RLS filters to zero rows) surfaces as
 * "no row updated" here — .single() throws — rather than silently
 * matching nothing. Declining deliberately touches nothing else; TAKING
 * is the caller's two-step (mark reaction_used, then this), since the
 * reaction is spent by the swing itself, not by the bookkeeping.
 */
export async function resolveOpportunityAttack(
  supabase: SupabaseClient,
  opportunityAttackId: string,
  taken: boolean
): Promise<OpportunityAttack> {
  const { data, error } = await supabase
    .from("opportunity_attacks")
    .update({
      status: taken ? "taken" : "declined",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", opportunityAttackId)
    .eq("status", "pending")
    .select()
    .single();

  if (error) throw error;
  return data as OpportunityAttack;
}

/**
 * Fires `handler` with each inserted OR updated offer row in the campaign
 * — subscribeToActionOverrides' exact postgres_changes shape (NOT the
 * room's campaign-channel broadcast), for the same reason: the mover and
 * the reactor's controller may be on different pages entirely, and both
 * the prompt landing and its resolution must reach every open surface.
 * Updates matter as much as inserts (taken/declined make the banner
 * disappear), hence event "*". Visibility rides the members-only SELECT
 * policy.
 */
export function subscribeToOpportunityAttacks(
  supabase: SupabaseClient,
  campaignId: string,
  handler: (opportunityAttack: OpportunityAttack) => void
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
      .channel(`opportunity-attacks:${campaignId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "opportunity_attacks",
          filter: `campaign_id=eq.${campaignId}`,
        },
        (payload) => handler(payload.new as OpportunityAttack)
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}
