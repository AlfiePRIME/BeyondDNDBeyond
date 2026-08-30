import type { SupabaseClient } from "@supabase/supabase-js";
import type { SkillName } from "@/rules-engine";

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
  /** Movement Collision & Gated Interaction Checks (0093): gates
   * GameRoom.tsx's transition confirm-prompt behind a skill check roll —
   * the map_transitions table's own equivalent of map_objects.
   * behavior_config's requiredCheck key (src/data-access/mapObjects.ts's
   * ObjectMovementConfig), needed as a REAL column here since a transition
   * is a row in its own table, not a jsonb blob. null (every transition
   * authored before this addition, and every one left unconfigured) offers
   * the ordinary Yes/No confirm immediately, exactly as before this column
   * existed. */
  required_skill: SkillName | null;
  created_at: string;
}

/** A transition's ORIGIN cell only — no destination, no required_skill.
 * Sourced from map_transition_anchors (0095), a narrow view over
 * map_transitions readable by any member who can read the map itself
 * (can_read_map), not just the DM: enough to know "a transition exists
 * here" without spoiling where it leads. */
export interface MapTransitionAnchor {
  from_map_id: string;
  from_x: number;
  from_y: number;
}

/**
 * Every transition anchor on this one map, for ANY campaign member who can
 * read it (map_transition_anchors' own view already scopes this correctly
 * per caller — DM: any map in their campaign; player: only the current live
 * map). GameRoom.tsx's blockedCellsForMovement/handleSelectedTokenCellClick
 * need this for EVERY mover, not just the DM's own listMapTransitions/
 * listMapTransitionsForCampaign above — a real regression showed a player's
 * own move onto a transition-covered blocking object being flatly denied,
 * since map_transitions itself returns nothing at all for a non-DM.
 */
export async function listMapTransitionAnchors(
  supabase: SupabaseClient,
  mapId: string
): Promise<MapTransitionAnchor[]> {
  const { data, error } = await supabase
    .from("map_transition_anchors")
    .select()
    .eq("from_map_id", mapId);

  if (error) throw error;
  return data ?? [];
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

/**
 * Every transition authored anywhere in the campaign, DM-only (0025's
 * read policy is unrestricted-by-live-map for the DM already — this just
 * fetches every map's worth in one call instead of one map at a time).
 *
 * Per-viewer map transitions (0046) decouple the DM's own currently-viewed
 * map from wherever a transition-triggering move actually happens — a
 * player can cross a transition authored on a map the DM currently isn't
 * looking at. GameRoom's maybeOfferTransition needs to recognize THAT
 * transition regardless of what the DM's own client has loaded, so it
 * matches candidates by the moved token's own map_id, not by whichever
 * single map's transitions used to be fetched (keyed off the DM's
 * liveMapId, before this). campaign_maps!from_map_id!inner(campaign_id) —
 * the narrative.ts lore_page_links precedent for disambiguating which of a
 * table's several foreign keys into the same target table a join should
 * follow (map_transitions has two: from_map_id and to_map_id). The embedded
 * `from_map` object only exists to filter the query — mapped out below into
 * plain MapTransition rows, the listLorePageLinksForCampaign precedent for
 * the same shape, rather than destructured-and-discarded.
 */
export async function listMapTransitionsForCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<MapTransition[]> {
  const { data, error } = await supabase
    .from("map_transitions")
    .select("*, from_map:campaign_maps!from_map_id!inner(campaign_id)")
    .eq("from_map.campaign_id", campaignId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    from_map_id: row.from_map_id,
    from_x: row.from_x,
    from_y: row.from_y,
    to_map_id: row.to_map_id,
    to_x: row.to_x,
    to_y: row.to_y,
    required_skill: row.required_skill,
    created_at: row.created_at,
  }));
}

export async function createMapTransition(
  supabase: SupabaseClient,
  params: {
    fromMapId: string;
    fromX: number;
    fromY: number;
    toMapId: string;
    toX: number;
    toY: number;
    /** Movement Collision & Gated Interaction Checks: omitted (or null) by
     * every call site that predates this addition — see MapTransition.
     * required_skill's own doc comment. */
    requiredSkill?: SkillName | null;
  }
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
      required_skill: params.requiredSkill ?? null,
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
