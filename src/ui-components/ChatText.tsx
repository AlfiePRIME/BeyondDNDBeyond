"use client";

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { parseChatFormatting } from "./chatFormatting";
import { scrambleGlyphs, subscribeToObfuscationTick } from "./chatObfuscationClock";
import styles from "./ui.module.css";

// React's own documented pattern for "render something different on the
// client than what was server-rendered, without a hydration mismatch"
// (https://react.dev/reference/react/useSyncExternalStore#im-getting-an-error-the-server-used) —
// `getServerSnapshot` (used for SSR AND the client's very first,
// hydration-matching render pass) always says "not hydrated yet"; the real
// `getSnapshot` says "hydrated" from the client's very next render
// onward. Never subscribes to anything real (there's nothing to subscribe
// to — this never changes again after the one hydration flip), so it's a
// plain, referentially-stable no-op rather than a fresh closure per render.
function subscribeNever() {
  return () => {};
}
function getHydratedSnapshot() {
  return true;
}
function getServerSnapshot() {
  return false;
}

export interface ChatTextProps {
  /**
   * The raw message string, formatting codes intact (e.g.
   * "&cHello &lworld&r!") — B1's chat_messages.body stores exactly this,
   * unparsed, so any caller can hand this component that column's value
   * directly with no separate parsing step of its own.
   */
  text: string;
  className?: string;
}

/**
 * Renders a raw Minecraft-style formatted chat message as real styled DOM
 * spans (see chatFormatting.ts for the parsing/format-code rules this
 * follows). The one shared rendering entry point for chat text — B3's
 * floating chat bubble and B4's persistent chat log panel both use this
 * same component rather than each re-implementing span rendering, so
 * formatting looks and behaves identically everywhere chat text appears in
 * the app. Deliberately takes the raw string rather than pre-parsed spans,
 * and renders a plain inline `<span>` rather than assuming any particular
 * layout container, so it drops into either context (or a future one)
 * unchanged.
 */
export function ChatText({ text, className }: ChatTextProps) {
  const spans = parseChatFormatting(text);
  const hasObfuscated = spans.some((span) => span.obfuscated);

  // The scramble is random by definition, so it can never be allowed to
  // render on the very first client pass — that pass has to produce markup
  // byte-for-byte identical to what the server rendered (this component
  // renders server-side too, "use client" only means it's ALSO interactive
  // on the client, not that it skips SSR) or React logs a hydration
  // mismatch and discards/re-renders the whole tree. `isHydrated` is false
  // for that first pass on both sides (genuinely identical, nothing random
  // involved yet) and flips true from the client's very next render
  // onward, which is when obfuscated spans below switch over to their
  // scrambled glyphs.
  const isHydrated = useSyncExternalStore(subscribeNever, getHydratedSnapshot, getServerSnapshot);

  // Forces a re-render on every shared clock tick so obfuscated spans below
  // recompute a fresh scramble — only subscribes once hydrated AND this
  // message actually has an obfuscated span, and only for as long as it's
  // mounted, so a page with no obfuscated text on screen (or a message that
  // scrolls out and unmounts) pays nothing (see chatObfuscationClock.ts).
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isHydrated || !hasObfuscated) return undefined;
    return subscribeToObfuscationTick(() => forceTick((tick) => tick + 1));
  }, [isHydrated, hasObfuscated]);

  const rootClassName = [styles.chatText, className].filter(Boolean).join(" ");

  return (
    <span className={rootClassName}>
      {spans.map((span, index) => {
        const decoration = [span.underline && "underline", span.strikethrough && "line-through"]
          .filter(Boolean)
          .join(" ");
        const style: CSSProperties = {
          color: span.color,
          fontWeight: span.bold ? 700 : undefined,
          fontStyle: span.italic ? "italic" : undefined,
          textDecorationLine: decoration || undefined,
        };

        if (!span.obfuscated) {
          return (
            <span key={index} className={styles.chatSpan} style={style} data-chat-span-index={index}>
              {span.text}
            </span>
          );
        }

        // Obfuscated: the visible glyphs re-scramble every tick and are
        // meaningless on their own (and would spam assistive tech with a
        // constantly-changing string if read directly) — hide the scramble
        // from screen readers and give them the real text instead, via a
        // visually-hidden sibling that doesn't affect layout.
        return (
          <span
            key={index}
            className={styles.chatSpan}
            style={style}
            data-chat-span-index={index}
            data-chat-span-obfuscated="true"
          >
            <span aria-hidden="true" data-chat-span-glyphs="true">
              {isHydrated ? scrambleGlyphs(span.text) : span.text}
            </span>
            <span className={styles.chatObfuscatedSrOnly} data-chat-span-sr-text="true">
              {span.text}
            </span>
          </span>
        );
      })}
    </span>
  );
}
