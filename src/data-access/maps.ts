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
  reference_image_ref: string | null;
  reference_image_x: number | null;
  reference_image_y: number | null;
  reference_image_scale: number | null;
  created_at: string;
}

/**
 * Map Art Generation E4 (0077) — a map's currently-accepted ComfyUI-
 * generated art. A separate table, not columns on CampaignMap (unlike
 * reference_image_*): a later prompt (E6) adds a `stale` column to this same
 * row, so it's a real, independently-migratable row/column set from the
 * start rather than an ad-hoc blob. One row per map (map_id is the primary
 * key) — accepting new art replaces this row, the same "at most one"
 * cardinality reference_image_ref already has.
 */
export interface MapArt {
  map_id: string;
  image_ref: string;
  style_prompt: string;
  generated_at: string;
}

export interface MapFolder {
  id: string;
  campaign_id: string;
  name: string;
  created_at: string;
}

/** map_cells.light_level's vocabulary (0036) — defined here like
 * TOKEN_ALLEGIANCES rather than in the rules engine, since no rules
 * calculation consumes it yet (the perception engine is Prompt 56). */
export const LIGHT_LEVELS = ["bright", "dim", "dark"] as const;

export type LightLevel = (typeof LIGHT_LEVELS)[number];

/** map_cells.ground_type's vocabulary (the post-roadmap ground-types
 * addition, migration 0046) — defined here like LIGHT_LEVELS, since ground
 * type is purely cosmetic and no rules calculation reads it (movement cost
 * and void-ness come from terrain_type alone, forever). 'default' is the
 * sparse-storage default: a cell painted no other way IS 'default', and
 * renders with the plain terrain-driven color every cell always has. The
 * first eight were the starter set; 'water' (migration 0051) is the "later
 * addition" 0047's own header comment anticipated by name. A water cell
 * only costs double movement when the DM ALSO paints it 'difficult' terrain
 * via the existing terrain brush — this column never feeds movement cost,
 * water included. */
export const GROUND_TYPES = [
  "default",
  "grass",
  "rock",
  "forest",
  "dense_forest",
  "path",
  "sand",
  "swamp",
  "stone",
  "water",
] as const;

export type GroundType = (typeof GROUND_TYPES)[number];

/** map_cells.water_flow_direction's vocabulary (migration 0051) — a per-cell
 * AUTHORED direction, purely decorative (nothing in the rules engine reads
 * it; no current/push mechanic exists). Four-way cardinal, reusing the
 * EXACT words MAP_GROWTH_EDGES already established for "which way" on this
 * schema, rather than an 8-way vocabulary this purely-visual arrow doesn't
 * need. */
export const WATER_FLOW_DIRECTIONS = ["north", "east", "south", "west"] as const;

export type WaterFlowDirection = (typeof WATER_FLOW_DIRECTIONS)[number];

export interface MapCell {
  map_id: string;
  x: number;
  y: number;
  elevation: number;
  terrain_type: TerrainType;
  /** Ambient light (Prompt 55) — authored per cell exactly like
   * terrain_type; 'bright' is the sparse-storage default. */
  light_level: LightLevel;
  /** Ground type (the post-roadmap addition) — authored per cell exactly
   * like terrain_type/light_level, but SEPARATE from and independent of
   * terrain_type: a cell's ground type never changes its movement cost or
   * void-ness, and painting one never touches the other. 'default' is the
   * sparse-storage default. */
  ground_type: GroundType;
  /** Flow direction authored on a water cell (migration 0051) — the
   * nullable-DB-column convention this codebase already uses for
   * always-present-but-optional fields (CampaignMap.thumbnail_ref,
   * .reference_image_ref, ...): a required key, typed `| null`, rather than
   * an optional key, so every reader handles the "no direction chosen" case
   * explicitly instead of it being silently indistinguishable from "field
   * omitted". Meaningful only when `ground_type === "water"`; null on every
   * other cell, and legitimately null on a water cell too (a DM can paint
   * water without ever picking a direction). Purely decorative — see
   * WaterFlowDirection's own doc comment. */
  water_flow_direction: WaterFlowDirection | null;
}

