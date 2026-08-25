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
 * only. Its first (and so far only) section lists pending action_overrides
 * flags for the campaign — character, action, reason, requester — with
 * Approve/Deny resolving each via resolveOverride; the verdict reaches the
 * requesting player's blocked control and the shared log live through the
 * action_overrides postgres_changes feed. Resolving here never touches
 * resource counts: approval only unlocks the one flagged action, and
 * whether a use is still consumed stays the DM's separate, explicit call
 * through the existing resource controls.
 *
 * Deliberately a plain labeled panel with room for a sibling section:
 * Prompt 53's action-economy strictness toggle is specified to live right
 * next to this control, as another section of this same panel.
 */
export function DmOverridesPanel({
  campaignId,
  characters,
  members,
}: {
  campaignId: string;
  /** The DM reads every character row under RLS, so names resolve here. */
  characters: Character[];
  members: RoomMember[];
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
