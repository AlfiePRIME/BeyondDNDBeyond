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

/**
 * Damage (negative delta) or heal (positive delta) a character, clamped to
 * [0, max_hp]. Goes through the apply_hp_delta RPC (0028) rather than a
 * read-then-update here, because the clamp must be computed from the
 * CURRENT stored value in one atomic UPDATE — two near-simultaneous deltas
 * must both land. The RPC is SECURITY INVOKER: authorization is 0008's
 * plain characters UPDATE policy (owner or campaign DM), same as
 * updateCharacter. Returns the updated row so callers (and the later
 * death-save/concentration prompts) can observe "HP just changed" from the
 * one shared application path.
 */
export async function applyHpDelta(
  supabase: SupabaseClient,
  characterId: string,
  delta: number
): Promise<Character> {
  const { data, error } = await supabase.rpc("apply_hp_delta", {
    p_character_id: characterId,
    p_delta: delta,
  });

  if (error) throw error;
  return data as Character;
}

/**
 * Fires `handler` with the new row whenever THIS character's row is
 * updated, from any client/tab/device — the characters-table analogue of
 * subscribeToProfileChanges (see that function for why this is a
 * postgres_changes subscription, not the campaign presence/broadcast bus):
 * the character sheet page isn't connected to the Game Room's realtime
 * channel at all, yet must reflect mid-combat damage immediately.
 * Visibility rides the characters SELECT policy (owner or DM), enabled for
 * Realtime in migration 0028.
 */
export function subscribeToCharacterChanges(
  supabase: SupabaseClient,
  characterId: string,
  handler: (character: Character) => void
): () => void {
  let removed = false;
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;

  void (async () => {
    // Same deterministic-claims dance as subscribeToProfileChanges: without
    // the explicit setAuth, the socket can join as anon and RLS silently
    // drops every event.
    const { data } = await supabase.auth.getSession();
    if (removed) return;
    if (data.session) await supabase.realtime.setAuth(data.session.access_token);
    if (removed) return;

    channel = supabase
      .channel(`character-changes:${characterId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "characters", filter: `id=eq.${characterId}` },
        (payload) => handler(payload.new as Character)
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}

export interface OwnedCharacter extends Character {
  /** Null only if the owner is no longer a member of the character's
   * campaign (campaigns' SELECT policy hides it from non-members). */
  campaign: { id: string; name: string } | null;
}

export async function listCharactersForUser(
  supabase: SupabaseClient,
  userId: string
): Promise<OwnedCharacter[]> {
  const { data, error } = await supabase
    .from("characters")
    .select("*, campaign:campaigns(id, name)")
    .eq("owner_id", userId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  // Same to-one embed typing caveat as listCampaignsForUser.
  return (data ?? []) as unknown as OwnedCharacter[];
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
