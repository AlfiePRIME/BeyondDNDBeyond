"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/ui-components";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { listCampaignsForUser } from "@/data-access";
import {
  joinLobbyChannel,
  type ConnectionState,
  type PresenceChannel,
  type PresenceMember,
} from "@/realtime";
import {
  StartSessionControl,
  SESSION_STARTED_EVENT,
  type SessionStartedPayload,
} from "./StartSessionControl";
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
  const router = useRouter();
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [justReconnected, setJustReconnected] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<SessionStartedPayload | null>(null);
  const lobbyChannelRef = useRef<PresenceChannel | null>(null);

  const publishSessionStarted = useCallback(async (payload: SessionStartedPayload) => {
    await lobbyChannelRef.current?.publish(SESSION_STARTED_EVENT, payload);
  }, []);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const channel = joinLobbyChannel(supabase, {
      userId: currentUserId,
      displayName: currentUserDisplayName,
    });
    lobbyChannelRef.current = channel;

    const unsubscribePresence = channel.onPresenceChange(setMembers);

    // Membership decides the reaction to a started session: members are
    // pulled straight into the room, everyone else just gets told about it.
    // Checked at receipt time (not join time) so a membership gained while
    // sitting in the lobby still counts.
    const unsubscribeSessionStarted = channel.subscribe<SessionStartedPayload>(
      SESSION_STARTED_EVENT,
      (payload) => {
        void listCampaignsForUser(supabase, currentUserId)
          .then((memberships) => {
            if (memberships.some((m) => m.campaign.id === payload.campaignId)) {
              router.push(`/campaigns/${payload.campaignId}/room`);
            } else {
              setSessionNotice(payload);
            }
          })
          .catch(() => setSessionNotice(payload));
      }
    );

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
      unsubscribeSessionStarted();
      unsubscribeConnection();
      lobbyChannelRef.current = null;
      void channel.leave();
    };
  }, [currentUserId, currentUserDisplayName, router]);

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

      {sessionNotice ? (
        <p className={styles.sessionNotice} role="status" data-testid="session-in-progress-notice">
          <Badge tone="orange" pulse>
            Session in progress
          </Badge>{" "}
          A session just started for “{sessionNotice.campaignName}” — you&apos;re not in that
          campaign, so the lobby is still your spot.
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

      <StartSessionControl
        currentUserId={currentUserId}
        currentUserDisplayName={currentUserDisplayName}
        lobbyMemberCount={members.length}
        publishSessionStarted={publishSessionStarted}
      />
    </>
  );
}
