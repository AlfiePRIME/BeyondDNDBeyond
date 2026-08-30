import type { SupabaseClient } from "@supabase/supabase-js";

export const TOKEN_ALLEGIANCES = ["party", "hostile", "neutral"] as const;

export type TokenAllegiance = (typeof TOKEN_ALLEGIANCES)[number];

/**
 * A token placed on a map — a PC token (character_id set) or a DM-created
 * NPC placeholder (npc_name set), never both (CHECK constraint in 0019).
 * Rows exist only for placed tokens: "every character has a token
 * available" is the UI offering placement, not a pre-created row. As of
 * Prompt 61 an NPC token may ALSO link a monster stat block
 * (monster_stat_block_id) — still an ordinary npc_name token to every
 * existing display path (npc_name is populated from the stat block's name
 * at creation), the link just makes its AC/HP/passive Perception real.
 */
export interface MapToken {
  id: string;
  map_id: string;
  character_id: string | null;
  npc_name: string | null;
  monster_stat_block_id: string | null;
  x: number;
  y: number;
  elevation: number;
  allegiance: TokenAllegiance;
  /** Click-to-attack follow-up (migration 0089): an NPC token's own
   * persistent HP, independent of whether combat is active — the
   * characters.current_hp parity NPCs never had before. null means "at
   * full health, derive the ceiling from its linked stat block" (or "not
   * applicable" for a PC token, whose HP lives on its own character row
   * instead). Kept in sync with an active encounter's own combat_
   * combatants.npc_current_hp from both directions — see
   * resolve_pc_attack_on_npc_damage and apply_npc_hp_delta. */
  current_hp: number | null;
  /** Press-R-to-rotate (0097_map_token_rotation.sql): degrees, matching
   * map_objects.rotation's own shape exactly (real, not integer — see that
   * migration's own doc comment). 0 is the pawn/model's own unrotated
   * orientation; MapSurface's TokenMarker applies this as a static Y-axis
   * rotation, composed with (never replacing) forwardOffsetDeg and the
   * stairs-tilt system — see TokenMarker's own rotationDeg doc comment. */
  rotation: number;
  created_at: string;
}

export async function listMapTokens(supabase: SupabaseClient, mapId: string): Promise<MapToken[]> {
  const { data, error } = await supabase
    .from("map_tokens")
    .select()
    .eq("map_id", mapId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Every map_token the caller can currently read, across EVERY map in the
 * campaign — not just whichever one is currently loaded as a "live map"
 * bundle. This is the per-viewer map-transitions primitive (0046): RLS
 * (can_read_map, extended by 0046) means a player's own result here always
 * includes wherever their own character's token currently sits, even on a
 * map that isn't campaigns.live_map, plus whatever's on the shared live_map
 * itself; the DM's result is every token on every map in their campaign
 * (their read access is already unrestricted). Two combined uses:
 *   - A player's own effective "current map" = mostRecentOwnToken(this,
 *     ownCharacterIds)?.map_id — see vision.ts's own doc comment on why
 *     "most recent" resolves the (rare) case of owning more than one
 *     placed character.
 *   - The DM's own map-picker "which maps are live" indicator = every
 *     distinct map_id among the PC tokens (character_id not null) in this
 *     same result.
 *
 * campaign_maps!inner(campaign_id), not a campaign_id column on map_tokens
 * itself (there isn't one) — the same embedded-join-filter shape
 * getActiveCombatantForCharacter (combat.ts) already uses for
 * combat_combatants -> combat_encounters.campaign_id. The embedded `map`
 * object only exists to filter the query — mapped out below into plain
 * MapToken rows, the listLorePageLinksForCampaign (narrative.ts) precedent
 * for the same shape, rather than destructured-and-discarded.
 */
export async function listMapTokensForCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<MapToken[]> {
  const { data, error } = await supabase
    .from("map_tokens")
    .select("*, map:campaign_maps!inner(campaign_id)")
    .eq("map.campaign_id", campaignId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    map_id: row.map_id,
    character_id: row.character_id,
    npc_name: row.npc_name,
    monster_stat_block_id: row.monster_stat_block_id,
    x: row.x,
    y: row.y,
    elevation: row.elevation,
    allegiance: row.allegiance,
    current_hp: row.current_hp,
    rotation: row.rotation,
    created_at: row.created_at,
  }));
}

