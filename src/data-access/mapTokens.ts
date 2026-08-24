import type { SupabaseClient } from "@supabase/supabase-js";

export const TOKEN_ALLEGIANCES = ["party", "hostile", "neutral"] as const;

export type TokenAllegiance = (typeof TOKEN_ALLEGIANCES)[number];

/**
 * A token placed on a map — a PC token (character_id set) or a DM-created
 * NPC placeholder (npc_name set), never both (CHECK constraint in 0019).
 * Rows exist only for placed tokens: "every character has a token
 * available" is the UI offering placement, not a pre-created row.
 */
export interface MapToken {
  id: string;
  map_id: string;
  character_id: string | null;
  npc_name: string | null;
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
 * branch of the RLS predicate can pass. */
export async function placeNpcToken(
  supabase: SupabaseClient,
  params: { mapId: string; npcName: string; x: number; y: number; elevation: number }
): Promise<MapToken> {
  const { data, error } = await supabase
    .from("map_tokens")
    .insert({
      map_id: params.mapId,
      npc_name: params.npcName.trim(),
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
