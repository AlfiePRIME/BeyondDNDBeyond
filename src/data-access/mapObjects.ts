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

export const MAP_OBJECT_ACTIONS = [
  "reveal_text",
  "reveal_image",
  "toggle_visibility",
  "toggle_state",
] as const;

export type MapObjectAction = (typeof MAP_OBJECT_ACTIONS)[number];

/**
 * The one place map_objects.behavior_config's shape is defined — the column
 * is schemaless jsonb (0014 left it '{}', meaning "no behavior"). Stored
 * keys, all top-level:
 *
 *   action            — one of MAP_OBJECT_ACTIONS
 *   content           — reveal_text: the hidden message; reveal_image: the
 *                       image URL; omitted for the two toggle actions
 *   playerTriggerable — whether a non-DM member may trigger it (the
 *                       trigger_map_object RPC in 0018 checks this key BY
 *                       NAME — renaming it is a migration, not a refactor)
 *   triggered         — the CURRENT live state, kept separate from the
 *                       authoring fields above because it must survive
 *                       reconnects/new joins: reveal_*: content is shown;
 *                       toggle_visibility: the object is visible;
 *                       toggle_state: the switch is on
 */
export interface MapObjectBehavior {
  action: MapObjectAction;
  content: string | null;
  playerTriggerable: boolean;
  triggered: boolean;
}

/** null for an unconfigured (or unrecognized) config — an inert object. */
export function parseMapObjectBehavior(config: Record<string, unknown>): MapObjectBehavior | null {
  const action = config.action;
  if (typeof action !== "string" || !(MAP_OBJECT_ACTIONS as readonly string[]).includes(action)) {
    return null;
  }
  return {
    action: action as MapObjectAction,
    content: typeof config.content === "string" ? config.content : null,
    playerTriggerable: config.playerTriggerable === true,
    triggered: config.triggered === true,
  };
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
 * behavior_config starts at its DB default ('{}') — a fresh placement is
 * inert until the DM assigns a behavior via setMapObjectBehavior. */
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

/**
 * Undo-path re-insert: recreates a deleted placement as the SAME row —
 * explicit id/created_at/behavior_config instead of the insert defaults —
 * so any captured reference to the object (later undo-history entries that
 * hold its id) stays valid after a delete is reversed. Goes through the
 * same DM-only INSERT policy as createMapObject.
 */
export async function restoreMapObject(
  supabase: SupabaseClient,
  object: MapObject
): Promise<MapObject> {
  const { data, error } = await supabase
    .from("map_objects")
    .insert({
      id: object.id,
      map_id: object.map_id,
      asset_id: object.asset_id,
      x: object.x,
      y: object.y,
      elevation: object.elevation,
      rotation: object.rotation,
      behavior_config: object.behavior_config,
      created_at: object.created_at,
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

/**
 * Replaces the object's whole behavior config (null clears it back to inert)
 * — an authoring operation, so it goes through the DM-only UPDATE policy
 * like rotate/move, not through the trigger RPC.
 */
export async function setMapObjectBehavior(
  supabase: SupabaseClient,
  objectId: string,
  behavior: MapObjectBehavior | null
): Promise<MapObject> {
  const behavior_config = behavior
    ? {
        action: behavior.action,
        ...(behavior.content !== null ? { content: behavior.content } : {}),
        playerTriggerable: behavior.playerTriggerable,
        triggered: behavior.triggered,
      }
    : {};
  const { data, error } = await supabase
    .from("map_objects")
    .update({ behavior_config })
    .eq("id", objectId)
    .select(OBJECT_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Persists the object's current triggered state via the trigger_map_object
 * RPC (0018) — the DM always may; a non-DM member only for a
 * playerTriggerable object on the live map. Takes the explicit target state
 * rather than flipping server-side so the caller's realtime broadcast
 * always matches what was persisted.
 */
export async function triggerMapObject(
  supabase: SupabaseClient,
  objectId: string,
  triggered: boolean
): Promise<void> {
  const { error } = await supabase.rpc("trigger_map_object", {
    p_object_id: objectId,
    p_triggered: triggered,
  });
  if (error) throw error;
}

export async function deleteMapObject(supabase: SupabaseClient, objectId: string): Promise<void> {
  const { error } = await supabase.from("map_objects").delete().eq("id", objectId);

  if (error) throw error;
}
