"use client";

import { Button } from "@/ui-components";
import { useHostGame } from "../../hostGame";
import styles from "./campaign.module.css";

/** The campaign page's own "Host a game" — same flow as Home's picker. */
export function HostThisGameButton({
  campaignId,
  campaignName,
  currentUserId,
  currentUserDisplayName,
  currentUserIsDM,
}: {
  campaignId: string;
  campaignName: string;
  currentUserId: string;
  currentUserDisplayName: string | null;
  currentUserIsDM: boolean;
}) {
  const { host, hostingId, error } = useHostGame({ userId: currentUserId, displayName: currentUserDisplayName });
  return (
    <span className={styles.hostControl}>
      <Button
        variant="primary"
        disabled={hostingId !== null}
        onClick={() => void host({ id: campaignId, name: campaignName })}
        title={currentUserIsDM ? undefined : "Hosting makes you this campaign's DM for the session"}
        data-testid="host-this-game"
      >
        {hostingId ? "Opening…" : "Host a game"}
      </Button>
      {error ? (
        <span role="alert" className={styles.errorText}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
