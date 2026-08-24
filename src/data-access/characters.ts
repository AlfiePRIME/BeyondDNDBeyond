import type { SupabaseClient } from "@supabase/supabase-js";

export interface InventoryItem {
  name: string;
  quantity: number;
}

export interface KnownSpell {
  name: string;
  level: number;
}

export interface Character {
  id: string;
  campaign_id: string;
  owner_id: string;
  name: string;
  race: string;
  class: string;
  level: number;
  strength: number;
  dexterity: number;
  constitution: number;
  intelligence: number;
  wisdom: number;
  charisma: number;
  current_hp: number;
  max_hp: number;
  armor_class: number;
  speed: number;
  proficiencies: string[];
  inventory: InventoryItem[];
  spells: KnownSpell[];
  created_at: string;
  updated_at: string;
}

export type CreateCharacterParams = Omit<Character, "id" | "created_at" | "updated_at">;

/**
 * Unlike createCampaign, .insert().select() is safe here: the characters
 * SELECT policy's `owner_id = auth.uid()` branch is satisfied by the row
 * being inserted itself, so RETURNING sees it (verified against the local
 * stack — no campaigns-style chicken-and-egg dependency on another table).
 */
export async function createCharacter(
  supabase: SupabaseClient,
  params: CreateCharacterParams
): Promise<Character> {
  const { data, error } = await supabase
    .from("characters")
    .insert({ id: crypto.randomUUID(), ...params })
    .select()
    .single();

  if (error) throw error;
  return data as Character;
}

export async function getCharacter(
  supabase: SupabaseClient,
  characterId: string
): Promise<Character | null> {
  const { data, error } = await supabase
    .from("characters")
    .select()
    .eq("id", characterId)
    .maybeSingle();

  if (error) throw error;
  // RLS returns no row (not an error) for a character the viewer isn't the
  // owner or campaign DM of — callers treat null as "not found" either way.
  return (data as Character | null) ?? null;
}

export type UpdateCharacterPatch = Partial<
  Omit<Character, "id" | "campaign_id" | "owner_id" | "created_at" | "updated_at">
>;

export async function updateCharacter(
  supabase: SupabaseClient,
  characterId: string,
  patch: UpdateCharacterPatch
): Promise<Character> {
  const { data, error } = await supabase
    .from("characters")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", characterId)
    .select()
    .single();

  if (error) throw error;
  return data as Character;
}

export async function listCharactersForCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<Character[]> {
  const { data, error } = await supabase
    .from("characters")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as Character[];
}
