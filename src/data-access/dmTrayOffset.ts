import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The DM's own persisted override for where their personal dice tray
 * actually sits on the table, relative to GameRoom.tsx's own computed
 * default position for it (memberTrayPositions' DM entry) — never an
 * absolute world coordinate. See 0098_dm_tray_offset.sql for why: that
 * computed default reshapes as party size/table arrangement changes, the
 * exact seat_offset/SeatOffset (seatOffsets.ts) and dm_book_offset/
 * DmBookOffset (dmBookOffset.ts) reasoning — just without a dRotationY
 * field, since a tray (like the book, unlike a chair) has no independent
 * facing of its own to preserve; seating.ts's computeMemberTrayPosition
 * returns a plain position with no rotation component at all.
 *
 * Structurally matches scene-3d/GameTableScene.tsx's own DM-tray-drag delta
 * shape — the same module-boundary convention SeatOffset/DmBookOffset
 * already establish (scene-3d can't import data-access's type directly, and
 * the reverse import would tangle the two modules together), so this is
 * data-access's independent, structurally-identical definition.
 */
export interface DmTrayOffset {
  dx: number;
  dz: number;
}

/**
 * This campaign's DM's own stored tray offset, or null if they've never
 * dragged it (or have reset it back to the default). Looked up by role
 * rather than a specific userId — the getDmBookOffset precedent exactly:
 * unlike getSeatOffset's own per-viewer lookup (every member has their own
 * chair), there is always exactly one DM row per campaign, and every viewer
 * (every connected member's own client renders every OTHER connected
 * member's personal tray too, including the DM's) needs to read the SAME
 * single value. Returns null for a campaign with no DM row at all, which
 * should never actually happen in practice (every campaign is created with
 * one) but is a safer contract than throwing for it.
 */
export async function getDmTrayOffset(
  supabase: SupabaseClient,
  campaignId: string
): Promise<DmTrayOffset | null> {
  const { data, error } = await supabase
    .from("campaign_members")
    .select("dm_tray_offset")
    .eq("campaign_id", campaignId)
    .eq("role", "dm")
    .maybeSingle();

  if (error) throw error;
  return (data?.dm_tray_offset as DmTrayOffset | null | undefined) ?? null;
}

/**
 * Saves (or, passing null, clears back to the computed default) the DM's
 * own tray offset for this campaign — a plain UPDATE on their own
 * already-existing campaign_members row, the setSeatOffset/setDmBookOffset
 * precedent exactly (including why this throws rather than silently
 * no-oping on zero rows affected: either campaignId/userId doesn't name a
 * real membership row, or RLS blocked a write to someone else's row, and
 * either is a real error, not a silent no-op). `userId` must be the
 * caller's own id (campaign_members' self-only UPDATE policy, 0004) —
 * callers always pass the DM's own currentUserId, never a looked-up DM id
 * for some other viewer, since only the DM who owns the row can ever
 * legally write it anyway.
 */
export async function setDmTrayOffset(
  supabase: SupabaseClient,
  campaignId: string,
  userId: string,
  offset: DmTrayOffset | null
): Promise<void> {
  const { error, count } = await supabase
    .from("campaign_members")
    .update({ dm_tray_offset: offset }, { count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", userId);

  if (error) throw error;
  if (count === 0) {
    throw new Error("Could not save the dice tray's new position — you may not be a member of this campaign.");
  }
}
