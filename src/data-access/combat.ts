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
 * roller in. The five action-economy fields (Prompt 53, plus Prompt 54's
 * disengaged) track this combatant's CURRENT turn's usage and are reset
 * by advance_turn the moment its turn begins.
 */
export interface CombatCombatant {
  id: string;
  encounter_id: string;
  token_id: string;
  character_id: string | null;
  npc_name: string | null;
  initiative: number | null;
  action_used: boolean;
  bonus_action_used: boolean;
  reaction_used: boolean;
  movement_used_feet: number;
  /** Declared Disengage this turn (Prompt 54): provokes no opportunity
   * attacks for the rest of the turn. Set only by declareDisengage
   * (which also spends the action), cleared by advance_turn's reset. */
  disengaged: boolean;
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
 * The character's combatant row in the campaign's currently-active
 * encounter, or null — null covers both "no combat running" and "this
 * character has no token in the fight", which callers treat the same way
 * (nothing combat-scoped to show). The character sheet uses this to
 * resolve which combatant's conditions belong on the sheet, since
 * conditions hang off combat_combatants, not characters.
 */
export async function getActiveCombatantForCharacter(
  supabase: SupabaseClient,
  campaignId: string,
  characterId: string
): Promise<CombatCombatant | null> {
  const { data, error } = await supabase
    .from("combat_combatants")
    .select("*, encounter:combat_encounters!inner(campaign_id, ended_at)")
    .eq("character_id", characterId)
    .eq("encounter.campaign_id", campaignId)
    .is("encounter.ended_at", null)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  // Strip the embedded encounter — it only existed to filter the query.
  const row = data as CombatCombatant;
  return {
    id: row.id,
    encounter_id: row.encounter_id,
    token_id: row.token_id,
    character_id: row.character_id,
    npc_name: row.npc_name,
    initiative: row.initiative,
    action_used: row.action_used,
    bonus_action_used: row.bonus_action_used,
    reaction_used: row.reaction_used,
    movement_used_feet: row.movement_used_feet,
    disengaged: row.disengaged,
    created_at: row.created_at,
  };
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

/** The three on/off action-economy flags (Prompt 53). Movement is NOT
 * here: it accumulates through the move_combat_token RPC, never a direct
 * flag flip. */
export type CombatantEconomyFlag = "action_used" | "bonus_action_used" | "reaction_used";

/**
 * Marks (or, in Freeform mode, un-marks) one action-economy flag — the
 * setCombatantInitiative shape exactly: a plain update through
 * can_write_combatant (0027), DM or the owning player, no RPC since a
 * single boolean flip has no cross-row invariant. The roll route uses it
 * to mark action_used after an attack resolves; the combat panel's manual
 * bonus-action/reaction controls use it directly (nothing consumes those
 * automatically yet — reactions proper are Prompt 54's scope). Strict
 * mode's "can't un-mark until your next turn" is a UI rule, not RLS —
 * matching how the strictness toggle itself is UI-gated.
 */
export async function setCombatantEconomyFlag(
  supabase: SupabaseClient,
  combatantId: string,
  flag: CombatantEconomyFlag,
  used: boolean
): Promise<CombatCombatant> {
  const { data, error } = await supabase
    .from("combat_combatants")
    .update({ [flag]: used })
    .eq("id", combatantId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Declares the Disengage action (Prompt 54): sets `disengaged` AND spends
 * the Action in ONE update, so "disengaged but action still free" can
 * never be observed — which is why this is a small dedicated function
 * rather than a widened setCombatantEconomyFlag (that shape flips exactly
 * one flag per call by design). Same authorization as every economy
 * write: a plain update through can_write_combatant (0027), DM or the
 * owning player, no RPC — a single-row two-column flip has no cross-row
 * invariant. Strict mode's "unavailable once the action is spent" is a
 * UI rule like the other economy locks; advance_turn resets both columns
 * at this combatant's next turn.
 */
export async function declareDisengage(
  supabase: SupabaseClient,
  combatantId: string
): Promise<CombatCombatant> {
  const { data, error } = await supabase
    .from("combat_combatants")
    .update({ disengaged: true, action_used: true })
    .eq("id", combatantId)
    .select()
    .single();

  if (error) throw error;
  return data;
}
