"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/ui-components";
import {
  getDebugSnapshot,
  setMasterVolume,
  setMuted,
  startLoop,
  stopLoop,
  subscribeDebugState,
  SOUND_KEYS,
} from "@/audio";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { listCampaignsForUser, DEFAULT_SOUND_SETTINGS, type SoundSettings } from "@/data-access";
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
  initialSoundSettings,
}: {
  currentUserId: string;
  currentUserDisplayName: string | null;
  /** ui_preferences.soundSettings at page-load time (page.tsx's own SSR
   * read of the caller's profile row) — the Lobby page has no
   * PanelLayoutProvider/useSoundSettings (that's the Game Room's own
   * debounced-write context, DraggablePanel.tsx), so this is applied ONCE
   * on mount below rather than kept live-synced; a mute/volume change made
   * on the Lobby itself has nowhere to persist to yet (no visible control
   * here — see this component's own doc comment below for why). */
  initialSoundSettings?: SoundSettings;
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

  // Lobby menu music: active for this component's whole mounted lifetime,
  // independent of the presence-channel effect below (no reason to
  // restart the music on a reconnect or a prop change that effect reacts
  // to). startLoop/stopLoop are idempotent, so a React Strict Mode
  // dev-mode double-mount is harmless here exactly like SP9's weather
  // loops. The caller's persisted volume/mute preference is applied ONCE
  // here too (mirroring SoundControl.tsx's own mount-time sync) so a
  // muted/quieted user doesn't get lobby_music at full volume just
  // because they haven't visited the Game Room yet this session — this is
  // read-once, not live-synced, since there's no visible control on this
  // page to react to a remote change.
  useEffect(() => {
    setMasterVolume(initialSoundSettings?.volume ?? DEFAULT_SOUND_SETTINGS.volume);
    setMuted(initialSoundSettings?.muted ?? DEFAULT_SOUND_SETTINGS.muted);
    void startLoop(SOUND_KEYS.LOBBY_MUSIC);
    return () => stopLoop(SOUND_KEYS.LOBBY_MUSIC);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once at mount, see doc comment above
  }, []);

  // Hidden render-state mirror, the same visionDebug/sound-manager-debug
  // convention SoundControl.tsx already establishes for the Game Room —
  // this page has no SoundControl of its own (no PanelLayoutProvider to
  // back a visible slider), but scripts/db/verify-game-music.mjs still
  // needs a real way to read the sound manager's actual state here.
  const [debugSnapshot, setDebugSnapshot] = useState(() => getDebugSnapshot());
  useEffect(() => subscribeDebugState(() => setDebugSnapshot(getDebugSnapshot())), []);
  useEffect(() => {
    const interval = setInterval(() => setDebugSnapshot(getDebugSnapshot()), 200);
    return () => clearInterval(interval);
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

  const soundManagerDebugMirror = (
    <div data-testid="sound-manager-debug" hidden>
      {JSON.stringify(debugSnapshot)}
    </div>
  );

  if (connectionState === "connecting") {
    return (
      <>
        {soundManagerDebugMirror}
        <p className={styles.connectionStatus} role="status">
          <Badge tone="neutral" pulse>
            Joining…
          </Badge>{" "}
          Connecting you to the lobby.
        </p>
      </>
    );
  }

  return (
    <>
      {soundManagerDebugMirror}
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
