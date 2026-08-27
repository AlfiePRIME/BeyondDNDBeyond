import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdvantageMode, AttackKind, RolledDiceGroup } from "@/rules-engine";
import type { Character } from "./characters";

export type RollKind =
  | "attack"
  | "save"
  | "check"
  | "skill"
  | "initiative"
  | "freeform"
  | "death_save"
  | "concentration_save"
  | "hide";

export interface RollModifierPart {
  label: string;
  value: number;
}

/** Attack-specific resolution detail, nested in a d20 breakdown. */
export interface AttackResolution {
  /** A PC attack's rules-engine kind, or "stat_block" for an NPC
   * stat-block attack (Prompt 61), whose bonus and damage are the stored
   * numbers rather than anything ability-derived. */
  attackKind: AttackKind | "stat_block";
  targetAc: number;
  targetName: string | null;
  targetCharacterId: string | null;
  natural20: boolean;
  natural1: boolean;
  hit: boolean;
  critical: boolean;
  damage: {
    notation: string;
    /** True on a crit — the dice (not the modifier) were doubled. */
    doubled: boolean;
    groups: RolledDiceGroup[];
    modifier: number;
    total: number;
  } | null;
  /** Set when the damage actually landed on a tracked PC's HP. */
  applied: { characterId: string; newHp: number } | null;
  /** The attacking combatant and stored attack name for a stat-block
   * attack (Prompt 61) — the NPC attacker has no character_id, so the
   * breakdown itself carries who swung. Absent on PC attacks and every
   * pre-61 stored roll (the instantDeath optionality precedent). */
  attackerCombatantId?: string | null;
  attackName?: string | null;
  /** Death-save fallout of damage landing on an already-0-HP target
   * (Prompt 49): true when it equalled or exceeded the target's max HP and
   * killed outright. false when nothing of the sort happened (including
   * every pre-49 logged roll, where the field is simply absent). */
  instantDeath: boolean;
  /** Failures added to the already-0-HP target's tally by this hit: 0
   * (nothing happened), 1 (ordinary damage), or 2 (a critical hit). */
  deathSaveFailureAdded: number;
  /** WHY the rolled mode was what it was (Prompt 59): every advantage
   * source and every disadvantage source the route collected —
   * human-readable strings ("manually selected", "target not perceived",
   * "target has Blinded (advantage against)"). The breakdown's `mode` is
   * their `combineAdvantageSources` resolution: both sides non-empty means
   * they canceled to a flat roll, which the log states explicitly. Optional
   * (like `instantDeath` before Prompt 49) so pre-59 stored rolls, where
   * the fields are simply absent, still parse; new attack rolls always
   * carry both, empty or not. */
  advantageSources?: string[];
  disadvantageSources?: string[];
}

/** Death-save resolution detail, nested in a d20 breakdown (Prompt 49) —
 * the after-the-roll state the apply_death_save_roll RPC settled on. */
export interface DeathSaveResolution {
  natural20: boolean;
  natural1: boolean;
  /** Natural 20: the character regained 1 HP and the sequence ended. */
  recovers: boolean;
  successesAfter: number;
  failuresAfter: number;
  /** Three successes: unconscious at 0 HP but safe. */
  stabilized: boolean;
  /** Three failures: dead. */
  died: boolean;
}

/** Concentration-save resolution detail, nested in a d20 breakdown
 * (Prompt 50). Unlike deathSave this is fully known before the RPC runs —
 * the route reads the stored DC and the at-risk spell, rolls, and compares
 * — so nothing is spliced in afterward. */
export interface ConcentrationSaveResolution {
  /** The stored pending_concentration_dc the roll was compared against. */
  dc: number;
  /** d20 + CON modifier (+ proficiency when the class has CON saves). */
  total: number;
  passed: boolean;
  /** The spell that was at risk, captured before the roll (a failure
   * clears concentrating_on, so it can't be read back afterwards). */
  spellName: string | null;
}

/** One observer's outcome of a Hide attempt, nested in HideResolution
 * (Prompt 60). `name` is resolved best-effort with the ROLLER's own
 * RLS-scoped reads — an NPC's npc_name, a readable character's name, or
 * the "Party member" fallback the combat panel already uses for another
 * player's unreadable PC. */
export interface HideObserverOutcome {
  combatantId: string;
  name: string;
  /** The passive Perception the Stealth total was compared against —
   * rules-engine passiveScore for a PC observer, a stat-blocked NPC's
   * stored passive_perception (Prompt 61), or the flat default of 10 for
   * a bare NPC placeholder with neither. Absent for observers who
   * couldn't perceive the hider at all (no comparison happened). */
  passivePerception?: number;
}

