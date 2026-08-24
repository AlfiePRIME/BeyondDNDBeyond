import type { SupabaseClient } from "@supabase/supabase-js";
import type { TerrainType } from "@/rules-engine";

export interface CampaignMap {
  id: string;
  campaign_id: string;
  name: string;
  grid_width: number;
  grid_height: number;
  created_at: string;
}

export interface MapCell {
  map_id: string;
  x: number;
  y: number;
  elevation: number;
  terrain_type: TerrainType;
}

/**
 * DM-only, enforced by campaign_maps' INSERT RLS policy (0015). Unlike
 * createCampaign, .insert().select() is safe here: the SELECT policy only
 * needs is_campaign_dm, which is already true before the insert runs.
 *
 * Cells are deliberately NOT pre-populated: map_cells storage is sparse. A
 * cell with no row is the default (elevation 0, normal terrain), so a fresh
 * grid_width x grid_height map needs zero cell rows — readers reconstruct
 * the full grid by overlaying whatever rows exist onto defaults.
 */
export async function createMap(
  supabase: SupabaseClient,
  params: { campaignId: string; name: string; gridWidth: number; gridHeight: number }
): Promise<CampaignMap> {
  const { data, error } = await supabase
    .from("campaign_maps")
    .insert({
      campaign_id: params.campaignId,
      name: params.name.trim(),
      grid_width: params.gridWidth,
      grid_height: params.gridHeight,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Every map RLS lets the caller see: all of them for the campaign's DM,
 * only the live one (if any) for other members.
 */
export async function listMapsForCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<CampaignMap[]> {
  const { data, error } = await supabase
    .from("campaign_maps")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/** null when the map doesn't exist — or RLS hides it, indistinguishably. */
export async function getMap(supabase: SupabaseClient, mapId: string): Promise<CampaignMap | null> {
  const { data, error } = await supabase.from("campaign_maps").select().eq("id", mapId).maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Points campaigns.live_map at this map (or clears it with null) — the
 * minimal plumbing that makes a map "the live one" so members' RLS reads
 * (can_read_map's live-map branch) have something to key off. DM-only via
 * campaigns' UPDATE policy (0011), with renameCampaign's zero-rows-affected
 * detection for a non-DM caller.
 */
export async function setLiveMap(
  supabase: SupabaseClient,
  campaignId: string,
  mapId: string | null
): Promise<void> {
  const { error, count } = await supabase
    .from("campaigns")
    .update({ live_map: mapId }, { count: "exact" })
    .eq("id", campaignId);

  if (error) throw error;
  if (count === 0) throw new Error("Only the campaign's DM can change the live map.");
}

/**
 * The map's stored (non-default) cells only, per the sparse-storage model —
 * callers overlay these onto an all-defaults grid to reconstruct the full
 * grid_width x grid_height picture.
 */
export async function listMapCells(supabase: SupabaseClient, mapId: string): Promise<MapCell[]> {
  const { data, error } = await supabase
    .from("map_cells")
    .select()
    .eq("map_id", mapId)
    .order("y", { ascending: true })
    .order("x", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Batch-saves edited cells. onConflict must name the composite primary key
 * columns for Postgres's ON CONFLICT clause to match. Cells edited back to
 * default values are upserted as default-valued rows rather than deleted —
 * a default row and no row reconstruct identically, so the extra rows are
 * harmless and the save path stays a single statement.
 */
export async function upsertMapCells(supabase: SupabaseClient, cells: MapCell[]): Promise<void> {
  if (cells.length === 0) return;
  const { error } = await supabase.from("map_cells").upsert(cells, { onConflict: "map_id,x,y" });

  if (error) throw error;
}
