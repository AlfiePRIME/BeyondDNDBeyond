"use client";

import { useMemo, useState } from "react";
import { Badge, Button } from "@/ui-components";
import type {
  Character,
  CombatCombatant,
  CombatEncounter,
  CombatantCondition,
  CombatantEconomyFlag,
} from "@/data-access";
import {
  CONDITIONS,
  CONDITION_BY_KEY,
  EXHAUSTION_KEY,
  MAX_EXHAUSTION_LEVEL,
  type AdvantageMode,
  type ConditionKey,
} from "@/rules-engine";
import { AdvantageToggle } from "./DiceLogPanel";
import styles from "./room.module.css";

/** The active encounter plus its combatants, already in turn order (see
 * listCombatCombatants) so current_turn_index indexes straight into the
 * array, and every combatant's applied conditions (as of Prompt 47). */
export interface CombatState {
  encounter: CombatEncounter;
  combatants: CombatCombatant[];
  conditions: CombatantCondition[];
}

/**
 * The Game Room's combat side panel: a DM-only Start Combat control while
 * nothing is active; once active, the sorted turn order with the current
 * combatant highlighted, initiative entry (DM, or the combatant's owning
 * player), the advance-turn control (DM or the current combatant's owner),
 * and DM-only End Combat. As of Prompt 46, clicking a combatant selects it,
 * and a selected PC combatant reveals the damage/heal control (DM, or the
 * combatant's owning player — the same rule as initiative entry). NPC
 * combatants have no HP anywhere yet, so they get no such control. As of
 * Prompt 47, every combatant's active conditions show as badges on its
 * row, and selecting a combatant the viewer may write (same DM-or-owner
 * rule; NPCs fall to the DM) reveals on/off toggles for the 14 SRD
 * conditions plus the exhaustion level stepper. As of Prompt 48 each
 * combatant also gets a Roll button — server-side d20 + DEX via the dice
 * roller, honoring the panel's advantage toggle — with manual entry kept
 * alongside for flexibility. As of Prompt 49 every 0-HP PC combatant's row
 * shows its death-save state (successes/failures tally, or Stable/Dead) so
 * the DM has whole-party visibility, and the CURRENT combatant — when
 * dying and actionable by this viewer (DM or owner) — gets a prominent
 * roll-death-save call-to-action. The turn-based prompt is a UI nicety
 * only: the RPC/route is deliberately not turn-gated, matching how
 * checks/saves/attacks aren't either (the table self-polices). As of
 * Prompt 50 a concentrating PC combatant's row shows what it's
 * concentrating on (table-wide, the death-save-state visibility
 * reasoning), and a pending concentration check gets the same prominent
 * roll prompt — NOT gated to the current turn, unlike the death-save
 * prompt: the check is triggered by damage on ANY turn. As of Prompt 53
 * the header carries the campaign's action-economy mode badge (Strict/
 * Freeform — table-wide visibility, the death-save-state reasoning:
 * every player must see the current enforcement mode, not just the DM
 * who sets it in the DM Controls panel), and the CURRENT combatant gets
 * a live economy readout — Action/Bonus Action/Reaction used-or-
 * available plus movement used this turn against the character's speed
 * — visible to everyone, with manual "mark used" controls for the bonus
 * action and reaction (nothing consumes either automatically yet;
 * reactions proper are Prompt 54) actionable only by the DM or the
 * combatant's owner. In Strict mode a spent mark can't be un-marked
 * until advance_turn's reset at that combatant's next turn; in Freeform
 * it toggles freely — tracked state only, never a block.
 */
