"use client";

import { useState, useActionState } from "react";
import Link from "next/link";
import { Badge, Button, TextInput } from "@/ui-components";
import { renameCampaignAction, deleteCampaignAction, leaveCampaignAction } from "./actions";
import type { FormActionState } from "../actions";
import type { CampaignMembership } from "@/data-access";
import styles from "./account.module.css";

const initialState: FormActionState = {};

export function CampaignManageRow({ membership }: { membership: CampaignMembership }) {
  const { role, campaign } = membership;
  const [renameState, renameAction, renamePending] = useActionState(
    renameCampaignAction.bind(null, campaign.id),
    initialState
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteCampaignAction.bind(null, campaign.id),
    initialState
  );
  const [leaveState, leaveAction, leavePending] = useActionState(
    leaveCampaignAction.bind(null, campaign.id),
    initialState
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <div className={styles.manageRow}>
      <div className={styles.manageHeader}>
        <Link href={`/campaigns/${campaign.id}`} className={styles.campaignName}>
          {campaign.name}
        </Link>
        <Badge tone={role === "dm" ? "pink" : "teal"}>{role === "dm" ? "DM" : "Player"}</Badge>
      </div>

      {role === "dm" ? (
        <>
          <form action={renameAction} className={styles.renameForm}>
            <TextInput
              label="Campaign name"
              name="name"
              required
              defaultValue={campaign.name}
              error={renameState.error}
              disabled={renamePending}
              className={styles.renameField}
            />
            <Button type="submit" variant="teal" size="sm" disabled={renamePending}>
              {renamePending ? "Renaming…" : "Rename"}
            </Button>
          </form>
          {confirming ? (
            <form action={deleteAction} className={styles.actionRow}>
              <span className={styles.confirmHint}>
                Delete “{campaign.name}” and everything in it? This can&apos;t be undone.
              </span>
              <Button type="submit" variant="danger" size="sm" disabled={deletePending}>
                {deletePending ? "Deleting…" : "Confirm delete"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={deletePending}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <div className={styles.actionRow}>
              <Button type="button" variant="danger" size="sm" onClick={() => setConfirming(true)}>
                Delete campaign
              </Button>
            </div>
          )}
          {deleteState.error ? (
            <p role="alert" className={styles.errorText}>
              {deleteState.error}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {confirming ? (
            <form action={leaveAction} className={styles.actionRow}>
              <span className={styles.confirmHint}>Leave “{campaign.name}”?</span>
              <Button type="submit" variant="danger" size="sm" disabled={leavePending}>
                {leavePending ? "Leaving…" : "Confirm leave"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={leavePending}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <div className={styles.actionRow}>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                Leave campaign
              </Button>
            </div>
          )}
          {leaveState.error ? (
            <p role="alert" className={styles.errorText}>
              {leaveState.error}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
