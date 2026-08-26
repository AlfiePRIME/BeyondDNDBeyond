import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A DM-authored hidden pit (docs/design/pits-and-falling.md §5) — the
 * `map_transitions` shape and RLS, mirrored exactly: DM-only in both
 * directions, so a player's client never learns this table exists. The
 * cell's PUBLIC `map_cells` row looks like ordinary floor (whatever terrain
 * the DM painted it as) for as long as this row exists; `bottom_elevation_steps`
 * is the trap's REAL floor elevation, since the public cell's own elevation
 * is the fake floor's, not the real bottom's. On a failed save the DM's own
 * move-handling code reveals the trap (writes `map_cells.terrain_type =
 * 'pit'` / `elevation = bottom_elevation_steps`, then deletes this row) —
 * after which it's indistinguishable from an ordinarily-painted visible
 * pit. A successful save never touches this row: the trap stays concealed.
 */
export interface ConcealedPit {
  map_id: string;
  x: number;
  y: number;
  bottom_elevation_steps: number;
  /** Defaults to CONCEALED_PIT_SAVE_DC (15) — not DM-configurable in v1 (no
   * editor field writes anything else), but carried here so a later prompt
   * can expose an override without a schema change. */
  save_dc: number;
}

/** Every concealed pit on this map — DM-only readable (0047), so a player's
 * client gets an empty list back rather than an error. */
export async function listConcealedPits(
  supabase: SupabaseClient,
  mapId: string
): Promise<ConcealedPit[]> {
  const { data, error } = await supabase
    .from("concealed_pits")
    .select()
    .eq("map_id", mapId)
    .order("x", { ascending: true })
    .order("y", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/** Upserts a concealed pit at (mapId, x, y) — the map editor's authoring
 * form re-submitting the same cell adjusts it in place rather than erroring
 * on the primary key, the same "re-applying is a harmless no-op/update"
 * posture as applyCondition. */
export async function createConcealedPit(
  supabase: SupabaseClient,
  params: { mapId: string; x: number; y: number; bottomElevationSteps: number; saveDc?: number }
): Promise<ConcealedPit> {
  const { data, error } = await supabase
    .from("concealed_pits")
    .upsert(
      {
        map_id: params.mapId,
        x: params.x,
        y: params.y,
        bottom_elevation_steps: params.bottomElevationSteps,
        ...(params.saveDc !== undefined ? { save_dc: params.saveDc } : {}),
      },
      { onConflict: "map_id,x,y" }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Removes a concealed pit — used both by the editor's Remove control and by
 * the Game Room's reveal-on-failed-save write (see GameRoom.tsx's
 * handleTokenLanded). */
export async function deleteConcealedPit(
  supabase: SupabaseClient,
  mapId: string,
  x: number,
  y: number
): Promise<void> {
  const { error } = await supabase
    .from("concealed_pits")
    .delete()
    .eq("map_id", mapId)
    .eq("x", x)
    .eq("y", y);

  if (error) throw error;
}
