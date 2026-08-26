import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A member's own persisted override for where their chair actually sits,
 * relative to scene-3d/seating.ts's computeCampaignSeatLayout's own
 * computed default for that seat — never an absolute world coordinate. See
 * 0044_seat_offsets.sql for why: computeCampaignSeatLayout's output
 * reshapes as party size changes (a table getting appended, or a table's
 * own per-seat angles shifting as its bucket fills/empties), so an absolute
 * stored coordinate would silently go stale the moment that happens.
 *
 * Structurally matches scene-3d/seating.ts's own SeatOffset — data-access
 * can't import that module's type directly (see SeatMember's own doc
 * comment in seating.ts on this exact module-boundary convention: scene-3d
 * can't fetch its own data, and the reverse import would tangle the two
 * modules together), so this is data-access's independent,
 * structurally-identical definition of the same shape. scene-3d's own
 * applySeatOffset/getEffectiveSeat are the only place the two are ever
 * actually combined.
 */
export interface SeatOffset {
  dx: number;
  dz: number;
  dRotationY: number;
}

/**
 * The caller's own stored chair offset for one campaign, or null if they've
 * never moved their chair (or have reset it back to the default) — the
 * same "row absent means default" shape as getForwardOffsetDeg.
 */
export async function getSeatOffset(
  supabase: SupabaseClient,
  campaignId: string,
  userId: string
): Promise<SeatOffset | null> {
  const { data, error } = await supabase
    .from("campaign_members")
    .select("seat_offset")
    .eq("campaign_id", campaignId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return (data?.seat_offset as SeatOffset | null | undefined) ?? null;
}

/**
 * Batched read for a whole campaign's roster at once, keyed by user_id —
 * the getForwardOffsetsForUrls shape: rendering a room full of seats needs
 * one round trip, not one per member. A member with no stored override is
 * simply absent from the returned map; callers treat a lookup miss the same
 * as an explicit null (scene-3d's applySeatOffset/getEffectiveSeat already
 * do, via Map.get's own undefined-on-miss).
 */
export async function getSeatOffsetsForCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<Map<string, SeatOffset>> {
  const { data, error } = await supabase
    .from("campaign_members")
    .select("user_id, seat_offset")
    .eq("campaign_id", campaignId)
    .not("seat_offset", "is", null);

  if (error) throw error;
  return new Map(
    (data ?? []).map((row) => {
      const r = row as unknown as { user_id: string; seat_offset: SeatOffset };
      return [r.user_id, r.seat_offset] as const;
    })
  );
}

/**
 * Saves (or, passing null, clears back to the computed default) the
 * caller's own chair offset for one campaign. A plain UPDATE on their
 * already-existing campaign_members row, not an upsert: that row is always
 * created at join time (createCampaign/joinCampaignByInviteCode), well
 * before any chair could ever get dragged, so there's never a missing row
 * to insert here — the setForwardOffsetDeg upsert precedent doesn't apply,
 * since that table's whole point is rows that might not exist yet for a
 * brand new model path.
 *
 * Goes through campaign_members' existing "a member can update their own
 * membership row" RLS policy (0004) — see 0044_seat_offsets.sql for why no
 * new policy is needed. Zero rows affected means either campaignId/userId
 * doesn't name a real membership row, or RLS blocked a write to someone
 * else's row; either way that's a real error, not a silent no-op, so this
 * throws rather than returning normally — the renameCampaign/setHouseRules
 * convention (campaigns.ts).
 */
export async function setSeatOffset(
  supabase: SupabaseClient,
  campaignId: string,
  userId: string,
  offset: SeatOffset | null
): Promise<void> {
  const { error, count } = await supabase
    .from("campaign_members")
    .update({ seat_offset: offset }, { count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", userId);

  if (error) throw error;
  if (count === 0) {
    throw new Error("Could not save this seat position — you may not be a member of this campaign.");
  }
}
