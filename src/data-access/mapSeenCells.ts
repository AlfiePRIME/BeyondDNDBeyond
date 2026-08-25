import type { SupabaseClient } from "@supabase/supabase-js";
import type { LightLevel } from "./maps";
import type { TerrainType } from "@/rules-engine";

/**
 * One player's memory of one map cell (Prompt 55, migration 0036): the
 * terrain/elevation/light snapshot from the last time they perceived it.
 * As of Prompt 58 the Game Room is the caller: it redraws
 * explored-but-not-currently-visible cells from these rows (the
 * "remembered" render state) and records newly-perceived cells in
 * debounced batches.
 *
 * RLS is deliberately NOT the usual everyone-sees-everything posture:
 * SELECT/INSERT/UPDATE are gated to the caller's OWN rows (user_id =
 * auth.uid()) for maps in campaigns they belong to — another player reading
 * your seen cells would leak what the fog-of-war is meant to hide.
 */
export interface MapSeenCell {
  id: string;
  map_id: string;
  user_id: string;
  x: number;
  y: number;
  terrain_type: TerrainType;
  elevation: number;
  light_level: LightLevel;
  seen_at: string;
}

export interface SeenCellSnapshot {
  x: number;
  y: number;
  terrain_type: TerrainType;
  elevation: number;
  light_level: LightLevel;
}

/** The calling player's own memory of this map — RLS guarantees no one
 * else's rows can come back, so no user_id filter is needed (passing one
 * anyway couldn't widen the result). */
export async function listSeenCells(
  supabase: SupabaseClient,
  mapId: string
): Promise<MapSeenCell[]> {
  const { data, error } = await supabase
    .from("map_seen_cells")
    .select()
    .eq("map_id", mapId)
    .order("y", { ascending: true })
    .order("x", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Records (or refreshes) the caller's memory of a batch of cells — an
 * upsert on the unique (map_id, user_id, x, y) constraint, so re-seeing a
 * cell updates its one existing row rather than duplicating it. seen_at is
 * written explicitly because the column default only applies on INSERT; an
 * upsert that takes the UPDATE path must still move the timestamp.
 */
export async function recordSeenCells(
  supabase: SupabaseClient,
  params: { mapId: string; userId: string; cells: SeenCellSnapshot[] }
): Promise<void> {
  if (params.cells.length === 0) return;
  const seenAt = new Date().toISOString();
  const { error } = await supabase.from("map_seen_cells").upsert(
    params.cells.map((cell) => ({
      map_id: params.mapId,
      user_id: params.userId,
      x: cell.x,
      y: cell.y,
      terrain_type: cell.terrain_type,
      elevation: cell.elevation,
      light_level: cell.light_level,
      seen_at: seenAt,
    })),
    { onConflict: "map_id,user_id,x,y" }
  );

  if (error) throw error;
}
