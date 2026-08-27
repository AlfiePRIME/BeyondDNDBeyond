"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ChatText } from "@/ui-components";
import {
  editChatMessage,
  sendChatMessage,
  subscribeToChatMessages,
  type ChatMessage,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import type { RoomMember } from "./avatar-url";
import styles from "./room.module.css";

// Mirrors listChatMessages' own default `limit` (chat.ts) — this client-side
// cap keeps a very long-running session's in-memory log from growing
// unbounded, the exact LOG_CAP reasoning DiceLogPanel already applies to
// roll_log.
const LOG_CAP = 200;

// Migration 0067's own edit window, replayed here (not imported — chat.ts
// deliberately performs no client-side pre-check of its own, see
// editChatMessage's doc comment) so the Edit affordance can be shown/hidden
// correctly; the RLS policy itself remains the only real enforcement.
const EDIT_WINDOW_MS = 2 * 60 * 1000;

// `now` is `null` only for the very first render (before the mount effect
// below has run) — treated as "not editable yet" rather than reading the
// clock here, since calling Date.now() during render itself is impure
// (React's own rule: https://react.dev/reference/rules/components-and-hooks-must-be-pure).
function canStillEdit(message: ChatMessage, currentUserId: string, now: number | null): boolean {
  return (
    now !== null &&
    message.sender_user_id === currentUserId &&
    now - Date.parse(message.created_at) < EDIT_WINDOW_MS
  );
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * The Game Room's persistent chat log (Chat & Summary B4): full history on
 * open (`initialMessages`, the same "read once for SSR, then subscribe"
 * shape as DiceLogPanel's own `initialRolls`), kept live via B1's
 * subscribeToChatMessages (postgres_changes, not the room's own broadcast
 * channel — chat reaches a member wherever they're reading it, per B1's own
 * doc comment), auto-scrolling to the newest message on arrival, and B2's
 * ChatText rendering every body.
 *
 * Also hosts the REAL chat-input control (a plain text box plus send
 * button) — this supersedes whatever minimal placeholder input B3 may have
 * put in a temporary spot; both this panel and B3's floating bubbles read
 * the exact same live feed off the exact same sendChatMessage call, so
 * sending here produces both a bubble (on every connected client) and a log
 * entry, from the one underlying action, with no extra wiring between the
 * two components needed.
 *
 * Editing (B1's own 2-minute sender-only window) is offered inline: an
 * "Edit" affordance appears only on the current viewer's own still-editable
 * messages (canStillEdit, re-evaluated on a timer scheduled to fire exactly
 * when the soonest such window closes — see the effect below — rather than
 * a recurring poll) and disappears the moment that window closes; a
 * successfully edited message shows a visible "(edited)" marker. The RLS
 * policy (0067) is the actual backstop regardless of what this UI offers —
 * a rejected edit (wrong sender, or a window that closed between render and
 * submit) surfaces as an ordinary error from editChatMessage, exactly like
 * every other RLS-gated write in this app.
 */
export function ChatLogPanel({
  campaignId,
  currentUserId,
  members,
  initialMessages,
}: {
  campaignId: string;
  currentUserId: string;
  members: RoomMember[];
  initialMessages: ChatMessage[];
}) {
  // listChatMessages returns newest-first (the listRollLog shape) — reversed
  // here since a running chat log reads top-to-bottom oldest-to-newest,
  // scrolling down as new messages arrive, unlike DiceLogPanel's own
  // newest-on-top roll history.
  const [messages, setMessages] = useState<ChatMessage[]>(() => [...initialMessages].reverse());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const memberById = useMemo(() => new Map(members.map((member) => [member.user_id, member])), [members]);

  // A stable identity (empty dependency array — it only ever uses the
  // functional setState form) so the live-subscription effect below can
  // list it as a real dependency instead of needing an exhaustive-deps
  // suppression.
  const upsertMessage = useCallback((message: ChatMessage) => {
    setMessages((current) => {
      const index = current.findIndex((candidate) => candidate.id === message.id);
      if (index === -1) return [...current, message].slice(-LOG_CAP);
      if (current[index] === message) return current;
      const next = [...current];
      next[index] = message;
      return next;
    });
  }, []);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    return subscribeToChatMessages(supabase, campaignId, upsertMessage);
  }, [campaignId, upsertMessage]);

  // Auto-scroll to the newest message on arrival — a plain scrollTop
  // assignment on this panel's own scroll container (.chatList), not the
  // whole panel (which also carries the input row/error line below the
  // list and must never itself scroll).
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  // The "current time", used only to decide which of the viewer's own
  // messages are still inside their edit window (canStillEdit above) — kept
  // in state and only ever read/written from effects, never computed inline
  // during render (calling the impure Date.now() during render itself is
  // disallowed by React's own purity rule). Refreshed whenever the message
  // list changes (a send, an edit, or a live arrival should be reflected
  // against a genuinely fresh clock, not a stale one from whenever this
  // panel happened to last render) via the effect immediately below, and
  // additionally via a single scheduled timeout — rescheduled every time
  // `now` or `messages` changes — that fires exactly when the SOONEST
  // still-open edit window among the viewer's own messages is due to
  // close, so the Edit affordance disappears the moment it should rather
  // than lingering until some unrelated re-render happens to catch it.
  // chatObfuscationClock.ts's own "one shared timer, not one per item"
  // discipline, applied here to a far lower-frequency concern: at most one
  // pending timeout, ever, for the whole panel.
  const [now, setNow] = useState<number | null>(null);
  // Deferred to a timer callback rather than called synchronously in the
  // effect body itself (react-hooks' set-state-in-effect rule) — a
  // zero-delay setTimeout, the same "defer the setState call into a
  // callback" shape every subscription-driven setState elsewhere in this
  // app already uses (e.g. subscribeToChatMessages's own handler above).
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(timer);
  }, [messages]);
  useEffect(() => {
    if (now === null) return undefined;
    const remaining = messages
      .filter((message) => message.sender_user_id === currentUserId)
      .map((message) => Date.parse(message.created_at) + EDIT_WINDOW_MS - now)
      .filter((ms) => ms > 0);
    if (remaining.length === 0) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...remaining) + 50);
    return () => clearTimeout(timer);
  }, [messages, currentUserId, now]);

  async function handleSend() {
    const body = draft.trim();
    if (body === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const message = await sendChatMessage(supabase, campaignId, currentUserId, body);
      upsertMessage(message);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send that message — try again.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(message: ChatMessage) {
    setEditingId(message.id);
    setEditDraft(message.body);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft("");
    setEditError(null);
  }

  async function handleSaveEdit(messageId: string) {
    const body = editDraft.trim();
    if (body === "" || editBusy) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const message = await editChatMessage(supabase, messageId, body);
      upsertMessage(message);
      setEditingId(null);
      setEditDraft("");
    } catch (err) {
      // The genuine backstop is 0067's UPDATE RLS policy, not canStillEdit
      // above — a save attempted right as the window closes (or a stale
      // sender mismatch) lands here as an ordinary rejected-write error,
      // exactly like every other RLS-gated mutation in this app.
      setEditError(
        err instanceof Error
          ? err.message
          : "Could not save that edit — the edit window may have closed."
      );
    } finally {
      setEditBusy(false);
    }
  }

  return (
    <aside className={styles.chatPanel} data-testid="chat-log-panel">
      <span className={styles.panelLabel}>Chat</span>

      <div className={styles.chatList} ref={listRef} data-testid="chat-log">
        {messages.length === 0 ? (
          <p className={styles.hint}>No messages yet — say something to the table.</p>
        ) : (
          messages.map((message) => {
            const sender = memberById.get(message.sender_user_id);
            const isDm = sender?.role === "dm";
            const editable = canStillEdit(message, currentUserId, now);
            const isEditing = editingId === message.id;
            return (
              <div
                key={message.id}
                className={[styles.chatEntry, isDm ? styles.chatEntryDm : ""].filter(Boolean).join(" ")}
                data-testid={`chat-entry-${message.id}`}
              >
                <div className={styles.chatEntryHeader}>
                  <span
                    className={[styles.rollMeta, isDm ? styles.chatSenderDm : ""].filter(Boolean).join(" ")}
                  >
                    {sender?.display_name ?? "Someone"}
                    {isDm ? " (DM)" : ""}
                  </span>
                  <span className={styles.chatTimestamp}>{formatTimestamp(message.created_at)}</span>
                  {message.edited_at ? (
                    <span className={styles.chatEditedMarker} data-testid={`chat-edited-${message.id}`}>
                      (edited)
                    </span>
                  ) : null}
                  {editable && !isEditing ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className={styles.chatEditButton}
                      onClick={() => startEdit(message)}
                      data-testid={`chat-edit-button-${message.id}`}
                    >
                      Edit
                    </Button>
                  ) : null}
                </div>
                {isEditing ? (
                  <div className={styles.chatEditRow}>
                    <input
                      className={styles.chatEditInput}
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleSaveEdit(message.id);
                        } else if (event.key === "Escape") {
                          cancelEdit();
                        }
                      }}
                      aria-label="Edit message"
                      data-testid={`chat-edit-input-${message.id}`}
                      autoFocus
                    />
                    <Button
                      size="sm"
                      variant="teal"
                      disabled={editBusy || editDraft.trim() === ""}
                      onClick={() => void handleSaveEdit(message.id)}
                      data-testid={`chat-edit-save-${message.id}`}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={cancelEdit}
                      data-testid={`chat-edit-cancel-${message.id}`}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <ChatText text={message.body} className={styles.chatBody} />
                )}
              </div>
            );
          })
        )}
      </div>

      {editError ? (
        <p role="alert" className={styles.errorText} data-testid="chat-edit-error">
          {editError}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className={styles.errorText} data-testid="chat-error">
          {error}
        </p>
      ) : null}

      <form
        className={styles.chatInputRow}
        onSubmit={(event) => {
          event.preventDefault();
          void handleSend();
        }}
      >
        <input
          className={styles.chatInput}
          placeholder="Say something…"
          aria-label="Chat message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          data-testid="chat-input"
        />
        <Button
          size="sm"
          variant="teal"
          type="submit"
          disabled={busy || draft.trim() === ""}
          data-testid="chat-send-button"
        >
          Send
        </Button>
      </form>
    </aside>
  );
}
