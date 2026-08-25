"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/ui-components";
import {
  subscribeToRollLog,
  type Character,
  type MapToken,
  type RollLogEntry,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { CLASSES, type AdvantageMode, type AttackKind } from "@/rules-engine";
import { postRoll } from "../roll/api";
import { damageText, rollDetail, rollHeadline } from "../roll/format";
import type { RoomMember } from "./avatar-url";
import styles from "./room.module.css";

const ATTACK_KIND_LABEL: Record<AttackKind, string> = {
  melee: "Melee",
  ranged: "Ranged",
  finesse: "Finesse",
  spell: "Spell",
};

const MODE_LABEL: Record<AdvantageMode, string> = {
  normal: "Normal",
  advantage: "Advantage",
  disadvantage: "Disadvantage",
};

const MODES: AdvantageMode[] = ["normal", "advantage", "disadvantage"];

const LOG_CAP = 50;

/** A shared three-state advantage/disadvantage picker — the manual toggle
 * required on every d20 roll surface. */
export function AdvantageToggle({
  mode,
  onChange,
  disabled,
  testIdPrefix,
}: {
  mode: AdvantageMode;
  onChange: (mode: AdvantageMode) => void;
  disabled?: boolean;
  testIdPrefix: string;
}) {
  return (
    <div className={styles.modeToggle} role="group" aria-label="Advantage mode">
      {MODES.map((candidate) => (
        <button
          key={candidate}
          type="button"
          className={[styles.modeButton, candidate === mode ? styles.modeButtonActive : ""]
            .filter(Boolean)
            .join(" ")}
          aria-pressed={candidate === mode}
          disabled={disabled}
          onClick={() => onChange(candidate)}
          data-testid={`${testIdPrefix}-mode-${candidate}`}
        >
          {MODE_LABEL[candidate]}
        </button>
      ))}
    </div>
  );
}

/**
 * The Game Room's shared dice panel: the campaign roll log (live via a
 * postgres_changes subscription on roll_log — NOT the room's campaign
 * broadcast channel, so rolls made from the character sheet page arrive
 * here too), a free-form roller, and the attack flow. Target AC is entered
 * manually — NPCs have no stored AC anywhere yet — with a convenience
 * auto-fill when the target is a PC whose row the roller can read.
 */
export function DiceLogPanel({
  campaignId,
  currentUserId,
  isDM,
  characters,
  tokens,
  members,
  initialRolls,
  onRollLanded,
}: {
  campaignId: string;
  currentUserId: string;
  isDM: boolean;
  /** RLS-filtered per viewer: a player's own characters, or all for the DM. */
  characters: Character[];
  tokens: MapToken[];
  members: RoomMember[];
  initialRolls: RollLogEntry[];
  /** Fired after this client's own roll persists (subscription echoes are
   * handled internally) — the room uses it to refresh HP after applied
   * attack damage. */
  onRollLanded: (roll: RollLogEntry) => void;
}) {
  const [rolls, setRolls] = useState<RollLogEntry[]>(initialRolls);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [notation, setNotation] = useState("");

  const attackers = useMemo(
    () => characters.filter((character) => isDM || character.owner_id === currentUserId),
    [characters, isDM, currentUserId]
  );
  const [attackerId, setAttackerId] = useState("");
  const attacker = attackers.find((candidate) => candidate.id === attackerId) ?? null;
  const [attackKind, setAttackKind] = useState<AttackKind>("melee");
  const [damageNotation, setDamageNotation] = useState("1d6");
  const [targetTokenId, setTargetTokenId] = useState("");
  const [acDraft, setAcDraft] = useState("");
  const [mode, setMode] = useState<AdvantageMode>("normal");

  const characterById = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  );

  const memberNameById = useMemo(
    () => new Map(members.map((member) => [member.user_id, member.display_name])),
    [members]
  );

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    return subscribeToRollLog(supabase, campaignId, (roll) => {
      setRolls((current) =>
        current.some((candidate) => candidate.id === roll.id)
          ? current
          : [roll, ...current].slice(0, LOG_CAP)
      );
    });
  }, [campaignId]);

  function tokenLabel(token: MapToken): string {
    if (token.npc_name) return token.npc_name;
    // Same fallback as TokenPanel: another player's PC is unreadable under
    // characters RLS, so it lists without its name.
    return characterById.get(token.character_id ?? "")?.name ?? "Party member";
  }

  const targetToken = tokens.find((candidate) => candidate.id === targetTokenId) ?? null;
  const spellCapable = attacker
    ? Boolean(CLASSES.find((c) => c.name === attacker.class)?.spellcastingAbility)
    : false;

  function selectTarget(tokenId: string) {
    setTargetTokenId(tokenId);
    const token = tokens.find((candidate) => candidate.id === tokenId) ?? null;
    const targetCharacter = token?.character_id
      ? (characterById.get(token.character_id) ?? null)
      : null;
    // Convenience only — an unreadable PC or any NPC still needs the AC
    // typed in by hand.
    if (targetCharacter) setAcDraft(String(targetCharacter.armor_class));
  }

  async function run(action: () => Promise<RollLogEntry>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const roll = await action();
      setRolls((current) =>
        current.some((candidate) => candidate.id === roll.id)
          ? current
          : [roll, ...current].slice(0, LOG_CAP)
      );
      onRollLanded(roll);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The roll failed — try again.");
    } finally {
      setBusy(false);
    }
  }

  const parsedAc = (() => {
    const value = Number(acDraft.trim());
    return Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
  })();

  const canAttack =
    attacker !== null && parsedAc !== null && damageNotation.trim() !== "" && !busy;

  return (
    <aside className={styles.dicePanel} data-testid="dice-log-panel">
      <span className={styles.panelLabel}>Dice</span>

      <form
        className={styles.objectHeader}
        onSubmit={(event) => {
          event.preventDefault();
          if (notation.trim() === "") return;
          void run(() => postRoll(campaignId, { kind: "freeform", notation: notation.trim() }));
        }}
      >
        <input
          className={styles.initiativeInput}
          placeholder="e.g. 2d6+3"
          aria-label="Free-form dice expression"
          value={notation}
          onChange={(event) => setNotation(event.target.value)}
          data-testid="freeform-notation-input"
        />
        <Button
          size="sm"
          variant="teal"
          type="submit"
          disabled={busy || notation.trim() === ""}
          data-testid="freeform-roll-button"
        >
          Roll
        </Button>
      </form>

      {attackers.length > 0 ? (
        <div className={styles.attackForm} data-testid="attack-form">
          <span className={styles.diceSectionLabel}>Attack</span>
          <div className={styles.attackRow}>
            <select
              className={styles.diceSelect}
              aria-label="Attacking character"
              value={attackerId}
              onChange={(event) => {
                setAttackerId(event.target.value);
                if (attackKind === "spell") setAttackKind("melee");
              }}
              data-testid="attack-attacker-select"
            >
              <option value="">Attacker…</option>
              {attackers.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
            <select
              className={styles.diceSelect}
              aria-label="Attack kind"
              value={attackKind}
              onChange={(event) => setAttackKind(event.target.value as AttackKind)}
              data-testid="attack-kind-select"
            >
              {(Object.keys(ATTACK_KIND_LABEL) as AttackKind[]).map((kind) => (
                <option key={kind} value={kind} disabled={kind === "spell" && !spellCapable}>
                  {ATTACK_KIND_LABEL[kind]}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.attackRow}>
            <select
              className={styles.diceSelect}
              aria-label="Target"
              value={targetTokenId}
              onChange={(event) => selectTarget(event.target.value)}
              data-testid="attack-target-select"
            >
              <option value="">Target (optional)…</option>
              {tokens.map((token) => (
                <option key={token.id} value={token.id}>
                  {tokenLabel(token)}
                </option>
              ))}
            </select>
            <input
              className={styles.initiativeInput}
              type="number"
              min={1}
              max={99}
              placeholder="AC"
              aria-label="Target armor class"
              value={acDraft}
              onChange={(event) => setAcDraft(event.target.value)}
              data-testid="attack-target-ac-input"
            />
            <input
              className={styles.initiativeInput}
              placeholder="1d6"
              aria-label="Damage dice"
              value={damageNotation}
              onChange={(event) => setDamageNotation(event.target.value)}
              data-testid="attack-damage-input"
            />
          </div>
          <div className={styles.attackRow}>
            <AdvantageToggle mode={mode} onChange={setMode} disabled={busy} testIdPrefix="attack" />
            <Button
              size="sm"
              variant="accent"
              disabled={!canAttack}
              onClick={() => {
                if (!attacker || parsedAc === null) return;
                void run(() =>
                  postRoll(campaignId, {
                    kind: "attack",
                    characterId: attacker.id,
                    attackKind,
                    damageNotation: damageNotation.trim(),
                    targetAc: parsedAc,
                    targetCharacterId: targetToken?.character_id ?? null,
                    targetName: targetToken ? tokenLabel(targetToken) : null,
                    mode,
                  })
                );
              }}
              data-testid="attack-roll-button"
            >
              Roll attack
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className={styles.errorText} data-testid="dice-error">
          {error}
        </p>
      ) : null}

      <div className={styles.rollList} data-testid="dice-log">
        {rolls.length === 0 ? (
          <p className={styles.hint}>No rolls yet — the whole table sees every roll here.</p>
        ) : (
          rolls.map((roll) => {
            const damageLine =
              roll.breakdown.type === "d20" && roll.breakdown.attack
                ? damageText(roll.breakdown.attack)
                : null;
            return (
              <div key={roll.id} className={styles.rollEntry} data-testid={`roll-entry-${roll.id}`}>
                <span className={styles.rollMeta}>
                  {memberNameById.get(roll.roller_user_id) ?? "Someone"}
                </span>
                <span className={styles.rollHeadline}>{rollHeadline(roll)}</span>
                <span className={styles.rollDetail} data-testid={`roll-detail-${roll.id}`}>
                  {rollDetail(roll)}
                </span>
                {damageLine ? (
                  <span className={styles.rollDetail} data-testid={`roll-damage-${roll.id}`}>
                    {damageLine}
                  </span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
