"use client";

import { useMemo, useState } from "react";
import { Button } from "@/ui-components";
import type { Character, CombatCombatant, CombatEncounter } from "@/data-access";
import styles from "./room.module.css";

/** The active encounter plus its combatants, already in turn order (see
 * listCombatCombatants) so current_turn_index indexes straight into the
 * array. */
export interface CombatState {
  encounter: CombatEncounter;
  combatants: CombatCombatant[];
}

/**
 * The Game Room's combat side panel: a DM-only Start Combat control while
 * nothing is active; once active, the sorted turn order with the current
 * combatant highlighted, initiative entry (DM, or the combatant's owning
 * player), the advance-turn control (DM or the current combatant's owner),
 * and DM-only End Combat.
 */
export function CombatPanel({
  isDM,
  currentUserId,
  characters,
  combat,
  busy,
  error,
  onStart,
  onAdvance,
  onEnd,
  onSetInitiative,
}: {
  isDM: boolean;
  currentUserId: string;
  /** RLS-filtered per viewer: a player's own characters, or all for the DM. */
  characters: Character[];
  combat: CombatState | null;
  busy: boolean;
  error: string | null;
  onStart: () => void;
  onAdvance: () => void;
  onEnd: () => void;
  onSetInitiative: (combatant: CombatCombatant, initiative: number) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const characterById = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  );

  function combatantLabel(combatant: CombatCombatant): string {
    if (combatant.npc_name) return combatant.npc_name;
    // Same fallback as TokenPanel: another player's PC is unreadable under
    // characters RLS, so it lists without its name.
    return characterById.get(combatant.character_id ?? "")?.name ?? "Party member";
  }

  function ownsCombatant(combatant: CombatCombatant): boolean {
    const character = combatant.character_id ? characterById.get(combatant.character_id) : null;
    return character?.owner_id === currentUserId;
  }

  // Mirrors 0027's can_write_combatant, applied client-side so players
  // never see an input the RLS would reject.
  function canEnterInitiative(combatant: CombatCombatant): boolean {
    return isDM || ownsCombatant(combatant);
  }

  if (!combat) {
    if (!isDM) return null;
    return (
      <aside className={styles.combatPanel} data-testid="combat-panel">
        <span className={styles.panelLabel}>Combat</span>
        <Button size="sm" variant="accent" disabled={busy} onClick={onStart} data-testid="start-combat-button">
          Start combat
        </Button>
        <p className={styles.hint}>
          Every token on the live map joins the turn order when combat starts.
        </p>
        {error ? (
          <p role="alert" className={styles.errorText} data-testid="combat-error">
            {error}
          </p>
        ) : null}
      </aside>
    );
  }

  const { encounter, combatants } = combat;
  const currentIndex = Math.min(encounter.current_turn_index, Math.max(combatants.length - 1, 0));
  const current = combatants[currentIndex] ?? null;
  const canAdvance = isDM || (current !== null && ownsCombatant(current));

  function draftFor(combatant: CombatCombatant): string {
    return drafts[combatant.id] ?? (combatant.initiative !== null ? String(combatant.initiative) : "");
  }

  function parsedDraft(combatant: CombatCombatant): number | null {
    const raw = draftFor(combatant).trim();
    if (raw === "") return null;
    const value = Number(raw);
    return Number.isInteger(value) ? value : null;
  }

  return (
    <aside className={styles.combatPanel} data-testid="combat-panel">
      <div className={styles.objectHeader}>
        <span className={styles.panelLabel}>Combat</span>
        <span className={styles.combatRound} data-testid="combat-round">
          Round {encounter.round_number}
        </span>
      </div>

      <span className={styles.currentTurn} data-testid="current-turn-indicator">
        {current ? `${combatantLabel(current)}'s turn` : "No combatants"}
      </span>

      <div className={styles.tokenSection}>
        {combatants.map((combatant, index) => (
          <div
            key={combatant.id}
            className={
              index === currentIndex
                ? `${styles.combatantRow} ${styles.combatantCurrent}`
                : styles.combatantRow
            }
            data-testid={`combatant-row-${combatant.id}`}
          >
            <div className={styles.objectHeader}>
              <span className={styles.objectName}>{combatantLabel(combatant)}</span>
              <span className={styles.initiativeValue} data-testid={`combatant-initiative-${combatant.id}`}>
                {combatant.initiative !== null ? combatant.initiative : "—"}
              </span>
            </div>
            {canEnterInitiative(combatant) ? (
              <div className={styles.objectHeader}>
                <input
                  type="number"
                  className={styles.initiativeInput}
                  aria-label={`Initiative for ${combatantLabel(combatant)}`}
                  placeholder="Initiative"
                  value={draftFor(combatant)}
                  onChange={(event) =>
                    setDrafts((prev) => ({ ...prev, [combatant.id]: event.target.value }))
                  }
                  data-testid={`combatant-initiative-input-${combatant.id}`}
                />
                <Button
                  size="sm"
                  variant="teal"
                  disabled={
                    busy ||
                    parsedDraft(combatant) === null ||
                    parsedDraft(combatant) === combatant.initiative
                  }
                  onClick={() => {
                    const value = parsedDraft(combatant);
                    if (value === null) return;
                    setDrafts((prev) => {
                      const next = { ...prev };
                      delete next[combatant.id];
                      return next;
                    });
                    onSetInitiative(combatant, value);
                  }}
                  data-testid={`combatant-initiative-save-${combatant.id}`}
                >
                  Set
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className={styles.objectHeader}>
        {canAdvance ? (
          <Button size="sm" variant="teal" disabled={busy} onClick={onAdvance} data-testid="advance-turn-button">
            Advance turn
          </Button>
        ) : null}
        {isDM ? (
          <Button size="sm" variant="danger" disabled={busy} onClick={onEnd} data-testid="end-combat-button">
            End combat
          </Button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className={styles.errorText} data-testid="combat-error">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
