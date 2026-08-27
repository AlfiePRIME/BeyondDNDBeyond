/**
 * How long a floating chat bubble (Chat & Summary B3) stays on screen before
 * fading out. Deliberately pure and dependency-free, like chatFormatting.ts/
 * chatObfuscationClock.ts — the Game Room (GameRoom.tsx) uses this to time
 * both the CSS fade the bubble itself renders with (ChatBubble's own
 * `durationMs` prop, src/scene-3d/ChatBubble.tsx) and the JS timer that
 * decides when a sender's NEXT queued message may start showing (this
 * project's "queue, don't overlap" rule) — the same number drives both, so
 * they can never drift apart.
 *
 * Counts the RAW message body's length (formatting codes intact — B1's own
 * "store the raw string, a separate feature parses it at render time"
 * posture), not the parsed/rendered text length, so this stays a trivial,
 * allocation-free function of the exact string chat_messages.body already
 * stores — a heavily-formatted short message never lingers just because its
 * literal typed length (including "&c"/"&l"/etc.) is longer than what a
 * reader actually sees.
 */

/** The acceptance criterion's own floor: "a short message stays up at least
 * 5 seconds." */
const MIN_DURATION_MS = 5000;

/** An upper bound so one extremely long message can't block its sender's
 * own queue indefinitely — nothing in the spec requires a cap, but leaving
 * duration unbounded would let a single wall-of-text message make every
 * later message from that sender wait minutes to appear. */
const MAX_DURATION_MS = 20000;

/** Messages at or under this length cost no extra time beyond the 5-second
 * floor — a short greeting or one-word reaction shouldn't need to scale at
 * all. */
const BASE_CHARACTERS = 20;

/** Extra display time per character beyond BASE_CHARACTERS. */
const MS_PER_EXTRA_CHARACTER = 60;

/**
 * Duration (in milliseconds) a floating chat bubble carrying `body` should
 * remain visible before it fades out and the sender's next queued message
 * (if any) takes over.
 */
export function computeChatBubbleDurationMs(body: string): number {
  const extraCharacters = Math.max(0, body.length - BASE_CHARACTERS);
  const scaled = MIN_DURATION_MS + extraCharacters * MS_PER_EXTRA_CHARACTER;
  return Math.min(MAX_DURATION_MS, scaled);
}