export function CombatPanel({
  isDM,
  currentUserId,
  characters,
  combat,
  busy,
  error,
  strict,
  onStart,
  onAdvance,
  onEnd,
  onSetInitiative,
  onRollInitiative,
  onApplyHp,
  onToggleCondition,
  onExhaustionDelta,
  onRollDeathSave,
  onRollConcentrationSave,
  onToggleEconomyFlag,
}: {
  isDM: boolean;
  currentUserId: string;
  /** RLS-filtered per viewer: a player's own characters, or all for the DM. */
  characters: Character[];
  combat: CombatState | null;
  busy: boolean;
  error: string | null;
  /** The campaign's live action-economy mode (Prompt 53). */
  strict: boolean;
  onStart: () => void;
  onAdvance: () => void;
  onEnd: () => void;
  onSetInitiative: (combatant: CombatCombatant, initiative: number) => void;
  /** Server-side d20 + DEX via the Prompt 48 dice roller; mode carries the
   * panel's advantage toggle. */
  onRollInitiative: (combatant: CombatCombatant, mode: AdvantageMode) => void;
  /** Negative = damage, positive = heal (see applyHpDelta). */
  onApplyHp: (combatant: CombatCombatant, delta: number) => void;
  /** active true applies the condition, false removes it. */
  onToggleCondition: (combatant: CombatCombatant, key: ConditionKey, active: boolean) => void;
  /** +1/-1 steps through apply_exhaustion_delta; clamped 0-6 server-side. */
  onExhaustionDelta: (combatant: CombatCombatant, delta: number) => void;
  /** Posts kind: "death_save" via the roll route — a plain server-rolled
   * d20, no modifiers, no advantage toggle. */
  onRollDeathSave: (combatant: CombatCombatant) => void;
  /** Posts kind: "concentration_save" via the roll route — a plain
   * server-rolled d20 + CON save bonus against the stored pending DC. */
  onRollConcentrationSave: (combatant: CombatCombatant) => void;
  /** The manual bonus-action/reaction marks — a plain can_write_combatant
   * update; action_used/movement move only through the roll route and
   * move_combat_token. */
  onToggleEconomyFlag: (
    combatant: CombatCombatant,
    flag: CombatantEconomyFlag,
    used: boolean
  ) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedCombatantId, setSelectedCombatantId] = useState<string | null>(null);
  const [hpAmounts, setHpAmounts] = useState<Record<string, string>>({});
  const [d20Mode, setD20Mode] = useState<AdvantageMode>("normal");

  const characterById = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  );

  const conditionsByCombatant = useMemo(() => {
    const grouped = new Map<string, CombatantCondition[]>();
    for (const condition of combat?.conditions ?? []) {
      const list = grouped.get(condition.combatant_id) ?? [];
      list.push(condition);
      grouped.set(condition.combatant_id, list);
    }
    return grouped;
  }, [combat]);

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

  // Same DM-or-owner rule as initiative (it's also exactly 0008's
  // characters UPDATE policy, which authorizes apply_hp_delta), plus the
  // PC-only restriction: an NPC combatant has no HP field to change.
  function canApplyHp(combatant: CombatCombatant): boolean {
    return combatant.character_id !== null && (isDM || ownsCombatant(combatant));
  }

  function combatantHp(combatant: CombatCombatant): { current: number; max: number } | null {
    const character = combatant.character_id ? characterById.get(combatant.character_id) : null;
    return character ? { current: character.current_hp, max: character.max_hp } : null;
  }

  // The linked character row, when the viewer can read it under RLS —
  // same lookup combatantHp rides on; null for NPCs and for other
  // players' PCs, whose death-save state the viewer can't see anyway.
  function combatantCharacter(combatant: CombatCombatant): Character | null {
    return combatant.character_id ? (characterById.get(combatant.character_id) ?? null) : null;
  }

  // Eligible to roll a death save right now: dying at exactly 0 HP,
  // neither stable nor dead.
  function isDying(character: Character): boolean {
    return character.current_hp === 0 && !character.is_stable && !character.is_dead;
  }

  // The same DM-or-owner rule as initiative, WITHOUT canApplyHp's PC-only
  // restriction: an NPC can be poisoned or prone just fine — its rows just
  // fall to the DM, since ownsCombatant is false by construction.
  function canEditConditions(combatant: CombatCombatant): boolean {
    return isDM || ownsCombatant(combatant);
  }

  function hasCondition(combatant: CombatCombatant, key: ConditionKey): boolean {
    return (conditionsByCombatant.get(combatant.id) ?? []).some(
      (condition) => condition.condition_key === key
    );
  }

  function exhaustionLevel(combatant: CombatCombatant): number {
    return (
      (conditionsByCombatant.get(combatant.id) ?? []).find(
        (condition) => condition.condition_key === EXHAUSTION_KEY
      )?.level ?? 0
    );
  }

  if (!combat) {
    if (!isDM) return null;
    return (
      <aside className={styles.combatPanel} data-testid="combat-panel">
        <div className={styles.objectHeader}>
          <span className={styles.panelLabel}>Combat</span>
          <Badge tone={strict ? "orange" : "teal"} data-testid="economy-mode-badge">
            {strict ? "Strict" : "Freeform"}
          </Badge>
        </div>
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

  // Always a positive amount — direction comes from the Damage/Heal button
  // pressed, never from the player typing a sign.
  function parsedHpAmount(combatant: CombatCombatant): number | null {
    const value = Number((hpAmounts[combatant.id] ?? "").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  return (
    <aside className={styles.combatPanel} data-testid="combat-panel">
      <div className={styles.objectHeader}>
        <span className={styles.panelLabel}>Combat</span>
        {/* Table-wide mode visibility: every player sees the current
            enforcement mode here, not just the DM in DM Controls. */}
        <Badge tone={strict ? "orange" : "teal"} data-testid="economy-mode-badge">
          {strict ? "Strict" : "Freeform"}
        </Badge>
        <span className={styles.combatRound} data-testid="combat-round">
          Round {encounter.round_number}
        </span>
      </div>

      <span className={styles.currentTurn} data-testid="current-turn-indicator">
        {current ? `${combatantLabel(current)}'s turn` : "No combatants"}
      </span>

      {current ? (
        // The live action-economy readout (Prompt 53) for the CURRENT
        // combatant, visible to everyone at the table like the death-save
        // state. Movement shows against the character's speed when the
        // viewer can read it (owner or DM under RLS); an NPC or an
        // unreadable PC just shows feet used.
        <div className={styles.economyReadout} data-testid="action-economy-readout">
          <div className={styles.economyRow}>
            <Badge tone={current.action_used ? "red" : "teal"} data-testid="economy-action">
              {current.action_used ? "Action used" : "Action available"}
            </Badge>
            <Badge
              tone={current.bonus_action_used ? "red" : "teal"}
              data-testid="economy-bonus-action"
            >
              {current.bonus_action_used ? "Bonus action used" : "Bonus action available"}
            </Badge>
            <Badge tone={current.reaction_used ? "red" : "teal"} data-testid="economy-reaction">
              {current.reaction_used ? "Reaction used" : "Reaction available"}
            </Badge>
          </div>
          <span className={styles.economyMovement} data-testid="economy-movement">
            {(() => {
              const speed = combatantCharacter(current)?.speed;
              return `Movement: ${current.movement_used_feet}${
                speed !== undefined ? ` / ${speed}` : ""
              } ft used this turn`;
            })()}
          </span>
          {isDM || ownsCombatant(current) ? (
            <div className={styles.economyRow}>
              {(
                [
                  ["bonus_action_used", "bonus action", "economy-mark-bonus-action"],
                  ["reaction_used", "reaction", "economy-mark-reaction"],
                ] as const
              ).map(([flag, label, testId]) => {
                const used = current[flag];
                // Strict: once spent, the mark locks until advance_turn's
                // reset at this combatant's next turn. Freeform: a free
                // toggle — tracked state only, nothing is ever blocked.
                const locked = strict && used;
                return (
                  <Button
                    key={flag}
                    size="sm"
                    variant="ghost"
                    disabled={busy || locked}
                    onClick={() => onToggleEconomyFlag(current, flag, !used)}
                    data-testid={testId}
                  >
                    {used
                      ? locked
                        ? `${label.charAt(0).toUpperCase()}${label.slice(1)} spent`
                        : `Clear ${label}`
                      : `Mark ${label} used`}
                  </Button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {combatants.some((combatant) => canEnterInitiative(combatant)) ? (
        <AdvantageToggle
          mode={d20Mode}
          onChange={setD20Mode}
          disabled={busy}
          testIdPrefix="initiative"
        />
      ) : null}

      <div className={styles.tokenSection}>
        {combatants.map((combatant, index) => {
          const hp = combatantHp(combatant);
          const selected = combatant.id === selectedCombatantId;
          const character = combatantCharacter(combatant);
          return (
          <div
            key={combatant.id}
            className={[
              styles.combatantRow,
              index === currentIndex ? styles.combatantCurrent : "",
              selected ? styles.combatantSelected : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-testid={`combatant-row-${combatant.id}`}
          >
            <button
              type="button"
              className={styles.combatantSelect}
              onClick={() => setSelectedCombatantId(selected ? null : combatant.id)}
              aria-pressed={selected}
              data-testid={`combatant-select-${combatant.id}`}
            >
              <span className={styles.objectName}>{combatantLabel(combatant)}</span>
              {hp ? (
                <span className={styles.hpValue} data-testid={`combatant-hp-${combatant.id}`}>
                  {hp.current}/{hp.max} HP
                </span>
              ) : null}
              <span className={styles.initiativeValue} data-testid={`combatant-initiative-${combatant.id}`}>
                {combatant.initiative !== null ? combatant.initiative : "—"}
              </span>
            </button>
            {character && character.current_hp === 0 ? (
              // Shown on EVERY 0-HP row, not just the current turn's — the
              // DM needs death-save visibility across the whole party.
              <div className={styles.deathSaveState} data-testid={`death-save-state-${combatant.id}`}>
                {character.is_dead ? (
                  <Badge tone="red" data-testid={`death-save-dead-${combatant.id}`}>
                    Dead
                  </Badge>
                ) : character.is_stable ? (
                  <Badge tone="teal" data-testid={`death-save-stable-${combatant.id}`}>
                    Stable
                  </Badge>
                ) : (
                  <>
                    <Badge tone="red">Dying</Badge>
                    <span
                      className={styles.deathSaveTally}
                      data-testid={`death-save-tally-${combatant.id}`}
                    >
                      ✓ {character.death_save_successes}/3 · ✗ {character.death_save_failures}/3
                    </span>
                  </>
                )}
              </div>
            ) : null}
            {character && character.concentrating_on !== null ? (
              // Table-wide like the death-save state — concentration is
              // relevant to everyone, not turn-gated.
              <div
                className={styles.concentrationState}
                data-testid={`concentration-state-${combatant.id}`}
              >
                <Badge tone="purple" data-testid={`concentration-badge-${combatant.id}`}>
                  Concentrating
                </Badge>
                <span className={styles.concentrationSpell}>{character.concentrating_on}</span>
              </div>
            ) : null}
            {character &&
            character.pending_concentration_dc !== null &&
            (isDM || ownsCombatant(combatant)) ? (
              // The damage-triggered call-to-action, the death-save
              // prompt's visual shape — but deliberately NOT gated to the
              // current turn: a concentration check can be triggered by
              // damage on any turn, not just this character's own.
              <div
                className={styles.concentrationPrompt}
                data-testid={`concentration-prompt-${combatant.id}`}
              >
                <span className={styles.deathSavePromptText}>
                  {combatantLabel(combatant)} took damage — roll a concentration save (DC{" "}
                  {character.pending_concentration_dc})
                </span>
                <Button
                  size="sm"
                  variant="accent"
                  disabled={busy}
                  onClick={() => onRollConcentrationSave(combatant)}
                  data-testid={`roll-concentration-save-${combatant.id}`}
                >
                  Roll concentration save
                </Button>
              </div>
            ) : null}
            {character &&
            isDying(character) &&
            index === currentIndex &&
            (isDM || ownsCombatant(combatant)) ? (
              // The turn-start call-to-action — deliberately louder than
              // the HP/condition controls. UI nicety only; the route/RPC
              // never checks whose turn it is.
              <div
                className={styles.deathSavePrompt}
                data-testid={`death-save-prompt-${combatant.id}`}
              >
                <span className={styles.deathSavePromptText}>
                  {combatantLabel(combatant)} is dying — roll a death save
                </span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => onRollDeathSave(combatant)}
                  data-testid={`roll-death-save-${combatant.id}`}
                >
                  Roll death save
                </Button>
              </div>
            ) : null}
            {(conditionsByCombatant.get(combatant.id) ?? []).length > 0 ? (
              <div
                className={styles.conditionBadges}
                data-testid={`combatant-conditions-${combatant.id}`}
              >
                {(conditionsByCombatant.get(combatant.id) ?? []).map((condition) => (
                  <Badge
                    key={condition.condition_key}
                    tone="orange"
                    data-testid={`condition-badge-${condition.condition_key}-${combatant.id}`}
                  >
                    {condition.condition_key === EXHAUSTION_KEY
                      ? `Exhaustion ${condition.level}`
                      : (CONDITION_BY_KEY.get(condition.condition_key as ConditionKey)?.name ??
                        condition.condition_key)}
                  </Badge>
                ))}
              </div>
            ) : null}
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
                <Button
                  size="sm"
                  variant="accent"
                  disabled={busy}
                  onClick={() => onRollInitiative(combatant, d20Mode)}
                  data-testid={`combatant-roll-initiative-${combatant.id}`}
                >
                  Roll
                </Button>
              </div>
            ) : null}
            {selected && canApplyHp(combatant) ? (
              <div className={styles.objectHeader} data-testid={`hp-controls-${combatant.id}`}>
                <input
                  type="number"
                  min={1}
                  className={styles.initiativeInput}
                  aria-label={`Damage or healing amount for ${combatantLabel(combatant)}`}
                  placeholder="Amount"
                  value={hpAmounts[combatant.id] ?? ""}
                  onChange={(event) =>
                    setHpAmounts((prev) => ({ ...prev, [combatant.id]: event.target.value }))
                  }
                  data-testid={`hp-amount-input-${combatant.id}`}
                />
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy || parsedHpAmount(combatant) === null}
                  onClick={() => {
                    const amount = parsedHpAmount(combatant);
                    if (amount !== null) onApplyHp(combatant, -amount);
                  }}
                  data-testid={`apply-damage-${combatant.id}`}
                >
                  Damage
                </Button>
                <Button
                  size="sm"
                  variant="teal"
                  disabled={busy || parsedHpAmount(combatant) === null}
                  onClick={() => {
                    const amount = parsedHpAmount(combatant);
                    if (amount !== null) onApplyHp(combatant, amount);
                  }}
                  data-testid={`apply-heal-${combatant.id}`}
                >
                  Heal
                </Button>
              </div>
            ) : null}
            {selected && canEditConditions(combatant) ? (
              <div className={styles.conditionControls} data-testid={`condition-controls-${combatant.id}`}>
                <div className={styles.conditionToggles}>
                  {CONDITIONS.map((definition) => {
                    const active = hasCondition(combatant, definition.key);
                    return (
                      <button
                        key={definition.key}
                        type="button"
                        className={[
                          styles.conditionToggle,
                          active ? styles.conditionToggleActive : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        aria-pressed={active}
                        title={definition.description}
                        disabled={busy}
                        onClick={() => onToggleCondition(combatant, definition.key, !active)}
                        data-testid={`condition-toggle-${definition.key}-${combatant.id}`}
                      >
                        {definition.name}
                      </button>
                    );
                  })}
                </div>
                <div className={styles.exhaustionRow}>
                  <span className={styles.exhaustionLabel}>Exhaustion</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || exhaustionLevel(combatant) <= 0}
                    onClick={() => onExhaustionDelta(combatant, -1)}
                    aria-label={`Lower ${combatantLabel(combatant)}'s exhaustion`}
                    data-testid={`exhaustion-decrease-${combatant.id}`}
                  >
                    −
                  </Button>
                  <span
                    className={styles.exhaustionValue}
                    data-testid={`exhaustion-level-${combatant.id}`}
                  >
                    {exhaustionLevel(combatant)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || exhaustionLevel(combatant) >= MAX_EXHAUSTION_LEVEL}
                    onClick={() => onExhaustionDelta(combatant, 1)}
                    aria-label={`Raise ${combatantLabel(combatant)}'s exhaustion`}
                    data-testid={`exhaustion-increase-${combatant.id}`}
                  >
                    +
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
          );
        })}
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
