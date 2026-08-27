"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/ui-components";
import styles from "./room.module.css";

export interface ChatDockProps {
  /** Fires with the trimmed, non-empty message body on submit — GameRoom.tsx
   * owns the actual sendChatMessage(supabase, campaignId, currentUserId, ...)
   * call and any resulting error surface; this component only ever collects
   * the raw text and clears itself once the caller's handler resolves. */
  onSend: (body: string) => Promise<void>;
}

/**
 * A deliberately minimal chat-input control (Chat & Summary B3) — a plain
 * text box plus a Send button, just enough to make the floating chat bubble
 * (ChatBubble.tsx, mounted by GameRoom.tsx) end-to-end testable. Not docked
 * through DraggablePanel/PanelLayoutProvider like this room's other panels:
 * B4 (the persistent chat log panel) is the prompt that builds the REAL,
 * fully-docked chat surface and supersedes this input outright, so this
 * stays a small fixed-position bar rather than registering a new panelId
 * this feature's own next prompt would just have to retire again.
 */
export function ChatDock({ onSend }: ChatDockProps) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = body.trim();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    void onSend(trimmed)
      .then(() => setBody(""))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not send that message."))
      .finally(() => setBusy(false));
  };

  return (
    <form className={styles.chatDock} onSubmit={handleSubmit} data-testid="chat-dock">
      <input
        className={styles.chatDockInput}
        placeholder="Say something…"
        aria-label="Chat message"
        value={body}
        maxLength={500}
        onChange={(event) => setBody(event.target.value)}
        data-testid="chat-dock-input"
      />
      <Button size="sm" variant="teal" type="submit" disabled={busy || trimmed === ""} data-testid="chat-dock-send">
        Send
      </Button>
      {error ? (
        <span className={styles.chatDockError} data-testid="chat-dock-error">
          {error}
        </span>
      ) : null}
    </form>
  );
}
