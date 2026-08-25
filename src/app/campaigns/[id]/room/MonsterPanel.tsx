"use client";

import { useState } from "react";
import { Badge, Button } from "@/ui-components";
import type { MonsterAttack, MonsterStatBlock, Npc } from "@/data-access";
import styles from "./room.module.css";

/** One attack row's form drafts — parsed/validated only on save. */
interface AttackDraft {
  name: string;
  bonus: string;
  damageNotation: string;
}

const EMPTY_ATTACK: AttackDraft = { name: "", bonus: "", damageNotation: "" };

/**
 * The DM's monster tooling (Prompt 61), a DM-ONLY side panel (GameRoom
 * never renders it for players, and 0038's RLS rejects a non-DM hitting
 * the table directly regardless): create/edit/list the campaign's
 * lightweight stat blocks — name, HP, AC, passive Perception, and a small
 * repeatable list of attacks (name + flat bonus + damage notation, the
 * numbers the roll route uses directly) — deliberately nothing like full
 * character creation. "Start from roster NPC" pre-fills the name from a
 * Prompt 33 narrative NPC rather than re-typing it (the task's own
 * "promote" convenience — a name pre-fill, nothing more). Each block's
 * "Quick add" arms the ordinary grid-click token placement; GameRoom
 * finishes the flow — placing the token (npc_name populated from the
 * block's name, monster_stat_block_id linked) and, if combat is active,
 * prompting for initiative and seating the combatant via add_combatant in
 * the same gesture. With no combat running, placement alone is the whole
 * action.
 */
