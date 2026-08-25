import type { SupabaseClient } from "@supabase/supabase-js";
import type { TerrainType } from "@/rules-engine";

export interface CampaignMap {
  id: string;
  campaign_id: string;
  name: string;
  grid_width: number;
  grid_height: number;
  folder_id: string | null;
  thumbnail_ref: string | null;
  created_at: string;
}

export interface MapFolder {
  id: string;
  campaign_id: string;
  name: string;
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

export interface NewMapCell {
  x: number;
  y: number;
  elevation: number;
  terrain_type: TerrainType;
}

export interface NewMapObjectSeed {
  asset_id: string;
  x: number;
  y: number;
  elevation: number;
  rotation: number;
  behavior_config?: Record<string, unknown>;
}

/**
 * createMap plus pre-populated content in one call: inserts the
 * campaign_maps row (optionally straight into a folder), then batch-inserts
 * the given cells and objects under the new map's id. The single creation
 * pathway for anything born non-blank — duplication and starter templates
 * both go through here. Not atomic (three statements, no RPC): a failure
 * mid-way can strand a partially-populated map, which the DM can simply see
 * and delete — not worth a SECURITY DEFINER function to prevent.
 *
 * Returns the stored cell rows alongside the map so callers can render a
 * thumbnail from the known-upfront terrain without re-fetching.
 */
export async function createPopulatedMap(
  supabase: SupabaseClient,
  params: {
    campaignId: string;
    name: string;
    gridWidth: number;
    gridHeight: number;
    folderId?: string | null;
    cells: NewMapCell[];
    objects: NewMapObjectSeed[];
  }
): Promise<{ map: CampaignMap; cells: MapCell[] }> {
  const { data: map, error } = await supabase
    .from("campaign_maps")
    .insert({
      campaign_id: params.campaignId,
      name: params.name.trim(),
      grid_width: params.gridWidth,
      grid_height: params.gridHeight,
      folder_id: params.folderId ?? null,
    })
    .select()
    .single();
  if (error) throw error;

  const cells: MapCell[] = params.cells.map((cell) => ({
    map_id: map.id,
    x: cell.x,
    y: cell.y,
    elevation: cell.elevation,
    terrain_type: cell.terrain_type,
  }));
  await upsertMapCells(supabase, cells);

  if (params.objects.length > 0) {
    const { error: objectsError } = await supabase.from("map_objects").insert(
      params.objects.map((object) => ({
        map_id: map.id,
        asset_id: object.asset_id,
        x: object.x,
        y: object.y,
        elevation: object.elevation,
        rotation: object.rotation,
        ...(object.behavior_config !== undefined
          ? { behavior_config: object.behavior_config }
          : {}),
      }))
    );
    if (objectsError) throw objectsError;
  }

  return { map, cells };
}

/**
 * Clones a map — terrain, elevation, and objects — as a new independent map
 * in the same campaign and folder. Objects keep their authored behavior
 * (action/content/playerTriggerable) but `triggered` resets to false: the
 * copy is a fresh authoring artifact that hasn't been played through, so a
 * sprung trap or opened chest on the source starts un-triggered here.
 */
export async function duplicateMap(
  supabase: SupabaseClient,
  sourceMapId: string
): Promise<{ map: CampaignMap; cells: MapCell[] }> {
  const source = await getMap(supabase, sourceMapId);
  if (!source) throw new Error("Map not found.");

  const [cells, objectsResult] = await Promise.all([
    listMapCells(supabase, sourceMapId),
    supabase
      .from("map_objects")
      .select("asset_id, x, y, elevation, rotation, behavior_config")
      .eq("map_id", sourceMapId),
  ]);
  if (objectsResult.error) throw objectsResult.error;

  return createPopulatedMap(supabase, {
    campaignId: source.campaign_id,
    name: `${source.name} (Copy)`,
    gridWidth: source.grid_width,
    gridHeight: source.grid_height,
    folderId: source.folder_id,
    cells,
    objects: (objectsResult.data ?? []).map((object) => ({
      ...object,
      behavior_config:
        "triggered" in object.behavior_config
          ? { ...object.behavior_config, triggered: false }
          : object.behavior_config,
    })),
  });
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

/** DM-only in both directions — map_folders' RLS (0023) hides every row
 * from non-DMs, matching the DM-only map list this organizes. */
export async function listMapFolders(
  supabase: SupabaseClient,
  campaignId: string
): Promise<MapFolder[]> {
  const { data, error } = await supabase
    .from("map_folders")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function createMapFolder(
  supabase: SupabaseClient,
  params: { campaignId: string; name: string }
): Promise<MapFolder> {
  const { data, error } = await supabase
    .from("map_folders")
    .insert({ campaign_id: params.campaignId, name: params.name.trim() })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function renameMapFolder(
  supabase: SupabaseClient,
  folderId: string,
  name: string
): Promise<MapFolder> {
  const { data, error } = await supabase
    .from("map_folders")
    .update({ name: name.trim() })
    .eq("id", folderId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Maps in the folder survive — folder_id's on delete set null unfiles
 * them, so they reappear under the picker's "Unfiled" group. */
export async function deleteMapFolder(supabase: SupabaseClient, folderId: string): Promise<void> {
  const { error } = await supabase.from("map_folders").delete().eq("id", folderId);
  if (error) throw error;
}

/** Files the map into a folder, or unfiles it with null. */
export async function setMapFolder(
  supabase: SupabaseClient,
  mapId: string,
  folderId: string | null
): Promise<CampaignMap> {
  const { data, error } = await supabase
    .from("campaign_maps")
    .update({ folder_id: folderId })
    .eq("id", mapId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function setMapThumbnail(
  supabase: SupabaseClient,
  mapId: string,
  thumbnailRef: string | null
): Promise<CampaignMap> {
  const { data, error } = await supabase
    .from("campaign_maps")
    .update({ thumbnail_ref: thumbnailRef })
    .eq("id", mapId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Uploads a canvas-exported PNG snapshot to the map-thumbnails bucket
 * (0024) and returns the object path to store as thumbnail_ref. Same
 * fresh-unique-path-per-upload scheme as the other buckets, but map-scoped
 * ({map_id}/{uuid}.png) so the bucket's RLS can reuse can_write_map
 * directly. Takes a Blob, not a File — the source is canvas.toBlob(), not
 * a file input.
 */
export async function uploadMapThumbnailFile(
  supabase: SupabaseClient,
  mapId: string,
  blob: Blob
): Promise<string> {
  const path = `${mapId}/${crypto.randomUUID()}.png`;
  const { error } = await supabase.storage
    .from("map-thumbnails")
    .upload(path, blob, { contentType: "image/png" });

  if (error) throw error;
  return path;
}

/** Best-effort cleanup when a fresh snapshot replaces an old one — each
 * upload takes a new path, so stale objects otherwise accumulate forever. */
export async function deleteMapThumbnailFile(supabase: SupabaseClient, path: string): Promise<void> {
  const { error } = await supabase.storage.from("map-thumbnails").remove([path]);
  if (error) throw error;
}

/**
 * Signed download URL for a map thumbnail — same private-bucket signed-URL
 * model (and no-auto-refresh expiry caveat) as getMapAssetSignedUrl; the
 * bucket's RLS limits reads via can_read_map.
 */
export async function getMapThumbnailSignedUrl(
  supabase: SupabaseClient,
  path: string,
  expiresInSeconds: number
): Promise<string> {
  const { data, error } = await supabase.storage
    .from("map-thumbnails")
    .createSignedUrl(path, expiresInSeconds);

  if (error) throw error;
  return data.signedUrl;
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
