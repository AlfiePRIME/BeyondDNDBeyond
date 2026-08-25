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
  | "death_save";

export interface RollModifierPart {
  label: string;
  value: number;
}

/** Attack-specific resolution detail, nested in a d20 breakdown. */
export interface AttackResolution {
  attackKind: AttackKind;
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
  /** Death-save fallout of damage landing on an already-0-HP target
   * (Prompt 49): true when it equalled or exceeded the target's max HP and
   * killed outright. false when nothing of the sort happened (including
   * every pre-49 logged roll, where the field is simply absent). */
  instantDeath: boolean;
  /** Failures added to the already-0-HP target's tally by this hit: 0
   * (nothing happened), 1 (ordinary damage), or 2 (a critical hit). */
  deathSaveFailureAdded: number;
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

export interface RollLogEntry {
  id: string;
  campaign_id: string;
  roller_user_id: string;
  character_id: string | null;
  kind: RollKind;
  breakdown: RollBreakdown;
  total: number;
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
