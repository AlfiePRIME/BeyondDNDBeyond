"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/ui-components";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { joinLobbyChannel, type ConnectionState, type PresenceMember } from "@/realtime";
import styles from "./page.module.css";

// How long the "Reconnected" confirmation stays up after recovery before fading back to nothing
// — long enough to notice, short enough not to linger once the list is trustworthy again.
const RECONNECTED_CONFIRMATION_MS = 4000;

export function LobbyPresence({
  currentUserId,
  currentUserDisplayName,
}: {
  currentUserId: string;
  currentUserDisplayName: string | null;
}) {
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [justReconnected, setJustReconnected] = useState(false);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const channel = joinLobbyChannel(supabase, {
      userId: currentUserId,
      displayName: currentUserDisplayName,
    });

    const unsubscribePresence = channel.onPresenceChange(setMembers);

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
  }, [currentUserId, currentUserDisplayName]);

  if (connectionState === "connecting") {
    return (
      <p className={styles.connectionStatus} role="status">
        <Badge tone="neutral" pulse>
          Joining…
        </Badge>{" "}
        Connecting you to the lobby.
      </p>
    );
  }

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

      <p className={styles.countRow}>
        <span className={styles.count} data-testid="lobby-count">
          {members.length}
        </span>{" "}
        <span className={styles.countLabel}>
          {members.length === 1 ? "adventurer online" : "adventurers online"}
        </span>
      </p>

      <ul className={styles.memberList}>
        {members.map((member) => (
          <li key={member.userId} className={styles.memberRow}>
            <span className={styles.memberName}>{member.displayName ?? "Unnamed adventurer"}</span>
            <span className={styles.memberBadges}>
              {member.userId === currentUserId ? <Badge tone="purple">You</Badge> : null}
              <Badge tone="teal" pulse>
                Online
              </Badge>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
