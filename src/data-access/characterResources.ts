import type { SupabaseClient } from "@supabase/supabase-js";

export type ResourceRecharge = "short_rest" | "long_rest" | "daily";

export interface CharacterResource {
  id: string;
  character_id: string;
  name: string;
  max_uses: number;
  current_uses: number;
  recharge: ResourceRecharge;
  created_at: string;
}

export type CreateCharacterResourceParams = Omit<CharacterResource, "id" | "created_at">;

export async function listCharacterResources(
  supabase: SupabaseClient,
  characterId: string
): Promise<CharacterResource[]> {
  const { data, error } = await supabase
    .from("character_resources")
    .select()
    .eq("character_id", characterId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as CharacterResource[];
}

export async function createCharacterResource(
  supabase: SupabaseClient,
  params: CreateCharacterResourceParams
): Promise<CharacterResource> {
  const { data, error } = await supabase
    .from("character_resources")
    .insert(params)
    .select()
    .single();

  if (error) throw error;
  return data as CharacterResource;
}

/**
 * The DB CHECK constraint (0 <= current_uses <= max_uses) is the source of
 * truth for bounds — an out-of-range value rejects here with an error
 * rather than clamping.
 */
export async function setCharacterResourceUses(
  supabase: SupabaseClient,
  resourceId: string,
  currentUses: number
): Promise<CharacterResource> {
  const { data, error } = await supabase
    .from("character_resources")
    .update({ current_uses: currentUses })
    .eq("id", resourceId)
    .select()
    .single();

  if (error) throw error;
  return data as CharacterResource;
}

/** Resets only short_rest resources — see the short_rest() SQL function. */
export async function shortRest(supabase: SupabaseClient, characterId: string): Promise<void> {
  const { error } = await supabase.rpc("short_rest", { p_character_id: characterId });
  if (error) throw error;
}

/**
 * Resets every resource (including spell slots, which are ordinary
 * character_resources rows) and restores HP to max — see the long_rest()
 * SQL function.
 */
export async function longRest(supabase: SupabaseClient, characterId: string): Promise<void> {
  const { error } = await supabase.rpc("long_rest", { p_character_id: characterId });
  if (error) throw error;
}
