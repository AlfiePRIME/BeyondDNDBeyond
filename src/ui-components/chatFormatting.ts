/**
 * Minecraft-style chat formatting parser (Chat & Summary B2).
 *
 * Players hand-type "&"-prefixed format codes into chat messages (e.g.
 * "&cHello &lworld&r!") the same way Minecraft server chat/MOTD text works.
 * This module turns a raw message string into a flat sequence of styled
 * `ChatSpan`s a renderer can map straight to DOM `<span>`s — see ChatText.tsx
 * for the small React wrapper that actually does that.
 *
 * Deliberately dependency-free (no React, no React Three Fiber, no DOM) so
 * it stays trivially unit-testable and reusable from any rendering context
 * — the floating chat bubble (B3) and the persistent log panel (B4) both
 * consume the exact same parser output. Only ChatText.tsx (and the
 * obfuscation clock it drives itself with, chatObfuscationClock.ts) touch
 * rendering.
 */

/** A single formatting flag a run of styled text can carry, independent of
 * color. `obfuscated` only marks intent here — ChatText.tsx (and
 * chatObfuscationClock.ts) own the actual continuously-scrambling render
 * effect; the parser has no concept of time or animation. */
export type ChatFormatFlag = "bold" | "italic" | "underline" | "strikethrough" | "obfuscated";

/** One contiguous run of text sharing the exact same style. Booleans are
 * always present (never optional) so span objects are trivially
 * deep-equal-comparable in tests and safe to destructure without `?? false`
 * at every call site. */
export interface ChatSpan {
  text: string;
  /** A CSS color value (a literal hex string from CHAT_COLOR_CODES below)
   * — or `undefined` for "use the renderer's own default text color"
   * (never set as its own code). */
  color?: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  obfuscated: boolean;
}

/**
 * Color codes. A practical subset of Minecraft's own 16-code table, not a
 * verbatim port of it. These are CONTENT colors a player picks on purpose,
 * so they're fixed, distinct hex values rather than theme tokens — under
 * the Material 3 theme several app tokens resolve to the same soft role
 * color (purple and lavender are both `primary`, red is a pastel `error`),
 * which would make "&4" stop reading as red. Values are the app's original
 * vivid accents, plus black/blue/green.
 *
 * Single-character keys only (never a multi-character code) — both to keep
 * `&<code>` exactly two characters like Minecraft's own scheme, and because
 * that guarantees these keys can never collide with an inherited
 * Object.prototype property name when looked up.
 */
export const CHAT_COLOR_CODES: Readonly<Record<string, string>> = {
  "0": "#000000", // black
  "1": "#3c6dff", // blue
  "2": "#3ecf5c", // green
  "3": "#1ec8c8", // teal
  "4": "#ff3b3b", // red
  "5": "#9b00ff", // purple
  "6": "#ff9a3c", // orange
  "7": "#9b8bbb", // gray
  "8": "#6b4f8c", // dark gray
  "9": "#ff2d78", // pink
  a: "#cc55ff", // lavender
  f: "#ede0ff", // white
};

/** Format codes (fixed by the prompt spec, one letter each) mapped to the
 * `ChatSpan` boolean flag they turn on. `r` (reset) isn't in this table — it
 * doesn't turn one flag on, it clears everything, and is handled as its own
 * case in the parser below. */
const FORMAT_FLAG_BY_CODE: Readonly<Record<string, ChatFormatFlag>> = {
  l: "bold",
  o: "italic",
  n: "underline",
  m: "strikethrough",
  k: "obfuscated",
};

type MutableStyle = Omit<ChatSpan, "text">;

function defaultStyle(): MutableStyle {
  return {
    color: undefined,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    obfuscated: false,
  };
}

/**
 * Parses a raw chat message into a sequence of styled spans.
 *
 * Code semantics deliberately mirror real Minecraft chat, since that's the
 * scheme players typing these codes by hand are expected to already know:
 * - A color code (`&0`-`&9`, `&a`, `&f`) sets the color AND resets every
 *   format flag back off — exactly like starting a fresh run of text.
 * - A format code (`&l`, `&o`, `&n`, `&m`, `&k`) turns on that one flag on
 *   top of whatever color/flags are already active — purely additive.
 * - `&r` resets color and every format flag back to the default.
 * - Any other `&<char>` (including a bare trailing `&` with nothing after
 *   it) is not a recognized code at all: it degrades to literal text,
 *   character-for-character, rather than being dropped or crashing.
 *
 * Adjacent text sharing an identical style is naturally already merged into
 * one span (a span only ever closes when a code actually changes the
 * current style), and codes that produce no visible text on either side
 * never produce an empty span.
 */
export function parseChatFormatting(raw: string): ChatSpan[] {
  const spans: ChatSpan[] = [];
  let buffer = "";
  let style = defaultStyle();

  const flush = () => {
    if (buffer.length > 0) {
      spans.push({ text: buffer, ...style });
      buffer = "";
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "&" && i + 1 < raw.length) {
      const code = raw[i + 1].toLowerCase();
      if (code in CHAT_COLOR_CODES) {
        flush();
        style = { ...defaultStyle(), color: CHAT_COLOR_CODES[code] };
        i++; // consume the code character too
        continue;
      }
      if (code === "r") {
        flush();
        style = defaultStyle();
        i++;
        continue;
      }
      const flag = FORMAT_FLAG_BY_CODE[code];
      if (flag) {
        flush();
        style = { ...style, [flag]: true };
        i++;
        continue;
      }
      // Unrecognized code: keep the "&" as a literal character and let the
      // next loop iteration handle whatever follows it on its own terms —
      // this consumes exactly one character per iteration either way, so
      // nothing is ever double-consumed or silently dropped.
      buffer += ch;
      continue;
    }
    // A plain character, or a trailing "&" with nothing after it.
    buffer += ch;
  }
  flush();

  return spans;
}