/** Hide-specific resolution detail, nested in a d20 breakdown (Prompt 60)
 * — the per-observer outcome of comparing the Stealth total against each
 * other combatant, fully known before anything persists (the
 * concentration-save "nothing spliced in afterward" case). Table-public
 * roll information like everything else in roll_log. */
export interface HideResolution {
  /** Observers the hider is now hidden from — their passive Perception
   * strictly beat the Stealth total (a tie or better means they notice;
   * only a strict loss hides — the build's meets-it-beats-it convention),
   * so a combatant_hidden_from row was recorded for each. */
  hiddenFrom: HideObserverOutcome[];
  /** Observers who noticed: the Stealth total met or beat their passive
   * Perception, so no row was recorded. */
  noticedBy: HideObserverOutcome[];
  /** Observers who couldn't perceive the hider AT ALL beforehand
   * (visibility tier "none" on the hider's cell — out of light/range, or
   * vision-blocked): hiding from someone who already can't see you is
   * meaningless, so no comparison was made and no row recorded. */
  couldNotPerceive: HideObserverOutcome[];
}

export interface D20RollBreakdown {
  type: "d20";
  /** Display name for the roll, e.g. "Perception check" or "Melee attack". */
  label: string;
  mode: AdvantageMode;
  /** One entry for a normal roll, two for advantage/disadvantage. */
  d20Rolls: number[];
  /** The die that counted (higher on advantage, lower on disadvantage). */
  d20Result: number;
  modifiers: RollModifierPart[];
  attack?: AttackResolution;
  deathSave?: DeathSaveResolution;
  concentrationSave?: ConcentrationSaveResolution;
  hide?: HideResolution;
}

export interface FreeformRollBreakdown {
  type: "dice";
  label: string;
  notation: string;
  groups: RolledDiceGroup[];
  modifier: number;
}

/** roll_log.breakdown's only schema (0030) — the column is otherwise
 * schemaless jsonb, same arrangement as map_objects.behavior_config. */
export type RollBreakdown = D20RollBreakdown | FreeformRollBreakdown;

/** roll_log.visibility (0042): 'public' is member-readable exactly like
 * every roll before this column existed; 'private' is DM-only, enforced by
 * RLS itself (both the SELECT and INSERT policies), not just by the UI
 * never offering the option to a non-DM. */
export type RollVisibility = "public" | "private";

export interface RollLogEntry {
  id: string;
  campaign_id: string;
  roller_user_id: string;
  character_id: string | null;
  kind: RollKind;
  breakdown: RollBreakdown;
  total: number;
  visibility: RollVisibility;
  created_at: string;
}

/** Most recent first. Inserts happen only in the roll Route Handler —
 * clients never write rolls directly, since the die results must be
 * server-generated. */
export async function listRollLog(
  supabase: SupabaseClient,
  campaignId: string,
  limit = 50
): Promise<RollLogEntry[]> {
  const { data, error } = await supabase
    .from("roll_log")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as RollLogEntry[];
}

/**
 * Every roll within [startIso, endIso] (inclusive), oldest first — Chat &
 * Summary B6's end-of-session summary window, unlike listRollLog above (a
 * most-recent-first, tail-limited live feed). No `limit`, same reasoning as
 * listChatMessagesInRange: one session's worth of rolls is bounded enough to
 * fetch in full, and the summary generator caps its own prompt size from the
 * result. Visibility rides roll_log's existing SELECT policy (campaign
 * members, private rolls DM-only) — the end-session-summary Route Handler is
 * DM-gated anyway, so this always sees every roll a DM legitimately can.
 */
export async function listRollLogInRange(
  supabase: SupabaseClient,
  campaignId: string,
  startIso: string,
  endIso: string
): Promise<RollLogEntry[]> {
  const { data, error } = await supabase
    .from("roll_log")
    .select()
    .eq("campaign_id", campaignId)
    .gte("created_at", startIso)
    .lte("created_at", endIso)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as RollLogEntry[];
}

/**
 * Fires `handler` with each newly logged roll in the campaign. A
 * postgres_changes subscription, NOT the Game Room's campaign-channel
 * broadcast, on purpose: rolls can originate from the character sheet page,
 * which isn't on that channel at all, and this feed reaches every
 * subscriber regardless of which page inserted the row (the
 * subscribeToCharacterChanges reasoning). Visibility rides the roll_log
 * SELECT policy (campaign members).
 */
