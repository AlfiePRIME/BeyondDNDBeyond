import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Map Editor Batch A6: one row per interaction — a step-on trigger firing,
 * an (existing) click trigger firing, and (starting with Batch A4) an item
 * taken from a container. Deliberately not hard-FK'd to map_objects alone:
 * exactly one of map_object_id/concealed_pit_id is ever set (0059's own
 * CHECK constraint enforces this at the DB level), since a concealed pit is
 * not a MapObject at all.
 *
 * Chat & Summary B5: read by DmBookActivityPage (the DM's book's live
 * Activity page) via listInteractionEvents/subscribeToInteractionEvents
 * below — the "who triggered/took what, and when" half of that feed, the
 * roll_log damage feed being the other half. A later Chat & Summary track
 * prompt (B6, the end-of-session summary) builds on the same read path.
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
 * an error. Read by Chat & Summary B5's live DM activity feed (DmBookActivityPage). */
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

/**
 * Every interaction event within [startIso, endIso] (inclusive), oldest
 * first — Chat & Summary B6's end-of-session summary window, unlike
 * listInteractionEvents above (a most-recent-first live feed with no time
 * bound). Same DM-only visibility (0059) as every other read of this table;
 * the end-session-summary Route Handler is itself DM-gated, so this never
 * needs to serve a player.
 */
export async function listInteractionEventsInRange(
  supabase: SupabaseClient,
  campaignId: string,
  startIso: string,
  endIso: string
): Promise<InteractionEvent[]> {
  const { data, error } = await supabase
    .from("interaction_events")
    .select()
    .eq("campaign_id", campaignId)
    .gte("created_at", startIso)
    .lte("created_at", endIso)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Fires `handler` with every newly logged interaction event in the
 * campaign — the subscribeToChatMessages/subscribeToRollLog postgres_changes
 * shape, INSERT-only since 0059 has no UPDATE or DELETE policy at all (every
 * row is write-once). Per-subscriber visibility rides the table's own
 * DM-only SELECT policy: a non-DM subscriber's socket simply never receives
 * anything, the same silent-empty-list posture listInteractionEvents above
 * already has.
 */
export function subscribeToInteractionEvents(
  supabase: SupabaseClient,
  campaignId: string,
  handler: (event: InteractionEvent) => void
): () => void {
  let removed = false;
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;

  void (async () => {
    // Same deterministic-claims dance as subscribeToChatMessages/
    // subscribeToRollLog: without the explicit setAuth, the socket can join
    // as anon and RLS silently drops every event.
    const { data } = await supabase.auth.getSession();
    if (removed) return;
    if (data.session) await supabase.realtime.setAuth(data.session.access_token);
    if (removed) return;

    channel = supabase
      .channel(`interaction-events:${campaignId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "interaction_events",
          filter: `campaign_id=eq.${campaignId}`,
        },
        (payload) => handler(payload.new as InteractionEvent)
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}
