"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Button } from "@/ui-components";
import {
  listOpportunityAttacks,
  resolveOpportunityAttack,
  setCombatantEconomyFlag,
  subscribeToOpportunityAttacks,
  type Character,
  type CombatCombatant,
  type OpportunityAttack,
  type RollLogEntry,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import {
  meleeWeaponItems,
  weaponRangeFeet,
  type AdvantageMode,
  type MeleeWeaponItem,
} from "@/rules-engine";
import { postRoll } from "../roll/api";
import { AdvantageToggle } from "./DiceLogPanel";
import type { CombatState } from "./CombatPanel";
import styles from "./room.module.css";

/**
 * The opportunity-attack prompts (Prompt 54): one banner per still-pending
 * offer in the active encounter, visible to the WHOLE table (the
 * death-save/concentration prompt pattern — everyone sees the ask) but
 * actionable only by the reactor's controller: the DM for an NPC reactor,
 * the owning player for a PC. Rows arrive from the mover's client
 * (GameRoom's drag-end detection) via the opportunity_attacks
 * postgres_changes feed, so a prompt lands — and disappears on
 * resolution — live in every open room.
 *
 * Taking it (PC reactor): pick one of the reactor's MELEE or FINESSE
 * weapon-tagged inventory items — never ranged weapons or spells (RAW 5e:
 * an opportunity attack is a melee attack), and deliberately with NO
 * range/reachability check at all: the attack resolves as if the target
 * were still in reach at the instant they left it, wherever the token
 * stands now. Firing sends the exact kind:"attack" postRoll request the
 * manual form and quick actions send (target = the mover; a readable PC
 * mover auto-fills AC, anything else takes the usual typed-in AC), then
 * marks reaction_used and resolves the row — the swing spends the
 * reaction whether it hits or not, the Prompt 53 miss-still-costs
 * reasoning; a roll REJECTED before it happens spends nothing, exactly
 * like the route's other rejected-roll paths. An NPC reactor has no
 * stats anywhere (stat blocks are Prompt 61), so its Take marks the
 * reaction spent and resolves the row while the DM rolls the swing by
 * hand through the dice panel, the same manual convention as every other
 * NPC attack. Declining resolves the row and touches nothing else.
 *
 * A reactor whose reaction is already spent is never offered a NEW
 * prompt (GameRoom's detection excludes them), but a second prompt
 * created EARLIER this turn can still be pending when the first is taken
 * — its Take goes unavailable with a clear reason (the live combat state
 * is the authority) while Decline stays open, so the stale offer can
 * always be cleared.
 */
export function OpportunityAttackPanel({
  campaignId,
  currentUserId,
  isDM,
  characters,
  combat,
  onRollLanded,
  onReactionSpent,
}: {
  campaignId: string;
  currentUserId: string;
  isDM: boolean;
  /** RLS-filtered per viewer: a player's own characters, or all for the DM. */
  characters: Character[];
  combat: CombatState | null;
  /** The room's post-roll hook (refresh HP + combat poke after the attack). */
  onRollLanded: (roll: RollLogEntry) => void;
  /** Refresh + poke after reaction_used flips without a roll (the NPC
   * mark-taken path — the PC path's roll already triggers onRollLanded). */
  onReactionSpent: () => void;
}) {
  // Tagged with the encounter the rows belong to (the QuickActionsPanel
  // resourceState arrangement), so an encounter change shows nothing
  // rather than the previous fight's stale offers while the refetch is in
  // flight — no state writes needed in the effect body itself.
  const [rowState, setRowState] = useState<{
    encounterId: string;
    rows: OpportunityAttack[];
  } | null>(null);
  const [mode, setMode] = useState<AdvantageMode>("normal");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [weaponChoices, setWeaponChoices] = useState<Record<string, string>>({});
  const [acDrafts, setAcDrafts] = useState<Record<string, string>>({});

  const encounterId = combat?.encounter.id ?? null;

  const upsertRow = (row: OpportunityAttack) => {
    setRowState((state) =>
      state && state.encounterId === row.encounter_id
        ? {
            ...state,
            rows: state.rows.some((existing) => existing.id === row.id)
              ? state.rows.map((existing) => (existing.id === row.id ? row : existing))
              : [...state.rows, row],
          }
        : state
    );
  };

  // Fetched per encounter and kept fresh by the postgres_changes feed —
  // the QuickActionsPanel overrides arrangement, so a reactor's
  // controller who reloads mid-prompt still sees it.
  useEffect(() => {
    if (!encounterId) return;
    const supabase = createBrowserSupabaseClient();
    let cancelled = false;
    listOpportunityAttacks(supabase, encounterId)
      .then((fetched) => {
        if (!cancelled) setRowState({ encounterId, rows: fetched });
      })
      .catch(() => undefined);
    const unsubscribe = subscribeToOpportunityAttacks(supabase, campaignId, (row) => {
      if (!cancelled) upsertRow(row);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [campaignId, encounterId]);

  const characterById = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  );
  const combatantById = useMemo(
    () => new Map((combat?.combatants ?? []).map((combatant) => [combatant.id, combatant])),
    [combat]
  );

  const pending = useMemo(
    () =>
      encounterId && rowState && rowState.encounterId === encounterId
        ? rowState.rows.filter((row) => row.status === "pending")
        : [],
    [rowState, encounterId]
  );

  if (!combat || pending.length === 0) return null;

  function combatantLabel(combatant: CombatCombatant): string {
    if (combatant.npc_name) return combatant.npc_name;
    // The TokenPanel/CombatPanel fallback: another player's PC is
    // unreadable under characters RLS, so it shows without its name.
    return characterById.get(combatant.character_id ?? "")?.name ?? "Party member";
  }

  function ownsCombatant(combatant: CombatCombatant): boolean {
    const character = combatant.character_id ? characterById.get(combatant.character_id) : null;
    return character?.owner_id === currentUserId;
  }

  function applyResolved(row: OpportunityAttack) {
    upsertRow(row);
  }

  async function decline(row: OpportunityAttack) {
    if (busyId) return;
    setBusyId(row.id);
    setError(null);
    try {
      // Leaves the reaction untouched by design — declining costs nothing.
      applyResolved(await resolveOpportunityAttack(createBrowserSupabaseClient(), row.id, false));
    } catch {
      setError("Could not decline — it may already be resolved.");
    } finally {
      setBusyId(null);
    }
  }

  /** The NPC-reactor take: no stats exist to roll with (Prompt 61's
   * scope), so the swing is spent and recorded while the DM rolls it by
   * hand — the same manual convention as every other NPC attack. */
  async function takeAsNpc(row: OpportunityAttack, reactor: CombatCombatant) {
    if (busyId) return;
    if (reactor.reaction_used) {
      setError(`${combatantLabel(reactor)} has no reaction left this turn.`);
      return;
    }
    setBusyId(row.id);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      await setCombatantEconomyFlag(supabase, reactor.id, "reaction_used", true);
      applyResolved(await resolveOpportunityAttack(supabase, row.id, true));
      onReactionSpent();
    } catch {
      setError("Could not take that opportunity attack — try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function takeAsPc(
    row: OpportunityAttack,
    reactor: CombatCombatant,
    reactorCharacter: Character,
    weapon: MeleeWeaponItem,
    mover: CombatCombatant,
    targetAc: number
  ) {
    if (busyId) return;
    // The two-pending-prompts guard: a second offer created before the
    // first spent the reaction re-checks the LIVE combatant state at
    // fire time — the Take control below is already disabled once the
    // refresh lands, this catches the race before it.
    if (reactor.reaction_used) {
      setError(`${reactorCharacter.name} has no reaction left this turn.`);
      return;
    }
    setBusyId(row.id);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      // The exact request shape the manual form and quick actions send —
      // an opportunity attack IS an ordinary attack roll, pre-filled.
      const roll = await postRoll(campaignId, {
        kind: "attack",
        characterId: reactorCharacter.id,
        attackKind: weapon.attackKind,
        damageNotation: weapon.damageNotation,
        targetAc,
        targetCharacterId: mover.character_id,
        targetName: combatantLabel(mover),
        mode,
      });
      // The roll happened, so the reaction is spent — hit or miss, the
      // Prompt 53 miss-still-costs-the-action reasoning applied to
      // reactions. (A postRoll rejection threw above and spent nothing.)
      await setCombatantEconomyFlag(supabase, reactor.id, "reaction_used", true);
      applyResolved(await resolveOpportunityAttack(supabase, row.id, true));
      onRollLanded(roll);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The opportunity attack failed — try again."
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <aside className={styles.opportunityPanel} data-testid="opportunity-attack-panel">
      <span className={styles.panelLabel}>Opportunity attacks</span>
      {pending.map((row) => {
        const reactor = combatantById.get(row.reactor_combatant_id) ?? null;
        const mover = combatantById.get(row.mover_combatant_id) ?? null;
        // A combatant deleted since the offer (its token removed) leaves
        // nothing to resolve against — the row cascades away with it.
        if (!reactor || !mover) return null;
        const canAct = isDM || ownsCombatant(reactor);
        const reactorCharacter = reactor.character_id
          ? (characterById.get(reactor.character_id) ?? null)
          : null;
        const reactionSpent = reactor.reaction_used;
        const weapons = reactorCharacter ? meleeWeaponItems(reactorCharacter.inventory) : [];
        const chosenName = weaponChoices[row.id];
        const weapon =
          weapons.find((item) => item.name === chosenName) ?? weapons[0] ?? null;
        const moverCharacter = mover.character_id
          ? (characterById.get(mover.character_id) ?? null)
          : null;
        // The established AC convention: auto-filled only for a readable
        // PC target; an NPC (or unreadable PC) mover takes a typed AC.
        const knownAc = moverCharacter?.armor_class ?? null;
        const draftAc = (() => {
          const value = Number((acDrafts[row.id] ?? "").trim());
          return Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
        })();
        const targetAc = knownAc ?? draftAc;
        return (
          <div
            key={row.id}
            className={styles.opportunityPrompt}
            data-testid={`opportunity-prompt-${row.id}`}
          >
            <span className={styles.deathSavePromptText}>
              <Badge tone="red">Opportunity attack</Badge> {combatantLabel(mover)} moved out of{" "}
              {combatantLabel(reactor)}&apos;s reach
            </span>
            {canAct ? (
              reactionSpent ? (
                // The stale second prompt: its reaction went to an earlier
                // take (or a manual mark) — Take is off the table with the
                // reason spelled out, Decline clears the offer.
                <span className={styles.quickActionControls}>
                  <span
                    className={styles.blockedReason}
                    data-testid={`opportunity-no-reaction-${row.id}`}
                  >
                    Reaction already spent this turn
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId !== null}
                    onClick={() => void decline(row)}
                    data-testid={`opportunity-decline-${row.id}`}
                  >
                    Decline
                  </Button>
                </span>
              ) : reactorCharacter ? (
                <span className={styles.quickActionControls}>
                  {weapon === null ? (
                    <span
                      className={styles.blockedReason}
                      data-testid={`opportunity-no-weapon-${row.id}`}
                    >
                      No melee or finesse weapon tagged
                    </span>
                  ) : (
                    <>
                      {weapons.length > 1 ? (
                        <select
                          className={styles.diceSelect}
                          aria-label={`Weapon for ${reactorCharacter.name}'s opportunity attack`}
                          value={weapon.name}
                          onChange={(event) =>
                            setWeaponChoices((prev) => ({ ...prev, [row.id]: event.target.value }))
                          }
                          data-testid={`opportunity-weapon-${row.id}`}
                        >
                          {weapons.map((item) => (
                            <option key={item.name} value={item.name}>
                              {item.name} ({item.damageNotation})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className={styles.quickActionMeta}
                          data-testid={`opportunity-weapon-label-${row.id}`}
                        >
                          {weapon.name} · {weapon.damageNotation} ·{" "}
                          {weaponRangeFeet(weapon)} ft reach
                        </span>
                      )}
                      {knownAc !== null ? (
                        <span
                          className={styles.quickActionMeta}
                          data-testid={`opportunity-known-ac-${row.id}`}
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
                          aria-label={`Armor class of ${combatantLabel(mover)}`}
                          value={acDrafts[row.id] ?? ""}
                          onChange={(event) =>
                            setAcDrafts((prev) => ({ ...prev, [row.id]: event.target.value }))
                          }
                          data-testid={`opportunity-ac-${row.id}`}
                        />
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busyId !== null || targetAc === null}
                        onClick={() => {
                          if (targetAc !== null) {
                            void takeAsPc(row, reactor, reactorCharacter, weapon, mover, targetAc);
                          }
                        }}
                        data-testid={`opportunity-take-${row.id}`}
                      >
                        Take the attack
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId !== null}
                    onClick={() => void decline(row)}
                    data-testid={`opportunity-decline-${row.id}`}
                  >
                    Decline
                  </Button>
                </span>
              ) : (
                // NPC reactor: no stat block exists anywhere yet, so the
                // take spends the reaction and records the swing while the
                // roll itself stays manual — the dice panel, like every
                // other NPC attack until Prompt 61.
                <span className={styles.quickActionControls}>
                  <span className={styles.quickActionMeta}>
                    Roll the NPC&apos;s swing from the dice panel
                  </span>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId !== null}
                    onClick={() => void takeAsNpc(row, reactor)}
                    data-testid={`opportunity-take-${row.id}`}
                  >
                    Take (spends reaction)
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId !== null}
                    onClick={() => void decline(row)}
                    data-testid={`opportunity-decline-${row.id}`}
                  >
                    Decline
                  </Button>
                </span>
              )
            ) : (
              <span
                className={styles.quickActionMeta}
                data-testid={`opportunity-waiting-${row.id}`}
              >
                Waiting on {combatantLabel(reactor)}&apos;s controller…
              </span>
            )}
          </div>
        );
      })}
      {pending.some(
        (row) => {
          const reactor = combatantById.get(row.reactor_combatant_id);
          return (
            reactor !== undefined &&
            (isDM || ownsCombatant(reactor)) &&
            !reactor.reaction_used &&
            reactor.character_id !== null
          );
        }
      ) ? (
        <AdvantageToggle
          mode={mode}
          onChange={setMode}
          disabled={busyId !== null}
          testIdPrefix="opportunity"
        />
      ) : null}
      {error ? (
        <p role="alert" className={styles.errorText} data-testid="opportunity-attack-error">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