/**
 * DM-only, enforced by campaign_maps' INSERT RLS policy (0015).
 *
 * CORRECTION as of 0048 (per-viewer map visibility) — the claim below that
 * .insert().select() is "safe here" is no longer true, and this function
 * currently fails for every caller: 0048 rewrote campaign_maps' SELECT
 * policy to `using (can_read_map(id))`, and can_read_map's body does its
 * own separate by-id lookup of campaign_maps — a fresh scan of the very
 * table this INSERT is writing to, executed mid-command via a SECURITY
 * DEFINER function call. Postgres hasn't advanced its command counter past
 * this row's own insertion yet at that point, so that lookup can't see the
 * row: the RETURNING projection gets rejected as an RLS violation
 * ("new row violates row-level security policy for table campaign_maps"),
 * confirmed by hand against the live instance and unrelated to which DM is
 * calling this. Root-caused and reproduced while adding the themed map
 * templates (see scripts/db/verify-map-templates.mjs's header comment); a
 * candidate fix sits as an unapplied, unverified draft at
 * supabase/migrations/0054_campaign_maps_returning_fix.sql pending explicit
 * review/authorization (it changes shared RLS policy on the live
 * instance) — until that lands, treat .insert().select() on campaign_maps
 * as broken and use a bare insert plus a separate select instead (see
 * verify-map-templates.mjs's createTemplateMapForReal for the pattern).
 *
 * [Original comment, now stale — left for context:] Unlike createCampaign,
 * .insert().select() is safe here: the SELECT policy only needs
 * is_campaign_dm, which is already true before the insert runs.
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
  /** Optional so pre-0036 callers (starter templates) stay valid — an
   * omitted value stores the 'bright' default, same as terrain omitting
   * nothing would. */
  light_level?: LightLevel;
  /** Optional for the same reason as light_level — an omitted value stores
   * the 'default' sparse-storage default, so pre-ground-types callers
   * (existing starter templates) stay valid unchanged. */
  ground_type?: GroundType;
  /** Optional for the same reason as ground_type — an omitted value stores
   * null, so pre-water callers (every existing starter template) stay
   * valid unchanged. */
  water_flow_direction?: WaterFlowDirection | null;
}

export interface NewMapObjectSeed {
  asset_id: string;
  x: number;
  y: number;
  elevation: number;
  rotation: number;
  behavior_config?: Record<string, unknown>;
  /** Optional for the same reason as light_level above; omitted means the
   * DB default (false). */
  blocks_line_of_sight?: boolean;
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
 *
 * CURRENTLY BROKEN for every caller (this is MapsManager.tsx's "Create &
 * edit" button, for a blank map or any template): this function's first
 * statement below is the exact same `.insert(campaign_maps).select().single()`
 * shape whose "is safe" claim createMap's own doc comment above corrects —
 * see that comment for the full root cause (a 0048 regression, unrelated to
 * which map/template is being created) and the unapplied draft fix at
 * supabase/migrations/0054_campaign_maps_returning_fix.sql.
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
    light_level: cell.light_level ?? "bright",
    ground_type: cell.ground_type ?? "default",
    water_flow_direction: cell.water_flow_direction ?? null,
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
        ...(object.blocks_line_of_sight !== undefined
          ? { blocks_line_of_sight: object.blocks_line_of_sight }
          : {}),
      }))
    );
    if (objectsError) throw objectsError;
  }

  return { map, cells };
}

