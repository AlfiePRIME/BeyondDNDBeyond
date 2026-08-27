import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Map Editor Batch A6: one row per interaction — a step-on trigger firing,
 * an (existing) click trigger firing, and (starting with Batch A4) an item
 * taken from a container. Deliberately not hard-FK'd to map_objects alone:
 * exactly one of map_object_id/concealed_pit_id is ever set (0059's own
 * CHECK constraint enforces this at the DB level), since a concealed pit is
 * not a MapObject at all.
 *
 * No UI reads this yet — it exists purely as plumbing for the live DM
 * activity feed / end-of-session summary a later Chat & Summary track
 * prompt builds on top of it.
 */
export interface InteractionEvent {
  id: string;
  campaign_id: string;
  map_object_id: string | null;
  concealed_pit_id: string | null;
  /** Freeform, e.g. "click_trigger" | "step_on_trigger" | "item_taken" — not
   * enumerated at the type level since later prompts in this batch (and the
   * Chat & Summary track) add their own values without needing a schema or
   * type change here. */
  action_type: string;
  /** Copied from the source's own freeform tag (map_objects.tag or, from
   * Batch A4 on, map_object_items.tag) at the moment the event is logged —
   * null if the source had none set. */
  tag: string | null;
  actor_user_id: string | null;
  created_at: string;
}

/**
 * Logs one interaction event. Enforced server-side (0059's RLS): any
 * campaign member may log an event, but only ever attributed to
 * themselves — actor_user_id must be the caller's own auth uid.
 *
 * Exactly one of mapObjectId/concealedPitId must be provided, matching the
 * table's own CHECK constraint — callers pass whichever source they have,
 * omitting or nulling the other.
 *
 * Map Editor Batch A4 fix: deliberately does NOT chain `.select()` after
 * the insert, and returns nothing. Postgres applies a table's SELECT
 * policy to an INSERT's RETURNING projection too (the exact
 * INSERT...RETURNING gotcha verify-rls.mjs's own campaign-creation flow
 * already documents) — and interaction_events' SELECT policy (0059) is
 * DM-only, full stop, even for the very member who just wrote the row. A
 * `.select().single()` here would make this function work only when the
 * caller happens to BE the DM (true for every call site A6 itself shipped:
 * step-on/click triggers both run on the DM's own authoritative client)
 * and throw a confusing "violates row-level security policy" for any
 * ordinary member — exactly what A4's own player-driven item-pickup flow
 * hit. No existing caller ever used the returned row anyway.
 */
export async function createInteractionEvent(
  supabase: SupabaseClient,
  params: {
    campaignId: string;
    mapObjectId?: string | null;
    concealedPitId?: string | null;
    actionType: string;
    tag?: string | null;
    actorUserId: string;
  }
): Promise<void> {
  const { error } = await supabase.from("interaction_events").insert({
    campaign_id: params.campaignId,
    map_object_id: params.mapObjectId ?? null,
    concealed_pit_id: params.concealedPitId ?? null,
    action_type: params.actionType,
    tag: params.tag ?? null,
    actor_user_id: params.actorUserId,
  });

  if (error) throw error;
}

/** Every interaction event for a campaign, most recent first — DM-only
 * readable (0059), so a player's client gets an empty list back rather than
 * an error. Unused by any UI yet (see this module's own doc comment); kept
 * here so the Chat & Summary track's activity feed/summary prompts have a
 * real read path to build on instead of reinventing one. */
export async function listInteractionEvents(
  supabase: SupabaseClient,
  campaignId: string
): Promise<InteractionEvent[]> {
  const { data, error } = await supabase
    .from("interaction_events")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}
