import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConditionKey } from "@/rules-engine";

/**
 * One applied condition on one combatant (0029). `condition_key` is a
 * rules-engine ConditionKey, or "exhaustion" (EXHAUSTION_KEY) — the DB
 * deliberately doesn't CHECK-enumerate the keys (the catalog in
 * rules-engine is the single source of truth; see the migration), so this
 * module only ever writes catalog-typed keys. `level` is non-null exactly
 * for exhaustion (1-6); for the on/off conditions the row's presence IS
 * the state.
 */
export interface CombatantCondition {
  id: string;
  combatant_id: string;
  condition_key: string;
  level: number | null;
  applied_at: string;
}

/** All conditions across the given combatants (one encounter's worth for
 * the Game Room, a single-element array for the character sheet), in
 * stable applied-at order so badges don't reshuffle between refetches. */
export async function listCombatantConditions(
  supabase: SupabaseClient,
  combatantIds: string[]
): Promise<CombatantCondition[]> {
  if (combatantIds.length === 0) return [];
  const { data, error } = await supabase
    .from("combatant_conditions")
    .select()
    .in("combatant_id", combatantIds)
    .order("applied_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw error;
  return (data ?? []) as CombatantCondition[];
}

/**
 * Allowed for the DM or the combatant's owning player via plain RLS
 * (0029, reusing 0027's can_write_combatant) — no RPC, same reasoning as
 * initiative entry: one row, no cross-row atomicity. An upsert that
 * ignores the (combatant_id, condition_key) conflict, so re-applying an
 * already-present condition is a harmless no-op.
 */
export async function applyCondition(
  supabase: SupabaseClient,
  combatantId: string,
  conditionKey: ConditionKey
): Promise<void> {
  const { error } = await supabase
    .from("combatant_conditions")
    .upsert(
      { combatant_id: combatantId, condition_key: conditionKey },
      { onConflict: "combatant_id,condition_key", ignoreDuplicates: true }
    );

  if (error) throw error;
}

/** Same authorization as applyCondition; removing an absent condition is a
 * harmless no-op (the DELETE just matches nothing). */
export async function removeCondition(
  supabase: SupabaseClient,
  combatantId: string,
  conditionKey: ConditionKey
): Promise<void> {
  const { error } = await supabase
    .from("combatant_conditions")
    .delete()
    .eq("combatant_id", combatantId)
    .eq("condition_key", conditionKey);

  if (error) throw error;
}

/**
 * Raise (positive) or lower (negative) a combatant's exhaustion level,
 * clamped to [0, 6], via the apply_exhaustion_delta RPC (0029) — the
 * apply_hp_delta pattern, not a client-side read-then-write, because the
 * new level is computed from the CURRENT stored level under a row lock so
 * two near-simultaneous clicks both land. SECURITY INVOKER: the lock on
 * the combatant row rides can_write_combatant's UPDATE policy, so
 * authorization is the same DM-or-owner rule as every other condition
 * write. Returns the new level; 0 means the exhaustion row was deleted
 * (no exhaustion = no row, consistent with the on/off conditions).
 */
export async function applyExhaustionDelta(
  supabase: SupabaseClient,
  combatantId: string,
  delta: number
): Promise<number> {
  const { data, error } = await supabase.rpc("apply_exhaustion_delta", {
    p_combatant_id: combatantId,
    p_delta: delta,
  });

  if (error) throw error;
  return data as number;
}

/**
 * Fires `handler` as a poke (no payload) whenever any combatant_conditions
 * row the subscriber can see changes — the character sheet's live-sync
 * path, since that page isn't on the Game Room's campaign channel
 * (subscribeToCharacterChanges' reasoning). Deliberately unfiltered and
 * payload-free, unlike that per-row subscription: DELETE events carry only
 * the old row's primary key under the default replica identity, so a
 * combatant-scoped server-side filter would silently drop removals — the
 * handler refetches instead, and RLS filters what the refetch returns.
 */
export function subscribeToCombatantConditionChanges(
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
      .channel(`combatant-condition-changes:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "combatant_conditions" },
        () => handler()
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}