export function MonsterPanel({
  statBlocks,
  rosterNpcs,
  combatActive,
  busy,
  error,
  onCreate,
  onUpdate,
  onDelete,
  onQuickAdd,
  className,
}: {
  statBlocks: MonsterStatBlock[];
  /** The Prompt 33 narrative roster, for the name pre-fill convenience. */
  rosterNpcs: Npc[];
  combatActive: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (params: {
    name: string;
    maxHp: number;
    armorClass: number;
    passivePerception: number;
    attacks: MonsterAttack[];
  }) => void;
  onUpdate: (
    statBlockId: string,
    patch: {
      name: string;
      max_hp: number;
      armor_class: number;
      passive_perception: number;
      attacks: MonsterAttack[];
    }
  ) => void;
  onDelete: (statBlock: MonsterStatBlock) => void;
  /** Arms grid-click placement for this block's token (GameRoom). */
  onQuickAdd: (statBlock: MonsterStatBlock) => void;
  /** Appended to the root `<aside>` — Phase C's DmToolPeel uses this for
   * its reveal-entrance animation, applied directly here rather than on a
   * wrapping div (a transform-based animation on a wrapper would become a
   * new CSS containing block for this `position: absolute` root,
   * relocating it relative to the wrapper instead of the room stage for
   * the animation's duration — see DmToolPeel.tsx). */
  className?: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [maxHp, setMaxHp] = useState("");
  const [armorClass, setArmorClass] = useState("");
  const [passivePerception, setPassivePerception] = useState("10");
  const [attackDrafts, setAttackDrafts] = useState<AttackDraft[]>([{ ...EMPTY_ATTACK }]);
  const [rosterPick, setRosterPick] = useState("");

  function resetForm() {
    setEditingId(null);
    setName("");
    setMaxHp("");
    setArmorClass("");
    setPassivePerception("10");
    setAttackDrafts([{ ...EMPTY_ATTACK }]);
    setRosterPick("");
  }

  function loadForEdit(statBlock: MonsterStatBlock) {
    setEditingId(statBlock.id);
    setName(statBlock.name);
    setMaxHp(String(statBlock.max_hp));
    setArmorClass(String(statBlock.armor_class));
    setPassivePerception(String(statBlock.passive_perception));
    setAttackDrafts(
      statBlock.attacks.length > 0
        ? statBlock.attacks.map((attack) => ({
            name: attack.name,
            bonus: String(attack.bonus),
            damageNotation: attack.damageNotation,
          }))
        : [{ ...EMPTY_ATTACK }]
    );
  }

  function positiveInt(raw: string): number | null {
    const value = Number(raw.trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  /** Parsed attacks, or null while any partially-filled row is invalid.
   * Fully-empty rows are simply dropped — a block with no attacks is
   * legal (it can still be placed, fought, hidden from). */
  function parsedAttacks(): MonsterAttack[] | null {
    const attacks: MonsterAttack[] = [];
    for (const draft of attackDrafts) {
      const empty =
        draft.name.trim() === "" && draft.bonus.trim() === "" && draft.damageNotation.trim() === "";
      if (empty) continue;
      const bonus = Number(draft.bonus.trim());
      if (draft.name.trim() === "" || !Number.isInteger(bonus) || draft.damageNotation.trim() === "") {
        return null;
      }
      attacks.push({
        name: draft.name.trim(),
        bonus,
        damageNotation: draft.damageNotation.trim(),
      });
    }
    return attacks;
  }

  const parsedHp = positiveInt(maxHp);
  const parsedAc = positiveInt(armorClass);
  const parsedPp = positiveInt(passivePerception);
  const attacks = parsedAttacks();
  const canSave =
    !busy && name.trim() !== "" && parsedHp !== null && parsedAc !== null && parsedPp !== null && attacks !== null;

  function save() {
    if (!canSave || parsedHp === null || parsedAc === null || parsedPp === null || attacks === null) {
      return;
    }
    if (editingId) {
      onUpdate(editingId, {
        name: name.trim(),
        max_hp: parsedHp,
        armor_class: parsedAc,
        passive_perception: parsedPp,
        attacks,
      });
    } else {
      onCreate({
        name: name.trim(),
        maxHp: parsedHp,
        armorClass: parsedAc,
        passivePerception: parsedPp,
        attacks,
      });
    }
    resetForm();
  }

  return (
    <aside
      className={[styles.monsterPanel, className].filter(Boolean).join(" ")}
      data-testid="monster-panel"
    >
      <div className={styles.objectHeader}>
        <span className={styles.panelLabel}>Monsters</span>
        <Badge tone="red">DM only</Badge>
      </div>

      {statBlocks.length === 0 ? (
        <p className={styles.hint}>No stat blocks yet — stat one up below.</p>
      ) : (
        <div className={styles.tokenSection}>
          {statBlocks.map((statBlock) => (
            <div
              key={statBlock.id}
              className={styles.objectRow}
              data-testid={`stat-block-${statBlock.id}`}
            >
              <div className={styles.objectHeader}>
                <span className={styles.objectName}>{statBlock.name}</span>
                <span className={styles.quickActionMeta}>
                  HP {statBlock.max_hp} · AC {statBlock.armor_class} · PP{" "}
                  {statBlock.passive_perception}
                </span>
              </div>
              {statBlock.attacks.length > 0 ? (
                <span className={styles.quickActionMeta}>
                  {statBlock.attacks
                    .map(
                      (attack) =>
                        `${attack.name} ${attack.bonus >= 0 ? "+" : ""}${attack.bonus} (${attack.damageNotation})`
                    )
                    .join(" · ")}
                </span>
              ) : null}
              <div className={styles.objectHeader}>
                <Button
                  size="sm"
                  variant="accent"
                  disabled={busy}
                  onClick={() => onQuickAdd(statBlock)}
                  data-testid={`quick-add-${statBlock.id}`}
                >
                  Quick add
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => loadForEdit(statBlock)}
                  data-testid={`edit-stat-block-${statBlock.id}`}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => onDelete(statBlock)}
                  data-testid={`delete-stat-block-${statBlock.id}`}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className={styles.hint}>
        Quick add places the token by grid click
        {combatActive ? ", then asks for its initiative to join the fight" : ""}.
      </p>

      <div className={styles.tokenSection} data-testid="stat-block-form">
        <span className={styles.diceSectionLabel}>
          {editingId ? "Edit stat block" : "New stat block"}
        </span>
        {rosterNpcs.length > 0 && !editingId ? (
          // The Prompt 33 promote convenience: pre-fill the name from a
          // roster NPC instead of re-typing it. A pre-fill only, on
          // purpose — the roster row is untouched.
          <select
            className={styles.diceSelect}
            aria-label="Start from roster NPC"
            value={rosterPick}
            onChange={(event) => {
              setRosterPick(event.target.value);
              const npc = rosterNpcs.find((candidate) => candidate.id === event.target.value);
              if (npc) setName(npc.name);
            }}
            data-testid="stat-block-roster-select"
          >
            <option value="">Start from roster NPC…</option>
            {rosterNpcs.map((npc) => (
              <option key={npc.id} value={npc.id}>
                {npc.name}
              </option>
            ))}
          </select>
        ) : null}
        <div className={styles.objectHeader}>
          <input
            className={styles.initiativeInput}
            placeholder="Name"
            aria-label="Stat block name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="stat-block-name-input"
          />
          <input
            className={styles.initiativeInput}
            type="number"
            min={1}
            placeholder="HP"
            aria-label="Maximum HP"
            value={maxHp}
            onChange={(event) => setMaxHp(event.target.value)}
            data-testid="stat-block-hp-input"
          />
          <input
            className={styles.initiativeInput}
            type="number"
            min={1}
            max={99}
            placeholder="AC"
            aria-label="Armor class"
            value={armorClass}
            onChange={(event) => setArmorClass(event.target.value)}
            data-testid="stat-block-ac-input"
          />
          <input
            className={styles.initiativeInput}
            type="number"
            min={1}
            placeholder="PP"
            aria-label="Passive Perception"
            value={passivePerception}
            onChange={(event) => setPassivePerception(event.target.value)}
            data-testid="stat-block-pp-input"
          />
        </div>
        {attackDrafts.map((draft, index) => (
          <div className={styles.objectHeader} key={index}>
            <input
              className={styles.initiativeInput}
              placeholder="Attack name"
              aria-label={`Attack ${index + 1} name`}
              value={draft.name}
              onChange={(event) =>
                setAttackDrafts((drafts) =>
                  drafts.map((row, i) => (i === index ? { ...row, name: event.target.value } : row))
                )
              }
              data-testid={`stat-block-attack-name-${index}`}
            />
            <input
              className={styles.initiativeInput}
              type="number"
              placeholder="Bonus"
              aria-label={`Attack ${index + 1} bonus`}
              value={draft.bonus}
              onChange={(event) =>
                setAttackDrafts((drafts) =>
                  drafts.map((row, i) => (i === index ? { ...row, bonus: event.target.value } : row))
                )
              }
              data-testid={`stat-block-attack-bonus-${index}`}
            />
            <input
              className={styles.initiativeInput}
              placeholder="1d6+2"
              aria-label={`Attack ${index + 1} damage`}
              value={draft.damageNotation}
              onChange={(event) =>
                setAttackDrafts((drafts) =>
                  drafts.map((row, i) =>
                    i === index ? { ...row, damageNotation: event.target.value } : row
                  )
                )
              }
              data-testid={`stat-block-attack-damage-${index}`}
            />
            {attackDrafts.length > 1 ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setAttackDrafts((drafts) => drafts.filter((_, i) => i !== index))}
                aria-label={`Remove attack ${index + 1}`}
                data-testid={`stat-block-attack-remove-${index}`}
              >
                −
              </Button>
            ) : null}
          </div>
        ))}
        <div className={styles.objectHeader}>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setAttackDrafts((drafts) => [...drafts, { ...EMPTY_ATTACK }])}
            data-testid="stat-block-attack-add"
          >
            + Attack
          </Button>
          <Button
            size="sm"
            variant="accent"
            disabled={!canSave}
            onClick={save}
            data-testid="stat-block-save"
          >
            {editingId ? "Save changes" : "Create stat block"}
          </Button>
          {editingId ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={resetForm}
              data-testid="stat-block-cancel-edit"
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className={styles.errorText} data-testid="monster-panel-error">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
