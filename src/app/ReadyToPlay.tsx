"use client";

import Link from "next/link";
import { Badge } from "@/ui-components";
import { useLobby } from "./LobbyProvider";
import { HostGameControl, type HostableCampaign } from "./HostGameControl";
import styles from "./page.module.css";

export interface LiveGame {
  campaignId: string;
  campaignName: string;
  hostName: string | null;
  paused: boolean;
}

function initials(name: string | null): string {
  const words = (name ?? "?").replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

/**
 * The Home page's hero. Games work host-then-join: someone hosts a game for
 * a campaign (becoming its DM for the night) and everyone else joins it on
 * purpose from here, or from the invitation pop-up (LobbyProvider). Also
 * shows who's online right now, on any page.
 */
export function ReadyToPlay({
  currentUserId,
  currentUserDisplayName,
  liveGames,
  hostableCampaigns,
}: {
  currentUserId: string;
  currentUserDisplayName: string | null;
  liveGames: LiveGame[];
  hostableCampaigns: HostableCampaign[];
}) {
  const lobby = useLobby();
  const members = lobby?.members ?? [];
  const others = members.filter((member) => member.userId !== currentUserId);

  return (
    <section className={styles.hero} aria-labelledby="ready-to-play-title">
      <div className={styles.heroText}>
        <p className={styles.heroEyebrow}>Welcome back, {currentUserDisplayName ?? "adventurer"}</p>
        <h1 id="ready-to-play-title" className={styles.heroTitle}>
          {liveGames.some((game) => !game.paused) ? "Your table is waiting" : "Ready to play?"}
        </h1>
        <p className={styles.heroSubtitle}>
          {liveGames.length > 0
            ? "Join a game below, or host a different campaign."
            : "Host a game to open one of your campaigns for tonight — everyone else in it can then join from here."}
        </p>
      </div>

      {liveGames.length > 0 ? (
        <ul className={styles.liveGames} data-testid="live-games">
          {liveGames.map((game) => (
            <li key={game.campaignId} className={styles.liveGame} data-testid={`live-game-${game.campaignId}`}>
              <span className={`${styles.statusDot} ${game.paused ? styles.statusDotPaused : styles.statusDotLive}`} aria-hidden="true" />
              <span className={styles.liveGameText}>
                <span className={styles.liveGameName}>{game.campaignName}</span>
                <span className={styles.liveGameMeta}>
                  {game.paused ? "Paused" : "Live now"}
                  {game.hostName ? ` · hosted by ${game.hostName}` : ""}
                </span>
              </span>
              <Link
                href={`/campaigns/${game.campaignId}/room`}
                className={styles.primaryAction}
                data-testid={`join-live-game-${game.campaignId}`}
              >
                {game.paused ? "Rejoin" : "Join game ▸"}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {lobby?.connectionState === "reconnecting" ? (
        <p className={styles.connectionStatus} role="status">
          <Badge tone="orange" pulse>
            Reconnecting…
          </Badge>{" "}
          Your connection dropped — trying to get you back online.
        </p>
      ) : lobby?.justReconnected ? (
        <p className={styles.connectionStatus} role="status">
          <Badge tone="teal">Reconnected</Badge> You&apos;re back online.
        </p>
      ) : null}

      <div className={styles.heroFooter}>
        <div className={styles.partyRow}>
          <span className={styles.onlineCount}>
            <span className={styles.onlineDot} aria-hidden="true" />
            <span data-testid="lobby-count">{members.length}</span> online
            {others.length === 0 && members.length > 0 ? " — just you so far" : ""}
          </span>
          <ul className={styles.party} aria-label="Online now">
            {members.map((member) => (
              <li key={member.userId} className={styles.partyMember} title={member.displayName ?? "Unnamed adventurer"}>
                <span className={styles.avatar} aria-hidden="true">
                  {initials(member.displayName)}
                </span>
                <span className={styles.partyName}>
                  {member.displayName ?? "Unnamed adventurer"}
                  {member.userId === currentUserId ? <span className={styles.youTag}> (you)</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <HostGameControl
          currentUserId={currentUserId}
          currentUserDisplayName={currentUserDisplayName}
          campaigns={hostableCampaigns}
        />
      </div>
    </section>
  );
}
