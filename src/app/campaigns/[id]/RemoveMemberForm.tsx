"use client";

import { useState, useActionState } from "react";
import { Button } from "@/ui-components";
import { removeCampaignMemberAction } from "./actions";
import type { FormActionState } from "../../actions";
import type { CampaignMember } from "@/data-access";
import styles from "./campaign.module.css";

const initialState: FormActionState = {};

/**
 * One player's own "Remove" control — the CampaignManageRow "delete
 * campaign" two-step confirm shape exactly (a `confirming` flag gates a
 * real are-you-sure step before anything destructive fires; a single click
 * never removes anyone on its own), and the same `.bind(null, ...)` +
 * useActionState wiring deleteCampaignAction/leaveCampaignAction already
 * use for a fully-bound, no-extra-form-fields destructive action — both
 * campaignId AND the target member's user_id are baked into the bound
 * action itself here, never a user-editable form field.
 */
function RemoveMemberRow({
  campaignId,
  member,
  characterNames,
}: {
  campaignId: string;
  member: { user_id: string; display_name: string | null };
  characterNames: string[];
}) {
  const [state, formAction, isPending] = useActionState(
    removeCampaignMemberAction.bind(null, campaignId, member.user_id),
    initialState
  );
  const [confirming, setConfirming] = useState(false);

  const displayName = member.display_name ?? "Unnamed player";
  const characterClause =
    characterNames.length === 0
      ? "They don't have a character in this campaign yet."
      : `Their character${characterNames.length > 1 ? "s" : ""} (${characterNames.join(", ")}) will be permanently deleted too.`;

  return (
    <div className={styles.manageRow} data-testid={`remove-member-row-${member.user_id}`}>
      <div className={styles.manageHeader}>
        <span>{displayName}</span>
      </div>
      {confirming ? (
        <form action={formAction} className={styles.actionRow}>
          <span className={styles.confirmHint} data-testid={`remove-member-confirm-hint-${member.user_id}`}>
            Remove {displayName} from this campaign? {characterClause} This can&apos;t be undone.
          </span>
          <Button
            type="submit"
            variant="danger"
            size="sm"
            disabled={isPending}
            data-testid={`remove-member-confirm-${member.user_id}`}
          >
            {isPending ? "Removing…" : "Confirm remove"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => setConfirming(false)}
            data-testid={`remove-member-cancel-${member.user_id}`}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className={styles.actionRow}>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => setConfirming(true)}
            data-testid={`remove-member-button-${member.user_id}`}
          >
            Remove
          </Button>
        </div>
      )}
      {state.error ? (
        <p role="alert" className={styles.errorText} data-testid={`remove-member-error-${member.user_id}`}>
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * DM-only "Remove a player" list — the TransferDMForm precedent for which
 * members are eligible (`players`, already excluding the DM themself at the
 * call site), rendered as its own confirm-gated row per player rather than
 * a single dropdown+button, since each row needs its own independent
 * confirm state and its own character-names message.
 */
export function RemoveMemberForm({
  campaignId,
  players,
  charactersByOwner,
}: {
  campaignId: string;
  players: CampaignMember[];
  charactersByOwner: Record<string, string[]>;
}) {
  if (players.length === 0) {
    return null;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {players.map((member) => (
        <RemoveMemberRow
          key={member.user_id}
          campaignId={campaignId}
          member={member}
          characterNames={charactersByOwner[member.user_id] ?? []}
        />
      ))}
    </div>
  );
}
