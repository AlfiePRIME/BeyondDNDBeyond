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
  /** Map Editor Batch A6: a freeform, optional, DM-authored label — set when
   * placing/editing an object, copied into every interaction_events row
   * this object's triggers produce so an event can be attributed to a
   * human-readable name regardless of what kind of object caused it.
   * Deliberately independent of A4's own separate map_object_items.tag
   * column (a different table, a different freeform label). null for every
   * object placed before this addition. */
  tag: string | null;
  /** Map Editor Batch A10: staged reveal for objects placed live, from the
   * Game Room itself. Defaults to TRUE for every object placed before this
   * addition and every object placed through the Map Editor route — only
   * the Game Room's own live-placement path (GameRoom.tsx's
   * handlePlaceLiveObject) ever inserts FALSE. While false, map_objects'
   * own SELECT policy (0063) hides the row from every non-DM member
   * entirely — the DM always sees it regardless. GameRoom.tsx additionally
   * never broadcasts an unrevealed row to other clients at all (matching
   * HandoutPayload's own "a fresh handout is hidden, so no other client may
   * see anything yet" precedent) — this flag isn't just a render-time
   * filter, it's backed by both layers. */
  revealed_to_players: boolean;
  /** Map Editor Batch A3: a '#rrggbb' hex string applied at render time as a
   * MULTIPLY against the model's own base color (see PosedClone.tsx's
   * buildTintedScene) — never a flat color replacement, so texture/grain
   * detail (a chest's wood grain, etc.) survives. null (the default, and
   * every object placed before this addition) renders through the exact
   * same untinted code path as before this feature — not just "visually
   * the same" but literally unchanged. Settable only via updateMapObject
   * (like `tag`), never at creation — the editor's color picker only shows
   * once an object is already selected. */
  tint: string | null;
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
 *   triggerOnStepOn   — Map Editor Batch A6: whether a token LANDING on
 *                       this object's cell fires it automatically, through
 *                       the exact same trigger_map_object RPC a click does
 *                       (GameRoom.tsx's handleTokenLanded) — independent of
 *                       playerTriggerable, since step-on resolution runs on
 *                       the DM's own authoritative client (the same one
 *                       that resolves pit falls), never gated on who owns
 *                       the stepping token. Fires for NPC tokens exactly
 *                       like player-character tokens.
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
  triggerOnStepOn: boolean;
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
    triggerOnStepOn: config.triggerOnStepOn === true,
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
    /** Rarely set at creation — the built-in Pressure Plate preset is the
     * one caller today (MapEditor.tsx's pressurePlateAssetId, the same
     * lookup-by-name-once pattern as chestAssetId/bridgeAssetId) so it
     * "works out of the box" without a manual BehaviorEditor step. */
    behaviorConfig?: Record<string, unknown>;
    /** Map Editor Batch A10: omitted (the DB default, true) by every
     * existing caller — the Map Editor's own placeAssetAtCell never passes
     * this. Only GameRoom.tsx's live-placement path passes `false`, so a
     * DM-placed object starts hidden from players until explicitly
     * revealed. See MapObject.revealed_to_players' own doc comment. */
    revealedToPlayers?: boolean;
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
      ...(params.behaviorConfig ? { behavior_config: params.behaviorConfig } : {}),
      ...(params.revealedToPlayers !== undefined
        ? { revealed_to_players: params.revealedToPlayers }
        : {}),
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
      tag: object.tag,
      tint: object.tint,
      revealed_to_players: object.revealed_to_players,
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
    /** Map Editor Batch A6: the freeform label editable from the map
     * editor's object panel — null clears it back to unlabeled. */
    tag?: string | null;
    /** Map Editor Batch A3: the render-time tint — see MapObject.tint's own
     * doc comment. null clears it back to untinted. */
    tint?: string | null;
    /** Map Editor Batch A10: the Game Room's per-object "Reveal" action
     * flips this true — see MapObject.revealed_to_players' own doc
     * comment. Nothing in this app ever flips it back to false today (no
     * "hide again" affordance was asked for). */
    revealed_to_players?: boolean;
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
 * Map Editor Batch A10: the DM's bulk "Reveal all pending" action — every
 * object on this map that's still hidden from players becomes visible in
 * one round trip, rather than the caller looping updateMapObject per row.
 */
export async function revealAllPendingMapObjects(
  supabase: SupabaseClient,
  mapId: string
): Promise<MapObject[]> {
  const { data, error } = await supabase
    .from("map_objects")
    .update({ revealed_to_players: true })
    .eq("map_id", mapId)
    .eq("revealed_to_players", false)
    .select(OBJECT_COLUMNS);

  if (error) throw error;
  return data ?? [];
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
        triggerOnStepOn: behavior.triggerOnStepOn,
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

/**
 * Map Editor Batch A3: live sync for object-metadata edits made from OUTSIDE
 * the Game Room's own broadcast channel — chiefly the separate Map Editor
 * route's tint picker (also tag/rotation/behavior edits made there, as a
 * byproduct), none of which broadcast anywhere today: MapEditor.tsx has no
 * realtime channel of its own at all, so a DM tinting an object on a map a
 * session is already live on would otherwise only reach connected clients
 * at their next full reconnect/map-switch refetch. postgres_changes rather
 * than a new broadcast channel — same subscribeToProfileChanges/
 * subscribeToUiPreferencesChanges precedent (data-access/profiles.ts),
 * row-filtered server-side to one map so an edit on a different map in the
 * same campaign never wakes this up. Same deterministic-claims setAuth
 * dance as those two: without it a socket can join anon and RLS silently
 * drops every event, which would look identical to "nothing changed"
 * instead of surfacing as a bug.
 *
 * Hands the caller postgres_changes' own raw new row — every scalar column,
 * but no joined `asset` (that join only happens in listMapObjects' own
 * OBJECT_COLUMNS select) — so a caller merges just the changed fields onto
 * whatever object it already has cached (keeping that object's own
 * `.asset`) rather than this function re-deriving a full MapObject itself.
 */
export function subscribeToMapObjectChanges(
  supabase: SupabaseClient,
  mapId: string,
  handler: (object: Omit<MapObject, "asset">) => void
): () => void {
  let removed = false;
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;

  void (async () => {
    const { data } = await supabase.auth.getSession();
    if (removed) return;
    if (data.session) await supabase.realtime.setAuth(data.session.access_token);
    if (removed) return;

    channel = supabase
      .channel(`map-object-changes:${mapId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "map_objects", filter: `map_id=eq.${mapId}` },
        (payload) => handler(payload.new as Omit<MapObject, "asset">)
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}
