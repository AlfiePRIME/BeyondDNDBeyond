"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/ui-components";
import {
  listActionOverrides,
  resolveOverride,
  subscribeToActionOverrides,
  type ActionOverride,
  type Character,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import type { RoomMember } from "./avatar-url";
import styles from "./room.module.css";

/**
 * The DM Controls panel (Prompt 52) — mounted by the Game Room for the DM
 * only. Its first section lists pending action_overrides flags for the
 * campaign — character, action, reason, requester — with Approve/Deny
 * resolving each via resolveOverride; the verdict reaches the requesting
 * player's blocked control and the shared log live through the
 * action_overrides postgres_changes feed. Resolving here never touches
 * resource counts: approval only unlocks the one flagged action, and
 * whether a use is still consumed stays the DM's separate, explicit call
 * through the existing resource controls.
 *
 * As of Prompt 53 the sibling section this panel was built to receive:
 * the action-economy enforcement toggle. Strict (normal 5e rules)
 * hard-blocks a second action and over-speed movement in combat; Freeform
 * still tracks and displays usage but never blocks. The state itself
 * lives in the Game Room (campaigns.action_economy_strict, live via the
 * campaigns postgres_changes feed) — this section only renders the dial,
 * so the rule-override list and the toggle stay one coherent panel. It
 * complements the per-action override above rather than replacing it:
 * overrides are one-off resource exceptions, this is the campaign-level
 * dial for the whole action-economy structure. Every player sees the
 * current mode via the combat panel's badge; only the DM sees this dial.
 */
export function DmOverridesPanel({
  campaignId,
  characters,
  members,
  strict,
  strictBusy,
  strictError,
  onSetStrict,
}: {
  campaignId: string;
  /** The DM reads every character row under RLS, so names resolve here. */
  characters: Character[];
  members: RoomMember[];
  strict: boolean;
  strictBusy: boolean;
  strictError: string | null;
  onSetStrict: (strict: boolean) => void;
}) {
  const [overrides, setOverrides] = useState<ActionOverride[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const characterNameById = useMemo(
    () => new Map(characters.map((character) => [character.id, character.name])),
    [characters]
  );
  const memberNameById = useMemo(
    () => new Map(members.map((member) => [member.user_id, member.display_name])),
    [members]
  );

  const pending = overrides.filter((override) => override.status === "pending");

  async function resolve(override: ActionOverride, approved: boolean) {
    if (busyId) return;
    setBusyId(override.id);
    setError(null);
    try {
      const resolved = await resolveOverride(createBrowserSupabaseClient(), override.id, approved);
      setOverrides((current) => [
        resolved,
        ...current.filter((existing) => existing.id !== resolved.id),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resolve the flag — try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <aside className={styles.dmControlsPanel} data-testid="dm-controls-panel">
      <span className={styles.panelLabel}>DM Controls</span>
      <div className={styles.dmControlsSection} data-testid="dm-economy-section">
        <span className={styles.diceSectionLabel}>Action economy</span>
        <div className={styles.modeToggle} role="group" aria-label="Action economy enforcement">
          <button
            type="button"
            className={[styles.modeButton, strict ? styles.modeButtonActive : ""]
              .filter(Boolean)
              .join(" ")}
            aria-pressed={strict}
            disabled={strictBusy}
            onClick={() => {
              if (!strict) onSetStrict(true);
            }}
            data-testid="economy-strict-button"
          >
            Strict
          </button>
          <button
            type="button"
            className={[styles.modeButton, !strict ? styles.modeButtonActive : ""]
              .filter(Boolean)
              .join(" ")}
            aria-pressed={!strict}
            disabled={strictBusy}
            onClick={() => {
              if (strict) onSetStrict(false);
            }}
            data-testid="economy-freeform-button"
          >
            Freeform
          </button>
        </div>
        <p className={styles.hint}>
          {strict
            ? "Strict: one action per turn and movement capped at speed — blocked with a clear reason."
            : "Freeform: usage is tracked and shown for reference, but nothing is ever blocked."}
        </p>
        {strictError ? (
          <p role="alert" className={styles.errorText} data-testid="dm-economy-error">
            {strictError}
          </p>
        ) : null}
      </div>
      <div className={styles.dmControlsSection} data-testid="dm-overrides-section">
        <span className={styles.diceSectionLabel}>Rule overrides</span>
        {pending.length === 0 ? (
          <p className={styles.hint} data-testid="dm-overrides-empty">
            No flagged actions. When a player flags a blocked action, it appears here to
            approve or deny.
          </p>
        ) : (
          pending.map((override) => (
            <div
              key={override.id}
              className={styles.rollEntry}
              data-testid={`dm-override-${override.id}`}
            >
              <span className={styles.rollMeta}>
                {memberNameById.get(override.requested_by) ?? "Someone"} ·{" "}
                {characterNameById.get(override.character_id) ?? "Unknown character"}
              </span>
              <span className={styles.rollHeadline}>{override.action_label}</span>
              <span className={styles.rollDetail}>{override.reason}</span>
              <span className={styles.quickActionControls}>
                <Button
                  size="sm"
                  variant="teal"
                  disabled={busyId !== null}
                  onClick={() => void resolve(override, true)}
                  data-testid={`dm-override-approve-${override.id}`}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busyId !== null}
                  onClick={() => void resolve(override, false)}
                  data-testid={`dm-override-deny-${override.id}`}
                >
                  Deny
                </Button>
              </span>
            </div>
          ))
        )}
      </div>
      {error ? (
        <p role="alert" className={styles.errorText} data-testid="dm-overrides-error">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
