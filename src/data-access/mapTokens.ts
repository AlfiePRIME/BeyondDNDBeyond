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
 * path unchanged); omitted, this is the bare placeholder it always was. */
export async function placeNpcToken(
  supabase: SupabaseClient,
  params: {
    mapId: string;
    npcName: string;
    x: number;
    y: number;
    elevation: number;
    monsterStatBlockId?: string | null;
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
      allegiance: "hostile",
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

export async function deleteMapToken(supabase: SupabaseClient, tokenId: string): Promise<void> {
  const { error } = await supabase.from("map_tokens").delete().eq("id", tokenId);

  if (error) throw error;
}
