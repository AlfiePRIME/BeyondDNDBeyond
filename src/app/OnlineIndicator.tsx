"use client";

import Link from "next/link";
import { useLobby } from "./LobbyProvider";
import styles from "./AppNav.module.css";

/** "● 3 online" in the nav, on every page — hover for who. */
export function OnlineIndicator() {
  const lobby = useLobby();
  if (!lobby?.identity) return null;
  const names = lobby.members.map((member) => member.displayName ?? "Unnamed adventurer");
  return (
    <Link
      href="/"
      className={styles.online}
      title={names.length ? `Online now: ${names.join(", ")}` : "Connecting…"}
      data-testid="nav-online-indicator"
    >
      <span className={styles.onlineDot} aria-hidden="true" />
      {lobby.members.length} online
    </Link>
  );
}
