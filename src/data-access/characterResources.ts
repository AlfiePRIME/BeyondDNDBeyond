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

/**
 * Raises a resource's max_uses by `deltaMax` (current_uses moves by the
 * same delta, clamped at the new max) — the level-up wizard's spell-slot
 * resync step: a level-up that increases a slot LEVEL's count (e.g. a
 * Wizard's 2nd-level slots going from 2 to 3 between character level 3 and
 * 4) must bump the row's ceiling, not just leave it stale at the old max
 * the way the character sheet page's own load-time provisioning (which
 * only creates MISSING slot-level rows, never resizes an existing one)
 * does. A plain update off the CALLER-supplied resource — not a
 * read-then-write RPC like apply_character_resource_delta — because a
 * level-up is the wizard's own single-player, already-serialized flow;
 * nothing else can race a level-up's slot resync the way a mid-combat
 * spend/restore can race across two tabs. Same RLS as
 * setCharacterResourceUses (owner or campaign DM via 0008's
 * can_access_character delegation).
 */
export async function growCharacterResourceMax(
  supabase: SupabaseClient,
  resource: CharacterResource,
  deltaMax: number
): Promise<CharacterResource> {
  const nextMax = resource.max_uses + deltaMax;
  const nextCurrent = Math.min(nextMax, Math.max(0, resource.current_uses + deltaMax));
  const { data, error } = await supabase
    .from("character_resources")
    .update({ max_uses: nextMax, current_uses: nextCurrent })
    .eq("id", resource.id)
    .select()
    .single();

  if (error) throw error;
  return data as CharacterResource;
}

/**
 * Raise or lower a named resource's current_uses by `delta`, clamped to
 * [0, max_uses], via the apply_character_resource_delta RPC (Map Editor
 * Batch A9) — the apply_hp_delta/applyExhaustionDelta pattern, not a
 * client-side read-then-write, so the new count is computed from the
 * CURRENT stored value under a row lock rather than a value read moments
 * earlier. Matched by name, case-insensitively, against whichever
 * character_resources row belongs to `characterId` — the cursed/blessed
 * item case this exists for configures a resource by NAME (see
 * CurseBlessingEffect in mapObjectItems.ts) since no specific
 * character_resources row exists yet when the DM authors the item. Returns
 * null (a silent no-op, not a thrown error) if the character has no
 * resource by that name — SECURITY INVOKER, so authorization is 0008's
 * plain character_resources UPDATE policy (owner or campaign DM), same as
 * setCharacterResourceUses.
 */
export async function applyResourceDelta(
  supabase: SupabaseClient,
  characterId: string,
  resourceName: string,
  delta: number
): Promise<CharacterResource | null> {
  const { data, error } = await supabase.rpc("apply_character_resource_delta", {
    p_character_id: characterId,
    p_resource_name: resourceName,
    p_delta: delta,
  });

  if (error) throw error;
  return (data as CharacterResource | null) ?? null;
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
