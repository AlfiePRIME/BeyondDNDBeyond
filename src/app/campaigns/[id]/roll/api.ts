import type { AbilityScore, AdvantageMode, AttackKind, SkillName } from "@/rules-engine";
import type { RollLogEntry } from "@/data-access";

/** The roll Route Handler's request body — one shape per roll kind. */
export type RollRequest =
  | { kind: "check"; characterId: string; ability: AbilityScore; mode?: AdvantageMode }
  | { kind: "save"; characterId: string; ability: AbilityScore; mode?: AdvantageMode }
  | { kind: "skill"; characterId: string; skill: SkillName; mode?: AdvantageMode }
  | { kind: "initiative"; combatantId: string; mode?: AdvantageMode }
  /** Combatant-scoped like initiative (an NPC can Hide too and has no
   * character): a server-rolled Stealth check — DEX + proficiency for a PC
   * hider, the plain-d20-for-NPCs initiative precedent otherwise — whose
   * total the server compares against every OTHER combatant's passive
   * Perception, recording combatant_hidden_from rows (Prompt 60). */
  | { kind: "hide"; combatantId: string; mode?: AdvantageMode }
  /** No mode: a death save is always a plain d20, no modifiers, and no
   * advantage/disadvantage (that's out of scope until Prompt 59) — the
   * server forces "normal" regardless of what a client sends. */
  | { kind: "death_save"; characterId: string }
  /** No mode, no DC: the server re-reads the character's stored
   * pending_concentration_dc (nothing client-sent is trusted) and rolls a
   * plain d20 + CON save bonus — advantage/disadvantage is Prompt 59's
   * territory, the death-save reasoning. */
  | { kind: "concentration_save"; characterId: string }
  | {
      kind: "attack";
      characterId: string;
      attackKind: AttackKind;
      damageNotation: string;
      /** Entered manually at roll time — NPCs have no stored AC anywhere
       * yet (stat blocks are later work), so there is nothing to look up. */
      targetAc: number;
      /** Set when the target is a tracked PC, so the server can apply the
       * damage to its HP. */
      targetCharacterId?: string | null;
      /** The target's map token (Prompt 59), PC or NPC alike — how the
       * server locates the target's position for the freshly-computed,
       * server-side can-the-attacker-perceive-them check (and, via the
       * combatant seeded from this token, the target's active conditions).
       * Optional and advisory-only: absent (or no longer on the live map)
       * means no visibility-based auto-disadvantage can be computed, never
       * an error — the roll still resolves with the manual mode and any
       * condition flags reachable through targetCharacterId. */
      targetTokenId?: string | null;
      targetName?: string | null;
      mode?: AdvantageMode;
    }
  | { kind: "freeform"; notation: string };

export interface RollResponse {
  ok: boolean;
  roll?: RollLogEntry;
  message?: string;
}

/** Client-side helper: POSTs the roll request; the server does ALL the
 * random rolling and returns the persisted log entry. */
export async function postRoll(campaignId: string, request: RollRequest): Promise<RollLogEntry> {
  const response = await fetch(`/campaigns/${campaignId}/roll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = (await response.json().catch(() => null)) as RollResponse | null;
  if (!body?.ok || !body.roll) {
    throw new Error(body?.message ?? "The roll failed — try again.");
  }
  return body.roll;
}
