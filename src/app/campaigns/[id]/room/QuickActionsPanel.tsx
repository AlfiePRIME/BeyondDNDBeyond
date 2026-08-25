"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Button } from "@/ui-components";
import {
  consumeOverride,
  listActionOverrides,
  listCharacterResources,
  requestOverride,
  setCharacterResourceUses,
  subscribeToActionOverrides,
  type ActionOverride,
  type Character,
  type CharacterResource,
  type MapToken,
  type RollLogEntry,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import {
  CLASSES,
  computeQuickActions,
  spellSlotResourceName,
  type AdvantageMode,
  type QuickAction,
  type SpellSlotLevel,
} from "@/rules-engine";
import { postRoll } from "../roll/api";
import { AdvantageToggle } from "./DiceLogPanel";
import type { CombatState } from "./CombatPanel";
import styles from "./room.module.css";

function actionKey(action: QuickAction): string {
  return `${action.source}-${action.name.toLowerCase().replace(/\s+/g, "-")}`;
}

/**
 * The contextual quick-actions panel (Prompt 51): on a PC's combat turn,
 * shown to that PC's owner (and the DM) with every attack that could land
 * THIS turn — each weapon-tagged inventory item and each known
 * attack-roll spell that's in range of at least one hostile combatant
 * given full-speed repositioning (computeQuickActions in the rules
 * engine), spells further gated on a matching spell slot (cantrips are
 * free). Firing posts the exact same kind:"attack" request the
 * DiceLogPanel's manual form sends — same route, same resolve_attack_
 * damage path, same roll_log shape — so a quick action IS an ordinary
 * attack roll, just pre-filled. A readable PC target auto-fills its AC
 * and fires in one click; an NPC target has no stored AC anywhere (the
 * deliberate, repeated schema decision — stat blocks are Prompt 61), so
 * it keeps a small inline AC field, matching the manual flow's
 * convention. This panel is a shortcut ONLY: the character sheet, the
 * DiceLogPanel's free attack form, and every other surface stay exactly
 * as usable beside it, and nothing here gates on Action/Bonus Action
 * economy or consumes a movement budget — that's Prompt 53's scope.
 *
 * As of Prompt 52 a resource-blocked spell (no matching-level slot left)
 * renders here too, disabled with its reason and a "Flag to DM" button.
 * Once the DM approves the flag, the action gains a one-time "Use anyway
 * (DM-approved)" control that fires the EXACT same postRoll attack
 * request — but skips the slot decrement entirely (the override grants
 * the action without a slot existing; whether a use is still consumed is
 * the DM's separate, explicit call through the resource controls) — and
 * then marks the override consumed, so a repeat needs a fresh flag.
 */
export function QuickActionsPanel({
  campaignId,
  currentUserId,
  isDM,
  characters,
  combat,
  tokens,
  onRollLanded,
}: {
  campaignId: string;
  currentUserId: string;
  isDM: boolean;
  /** RLS-filtered per viewer: a player's own characters, or all for the DM. */
  characters: Character[];
  combat: CombatState | null;
  tokens: MapToken[];
  /** The room's post-roll hook (refresh HP + combat poke on applied damage). */
  onRollLanded: (roll: RollLogEntry) => void;
}) {
  const [mode, setMode] = useState<AdvantageMode>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tagged with the character the rows belong to, so a turn change shows
  // "no resources yet" (empty) rather than the previous character's rows
  // while the refetch is in flight — no state writes needed in the effect
  // body itself.
  const [resourceState, setResourceState] = useState<{
    characterId: string;
    rows: CharacterResource[];
  } | null>(null);
  const [targetChoices, setTargetChoices] = useState<Record<string, string>>({});
  const [acDrafts, setAcDrafts] = useState<Record<string, string>>({});
  // Override rows (Prompt 52), fetched once and kept fresh by the
  // postgres_changes feed — a DM approval flips a blocked action to its
  // one-time "Use anyway" form the moment it lands, and the consumed
  // transition (from any client) reverts it to needing a fresh flag.
  const [overrides, setOverrides] = useState<ActionOverride[]>([]);

  const characterById = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  );

  // Same current-turn derivation as CombatPanel: current_turn_index
  // indexes the already-sorted combatant array.
  const combatants = combat?.combatants ?? [];
  const currentIndex = combat
    ? Math.min(combat.encounter.current_turn_index, Math.max(combatants.length - 1, 0))
    : -1;
  const current = currentIndex >= 0 ? (combatants[currentIndex] ?? null) : null;
  // Readable only for the owner and the DM under characters RLS — exactly
  // the audience this panel is for, so an unreadable PC (another player's
  // turn) and an NPC turn both fall out here.
  const actingCharacter = current?.character_id
    ? (characterById.get(current.character_id) ?? null)
    : null;
  const actingToken = current ? (tokens.find((t) => t.id === current.token_id) ?? null) : null;
  const canAct =
    actingCharacter !== null && (isDM || actingCharacter.owner_id === currentUserId);
  const actingCharacterId = canAct && actingCharacter ? actingCharacter.id : null;

  // The acting character's live resource rows (spell-slot availability).
  // Keyed on `combat` so every combat-changed refresh (turn advances,
  // damage landing, the poke on reconnect) re-reads them too.
  useEffect(() => {
    if (!combat || !actingCharacterId) return;
    let cancelled = false;
    listCharacterResources(createBrowserSupabaseClient(), actingCharacterId)
      .then((rows) => {
        if (!cancelled) setResourceState({ characterId: actingCharacterId, rows });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [combat, actingCharacterId]);

  const resources = useMemo(
    () =>
      resourceState && resourceState.characterId === actingCharacterId
        ? resourceState.rows
        : [],
    [resourceState, actingCharacterId]
  );

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    let cancelled = false;
    listActionOverrides(supabase, campaignId)
      .then((rows) => {
        if (!cancelled) setOverrides(rows);
      })
      .catch(() => undefined);
    const unsubscribe = subscribeToActionOverrides(supabase, campaignId, (row) => {
      setOverrides((current) => [row, ...current.filter((existing) => existing.id !== row.id)]);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [campaignId]);

  // Hostile combatants still on the live map — allegiance comes from the
  // token (the established hostile-vs-party distinction), membership in
  // the fight from the combatant rows.
  const currentTokenId = current?.token_id ?? null;
  const hostiles = useMemo(() => {
    if (!combat) return [];
    const combatantTokenIds = new Set(combat.combatants.map((c) => c.token_id));
    return tokens.filter(
      (token) =>
        token.allegiance === "hostile" &&
        combatantTokenIds.has(token.id) &&
        token.id !== currentTokenId
    );
  }, [combat, tokens, currentTokenId]);

  const actions = useMemo(() => {
    if (!canAct || !actingCharacter || !actingToken) return [];
    // The roll route rejects attackKind "spell" for a class with no
    // spellcasting ability, so such a class contributes no spell actions.
    const spellCapable = Boolean(
      CLASSES.find((c) => c.name === actingCharacter.class)?.spellcastingAbility
    );
    return computeQuickActions({
      position: { x: actingToken.x, y: actingToken.y },
      speed: actingCharacter.speed,
      hostiles: hostiles.map((token) => ({
        tokenId: token.id,
        position: { x: token.x, y: token.y },
      })),
      inventory: actingCharacter.inventory,
      knownSpellNames: spellCapable ? actingCharacter.spells.map((s) => s.name) : [],
      resources,
    });
  }, [canAct, actingCharacter, actingToken, hostiles, resources]);

  if (!combat || !current || !actingCharacter || !actingToken || !canAct) return null;

  function tokenLabel(token: MapToken): string {
    if (token.npc_name) return token.npc_name;
    // Same fallback as TokenPanel/DiceLogPanel: another player's PC is
    // unreadable under characters RLS, so it lists without its name.
    return characterById.get(token.character_id ?? "")?.name ?? "Party member";
  }

  /** The newest pending-or-approved override for this action on the
   * acting character — the one flag/approval cycle currently in flight.
   * Denied and consumed rows fall out, so the action reverts to "Flag to
   * DM" (a fresh flag) after either terminal state. */
  function activeOverrideFor(action: QuickAction): ActionOverride | null {
    if (!actingCharacter) return null;
    return (
      overrides.find(
        (candidate) =>
          candidate.character_id === actingCharacter.id &&
          candidate.action_label === action.name &&
          (candidate.status === "pending" || candidate.status === "approved")
      ) ?? null
    );
  }

  async function flag(action: QuickAction) {
    if (busy || !actingCharacter || !action.blockedReason) return;
    setBusy(true);
    setError(null);
    try {
      const row = await requestOverride(
        createBrowserSupabaseClient(),
        campaignId,
        actingCharacter.id,
        action.name,
        action.blockedReason
      );
      setOverrides((current) => [row, ...current.filter((existing) => existing.id !== row.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not flag the action — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function fire(
    action: QuickAction,
    target: MapToken,
    targetAc: number,
    override?: ActionOverride
  ) {
    if (busy || !actingCharacter) return;
    setBusy(true);
    setError(null);
    try {
      // The exact request shape DiceLogPanel's manual attack form sends —
      // verified byte-identical roll_log output in verify-quick-actions.
      // A DM-approved override fire sends this SAME request: the override
      // changes nothing about the roll itself.
      const roll = await postRoll(campaignId, {
        kind: "attack",
        characterId: actingCharacter.id,
        attackKind: action.attackKind,
        damageNotation: action.damageNotation,
        targetAc,
        targetCharacterId: target.character_id ?? null,
        // The token itself (PC or NPC) so the server can find the target's
        // position for its perception check (Prompt 59).
        targetTokenId: target.id,
        targetName: tokenLabel(target),
        mode,
      });
      onRollLanded(roll);
      if (override) {
        // The one-time bypass is spent the moment the roll lands. NO slot
        // decrement here, by design: the override grants the action
        // without a slot existing to spend (the exhausted row's DB CHECK
        // couldn't go below 0 anyway), and whether a use is still
        // consumed is the DM's separate, explicit call through the
        // existing resource controls.
        const consumed = await consumeOverride(createBrowserSupabaseClient(), override.id);
        setOverrides((current) => [
          consumed,
          ...current.filter((existing) => existing.id !== consumed.id),
        ]);
        return;
      }
      // Casting a leveled spell spends its slot (the enforcement the
      // sheet's concentration toggle deliberately left to this prompt);
      // cantrips are unlimited. A concurrent-spend conflict just leaves
      // the row as-is — the DB CHECK is the authority.
      if (action.source === "spell" && action.spellLevel !== null && action.spellLevel > 0) {
        const slot = resources.find(
          (resource) => resource.name === spellSlotResourceName(action.spellLevel as SpellSlotLevel)
        );
        if (slot && slot.current_uses > 0) {
          const updated = await setCharacterResourceUses(
            createBrowserSupabaseClient(),
            slot.id,
            slot.current_uses - 1
          );
          setResourceState((state) =>
            state
              ? {
                  ...state,
                  rows: state.rows.map((row) => (row.id === updated.id ? updated : row)),
                }
              : state
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The attack failed — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className={styles.quickActionsPanel} data-testid="quick-actions-panel">
      <div className={styles.objectHeader}>
        <span className={styles.panelLabel}>Quick actions</span>
        <span className={styles.quickActionsTurn} data-testid="quick-actions-character">
          {actingCharacter.name}&apos;s turn
        </span>
      </div>
      {actions.length === 0 ? (
        <p className={styles.hint} data-testid="quick-actions-empty">
          Nothing tagged is in reach of a hostile this turn — the full sheet and the dice
          panel are always available.
        </p>
      ) : (
        <>
          <AdvantageToggle
            mode={mode}
            onChange={setMode}
            disabled={busy}
            testIdPrefix="quick-actions"
          />
          {actions.map((action) => {
            const key = actionKey(action);
            const override = action.blockedReason ? activeOverrideFor(action) : null;
            // A blocked action only exposes the fire controls once the DM
            // has approved its flag (and that approval isn't spent yet).
            const canFire = action.blockedReason === null || override?.status === "approved";
            const chosen = targetChoices[key];
            const selectedTokenId =
              chosen && action.targetTokenIds.includes(chosen)
                ? chosen
                : action.targetTokenIds[0];
            const target = tokens.find((token) => token.id === selectedTokenId) ?? null;
            if (!target) return null;
            const targetCharacter = target.character_id
              ? (characterById.get(target.character_id) ?? null)
              : null;
            // The DiceLogPanel convention: auto-fill AC only for a
            // readable PC target; an NPC (or unreadable PC) needs it typed
            // in — inline, right here.
            const knownAc = targetCharacter?.armor_class ?? null;
            const draftAc = (() => {
              const value = Number((acDrafts[key] ?? "").trim());
              return Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
            })();
            const targetAc = knownAc ?? draftAc;
            return (
              <div className={styles.quickActionRow} key={key} data-testid={`quick-action-${key}`}>
                <span className={styles.quickActionName}>
                  {action.name}
                  {action.spellLevel !== null ? (
                    <Badge tone="purple">
                      {action.spellLevel === 0 ? "cantrip" : `level ${action.spellLevel}`}
                    </Badge>
                  ) : null}
                </span>
                <span className={styles.quickActionMeta}>
                  {action.damageNotation} · {action.rangeFeet} ft
                </span>
                {action.blockedReason ? (
                  <span
                    className={styles.blockedReason}
                    data-testid={`quick-action-blocked-${key}`}
                  >
                    {action.blockedReason}
                  </span>
                ) : null}
                {!canFire ? (
                  <span className={styles.quickActionControls}>
                    {override ? (
                      <span
                        className={styles.quickActionMeta}
                        data-testid={`quick-action-flagged-${key}`}
                      >
                        Flagged — waiting for the DM
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void flag(action)}
                        data-testid={`quick-action-flag-${key}`}
                      >
                        Flag to DM
                      </Button>
                    )}
                  </span>
                ) : (
                <span className={styles.quickActionControls}>
                  {action.targetTokenIds.length > 1 ? (
                    <select
                      className={styles.diceSelect}
                      aria-label={`Target for ${action.name}`}
                      value={selectedTokenId}
                      onChange={(event) =>
                        setTargetChoices((prev) => ({ ...prev, [key]: event.target.value }))
                      }
                      data-testid={`quick-action-target-${key}`}
                    >
                      {action.targetTokenIds.map((tokenId) => {
                        const candidate = tokens.find((token) => token.id === tokenId);
                        return candidate ? (
                          <option key={tokenId} value={tokenId}>
                            {tokenLabel(candidate)}
                          </option>
                        ) : null;
                      })}
                    </select>
                  ) : (
                    <span
                      className={styles.quickActionMeta}
                      data-testid={`quick-action-target-label-${key}`}
                    >
                      vs {tokenLabel(target)}
                    </span>
                  )}
                  {knownAc !== null ? (
                    <span
                      className={styles.quickActionMeta}
                      data-testid={`quick-action-known-ac-${key}`}
                    >
                      AC {knownAc}
                    </span>
                  ) : (
                    <input
                      className={styles.initiativeInput}
                      type="number"
                      min={1}
                      max={99}
                      placeholder="AC"
                      aria-label={`Armor class of ${tokenLabel(target)}`}
                      value={acDrafts[key] ?? ""}
                      onChange={(event) =>
                        setAcDrafts((prev) => ({ ...prev, [key]: event.target.value }))
                      }
                      data-testid={`quick-action-ac-${key}`}
                    />
                  )}
                  <Button
                    size="sm"
                    variant={override ? "teal" : "accent"}
                    disabled={busy || targetAc === null}
                    onClick={() => {
                      if (targetAc !== null)
                        void fire(action, target, targetAc, override ?? undefined);
                    }}
                    data-testid={
                      override
                        ? `quick-action-override-fire-${key}`
                        : `quick-action-fire-${key}`
                    }
                  >
                    {override ? "Use anyway (DM-approved)" : "Attack"}
                  </Button>
                </span>
                )}
              </div>
            );
          })}
        </>
      )}
      {error ? (
        <p role="alert" className={styles.errorText} data-testid="quick-actions-error">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