/**
 * Clones a map — terrain, elevation, lighting, and objects — as a new
 * independent map in the same campaign and folder. Objects keep their
 * authored behavior (action/content/playerTriggerable) and LOS flag but
 * `triggered` resets to false: the copy is a fresh authoring artifact that
 * hasn't been played through, so a sprung trap or opened chest on the
 * source starts un-triggered here. Light sources are NOT copied — they can
 * anchor to tokens, which duplication never copies, so a faithful partial
 * copy would be misleading; re-authoring lights on a duplicate is cheap.
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
      .select("asset_id, x, y, elevation, rotation, behavior_config, blocks_line_of_sight")
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

export interface LinkedFromMap {
  id: string;
  name: string;
}

/**
 * Other maps with an authored transition whose to_map_id targets this one —
 * a door/link elsewhere that leads here (map_transitions' own doc comment:
 * directional, one row per origin cell). Read this BEFORE deleteMap so the
 * DM's confirmation dialog can name them: map_transitions.to_map_id cascades
 * on delete (0025) right along with the map itself, so that other map's own
 * door silently stops working unless the DM is warned first. Self-links (a
 * map transitioning into itself) are excluded via the from/to filter — not
 * "another map" needing a warning, and already covered by the plain
 * permanent-deletion warning every delete gets.
 */
export async function listMapsLinkingInto(
  supabase: SupabaseClient,
  mapId: string
): Promise<LinkedFromMap[]> {
  const { data, error } = await supabase
    .from("map_transitions")
    .select("from_map:campaign_maps!from_map_id(id, name)")
    .eq("to_map_id", mapId)
    .neq("from_map_id", mapId);

  if (error) throw error;
  const byId = new Map<string, LinkedFromMap>();
  for (const row of data ?? []) {
    const fromMap = row.from_map as unknown as LinkedFromMap | null;
    if (fromMap) byId.set(fromMap.id, fromMap);
  }
  return [...byId.values()];
}

/**
 * Permanently deletes a map. Every other table referencing map_id (cells,
 * objects, tokens, transitions in both directions, light sources, concealed
 * pits, whiteboard tiles, container items, interaction events, ...) already
 * cascades via its own FK, and campaigns.live_map's "on delete set null"
 * (0014) means a campaign whose live map is this one just loses it rather
 * than blocking the delete — see this file's own migration audit above.
 * Only the thumbnail, reference-image, and generated-art Storage objects
 * need explicit cleanup here: they live in Storage buckets, outside the FK
 * graph a DB-level cascade can reach. (map_art's own ROW is a real FK to
 * campaign_maps with `on delete cascade` — 0077 — so only its Storage object
 * needs this explicit step, not the row itself.)
 *
 * The storage cleanup MUST run before the row delete below, not after:
 * every one of these buckets' own delete policies (0024/0026/0077) gates on
 * can_write_map(mapId), which itself looks the map row up by id — once
 * campaign_maps' row is gone, can_write_map can never resolve true again, so
 * a delete attempted afterward would be silently blocked by that bucket's
 * own RLS, leaking the file forever. Reading map_art BEFORE the map row
 * disappears is required for the same reason.
 *
 * DM-only, enforced by campaign_maps' DELETE RLS policy (0015) — same
 * zero-rows-affected detection as deleteCampaign/renameCampaign (campaigns.ts)
 * and setLiveMap below: a non-DM caller's delete matches zero rows rather
 * than erroring, so `count` is the only signal available to distinguish that
 * from a real deletion.
 */
