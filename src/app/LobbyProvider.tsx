"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { getProfile, isProfileComplete, listCampaignsForUser } from "@/data-access";
import {
  joinLobbyChannel,
  type ChannelIdentity,
  type ConnectionState,
  type PresenceChannel,
  type PresenceMember,
} from "@/realtime";
import Link from "next/link";
import { SESSION_STARTED_EVENT, type SessionStartedPayload } from "./sessionEvents";
import styles from "./LobbyProvider.module.css";

export interface LobbyContextValue {
  /** The signed-in viewer, or null while signed out / still resolving. */
  identity: ChannelIdentity | null;
  members: PresenceMember[];
  connectionState: ConnectionState;
  /** True for a few seconds after recovering from a dropped connection. */
  justReconnected: boolean;
  /** A session that started for a campaign the viewer isn't in. */
  sessionNotice: SessionStartedPayload | null;
  /** A game that just opened in one of the viewer's own campaigns. */
  invite: SessionStartedPayload | null;
  dismissInvite(): void;
  publishSessionStarted(payload: SessionStartedPayload): Promise<void>;
}

const LobbyContext = createContext<LobbyContextValue | null>(null);

export function useLobby(): LobbyContextValue | null {
  return useContext(LobbyContext);
}

const SIGNED_OUT_PATHS = ["/login", "/signup", "/profile-setup"];
const RECONNECTED_CONFIRMATION_MS = 4000;

/**
 * The app-wide lobby: every signed-in viewer, on ANY page, is present on the
 * lobby channel (shown as "online" in the nav), and when someone starts
 * hosting a game in one of their campaigns they get an invitation pop-up to
 * join it — an intentional click, never an automatic redirect. This used to
 * live on the Lobby page alone, where anyone browsing their campaigns or
 * account at that moment was invisible and missed the session starting.
 *
 * Mounted once in the root layout, so it survives client-side navigation.
 * The user is re-resolved as the route changes (logging in/out is itself a
 * navigation, which never remounts this layout).
 */
export function LobbyProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const [identity, setIdentity] = useState<ChannelIdentity | null>(null);
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [justReconnected, setJustReconnected] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<SessionStartedPayload | null>(null);
  const [invite, setInvite] = useState<SessionStartedPayload | null>(null);
  const channelRef = useRef<PresenceChannel | null>(null);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  const signedOutPath = SIGNED_OUT_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  // Resolve (or clear) who's signed in whenever the route changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (signedOutPath) {
        if (!cancelled) setIdentity(null);
        return;
      }
      const supabase = createBrowserSupabaseClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        if (!cancelled) setIdentity(null);
        return;
      }
      const profile = await getProfile(supabase, user.id).catch(() => null);
      if (cancelled) return;
      if (!isProfileComplete(profile)) {
        setIdentity(null);
        return;
      }
      const displayName = profile!.display_name;
      setIdentity((current) =>
        current && current.userId === user.id && current.displayName === displayName
          ? current
          : { userId: user.id, displayName }
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname, signedOutPath]);

  const userId = identity?.userId ?? null;
  const displayName = identity?.displayName ?? null;

  useEffect(() => {
    if (!userId) return;
    const supabase = createBrowserSupabaseClient();
    const channel = joinLobbyChannel(supabase, { userId, displayName });
    channelRef.current = channel;
    const unsubscribePresence = channel.onPresenceChange(setMembers);

    const unsubscribeSessionStarted = channel.subscribe<SessionStartedPayload>(SESSION_STARTED_EVENT, (payload) => {
      // Pages listing live games (Home, the campaign page) pick up the change.
      router.refresh();
      void listCampaignsForUser(supabase, userId)
        .then((memberships) => {
          if (memberships.some((m) => m.campaign.id === payload.campaignId)) {
            setInvite(payload);
          } else {
            setSessionNotice(payload);
          }
        })
        .catch(() => undefined);
    });

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
      channelRef.current = null;
      void channel.leave();
    };
  }, [userId, displayName, router]);

  const publishSessionStarted = useCallback(async (payload: SessionStartedPayload) => {
    await channelRef.current?.publish(SESSION_STARTED_EVENT, payload);
  }, []);
  const dismissInvite = useCallback(() => setInvite(null), []);

  // No invitation for a table you're already sitting at (or while signed out).
  const atTable = invite ? pathname.startsWith(`/campaigns/${invite.campaignId}/room`) : false;
  const showInvite = invite !== null && userId !== null && !atTable;

  return (
    <LobbyContext.Provider
      value={{
        identity,
        members: userId ? members : [],
        connectionState,
        justReconnected,
        sessionNotice,
        invite,
        dismissInvite,
        publishSessionStarted,
      }}
    >
      {children}
      {showInvite ? (
        <div className={styles.invite} role="status" data-testid="game-invite">
          <span className={styles.inviteText}>
            <strong>{invite!.hostName ?? "Someone"}</strong> is hosting <strong>{invite!.campaignName}</strong>
          </span>
          <Link
            href={`/campaigns/${invite!.campaignId}/room`}
            className={styles.inviteJoin}
            onClick={dismissInvite}
            data-testid="game-invite-join"
          >
            Join
          </Link>
          <button type="button" className={styles.inviteDismiss} onClick={dismissInvite} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ) : null}
    </LobbyContext.Provider>
  );
}