/**
 * A single token by id, or null if it doesn't exist or RLS hides it (the
 * getMap/getCharacter convention: indistinguishable on purpose). Added for
 * the roll route's per-token perception context (Prompt 59/60) — resolving
 * a combatant's hider/attacker/target position from ITS OWN token's actual
 * current map_id, rather than assuming campaign.live_map, is what keeps
 * Hide/attack perception checks correct once a combatant's token can live
 * on a map other than the campaign's shared one (0046).
 */
export async function getMapToken(supabase: SupabaseClient, tokenId: string): Promise<MapToken | null> {
  const { data, error } = await supabase.from("map_tokens").select().eq("id", tokenId).maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * A character's own current token, wherever it is — the most-recently-
 * created row for this character_id, in the rare case a stray extra one
 * exists (map_tokens' own unique constraint (0019) only guards against two
 * rows on the SAME map; transitionMapToken normally collapses a moved
 * character down to exactly one row campaign-wide, but a DM manually
 * placing a second one directly is possible). Used by the roll route's PC
 * attack-perception check (0046): a PC attacker isn't always a currently-
 * tracked combatant (combatant.token_id needs an active encounter row), so
 * their own position has to be resolved from their character_id directly
 * rather than through a combatant row that might not exist.
 */
export async function getCharacterCurrentToken(
  supabase: SupabaseClient,
  characterId: string
): Promise<MapToken | null> {
  const { data, error } = await supabase
    .from("map_tokens")
    .select()
    .eq("character_id", characterId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Allowed for the character's owner or the campaign's DM (0019 RLS). */
export async function placeCharacterToken(
  supabase: SupabaseClient,
  params: { mapId: string; characterId: string; x: number; y: number; elevation: number }
): Promise<MapToken> {
  const { data, error } = await supabase
    .from("map_tokens")
    .insert({
      map_id: params.mapId,
      character_id: params.characterId,
      x: params.x,
      y: params.y,
      elevation: params.elevation,
      allegiance: "party",
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** DM-only by construction: with no character_id, only the can_write_map
 * branch of the RLS predicate can pass. As of Prompt 61 an optional
 * monsterStatBlockId links the token to a stat block (the quick-add flow
 * passes the block's own name as npcName, keeping every npc_name display
 * path unchanged); omitted, this is the bare placeholder it always was.
 * Weather & Enemies C5 adds an optional `allegiance` override, defaulting
 * to the long-standing hardcoded 'hostile' when omitted — every existing
 * caller (bare NPC placement, and quick-add from a hand-authored stat
 * block) is completely unaffected; only a quick-add sourced from a
 * monster_templates copy (GameRoom's handleQuickAddMonster, reading the
 * stat block's own default_allegiance) ever passes something else. */
export async function placeNpcToken(
  supabase: SupabaseClient,
  params: {
    mapId: string;
    npcName: string;
    x: number;
    y: number;
    elevation: number;
    monsterStatBlockId?: string | null;
    allegiance?: TokenAllegiance;
  }
): Promise<MapToken> {
  const { data, error } = await supabase
    .from("map_tokens")
    .insert({
      map_id: params.mapId,
      npc_name: params.npcName.trim(),
      monster_stat_block_id: params.monsterStatBlockId ?? null,
      x: params.x,
      y: params.y,
      elevation: params.elevation,
      allegiance: params.allegiance ?? "hostile",
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function moveMapToken(
  supabase: SupabaseClient,
  tokenId: string,
  position: { x: number; y: number; elevation: number }
): Promise<MapToken> {
  const { data, error } = await supabase
    .from("map_tokens")
    .update(position)
    .eq("id", tokenId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * The tracked variant of moveMapToken (Prompt 53): same-map move via the
 * move_combat_token RPC, which — when the token is the active encounter's
 * CURRENT combatant — accumulates `feetCost` into the combatant's
 * movement_used_feet, and in Strict mode rejects the whole move (token
 * unmoved, clear message) once the turn's total would exceed
 * characters.speed. Any other token falls through to a plain move inside
 * the RPC, so callers needn't pre-check combat state; GameRoom still
 * routes non-current-combatant drags through plain moveMapToken, since
 * those moves need no bookkeeping at all. Returns the updated row exactly
 * like moveMapToken.
 */
export async function moveCombatToken(
  supabase: SupabaseClient,
  tokenId: string,
  position: { x: number; y: number; elevation: number },
  feetCost: number
): Promise<MapToken> {
  const { data, error } = await supabase.rpc("move_combat_token", {
    p_token_id: tokenId,
    p_x: position.x,
    p_y: position.y,
    p_elevation: position.elevation,
    p_feet_cost: feetCost,
  });

  if (error) throw error;
  return data as MapToken;
}

/**
 * Moves a token to a DIFFERENT map (a map-transition crossing) — the only
 * write that changes map_id; moveMapToken is same-map by construction.
 *
 * Returns the resulting destination-map token plus the id of any row this
 * removed, so callers can broadcast both effects.
 */
export async function transitionMapToken(
  supabase: SupabaseClient,
  token: MapToken,
  destination: { mapId: string; x: number; y: number; elevation: number }
): Promise<{ moved: MapToken; removedTokenId: string | null }> {
  // map_tokens has unique(map_id, character_id) (0019) — nulls-distinct, so
  // only PC tokens can collide. A character who visited the destination map
  // earlier may still have a stale token sitting there, and re-pointing this
  // token's map_id at it would violate the constraint; instead the STALE row
  // becomes the character's token (moved to the entry cell) and the source
  // row is deleted — one resulting row either way.
  if (token.character_id) {
    const { data: existing, error } = await supabase
      .from("map_tokens")
      .select()
      .eq("map_id", destination.mapId)
      .eq("character_id", token.character_id)
      .maybeSingle();
    if (error) throw error;
    if (existing) {
      const moved = await moveMapToken(supabase, existing.id, {
        x: destination.x,
        y: destination.y,
        elevation: destination.elevation,
      });
      await deleteMapToken(supabase, token.id);
      return { moved, removedTokenId: token.id };
    }
  }

  const { data, error } = await supabase
    .from("map_tokens")
    .update({
      map_id: destination.mapId,
      x: destination.x,
      y: destination.y,
      elevation: destination.elevation,
    })
    .eq("id", token.id)
    .select()
    .single();

  if (error) throw error;
  return { moved: data, removedTokenId: null };
}

export async function setTokenAllegiance(
  supabase: SupabaseClient,
  tokenId: string,
  allegiance: TokenAllegiance
): Promise<MapToken> {
  const { data, error } = await supabase
    .from("map_tokens")
    .update({ allegiance })
    .eq("id", tokenId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Press-R-to-rotate: same shape as setTokenAllegiance (a plain single-column
 * update), allowed for the DM or the token's own owning player under the
 * SAME "DM, or the owning player, can move a token" UPDATE policy
 * (0019_map_tokens.sql) moveMapToken already relies on — no new RLS was
 * needed for this column (0097_map_token_rotation.sql's own doc comment).
 * Callers pass the already-wrapped 0/90/180/270 target, not a delta —
 * GameRoom's handleRotateSelectedToken computes `(current + 90) % 360`
 * before calling this, the same "caller decides the next value" shape
 * moveMapToken's own position argument already has.
 */
export async function rotateMapToken(
  supabase: SupabaseClient,
  tokenId: string,
  rotation: number
): Promise<MapToken> {
  const { data, error } = await supabase
    .from("map_tokens")
    .update({ rotation })
    .eq("id", tokenId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteMapToken(supabase: SupabaseClient, tokenId: string): Promise<void> {
  const { error } = await supabase.from("map_tokens").delete().eq("id", tokenId);

  if (error) throw error;
}
