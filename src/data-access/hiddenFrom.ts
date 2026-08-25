import type { SupabaseClient } from "@supabase/supabase-js";

// Hide/Stealth (Prompt 60): who is currently hidden from whom. One row per
// (hider, observer) combatant pair — absence of a row means "not hidden
// from them", the combatant_conditions presence-IS-the-state shape. Rows
// are written by the roll Route Handler when a Hide roll resolves and
// deleted by the reveal paths (an attack by the hider — server-side in the
// route — or the manual "Stop hiding" control via clearHiddenAsHider).
// SELECT is member-wide (0037): this is public table state like conditions
// and rolls — the per-viewer "you don't see a token hidden from you" is
// Prompt 58-style presentation masking in the Game Room, not RLS.

export interface CombatantHiddenFrom {
  id: string;
  /** The combatant doing the hiding. */
  hider_combatant_id: string;
  /** The combatant it is hidden FROM. */
  observer_combatant_id: string;
  hidden_at: string;
}

/** One vision-stats row per DISTINCT character linked to a combatant in an
 * encounter, from the get_encounter_vision_stats RPC (0037) — the one
 * narrow SECURITY DEFINER crossing of characters' owner-or-DM SELECT
 * policy, member-authorized, so the roll route can compute every
 * observer's passive Perception and perception eligibility in Node. An NPC
 * combatant has no character and no row here (callers apply the flat NPC
 * defaults: passive Perception 10, normal vision). */
export interface EncounterVisionStats {
  character_id: string;
  strength: number;
  dexterity: number;
  constitution: number;
  intelligence: number;
  wisdom: number;
  charisma: number;
  level: number;
  proficiencies: string[];
  darkvision_feet: number | null;
}

export async function getEncounterVisionStats(
  supabase: SupabaseClient,
  encounterId: string
): Promise<EncounterVisionStats[]> {
  const { data, error } = await supabase.rpc("get_encounter_vision_stats", {
    p_encounter_id: encounterId,
  });

  if (error) throw error;
  return (data ?? []) as EncounterVisionStats[];
}

/** All hidden-from pairs across the given combatants (one encounter's
 * worth for the Game Room), keyed off the hider side — the
 * listCombatantConditions ids-in shape, since the table carries no
 * encounter_id of its own. Stable order so lists don't reshuffle. */
export async function listCombatantHiddenFrom(
  supabase: SupabaseClient,
  combatantIds: string[]
): Promise<CombatantHiddenFrom[]> {
  if (combatantIds.length === 0) return [];
  const { data, error } = await supabase
    .from("combatant_hidden_from")
    .select()
    .in("hider_combatant_id", combatantIds)
    .order("hidden_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw error;
  return (data ?? []) as CombatantHiddenFrom[];
}

/**
 * Replaces the hider's ENTIRE hidden-from set in a delete-then-insert pair
 * — a fresh Hide roll represents the CURRENT concealment state, never an
 * accumulation of pairs from a previous attempt at some other hiding spot.
 * Authorized by RLS on the hider's side only (0037's can_write_combatant
 * policies: DM, or the hider's owning player — an NPC hider falls to the
 * DM), which is why the roll route ALSO pre-checks controllership before
 * rolling: an empty observer set would otherwise slip past the INSERT
 * policy by never inserting. Not an RPC: the two statements have no
 * cross-row invariant worth a transaction (a race between two Hide rolls
 * for the same combatant resolves to one attempt's set either way, and the
 * unique pair constraint prevents duplicates).
 */
export async function replaceHiddenAsHider(
  supabase: SupabaseClient,
  hiderCombatantId: string,
  observerCombatantIds: readonly string[]
): Promise<void> {
  const { error: deleteError } = await supabase
    .from("combatant_hidden_from")
    .delete()
    .eq("hider_combatant_id", hiderCombatantId);
  if (deleteError) throw deleteError;

  if (observerCombatantIds.length === 0) return;
  const { error: insertError } = await supabase.from("combatant_hidden_from").insert(
    observerCombatantIds.map((observerCombatantId) => ({
      hider_combatant_id: hiderCombatantId,
      observer_combatant_id: observerCombatantId,
    }))
  );
  if (insertError) throw insertError;
}

/** Reveals the combatant to everyone — deletes every pair it holds as
 * hider. The manual "Stop hiding" control's write, and the route's
 * reveal-on-attack side effect; same hider-side RLS as replaceHiddenAsHider
 * (a non-controller's attempt just matches zero rows). Deleting while not
 * hidden is a harmless no-op. */
export async function clearHiddenAsHider(
  supabase: SupabaseClient,
  hiderCombatantId: string
): Promise<void> {
  const { error } = await supabase
    .from("combatant_hidden_from")
    .delete()
    .eq("hider_combatant_id", hiderCombatantId);

  if (error) throw error;
}

/**
 * Fires `handler` as a poke (no payload) whenever any combatant_hidden_from
 * row the subscriber can see changes — subscribeToCombatantConditionChanges'
 * exact shape, for the same structural reason: DELETE events (every reveal
 * is one) carry only the old row's primary key under the default replica
 * identity, so any server-side column filter would silently drop them —
 * the handler refetches instead, and RLS filters what the refetch returns.
 * postgres_changes rather than the room's broadcast channel because the
 * reveal-on-attack write happens in the roll Route Handler, which is on no
 * channel at all.
 */
export function subscribeToCombatantHiddenFromChanges(
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
      .channel(`combatant-hidden-from-changes:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "combatant_hidden_from" },
        () => handler()
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}
