/**
 * The shared clock that drives every obfuscated ("&k") chat span's
 * continuously-scrambling glyph effect (Chat & Summary B2).
 *
 * A page could have several obfuscated messages visible at once (the
 * floating chat bubble plus several rows of the persistent log panel, say)
 * — one `setInterval` per obfuscated span would mean the animation cost
 * scales with how much obfuscated text happens to be on screen. Instead,
 * every currently-mounted obfuscated span (across every ChatText instance
 * on the page) subscribes to this ONE module-level interval; it starts the
 * instant the first subscriber appears and is torn down the instant the
 * last one goes away, so a page with no obfuscated text on screen pays
 * nothing at all.
 *
 * Deliberately still React-free (like chatFormatting.ts) — ChatText.tsx is
 * the only thing that wires this up to a component's re-renders, via a
 * plain `useEffect`/`useState` subscription, not a custom hook exported
 * from here.
 */

const TICK_INTERVAL_MS = 50;

type Listener = () => void;

const listeners = new Set<Listener>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;

function tick() {
  for (const listener of listeners) listener();
}

/**
 * Registers `listener` to be called on every clock tick (~every 50ms) while
 * subscribed. Returns an unsubscribe function — always call it on cleanup
 * (ChatText.tsx does this from a `useEffect` cleanup), or the interval will
 * never stop for a page that keeps a stale subscriber around.
 */
export function subscribeToObfuscationTick(listener: Listener): () => void {
  listeners.add(listener);
  if (intervalHandle === null) {
    intervalHandle = setInterval(tick, TICK_INTERVAL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  };
}

/**
 * Introspection only — not used by any product rendering path. Exists so a
 * real, end-to-end Playwright check (scripts/db/verify-chat-formatting.mjs)
 * can confirm from outside the module that mounting several obfuscated
 * spans at once still only ever runs a single shared interval, the same
 * "mirror internal state into something a test can read" pattern this
 * codebase already uses for WebGL-only state (see e.g. DmBookProp.tsx's
 * onProjectedPosition doc comment).
 */
export function getObfuscationClockDebugInfo(): { subscriberCount: number; intervalActive: boolean } {
  return { subscriberCount: listeners.size, intervalActive: intervalHandle !== null };
}

const OBFUSCATION_GLYPHS =
  "!@#$%^&*()_-+=<>?/\\|~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split("");

/**
 * Produces one tick's worth of scrambled output for an obfuscated span's
 * real text: every non-whitespace character replaced with a random glyph,
 * whitespace left untouched at the same positions (Minecraft's own
 * convention) so word shape/wrapping doesn't visibly jump around as it
 * scrambles. Pure — holds no state between calls; ChatText.tsx re-invokes
 * it with the span's original text on every clock tick to get a fresh
 * scramble, rather than this module tracking per-span identity itself.
 */
export function scrambleGlyphs(text: string): string {
  let out = "";
  for (const ch of text) {
    out += /\s/.test(ch) ? ch : OBFUSCATION_GLYPHS[Math.floor(Math.random() * OBFUSCATION_GLYPHS.length)];
  }
  return out;
}
