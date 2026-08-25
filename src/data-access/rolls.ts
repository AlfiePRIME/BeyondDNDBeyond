import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdvantageMode, AttackKind, RolledDiceGroup } from "@/rules-engine";

export type RollKind = "attack" | "save" | "check" | "skill" | "initiative" | "freeform";

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
 */
export async function resolveAttackDamage(
  supabase: SupabaseClient,
  campaignId: string,
  rollerUserId: string,
  attackerCharacterId: string,
  targetCharacterId: string,
  damage: number,
  breakdown: D20RollBreakdown,
  total: number
): Promise<RollLogEntry> {
  const { data, error } = await supabase
    .rpc("resolve_attack_damage", {
      p_attacker_character_id: attackerCharacterId,
      p_target_character_id: targetCharacterId,
      p_damage: damage,
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
  };

  const breakdownWithApplied: D20RollBreakdown = {
    ...breakdown,
    attack: breakdown.attack && {
      ...breakdown.attack,
      applied: { characterId: row.out_target_id, newHp: row.out_target_current_hp },
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
