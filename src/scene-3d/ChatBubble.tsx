"use client";

import { useEffect, useState } from "react";
import { Html } from "@react-three/drei";
import { ChatText } from "@/ui-components";
import { SEAT_TOP_Y } from "./Chair";
import { AVATAR_HEIGHT } from "./SeatAvatar";
import styles from "./ChatBubble.module.css";

// How long the CSS opacity transition (below) takes to fully fade the
// bubble out — the tail end of `durationMs`, not extra time on top of it,
// so this component's total on-screen lifetime always matches exactly what
// GameRoom.tsx's own dequeue timer (computeChatBubbleDurationMs) is timed
// against; the two would visibly disagree (a bubble popping away before its
// fade finishes, or GameRoom starting the next queued message while this one
// is still visibly fading) if fading added time rather than eating into it.
const FADE_MS = 400;

// How far above the seat's own floor-level base (Seat.position — the stool,
// GameTableScene.tsx's own Seat/CampaignSeat doc comment) this bubble
// floats: past the seat pad (Chair.tsx's SEAT_TOP_Y) and the full seated
// avatar's own height (SeatAvatar's AVATAR_HEIGHT), plus a small clearance
// margin so it reads as hovering above the character's head rather than
// resting on it. Both roles land close enough together (SEAT_TOP_Y.dm is
// only 0.03 taller than .player) that one shared margin works for either.
const HEAD_CLEARANCE = 0.3;

export interface ChatBubbleProps {
  /** Purely a data-testid disambiguator (`chat-bubble-${userId}`) — a real
   * Playwright check has no other way to find a specific sender's own
   * bubble among several simultaneously-chatting members, the same
   * verification-only reasoning as DmBookPropProps.onProjectedPosition.
   * Never read by this component for anything else. */
  userId: string;
  /** The sender's CURRENT effective seat position (getEffectiveSeat,
   * seating.ts) — GameRoom.tsx re-resolves this on every render, so a
   * message sent mid chair-drag anchors to wherever the chair actually is
   * RIGHT NOW, the same live-tracking guarantee DmBookProp's own `position`
   * prop gets from GameRoom's dmBookPosition memo. This is the stool's own
   * floor-level base (Seat.position's documented meaning) — this component
   * adds HEAD_CLEARANCE's own offset above it itself, the caller never
   * needs to know this component floats above a head rather than sitting on
   * the floor. */
  position: readonly [number, number, number];
  /** B1's chat_messages.body, raw and unparsed — rendered via B2's ChatText,
   * exactly like every other chat surface in this app. */
  text: string;
  /** The DM's own bubble gets visually distinct (purple-accented) chrome so
   * it reads as DM speech rather than a player's — ChatBubble.module.css's
   * `.bubbleDm`. */
  isDm: boolean;
  /** Total on-screen lifetime in milliseconds (computeChatBubbleDurationMs,
   * src/ui-components/chatBubbleTiming.ts) — GameRoom.tsx's own dequeue
   * timer unmounts this component (and shows the sender's next queued
   * message, if any) at exactly this same duration, so the fade below is
   * timed to finish exactly as this component itself goes away, never
   * cut off mid-fade or lingering fully-transparent after its slot ends. */
  durationMs: number;
}

/**
 * A floating chat bubble anchored above a seated member's own chair (Chat &
 * Summary B3) — <Html transform={false}>, matching DmBookProp.tsx's own
 * anchoring approach (a non-perspective-transformed DOM overlay pinned to a
 * 3D world position, rather than a canvas-texture billboard, since chat text
 * is arbitrary player-authored content, not a small fixed set of cacheable
 * strings). Mounted directly by GameRoom.tsx as a `<Canvas>` sibling of
 * GameTableScene (DmBookProp's own precedent) whenever that sender currently
 * has a message to show — GameRoom owns the queue/duration timing entirely;
 * this component only ever renders "is currently the one visible message,"
 * never queueing or duration logic of its own beyond the trailing CSS fade.
 */
export function ChatBubble({ userId, position, text, isDm, durationMs }: ChatBubbleProps) {
  const [fading, setFading] = useState(false);

  // GameRoom.tsx keys this component by the message's own id, so a genuinely
  // new message always remounts this component fresh — `fading`'s own
  // useState(false) initializer above is therefore already correct on every
  // new message with no explicit reset needed here (a component reusing
  // this same instance across two different messages never happens).
  useEffect(() => {
    const fadeDelay = Math.max(0, durationMs - FADE_MS);
    const timer = setTimeout(() => setFading(true), fadeDelay);
    return () => clearTimeout(timer);
  }, [durationMs]);

  const anchorY = SEAT_TOP_Y[isDm ? "dm" : "player"] + AVATAR_HEIGHT + HEAD_CLEARANCE;
  const className = [styles.bubble, isDm ? styles.bubbleDm : "", fading ? styles.bubbleFading : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <group position={position as [number, number, number]}>
      <Html
        position={[0, anchorY, 0]}
        center
        transform={false}
        zIndexRange={[450, 0]}
        // A passive readout, not a control — never intercepts clicks/drags
        // meant for the table/seat/chair beneath it (DmBookProp's own
        // interactive book content is the opposite case, hence its
        // `pointerEvents="auto"`).
        pointerEvents="none"
      >
        <div
          className={className}
          data-testid={`chat-bubble-${userId}`}
          // A plain boolean flag, not a style value — a verify script asserts
          // the DM/player visual split via each's own computed style
          // directly (the whole point of the acceptance criterion), but a
          // color-mix() output isn't something a script should have to
          // reverse-engineer just to find WHICH bubble is which before
          // comparing them; the same "mirror what a test can't otherwise
          // read" reasoning as every other data-* attribute in this file.
          data-chat-bubble-dm={isDm ? "true" : "false"}
        >
          <ChatText text={text} />
        </div>
      </Html>
    </group>
  );
}
