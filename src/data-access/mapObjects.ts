import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssetSourceType } from "./assets";

/** The asset fields a renderer needs to resolve a loadable URL, joined onto
 * each placed object so callers don't re-query asset_library per object. */
export interface PlacedObjectAsset {
  name: string;
  source_type: AssetSourceType;
  model_ref: string;
}

export interface MapObject {
  id: string;
  map_id: string;
  asset_id: string;
  x: number;
  y: number;
  elevation: number;
  /** Degrees, not radians: stepped rotations round-trip through the real
   * column exactly (90 is 90), where radian multiples of π/2 would come
   * back as float approximations that can't be compared for equality. */
  rotation: number;
  behavior_config: Record<string, unknown>;
  created_at: string;
  asset: PlacedObjectAsset;
}

const OBJECT_COLUMNS = "*, asset:asset_library(name, source_type, model_ref)";

export async function listMapObjects(supabase: SupabaseClient, mapId: string): Promise<MapObject[]> {
  const { data, error } = await supabase
    .from("map_objects")
    .select(OBJECT_COLUMNS)
    .eq("map_id", mapId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/** DM-only, enforced by map_objects' INSERT RLS policy (0015).
 * behavior_config is left at its DB default — POI behavior is Prompt 28. */
export async function createMapObject(
  supabase: SupabaseClient,
  params: { mapId: string; assetId: string; x: number; y: number; elevation: number; rotation: number }
): Promise<MapObject> {
  const { data, error } = await supabase
    .from("map_objects")
    .insert({
      map_id: params.mapId,
      asset_id: params.assetId,
      x: params.x,
      y: params.y,
      elevation: params.elevation,
      rotation: params.rotation,
    })
    .select(OBJECT_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/** Repositions and/or rotates one placed object. */
export async function updateMapObject(
  supabase: SupabaseClient,
  objectId: string,
  patch: { x?: number; y?: number; elevation?: number; rotation?: number }
): Promise<MapObject> {
  const { data, error } = await supabase
    .from("map_objects")
    .update(patch)
    .eq("id", objectId)
    .select(OBJECT_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function deleteMapObject(supabase: SupabaseClient, objectId: string): Promise<void> {
  const { error } = await supabase.from("map_objects").delete().eq("id", objectId);

  if (error) throw error;
}
