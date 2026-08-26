import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssetSourceType } from "./assets";

/** The asset fields a renderer needs to resolve a loadable URL, joined onto
 * each placed object so callers don't re-query asset_library per object. */
export interface PlacedObjectAsset {
  name: string;
  source_type: AssetSourceType;
  model_ref: string;
}

/**
 * Bridges and stairs (a post-roadmap addition): a crossing structure is an
 * ordinary placed map OBJECT, deliberately NOT a new terrain_type. A pit or
 * a difficult water cell is still really there underneath — the object
 * overlays it without replacing it, which is exactly "you can walk across
 * without falling into (or paying full price for) what's still there",
 * where a terrain_type would need CHECK-widening AND couldn't represent
 * "the pit is still a pit, just crossable right here" without inventing a
 * fifth terrain value that means "pit, but not really" for one cell at a
 * time. src/rules-engine/movement.ts defines a structurally-identical
 * CrossingType of its own (the MapSurfaceGroundType/GroundType decoupling
 * precedent — rules-engine cannot import data-access) that this type's
 * values must keep matching by hand.
 *
 * 'bridge' suppresses a pit's fall-trigger (GameRoom.tsx's
 * handleTokenLanded) and water's difficult-terrain movement cost
 * (movement.ts's cellMovementCost) for the cell it sits on. 'stairs'
 * suppresses movement.ts's SRD climbing surcharge for the cell it sits on.
 * null (the default, and every object placed before this addition) is an
 * ordinary object with no effect on movement or falling.
 *
 * Fixed at PLACEMENT time from which built-in preset asset the DM selected
 * (MapEditor.tsx's bridgeAssetId/stairsAssetId, resolved the same
 * lookup-by-name-once way chestAssetId already is) — deliberately never
 * inferred from an asset's mutable display NAME at movement-resolution
 * time. Movement rules are load-bearing in a way the Chest quick-place
 * shortcut's own name lookup never was: if this behavior were driven by
 * asset.name, renaming a preset, or a campaign's own custom upload merely
 * happening to be named "Bridge", would silently grant (or a rename would
 * silently revoke) real gameplay behavior on every object using that
 * asset. Storing the decision as its own column at creation time means it
 * survives any later rename and can never be spoofed by an uploaded
 * asset's chosen display name.
 */
export type CrossingType = "bridge" | "stairs";

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
  /** INERT (Prompt 55, migration 0036): whether this object blocks line of
   * sight. The DM can author it (see the map editor's toggle), but NO code
   * branches on its value yet — a future full-line-of-sight prompt reads
   * it. Do not add a consumer without that prompt's design. */
  blocks_line_of_sight: boolean;
  /** See CrossingType's own doc comment. null for every object that isn't a
   * bridge or stairs — every object placed before this addition included. */
  crossing_type: CrossingType | null;
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
 * inert until the DM assigns a behavior via setMapObjectBehavior.
 * `crossingType` defaults to null (an ordinary object) — see CrossingType's
 * own doc comment for why this is fixed here, at creation, rather than
 * settable later like rotate/move. */
export async function createMapObject(
  supabase: SupabaseClient,
  params: {
    mapId: string;
    assetId: string;
    x: number;
    y: number;
    elevation: number;
    rotation: number;
    crossingType?: CrossingType | null;
  }
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
      crossing_type: params.crossingType ?? null,
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
      blocks_line_of_sight: object.blocks_line_of_sight,
      crossing_type: object.crossing_type,
      created_at: object.created_at,
    })
    .select(OBJECT_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/** Repositions and/or rotates one placed object — and, as of Prompt 55,
 * toggles its (inert, see MapObject) blocks_line_of_sight flag. */
export async function updateMapObject(
  supabase: SupabaseClient,
  objectId: string,
  patch: {
    x?: number;
    y?: number;
    elevation?: number;
    rotation?: number;
    blocks_line_of_sight?: boolean;
  }
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
