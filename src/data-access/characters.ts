import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeaponAttackKind } from "@/rules-engine";

/**
 * One carried item in `characters.inventory` (a jsonb array — no
 * migration needed for new optional fields; older rows simply lack them).
 * The three optional weapon fields (Prompt 51) tag an item as attackable
 * from the quick-actions panel: `attackKind` picks which of the roll
 * route's weapon attack kinds it rolls as, `damageNotation` is its damage
 * dice in the dice module's notation, and `rangeFeet` optionally overrides
 * the defaults (5 ft reach for melee/finesse, a documented 60 ft stand-in
 * for ranged — no per-weapon SRD range table is modeled anywhere yet).
 * Plain gear leaves all three unset.
 */
export interface InventoryItem {
  name: string;
  quantity: number;
  attackKind?: WeaponAttackKind;
  damageNotation?: string;
  rangeFeet?: number;
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
  /** Vision capability (Prompt 55, migration 0036): null is normal vision
   * only; a number is the darkvision range in feet. Initialized at creation
   * from the chosen race/subrace's `darkvisionFeet` (the static SRD catalog)
   * by the creation UI — caller-supplied like `speed`, not re-derived — and
   * thereafter a plain stored, patchable stat like the rest of the sheet
   * (a character can gain darkvision from sources the catalog doesn't
   * model). Nothing computes visibility from it yet — that's Prompt 56. */
  darkvision_feet: number | null;
  proficiencies: string[];
  inventory: InventoryItem[];
  spells: KnownSpell[];
  /** Death-save state (Prompt 49, migration 0031). The counts tick 0-3;
   * three successes sets is_stable, three failures — or instant death —
   * sets is_dead. Written only by the apply_death_save_roll /
   * apply_hp_delta / resolve_attack_damage RPCs, never patched directly. */
  death_save_successes: number;
  death_save_failures: number;
  is_stable: boolean;
  is_dead: boolean;
  /** Concentration state (Prompt 50, migration 0032). The spell's name as
   * plain text (spells are a static rules-engine catalog, nothing to FK),
   * or null when not concentrating. Written only by startConcentrating/
   * stopConcentrating below and the damage/condition/save flows, never a
   * direct sheet patch. */
  concentrating_on: string | null;
  /** Server-authoritative "owes a Constitution save" flag: set by
   * apply_hp_delta/resolve_attack_damage when a concentrating character
   * takes damage without dropping to 0 HP, cleared only by
   * resolve_concentration_save (or by starting/stopping concentration,
   * which moots it). The roll route re-reads this rather than trusting a
   * client-sent DC. */
  pending_concentration_dc: number | null;
  created_at: string;
  updated_at: string;
}

/** The death-save and concentration columns are excluded along with the
 * timestamps: they start at their DB defaults (0/false/null) and only ever
 * move through the RPCs and the dedicated functions below, so no creation
 * or sheet-edit path supplies them. */
type ServerManagedCharacterField =
  | "id"
  | "created_at"
  | "updated_at"
  | "death_save_successes"
  | "death_save_failures"
  | "is_stable"
  | "is_dead"
  | "concentrating_on"
  | "pending_concentration_dc";

export type CreateCharacterParams = Omit<Character, ServerManagedCharacterField>;

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
  Omit<Character, ServerManagedCharacterField | "campaign_id" | "owner_id">
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
 * Deletes a character — owner or the campaign's DM, 0008's characters
 * DELETE policy exactly (`owner_id = auth.uid() or is_campaign_dm
 * (campaign_id)`), the same zero-rows-affected detection as
 * deleteCampaign/leaveCampaign (campaigns.ts). Every character_id-keyed
 * table (map_tokens 0019, character_resources 0007, action_overrides 0033,
 * character_pawns 0080) is ON DELETE CASCADE off characters, so they go
 * with it; roll_log.character_id (0030) is ON DELETE SET NULL by design —
 * the campaign's shared roll history survives a retired/removed character
 * rather than being erased. Used by removeCampaignMember (campaigns.ts) to
 * delete a removed player's character(s); also available for a future
 * "delete my own character" UI, since the RLS already permits it.
 */
export async function deleteCharacter(supabase: SupabaseClient, characterId: string): Promise<void> {
  const { error, count } = await supabase
    .from("characters")
    .delete({ count: "exact" })
    .eq("id", characterId);

  if (error) throw error;
  if (count === 0) throw new Error("Only the character's owner or the campaign's DM can delete it.");
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
 *
 * As of Prompt 49 (migration 0031) the RPC also keeps the death-save state
 * machine honest: damage while already at 0 HP adds a failure (instant
 * death instead when it's >= max_hp), and healing a 0-HP character above 0
 * clears the successes/failures/is_stable slate — is_dead is never cleared.
 * The four new fields flow back through the same returned Character row.
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
 * Starts (or switches) concentration on a spell — a plain update through
 * 0008's characters UPDATE RLS (owner or DM), no RPC, the map_tokens
 * reasoning: one row, no cross-row invariant, and "silently replaces any
 * previous spell" is just what an overwrite does. Clearing
 * pending_concentration_dc alongside is deliberate: a still-unresolved
 * check belonged to the OLD spell, and starting a new one moots it.
 */
export async function startConcentrating(
  supabase: SupabaseClient,
  characterId: string,
  spellName: string
): Promise<Character> {
  const { data, error } = await supabase
    .from("characters")
    .update({
      concentrating_on: spellName,
      pending_concentration_dc: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", characterId)
    .select()
    .single();

  if (error) throw error;
  return data as Character;
}

/** Ends concentration manually (the owner/DM "Stop concentrating" action,
 * and the incapacitating-condition hook's second step) — same plain-RLS
 * reasoning as startConcentrating. Clears the pending check too: with no
 * spell left to protect, there is nothing to save for. */
export async function stopConcentrating(
  supabase: SupabaseClient,
  characterId: string
): Promise<Character> {
  const { data, error } = await supabase
    .from("characters")
    .update({
      concentrating_on: null,
      pending_concentration_dc: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", characterId)
    .select()
    .single();

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
