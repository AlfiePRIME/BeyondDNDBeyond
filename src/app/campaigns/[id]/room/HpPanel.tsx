"use client";

import { useState } from "react";
import { Button } from "@/ui-components";
import type { Character } from "@/data-access";
import styles from "./room.module.css";

/**
 * Freeform combat mode's direct "edit my current HP" control: a player
 * types their character's new current HP (e.g. 10 instead of 15 after
 * taking 5 damage) right here in the Game Room, rather than the app
 * computing and applying damage automatically. That's the DM's stated
 * table model for Freeform — verbal/table-decided outcomes, the app just
 * tracks the number — and it's the opposite of Strict mode's whole point
 * (server-computed damage via resolve_attack_damage/apply_hp_delta), so
 * this panel renders NOTHING when the campaign is Strict: a silent
 * self-edit there would undermine exactly what a Strict table chose the
 * mode for. Authorization needs no new grant: the characters UPDATE RLS
 * (0008, owner or campaign DM) already lets a player write their OWN
 * current_hp, and the characters_current_hp_in_range CHECK (0028) is the
 * same [0, max_hp] backstop apply_hp_delta relies on — this control is
 * purely the missing UI, confirmed by reading the RLS/CHECK directly
 * rather than assumed. Deliberately its own small independent panel (not
 * folded into CombatPanel or the full character sheet): it must work with
 * no active combat running at all (a player hurt between fights), and
 * "not buried three clicks deep in the sheet" was the explicit ask.
 */
export function HpPanel({
  characters,
  currentUserId,
  strict,
  busy,
  error,
  onSetHp,
}: {
  /** RLS-filtered per viewer already (own characters, or every character
   * for the DM) — narrowed again below to the viewer's OWN characters: a
   * DM looking at someone else's character never gets a self-edit control
   * for it here (CombatPanel's existing DM Damage/Heal control already
   * covers that, unchanged). */
  characters: Character[];
  currentUserId: string;
  /** The campaign's live action-economy mode — Freeform-only (renders
   * nothing when true), the room's shared economyStrict state. */
  strict: boolean;
  busy: boolean;
  error: string | null;
  onSetHp: (character: Character, value: number) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const own = characters.filter((character) => character.owner_id === currentUserId);

  if (strict || own.length === 0) return null;

  function draftFor(character: Character): string {
    return drafts[character.id] ?? String(character.current_hp);
  }

  // Respects the same [0, max_hp] range the characters_current_hp_in_range
  // CHECK enforces server-side — this is a UX nicety (disable the button
  // on an out-of-range draft) rather than the real backstop.
  function parsedValue(character: Character): number | null {
    const raw = draftFor(character).trim();
    if (raw === "") return null;
    const value = Number(raw);
    if (!Number.isInteger(value)) return null;
    if (value < 0 || value > character.max_hp) return null;
    return value;
  }

  return (
    <aside className={styles.hpPanel} data-testid="hp-panel">
      <span className={styles.panelLabel}>My HP</span>
      {own.map((character) => {
        const value = parsedValue(character);
        return (
          <form
            key={character.id}
            className={styles.objectHeader}
            data-testid={`hp-panel-row-${character.id}`}
            onSubmit={(event) => {
              event.preventDefault();
              if (value === null || value === character.current_hp) return;
              onSetHp(character, value);
            }}
          >
            <span className={styles.objectName}>{character.name}</span>
            <input
              type="number"
              min={0}
              max={character.max_hp}
              className={styles.initiativeInput}
              aria-label={`${character.name}'s current HP`}
              value={draftFor(character)}
              onChange={(event) =>
                setDrafts((prev) => ({ ...prev, [character.id]: event.target.value }))
              }
              data-testid={`hp-panel-input-${character.id}`}
            />
            <span className={styles.hpValue}>/ {character.max_hp}</span>
            <Button
              size="sm"
              variant="teal"
              type="submit"
              disabled={busy || value === null || value === character.current_hp}
              data-testid={`hp-panel-save-${character.id}`}
            >
              Set HP
            </Button>
          </form>
        );
      })}
      {error ? (
        <p role="alert" className={styles.errorText} data-testid="hp-panel-error">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