export async function deleteMap(supabase: SupabaseClient, mapId: string): Promise<void> {
  const map = await getMap(supabase, mapId);
  if (!map) throw new Error("Map not found.");

  if (map.thumbnail_ref) await deleteMapThumbnailFile(supabase, map.thumbnail_ref);
  if (map.reference_image_ref) await deleteMapReferenceImageFile(supabase, map.reference_image_ref);
  const art = await getMapArt(supabase, mapId);
  if (art) await deleteMapArtFile(supabase, art.image_ref);

  const { error, count } = await supabase
    .from("campaign_maps")
    .delete({ count: "exact" })
    .eq("id", mapId);

  if (error) throw error;
  if (count === 0) throw new Error("Only the campaign's DM can delete this map.");
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

/** Which edge of the grid a growth call extends. */
export const MAP_GROWTH_EDGES = ["north", "south", "east", "west"] as const;

export type MapGrowthEdge = (typeof MAP_GROWTH_EDGES)[number];

/**
 * Grows a map's grid by `amount` cells along the chosen edge, mid-session.
 * East/south growth is a pure grid_width/grid_height bump — every existing
 * cell/object/token keeps its stored x/y exactly as-is. West/north growth
 * shifts every existing cell/object/token's x (west) or y (north) coordinate
 * by `amount` so the grid's new (0,0) origin lands correctly and nothing
 * that already existed moves relative to the rest of the map, even though
 * every one of its stored coordinates just changed. Both cases and the
 * shift itself all happen inside the grow_map_grid RPC (0046) as one
 * transaction, so a mid-operation failure can never leave the map in an
 * inconsistent state — this function is a thin wrapper around it, not a
 * caller-orchestrated multi-statement sequence. DM-only via the same RLS
 * grow_map_grid itself runs under (no SECURITY DEFINER — see its own
 * doc comment).
 */
export async function growMapGrid(
  supabase: SupabaseClient,
  mapId: string,
  edge: MapGrowthEdge,
  amount: number
): Promise<CampaignMap> {
  const { data, error } = await supabase.rpc("grow_map_grid", {
    p_map_id: mapId,
    p_edge: edge,
    p_amount: amount,
  });

  if (error) throw error;
  return data as CampaignMap;
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

// Extensions the bucket's allowed_mime_types (0026) accepts, keyed by the
// File's reported type — an unknown type fails here, client-side, instead
// of as an opaque Storage policy error.
const REFERENCE_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Uploads a DM's battle-map reference art to the map-references bucket
 * (0026) and returns the object path to store as reference_image_ref. Same
 * map-scoped fresh-unique-path scheme as thumbnails, but the bucket is
 * DM-only in BOTH directions — a reference image is never player-visible,
 * even for the live map.
 */
export async function uploadMapReferenceImageFile(
  supabase: SupabaseClient,
  mapId: string,
  file: File
): Promise<string> {
  const extension = REFERENCE_IMAGE_EXTENSIONS[file.type];
  if (!extension) throw new Error("Reference images must be PNG, JPEG, or WebP.");
  const path = `${mapId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from("map-references")
    .upload(path, file, { contentType: file.type });

  if (error) throw error;
  return path;
}

/** Best-effort cleanup when an image is replaced or removed — each upload
 * takes a new path, so stale objects otherwise accumulate forever. */
export async function deleteMapReferenceImageFile(
  supabase: SupabaseClient,
  path: string
): Promise<void> {
  const { error } = await supabase.storage.from("map-references").remove([path]);
  if (error) throw error;
}

/**
 * Signed download URL for a reference image — same private-bucket
 * signed-URL model as getMapThumbnailSignedUrl, but the bucket's SELECT
 * policy uses can_write_map, so only the owning campaign's DM can mint one.
 */
export async function getMapReferenceImageSignedUrl(
  supabase: SupabaseClient,
  path: string,
  expiresInSeconds: number
): Promise<string> {
  const { data, error } = await supabase.storage
    .from("map-references")
    .createSignedUrl(path, expiresInSeconds);

  if (error) throw error;
  return data.signedUrl;
}

/**
 * Persists the reference image's path and placement together — the schema's
 * all-or-none constraint (0026) means they can only change as a unit.
 * Position is in grid-cell units from the grid's center; scale multiplies
 * the image's fitted-to-grid base size.
 */
export async function setMapReferenceImage(
  supabase: SupabaseClient,
  mapId: string,
  params: { ref: string; x: number; y: number; scale: number }
): Promise<CampaignMap> {
  const { data, error } = await supabase
    .from("campaign_maps")
    .update({
      reference_image_ref: params.ref,
      reference_image_x: params.x,
      reference_image_y: params.y,
      reference_image_scale: params.scale,
    })
    .eq("id", mapId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Removes the reference image entirely (all four columns back to null);
 * deleting the Storage object is the caller's separate best-effort step. */
export async function clearMapReferenceImage(
  supabase: SupabaseClient,
  mapId: string
): Promise<CampaignMap> {
  const { data, error } = await supabase
    .from("campaign_maps")
    .update({
      reference_image_ref: null,
      reference_image_x: null,
      reference_image_y: null,
      reference_image_scale: null,
    })
    .eq("id", mapId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** null when no art has been accepted for this map yet — or map_art's own
 * SELECT RLS (0077, can_read_map-gated, same posture as campaign_maps
 * itself) hides it, indistinguishably. */
export async function getMapArt(supabase: SupabaseClient, mapId: string): Promise<MapArt | null> {
  const { data, error } = await supabase.from("map_art").select().eq("map_id", mapId).maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Uploads an accepted ComfyUI-generated PNG to the map-art bucket (0077) and
 * returns the object path to store as map_art.image_ref. Same map-scoped
 * fresh-unique-path-per-upload scheme as thumbnails/references, but this
 * bucket's SELECT policy uses can_read_map — player-visible once the map is
 * live, the opposite posture from map-references and a distinct bucket from
 * map-thumbnails (0077's own migration comment explains why neither existing
 * bucket fits). Takes a Blob, not a File: the source is the generate-art
 * Route Handler's own PNG response turned into a Blob client-side, not an
 * `<input type=file>` — the same "no file input involved" shape
 * uploadMapThumbnailFile already has for its own canvas-exported Blob.
 */
export async function uploadMapArtFile(
  supabase: SupabaseClient,
  mapId: string,
  blob: Blob
): Promise<string> {
  const path = `${mapId}/${crypto.randomUUID()}.png`;
  const { error } = await supabase.storage
    .from("map-art")
    .upload(path, blob, { contentType: "image/png" });

  if (error) throw error;
  return path;
}

/** Best-effort cleanup when accepted art is replaced by a fresh generation —
 * each acceptance takes a new path, so stale objects otherwise accumulate
 * forever. */
export async function deleteMapArtFile(supabase: SupabaseClient, path: string): Promise<void> {
  const { error } = await supabase.storage.from("map-art").remove([path]);
  if (error) throw error;
}

/**
 * Signed download URL for a map's accepted art — same private-bucket
 * signed-URL model (and no-auto-refresh expiry caveat) as
 * getMapThumbnailSignedUrl. Unlike getMapReferenceImageSignedUrl, this is a
 * signed URL a PLAYER (any campaign member who can read the map, not only
 * its DM) can legitimately mint: the map-art bucket's RLS (0077) gates on
 * can_read_map, mirroring map-thumbnails rather than map-references — the
 * exact thing accepting map art is supposed to make true.
 */
export async function getMapArtSignedUrl(
  supabase: SupabaseClient,
  path: string,
  expiresInSeconds: number
): Promise<string> {
  const { data, error } = await supabase.storage
    .from("map-art")
    .createSignedUrl(path, expiresInSeconds);

  if (error) throw error;
  return data.signedUrl;
}

/**
 * Records a freshly-generated PNG as the map's current accepted art — an
 * upsert keyed on map_id (0077's primary key: a map has at most one accepted
 * art row at a time, the same cardinality reference_image_ref already has).
 * DM-only via map_art's own INSERT/UPDATE RLS (0077, can_write_map-gated).
 * Deleting the PREVIOUS art's Storage object (if replacing one) is the
 * caller's own separate best-effort step, matching setMapReferenceImage's
 * own division of labor.
 */
export async function acceptMapArt(
  supabase: SupabaseClient,
  mapId: string,
  params: { imageRef: string; stylePrompt: string }
): Promise<MapArt> {
  const { data, error } = await supabase
    .from("map_art")
    .upsert(
      {
        map_id: mapId,
        image_ref: params.imageRef,
        style_prompt: params.stylePrompt,
        generated_at: new Date().toISOString(),
      },
      { onConflict: "map_id" }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
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
