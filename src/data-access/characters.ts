import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdvantageMode, WeaponAttackKind } from "@/rules-engine";

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
  /** The character's one SRD subclass pick (e.g. "Thief", "School of
   * Evocation"), migration 0106 — null until the level-up wizard's
   * subclass-choice step is completed at (or, for a legacy character
   * created before this column existed, any level at or past) the base
   * class's own subclass-gate level. Player-writable like any other sheet
   * field (0008's blanket owner-or-DM UPDATE policy already covers it) —
   * unlike xp/pending_roll_mode, choosing a subclass is exactly the kind
   * of thing completing the level-up wizard itself should be allowed to
   * do, so no DM-only trigger narrowing applies here. */
  subclass: string | null;
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
  /** Persisted experience points (DM party dashboard, migration 0101).
   * Written only by the award_xp RPC (DM-only via the
   * characters_dm_managed_columns trigger), never a direct sheet patch —
   * crossing an SRD threshold (rules-engine levelForXp) surfaces as a
   * suggest-then-confirm level-up on the dashboard, it never silently
   * changes `level`. */
  xp: number;
  /** DM-granted advantage/disadvantage for this character's NEXT roll
   * (migration 0101) — the persisted, cross-surface counterpart of the
   * sheet's client-local rollMode toggle. Set (to a non-normal value) only
   * by the DM (trigger-enforced); read AND cleared back to "normal" by the
   * roll Route Handler via consume_pending_roll_mode, so it applies
   * exactly once, to the next mode-honoring roll, no matter which surface
   * triggers it. */
  pending_roll_mode: AdvantageMode;
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
  | "pending_concentration_dc"
  | "xp"
  | "pending_roll_mode";

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
 * Awards (or, with a negative amount, claws back) experience points via
 * the award_xp RPC (0101) — an atomic xp = xp + delta computed from the
 * CURRENT stored value under the row's UPDATE, the applyHpDelta reasoning
 * (two near-simultaneous awards must both land). DM-only: the RPC checks
 * is_campaign_dm explicitly and the characters_dm_managed_columns trigger
 * backstops any other write path, so a player calling this (or patching
 * the column directly) is rejected at the data layer, not just hidden in
 * the UI. Returns the updated row; the caller decides whether the new
 * total crosses an SRD threshold (rules-engine levelForXp) and offers —
 * never silently applies — the level-up.
 */
export async function awardXp(
  supabase: SupabaseClient,
  characterId: string,
  delta: number
): Promise<Character> {
  const { data, error } = await supabase.rpc("award_xp", {
    p_character_id: characterId,
    p_delta: delta,
  });

  if (error) throw error;
  return data as Character;
}

/**
 * Sets (or, with "normal", clears) the DM-granted next-roll
 * advantage/disadvantage flag — a plain 0008-RLS update like
 * startConcentrating (one row, no cross-row invariant; overwriting a
 * still-unconsumed flag is just what an overwrite does). Setting a
 * NON-normal value is DM-only via the characters_dm_managed_columns
 * trigger (0101); the .single() turns a trigger rejection or an
 * RLS-filtered zero-row write into a thrown error either way. Consumption
 * happens server-side in the roll route via consume_pending_roll_mode —
 * this function is only the dashboard's grant/clear control.
 */
export async function setPendingRollMode(
  supabase: SupabaseClient,
  characterId: string,
  mode: AdvantageMode
): Promise<Character> {
  const { data, error } = await supabase
    .from("characters")
    .update({ pending_roll_mode: mode, updated_at: new Date().toISOString() })
    .eq("id", characterId)
    .select()
    .single();

  if (error) throw error;
  return data as Character;
}

/**
 * Atomically reads-and-clears the character's pending roll mode via the
 * consume_pending_roll_mode RPC (0101), returning what it WAS — the roll
 * Route Handler's one call per mode-honoring d20 roll. SECURITY INVOKER:
 * the row lock rides 0008's characters UPDATE policy (owner or DM), which
 * is exactly who the route lets roll for the character at all.
 */
export async function consumePendingRollMode(
  supabase: SupabaseClient,
  characterId: string
): Promise<AdvantageMode> {
  const { data, error } = await supabase.rpc("consume_pending_roll_mode", {
    p_character_id: characterId,
  });

  if (error) throw error;
  return (data === "advantage" || data === "disadvantage" ? data : "normal") as AdvantageMode;
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

/**
 * Fires `handler` with the new row whenever ANY character in the campaign
 * is updated — subscribeToCharacterChanges' exact mechanism with a
 * campaign_id filter instead of a single-row id filter, for the DM party
 * dashboard (which watches the whole roster at once: HP swings from the
 * Game Room, XP awards, condition-driven updated_at bumps). Visibility
 * rides the characters SELECT policy (owner or DM — the dashboard is
 * DM-gated, so the DM sees every row), enabled for Realtime in 0028.
 */
export function subscribeToCampaignCharacterChanges(
  supabase: SupabaseClient,
  campaignId: string,
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
      .channel(`campaign-character-changes:${campaignId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "characters",
          filter: `campaign_id=eq.${campaignId}`,
        },
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

/** Just enough to label a token that belongs to a character this viewer
 * cannot otherwise read. Sourced from character_roster_names (0103), a
 * narrow view over `characters` readable by ANY campaign member
 * (is_campaign_member) — deliberately broader than characters' own
 * owner-or-DM-only RLS (0008), but exposing nothing beyond these three
 * columns: no ability scores, HP, inventory, or spells leak through it. */
export interface CharacterRosterName {
  id: string;
  name: string;
  level: number;
}

/**
 * Every character in the campaign's name/level, keyed by character id —
 * GameRoom.tsx's fallback for a PC token whose `character_id` isn't in the
 * caller's own RLS-filtered `characters` array (another player's token):
 * the existing "my own or the DM's full row" path always takes priority
 * when it has data, this only fills the gap. Unlike listCharactersForCampaign,
 * this NEVER comes back trimmed to "just mine" for a player — that's the
 * entire point of the underlying view's broader is_campaign_member policy.
 */
export async function listCharacterRosterNames(
  supabase: SupabaseClient,
  campaignId: string
): Promise<Map<string, CharacterRosterName>> {
  const { data, error } = await supabase
    .from("character_roster_names")
    .select("id, name, level")
    .eq("campaign_id", campaignId);

  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.id, row as CharacterRosterName]));
}
