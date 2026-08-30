"use client";

import { useEffect } from "react";
import type { TokenAllegiance } from "@/data-access";
import styles from "./AllegianceBanner.module.css";

/** One pending announcement — GameRoom.tsx builds these (see its own
 * allegianceBannerText/resolveTokenDisplayName) the instant a token's
 * allegiance genuinely changes to/from 'party'; this component only ever
 * displays them, never decides wording. `tone` is the token's NEW
 * allegiance after the change (drives the banner's accent color only —
 * TokenPanel.tsx's own party/hostile/neutral = teal/red/orange convention,
 * reused here rather than invented fresh). `id` just needs to be unique per
 * event, not meaningful — GameRoom mints it with crypto.randomUUID() the
 * same way several data-access modules already do for client-generated
 * ids. */
export interface AllegianceBannerEvent {
  id: string;
  text: string;
  tone: TokenAllegiance;
}

// How long each banner stays up before the queue advances to the next one.
// Matches CampaignRoster.tsx's own RECONNECTED_CONFIRMATION_MS (4000ms) —
// the closest existing "transient status notice" duration convention in
// this app: long enough to read a short sentence, short enough not to
// linger once the moment has passed.
const AUTO_DISMISS_MS = 4000;

/**
 * Global Party Members: a full-width (never full-screen — it must never
 * block the 3D scene underneath), animated announcement banner for a
 * token's allegiance changing to/from 'party' — joining, turning hostile,
 * or becoming neutral. Mounted once in GameRoom.tsx, fed entirely by data
 * that already arrives over the existing TOKEN_EVENT broadcast/local-apply
 * path (see GameRoom.tsx's pushAllegianceBannerIfNeeded) — no new
 * persistence, no new broadcast event. Every already-connected client
 * reacts independently to its own copy of that same data, which is why a
 * second, idle client sees the same banner live with zero extra plumbing.
 *
 * Multiple rapid changes (e.g. a DM flipping several tokens in quick
 * succession during setup) are queued, not stacked or replaced: `banners`
 * is a plain FIFO GameRoom owns (capped at MAX_QUEUED_ALLEGIANCE_BANNERS
 * there), and this component always renders only `banners[0]` — the
 * OLDEST still-pending one — for its own full AUTO_DISMISS_MS before
 * calling `onDismiss` and letting the next one take its place. This was
 * chosen over stacking (which would need its own scroll/overflow story the
 * instant more than two or three arrived back-to-back) and over "newest
 * replaces current" (which would silently swallow information — a DM who
 * just flipped three tokens in a row would only ever see the last one
 * announced, even though every flip is a real, distinct game event worth
 * calling out). One-at-a-time queuing keeps the display simple and never
 * drops a change, at the cost of a short delay before a rapid-fire change
 * gets its own announcement — an acceptable trade for something this
 * transient and non-blocking.
 *
 * `key={current.id}` on the root element is deliberate, not decorative: it
 * forces React to unmount and remount the banner element whenever the
 * CURRENTLY-shown item changes (a genuinely different id at position 0),
 * which is what makes the `fade-up` entrance animation replay for each new
 * announcement and resets this component's own auto-dismiss timer for it —
 * while appending a new item to the END of the queue (not touching
 * banners[0]) leaves `current` referentially unchanged, so a banner
 * already on screen is never interrupted or re-animated just because
 * something else joined the queue behind it.
 */
export function AllegianceBanner({
  banners,
  onDismiss,
}: {
  banners: readonly AllegianceBannerEvent[];
  onDismiss: (id: string) => void;
}) {
  const current = banners[0] ?? null;

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => onDismiss(current.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [current, onDismiss]);

  if (!current) return null;

  return (
    <div
      key={current.id}
      className={styles.banner}
      data-tone={current.tone}
      role="status"
      aria-live="polite"
      data-testid="allegiance-banner"
    >
      <span className={styles.text}>{current.text}</span>
    </div>
  );
}