export function subscribeToRollLog(
  supabase: SupabaseClient,
  campaignId: string,
  handler: (roll: RollLogEntry) => void
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
      .channel(`roll-log:${campaignId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "roll_log",
          filter: `campaign_id=eq.${campaignId}`,
        },
        (payload) => handler(payload.new as RollLogEntry)
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}

/**
 * Applies a resolved attack's damage to a tracked PC target AND logs the
 * roll, atomically, via the resolve_attack_damage RPC (0030). Authorization
 * is ATTACKER-based (DM, or owner of the attacking character), deliberately
 * not applyHpDelta's target-owner check — see the migration for why reusing
 * apply_hp_delta would wrongly reject a player's legitimate hit on another
 * player's PC.
 *
 * The roll_log insert happens inside the same RPC, in the same transaction
 * as the HP write — not a separate `insertRoll` call afterward — because
 * this RPC (unlike apply_hp_delta) lets one player move HP on a DIFFERENT
 * player's character; folding the log write in means that can never happen
 * without a matching, permanent roll_log row, structurally, regardless of
 * how the RPC is called. `breakdown.attack.applied` should be `null` going
 * in — this function splices in the real value from the RPC's result and
 * returns the roll_log row exactly as persisted, so the caller doesn't
 * separately call `insertRoll` for this path.
 *
 * As of Prompt 49 `critical` rides through as p_critical so a crit landing
 * on an already-0-HP target adds two death-save failures instead of one;
 * the RPC's new out_instant_death/out_failure_added columns are spliced
 * into `breakdown.attack` alongside `applied` the same way.
 */
export async function resolveAttackDamage(
  supabase: SupabaseClient,
  campaignId: string,
  rollerUserId: string,
  attackerCharacterId: string,
  targetCharacterId: string,
  damage: number,
  critical: boolean,
  breakdown: D20RollBreakdown,
  total: number
): Promise<RollLogEntry> {
  const { data, error } = await supabase
    .rpc("resolve_attack_damage", {
      p_attacker_character_id: attackerCharacterId,
      p_target_character_id: targetCharacterId,
      p_damage: damage,
      p_critical: critical,
      p_breakdown: breakdown,
      p_total: total,
    })
    .single();

  if (error) throw error;
  const row = data as {
    out_target_id: string;
    out_target_current_hp: number;
    out_roll_id: string;
    out_roll_created_at: string;
    out_instant_death: boolean;
    out_failure_added: number;
  };

  const breakdownWithApplied: D20RollBreakdown = {
    ...breakdown,
    attack: breakdown.attack && {
      ...breakdown.attack,
      applied: { characterId: row.out_target_id, newHp: row.out_target_current_hp },
      instantDeath: row.out_instant_death,
      deathSaveFailureAdded: row.out_failure_added,
    },
  };

  return {
    id: row.out_roll_id,
    campaign_id: campaignId,
    roller_user_id: rollerUserId,
    character_id: attackerCharacterId,
    kind: "attack",
    breakdown: breakdownWithApplied,
    total,
    // resolve_attack_damage's own roll_log insert (0030) never sets this
    // column, so it always takes the 'public' default — an attack that
    // actually applies damage to a tracked PC's HP is never fully private
    // anyway (the target's own HP bar updates for every viewer), so
    // threading visibility into this RPC would be a change with no real
    // privacy payoff. A private roll's DM-only surface is the plain
    // insertRoll path in the roll route (freeform/quick-roll/miss/untracked
    // attacks) — see RollRequest's `visibility` field.
    visibility: "public",
    created_at: row.out_roll_created_at,
  };
}

/**
 * The NPC-attacker counterpart of resolveAttackDamage (Prompt 61): applies
 * a stat-block attack's resolved damage to a tracked PC target AND logs
 * the roll atomically via the resolve_npc_attack_damage RPC (0038) — a
 * NEW, PARALLEL function beside resolve_attack_damage, never a
 * modification of it (the apply_hp_delta-vs-resolve_attack_damage
 * different-authorization precedent). Authorization is DM-only on the
 * attacking COMBATANT's campaign — an NPC attacker is always
 * DM-controlled; there is no owning player. Target-side behavior (clamp,
 * death saves with crit doubling, instant death, concentration, the folded
 * log write) mirrors resolveAttackDamage exactly, and the same
 * splice-and-return shape applies. character_id in the returned entry is
 * null: the attacker has no character row; the breakdown's
 * attackerCombatantId/attackName carry who swung.
 */
export async function resolveNpcAttackDamage(
  supabase: SupabaseClient,
  campaignId: string,
  rollerUserId: string,
  attackerCombatantId: string,
  targetCharacterId: string,
  damage: number,
  critical: boolean,
  breakdown: D20RollBreakdown,
  total: number
): Promise<RollLogEntry> {
  const { data, error } = await supabase
    .rpc("resolve_npc_attack_damage", {
      p_attacker_combatant_id: attackerCombatantId,
      p_target_character_id: targetCharacterId,
      p_damage: damage,
      p_critical: critical,
      p_breakdown: breakdown,
      p_total: total,
    })
    .single();

  if (error) throw error;
  const row = data as {
    out_target_id: string;
    out_target_current_hp: number;
    out_roll_id: string;
    out_roll_created_at: string;
    out_instant_death: boolean;
    out_failure_added: number;
  };

  const breakdownWithApplied: D20RollBreakdown = {
    ...breakdown,
    attack: breakdown.attack && {
      ...breakdown.attack,
      applied: { characterId: row.out_target_id, newHp: row.out_target_current_hp },
      instantDeath: row.out_instant_death,
      deathSaveFailureAdded: row.out_failure_added,
    },
  };

  return {
    id: row.out_roll_id,
    campaign_id: campaignId,
    roller_user_id: rollerUserId,
    character_id: null,
    kind: "attack",
    breakdown: breakdownWithApplied,
    total,
    // Same reasoning as resolveAttackDamage's own visibility field above —
    // resolve_npc_attack_damage's insert also never sets this column.
    visibility: "public",
    created_at: row.out_roll_created_at,
  };
}

/**
 * Applies one death-save roll's already-resolved deltas via the
 * apply_death_save_roll RPC (0031), splices the settled after-state into
 * the caller-supplied breakdown's `deathSave`, logs the roll, and returns
 * the persisted RollLogEntry — resolveAttackDamage's splice-and-return
 * shape. Unlike that RPC, the log insert here is a separate write AFTER
 * the RPC succeeds (the initiative-path "write succeeds, then log"
 * ordering), NOT folded into the same transaction: this RPC is SECURITY
 * INVOKER and always self/DM-scoped on ONE character — structurally
 * apply_exhaustion_delta, not resolve_attack_damage's cross-player case —
 * and a rejected roll (not at 0 HP, already stable, already dead, or not
 * yours) throws before anything is logged.
 */
export async function rollDeathSave(
  supabase: SupabaseClient,
  campaignId: string,
  rollerUserId: string,
  characterId: string,
  successesDelta: number,
  failuresDelta: number,
  recovers: boolean,
  breakdown: D20RollBreakdown,
  total: number
): Promise<RollLogEntry> {
  const { data, error } = await supabase.rpc("apply_death_save_roll", {
    p_character_id: characterId,
    p_successes_delta: successesDelta,
    p_failures_delta: failuresDelta,
    p_recovers: recovers,
  });

  if (error) throw error;
  const character = data as Character;

  const breakdownWithOutcome: D20RollBreakdown = {
    ...breakdown,
    deathSave: {
      natural20: breakdown.deathSave?.natural20 ?? false,
      natural1: breakdown.deathSave?.natural1 ?? false,
      recovers,
      successesAfter: character.death_save_successes,
      failuresAfter: character.death_save_failures,
      stabilized: character.is_stable,
      died: character.is_dead,
    },
  };

  const { data: row, error: insertError } = await supabase
    .from("roll_log")
    .insert({
      campaign_id: campaignId,
      roller_user_id: rollerUserId,
      character_id: characterId,
      kind: "death_save",
      breakdown: breakdownWithOutcome,
      total,
    })
    .select()
    .single();

  if (insertError) throw insertError;
  return row as RollLogEntry;
}

/**
 * Resolves one pending concentration check via the
 * resolve_concentration_save RPC (0032), then logs the roll and returns
 * the persisted RollLogEntry — rollDeathSave's write-then-log shape, NOT
 * resolveAttackDamage's atomic merge, for the same structural reason: this
 * RPC is SECURITY INVOKER and always self/DM-scoped on ONE character
 * (apply_death_save_roll/apply_exhaustion_delta's case, never the
 * cross-player one that justified folding the log into
 * resolve_attack_damage), and a rejected roll (no check pending, or not
 * yours) throws before anything is logged. The caller supplies the
 * breakdown fully formed — the DC, total, verdict, and at-risk spell are
 * all known before the RPC runs, so unlike rollDeathSave there is no
 * after-state to splice in.
 */
export async function rollConcentrationSave(
  supabase: SupabaseClient,
  campaignId: string,
  rollerUserId: string,
  characterId: string,
  passed: boolean,
  breakdown: D20RollBreakdown,
  total: number
): Promise<RollLogEntry> {
  const { error } = await supabase.rpc("resolve_concentration_save", {
    p_character_id: characterId,
    p_passed: passed,
  });

  if (error) throw error;

  const { data: row, error: insertError } = await supabase
    .from("roll_log")
    .insert({
      campaign_id: campaignId,
      roller_user_id: rollerUserId,
      character_id: characterId,
      kind: "concentration_save",
      breakdown,
      total,
    })
    .select()
    .single();

  if (insertError) throw insertError;
  return row as RollLogEntry;
}
