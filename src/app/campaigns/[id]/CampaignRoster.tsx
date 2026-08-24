"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/ui-components";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { joinCampaignChannel, type CampaignConnectionState } from "@/realtime";
import type { CampaignMember } from "@/data-access";
import styles from "./campaign.module.css";

// How long the "Reconnected" confirmation stays up after recovery before fading back to nothing
// — long enough to notice, short enough not to linger once the roster is trustworthy again.
const RECONNECTED_CONFIRMATION_MS = 4000;

export function CampaignRoster({
  campaignId,
  currentUserId,
  currentUserDisplayName,
  members,
}: {
  campaignId: string;
  currentUserId: string;
  currentUserDisplayName: string | null;
  members: CampaignMember[];
}) {
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [connectionState, setConnectionState] = useState<CampaignConnectionState>("connecting");
  const [justReconnected, setJustReconnected] = useState(false);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const channel = joinCampaignChannel(supabase, campaignId, {
      userId: currentUserId,
      displayName: currentUserDisplayName,
    });

    const unsubscribePresence = channel.onPresenceChange((present) => {
      setOnlineUserIds(new Set(present.map((member) => member.userId)));
    });

    // Only a transition INTO "reconnecting" (not the initial "connecting") should arm the
    // post-recovery confirmation — a fresh page load recovering from nothing to show isn't a
    // "reconnected" moment.
    let wasReconnecting = false;
    let hideConfirmationTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribeConnection = channel.onConnectionStateChange((state) => {
      setConnectionState(state);
      if (state === "reconnecting") {
        wasReconnecting = true;
        setJustReconnected(false);
        clearTimeout(hideConfirmationTimer);
      } else if (state === "connected" && wasReconnecting) {
        wasReconnecting = false;
        setJustReconnected(true);
        hideConfirmationTimer = setTimeout(() => setJustReconnected(false), RECONNECTED_CONFIRMATION_MS);
      }
    });

    return () => {
      clearTimeout(hideConfirmationTimer);
      unsubscribePresence();
      unsubscribeConnection();
      void channel.leave();
    };
  }, [campaignId, currentUserId, currentUserDisplayName]);

  return (
    <>
      {connectionState === "reconnecting" ? (
        <p className={styles.connectionStatus} role="status">
          <Badge tone="orange" pulse>
            Reconnecting…
          </Badge>{" "}
          Your connection dropped — trying to get you back online.
        </p>
      ) : justReconnected ? (
        <p className={styles.connectionStatus} role="status">
          <Badge tone="teal">Reconnected</Badge> You&apos;re back online.
        </p>
      ) : null}
      <ul className={styles.memberList}>
        {members.map((member) => (
          <li key={member.user_id} className={styles.memberRow}>
            <span>{member.display_name ?? "Unnamed player"}</span>
            <span className={styles.characterMeta}>
              <Badge tone={member.role === "dm" ? "pink" : "teal"}>{member.role === "dm" ? "DM" : "Player"}</Badge>
              {onlineUserIds.has(member.user_id) ? (
                <Badge tone="teal" pulse>
                  Online
                </Badge>
              ) : (
                <Badge tone="neutral">Offline</Badge>
              )}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
