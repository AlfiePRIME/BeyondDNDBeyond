import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A DM-authored link from a cell on one map to an entry cell on another —
 * directional, one outgoing transition per origin cell (unique constraint in
 * 0025). DM-only in both directions via RLS, matching map_folders: the
 * runtime prompt this powers is DM-facing only, so players never read these.
 */
export interface MapTransition {
  id: string;
  from_map_id: string;
  from_x: number;
  from_y: number;
  to_map_id: string;
  to_x: number;
  to_y: number;
  created_at: string;
}

/** Outgoing transitions only — the ones a token on this map can trigger. */
export async function listMapTransitions(
  supabase: SupabaseClient,
  mapId: string
): Promise<MapTransition[]> {
  const { data, error } = await supabase
    .from("map_transitions")
    .select()
    .eq("from_map_id", mapId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function createMapTransition(
  supabase: SupabaseClient,
  params: { fromMapId: string; fromX: number; fromY: number; toMapId: string; toX: number; toY: number }
): Promise<MapTransition> {
  const { data, error } = await supabase
    .from("map_transitions")
    .insert({
      from_map_id: params.fromMapId,
      from_x: params.fromX,
      from_y: params.fromY,
      to_map_id: params.toMapId,
      to_x: params.toX,
      to_y: params.toY,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteMapTransition(
  supabase: SupabaseClient,
  transitionId: string
): Promise<void> {
  const { error } = await supabase.from("map_transitions").delete().eq("id", transitionId);

  if (error) throw error;
}
