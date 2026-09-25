"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Button, Modal } from "@/ui-components";
import { useHostGame } from "./hostGame";
import styles from "./page.module.css";

export interface HostableCampaign {
  id: string;
  name: string;
  /** A game is already running (or paused) — offer Join instead of Host. */
  inProgress: boolean;
}

/**
 * "Host a game": pick one of your campaigns to open a session for. You
 * become its DM for the night and go straight to the table; everyone else in
 * the campaign gets an invitation to join (see LobbyProvider).
 */
export function HostGameControl({
  currentUserId,
  currentUserDisplayName,
  campaigns,
}: {
  currentUserId: string;
  currentUserDisplayName: string | null;
  campaigns: HostableCampaign[];
}) {
  const [open, setOpen] = useState(false);
  const { host, hostingId, error } = useHostGame({ userId: currentUserId, displayName: currentUserDisplayName });

  return (
    <div className={styles.startControl}>
      <Button
        variant="primary"
        size="lg"
        disabled={campaigns.length === 0}
        onClick={() => setOpen(true)}
        data-testid="start-session-button"
      >
        Host a game
      </Button>
      {campaigns.length === 0 ? (
        <p className={styles.startHint}>Create or join a campaign below to host a game.</p>
      ) : null}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Host a game"
        footer={
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        }
      >
        <p className={styles.startModalHint}>
          Pick a campaign to open for tonight. You&apos;ll be its DM for the session and go straight to the table
          — everyone else in the campaign gets an invitation to join.
        </p>
        <ul className={styles.startList}>
          {campaigns.map((campaign) => (
            <li key={campaign.id} className={styles.startRow}>
              <span className={styles.startName}>{campaign.name}</span>
              <span className={styles.startRowActions}>
                {campaign.inProgress ? (
                  <>
                    <Badge tone="teal" pulse>
                      In progress
                    </Badge>
                    <Link
                      href={`/campaigns/${campaign.id}/room`}
                      className={styles.primaryAction}
                      data-testid={`join-campaign-${campaign.id}`}
                    >
                      Join
                    </Link>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={hostingId !== null}
                    onClick={() => void host(campaign)}
                    data-testid={`start-campaign-${campaign.id}`}
                  >
                    {hostingId === campaign.id ? "Opening…" : "Host"}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {error ? (
          <p role="alert" className={styles.startError} data-testid="start-session-error">
            {error}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
