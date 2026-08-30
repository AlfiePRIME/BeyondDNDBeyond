import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConditionKey } from "@/rules-engine";

/**
 * One applied condition on one CHARACTER (0101) — the combat-independent
 * counterpart of conditions.ts' CombatantCondition (0029), same shape
 * re-keyed on character_id. Exists because a combatant_conditions row
 * structurally requires a live combat_combatants row: a character not in
 * the currently active encounter simply could not be poisoned at all
 * before this table. The two tables deliberately coexist rather than one
 * absorbing the other — see 0101's own doc comment for the full
 * reasoning (policy/reader blast radius, the UNIQUE-upsert contract, and
 * the genuinely different lifetimes: combat conditions die with the
 * encounter, these persist until removed).
 *
 * Merge rule every display surface follows (the sheet's Conditions panel,
 * the DM dashboard): union the two sources BY condition_key so a
 * condition present in both shows exactly once; exhaustion shows the
 * higher of the two levels. The dashboard's apply/remove writes BOTH
 * sides while combat is live (this table always, plus the live combatant
 * row when one exists) so in-combat mechanics — which read
 * combatant_conditions only — pick the change up immediately, and the
 * condition still survives the encounter ending.
 */
export interface CharacterCondition {
  id: string;
  character_id: string;
  condition_key: string;
  level: number | null;
  applied_at: string;
}

/** All character-keyed conditions across the given characters (the whole
 * roster for the dashboard, a single-element array for the sheet), in
 * stable applied-at order so badges don't reshuffle between refetches —
 * listCombatantConditions' exact shape. */
export async function listCharacterConditions(
  supabase: SupabaseClient,
  characterIds: string[]
): Promise<CharacterCondition[]> {
  if (characterIds.length === 0) return [];
  const { data, error } = await supabase
    .from("character_conditions")
    .select()
    .in("character_id", characterIds)
    .order("applied_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw error;
  return (data ?? []) as CharacterCondition[];
}

/**
 * Applies an on/off condition directly to the character — owner or DM via
 * plain RLS (0101's can_access_character policies), no RPC, the 0029
 * applyCondition reasoning exactly: one row, no cross-row atomicity, and
 * the UNIQUE-conflict upsert makes re-applying a harmless no-op.
 */
export async function applyCharacterCondition(
  supabase: SupabaseClient,
  characterId: string,
  conditionKey: ConditionKey
): Promise<void> {
  const { error } = await supabase
    .from("character_conditions")
    .upsert(
      { character_id: characterId, condition_key: conditionKey },
      { onConflict: "character_id,condition_key", ignoreDuplicates: true }
    );

  if (error) throw error;
}

/** Same authorization as applyCharacterCondition; removing an absent
 * condition is a harmless no-op (the DELETE just matches nothing). */
export async function removeCharacterCondition(
  supabase: SupabaseClient,
  characterId: string,
  conditionKey: ConditionKey
): Promise<void> {
  const { error } = await supabase
    .from("character_conditions")
    .delete()
    .eq("character_id", characterId)
    .eq("condition_key", conditionKey);

  if (error) throw error;
}

/**
 * Raise (positive) or lower (negative) the character's exhaustion level,
 * clamped to [0, 6], via the apply_character_exhaustion_delta RPC (0101)
 * — applyExhaustionDelta's pattern re-keyed on the character: the new
 * level is computed from the CURRENT stored level under a row lock so two
 * near-simultaneous clicks both land. Returns the new level; 0 means the
 * row was deleted (no exhaustion = no row, consistent with the on/off
 * conditions).
 */
export async function applyCharacterExhaustionDelta(
  supabase: SupabaseClient,
  characterId: string,
  delta: number
): Promise<number> {
  const { data, error } = await supabase.rpc("apply_character_exhaustion_delta", {
    p_character_id: characterId,
    p_delta: delta,
  });

  if (error) throw error;
  return data as number;
}

/**
 * Fires `handler` as a poke (no payload) whenever any character_conditions
 * row the subscriber can see changes — subscribeToCombatantConditionChanges'
 * exact arrangement (deliberately unfiltered and payload-free: DELETE
 * events carry only the old primary key under the default replica
 * identity, so a scoped server-side filter would silently drop removals —
 * the handler refetches instead, and RLS trims what the refetch returns).
 */
export function subscribeToCharacterConditionChanges(
  supabase: SupabaseClient,
  handler: () => void
): () => void {
  let removed = false;
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;

  void (async () => {
    // Same deterministic-claims dance as subscribeToProfileChanges: without
    // the explicit setAuth, the socket can join as anon and RLS silently
    // drops every event.
    const { data } = await supabase.auth.getSession();
    if (removed) return;
    if (data.session) await supabase.realtime.setAuth(data.session.access_token);
    if (removed) return;

    channel = supabase
      .channel(`character-condition-changes:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "character_conditions" },
        () => handler()
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}
