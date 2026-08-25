import type { SupabaseClient } from "@supabase/supabase-js";

export interface CombatEncounter {
  id: string;
  campaign_id: string;
  round_number: number;
  current_turn_index: number;
  started_at: string;
  ended_at: string | null;
}

/**
 * One combatant per token present on the live map when combat started.
 * character_id/npc_name are seeding-time snapshots of the source token's
 * PC-xor-NPC pair (0019's shape, mirrored by 0027's CHECK), so the row
 * stays meaningful even if the token later leaves the live map. initiative
 * is null until entered — manual entry only until Prompt 48 wires the dice
 * roller in.
 */
export interface CombatCombatant {
  id: string;
  encounter_id: string;
  token_id: string;
  character_id: string | null;
  npc_name: string | null;
  initiative: number | null;
  created_at: string;
}

export async function getActiveCombatEncounter(
  supabase: SupabaseClient,
  campaignId: string
): Promise<CombatEncounter | null> {
  const { data, error } = await supabase
    .from("combat_encounters")
    .select()
    .eq("campaign_id", campaignId)
    .is("ended_at", null)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Rows come back in turn order — the same `initiative desc nulls last,
 * created_at, id` ordering advance_turn's current-combatant lookup uses
 * (0027) — so `encounter.current_turn_index` indexes directly into this
 * array.
 */
export async function listCombatCombatants(
  supabase: SupabaseClient,
  encounterId: string
): Promise<CombatCombatant[]> {
  const { data, error } = await supabase
    .from("combat_combatants")
    .select()
    .eq("encounter_id", encounterId)
    .order("initiative", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * DM-only (the RPC checks is_campaign_dm). Creates the encounter and seeds
 * one combatant per token on the live map at this instant; throws with the
 * RPC's specific message if combat is already in progress, there's no live
 * map, or the live map has no tokens. Returns the new encounter's id.
 */
export async function startCombat(supabase: SupabaseClient, campaignId: string): Promise<string> {
  const { data, error } = await supabase.rpc("start_combat", { p_campaign_id: campaignId });
  if (error) throw error;
  return data as string;
}

/**
 * Allowed for the DM or the owner of the CURRENT combatant's character —
 * a cross-row check only the RPC can express; anyone else's call throws.
 * The RPC's row lock makes the pointer move exactly one step per call,
 * wrapping to 0 and incrementing round_number past the last combatant.
 */
export async function advanceTurn(supabase: SupabaseClient, encounterId: string): Promise<void> {
  const { error } = await supabase.rpc("advance_turn", { p_encounter_id: encounterId });
  if (error) throw error;
}

/** DM-only (the RPC checks is_campaign_dm); idempotent if nothing is active. */
export async function endCombat(supabase: SupabaseClient, campaignId: string): Promise<void> {
  const { error } = await supabase.rpc("end_combat", { p_campaign_id: campaignId });
  if (error) throw error;
}

/**
 * Allowed for the DM or the combatant's owning player via plain RLS (0027)
 * — no RPC, since a single combatant's initiative has no cross-row
 * atomicity concern the way the shared turn pointer does. An NPC combatant
 * has no owner, so its initiative is DM-only by construction.
 */
export async function setCombatantInitiative(
  supabase: SupabaseClient,
  combatantId: string,
  initiative: number
): Promise<CombatCombatant> {
  const { data, error } = await supabase
    .from("combat_combatants")
    .update({ initiative })
    .eq("id", combatantId)
    .select()
    .single();

  if (error) throw error;
  return data;
}
