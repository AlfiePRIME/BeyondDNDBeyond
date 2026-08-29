import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The DM's own persisted override for where their book actually sits on the
 * table, relative to GameRoom.tsx's own computed default position for it
 * (dmSeat's position plus DM_BOOK_FORWARD_OFFSET/DM_BOOK_LATERAL_OFFSET) —
 * never an absolute world coordinate. See 0088_dm_book_offset.sql for why:
 * that computed default reshapes as party size/table arrangement changes,
 * the exact seat_offset/SeatOffset reasoning (seatOffsets.ts) — just
 * without a dRotationY field, since the book (unlike a chair) has no
 * independent facing of its own to preserve; it always renders at the DM's
 * own seat rotationY regardless of where it's been dragged to.
 *
 * Structurally matches scene-3d/DmBookProp.tsx's own drag-delta shape — the
 * same module-boundary convention SeatOffset/seatOffsets.ts already
 * establishes (scene-3d can't import data-access's type directly, and the
 * reverse import would tangle the two modules together), so this is
 * data-access's independent, structurally-identical definition.
 */
export interface DmBookOffset {
  dx: number;
  dz: number;
}

/**
 * This campaign's DM's own stored book offset, or null if they've never
 * dragged it (or have reset it back to the default). Looked up by role
 * rather than a specific userId — unlike getSeatOffset's own per-viewer
 * lookup (every member has their own chair), there is always exactly one
 * DM row per campaign, and EVERY viewer (the DM's own client, and every
 * player's, for their own chair-drag obstacle avoidance — GameRoom.tsx's
 * handleChairDragEnd) needs to read the SAME single value. Returns null for
 * a campaign with no DM row at all, which should never actually happen in
 * practice (every campaign is created with one) but is a safer contract
 * than throwing for it.
 */
export async function getDmBookOffset(
  supabase: SupabaseClient,
  campaignId: string
): Promise<DmBookOffset | null> {
  const { data, error } = await supabase
    .from("campaign_members")
    .select("dm_book_offset")
    .eq("campaign_id", campaignId)
    .eq("role", "dm")
    .maybeSingle();

  if (error) throw error;
  return (data?.dm_book_offset as DmBookOffset | null | undefined) ?? null;
}

/**
 * Saves (or, passing null, clears back to the computed default) the DM's
 * own book offset for this campaign — a plain UPDATE on their own
 * already-existing campaign_members row, the setSeatOffset precedent
 * exactly (including why this throws rather than silently no-oping on zero
 * rows affected: either campaignId/userId doesn't name a real membership
 * row, or RLS blocked a write to someone else's row, and either is a real
 * error, not a silent no-op). `userId` must be the caller's own id
 * (campaign_members' self-only UPDATE policy, 0004) — callers always pass
 * the DM's own currentUserId, never a looked-up DM id for some other
 * viewer, since only the DM who owns the row can ever legally write it
 * anyway.
 */
export async function setDmBookOffset(
  supabase: SupabaseClient,
  campaignId: string,
  userId: string,
  offset: DmBookOffset | null
): Promise<void> {
  const { error, count } = await supabase
    .from("campaign_members")
    .update({ dm_book_offset: offset }, { count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", userId);

  if (error) throw error;
  if (count === 0) {
    throw new Error("Could not save the DM book's new position — you may not be a member of this campaign.");
  }
}
