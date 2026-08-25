"use client";

import { useState, type ReactNode } from "react";
import { Badge, Peel, type PeelOptions } from "@/ui-components";
import styles from "./DmToolPeel.module.css";

type TabSide = NonNullable<PeelOptions["side"]>;

/**
 * Phase C: the "turn the page" reveal for MonsterPanel and
 * DmOverridesPanel — the two Game Room panels that are entirely,
 * unconditionally DM-only in both content and every control (every other
 * panel is at least partly shared, which is why those seven went into
 * Phase B's drag/collapse system instead — see DraggablePanel.tsx's
 * PanelId doc comment). Per the owner's wishlist: the table view shouldn't
 * be cluttered by these two sitting open by default; a small, clearly
 * DM-only tab peels back to reveal the real panel, and can be dismissed
 * again once the DM is done. Each panel keeps its own untouched
 * `position: absolute` placement in room.module.css — this only adds the
 * tab and the reveal, layered on top, at that same screen corner (see
 * DmToolPeel.module.css's anchor classes).
 *
 * Two things learned by reading Peel.tsx closely (not guessed) that shape
 * every decision below:
 *
 * 1. Peel's `under` slot — the thing actually meant to be "revealed" — is
 *    only ever rendered when `supportsHtmlInCanvas()` is true, which
 *    requires a real browser feature (`CanvasRenderingContext2D
 *    .drawElementImage` + `canvas.requestPaint`, the same "html-in-canvas"
 *    capability Glitch/VHS/ForceField all feature-detect). Verified
 *    directly against the Chromium this project's own `yarn dev`/
 *    Playwright checks use: neither method exists. Reading Peel's fallback
 *    JSX confirms the consequence — when `native` is false it renders
 *    ONLY `children`, `under` is never mounted at all. Routing the real,
 *    clickable MonsterPanel/DmOverridesPanel through `under` would make
 *    them permanently unreachable today, not just visually different. So
 *    Peel here wraps only the small trigger tab's decorative face —
 *    forward-compatible if a browser ever ships support, inert (and
 *    harmless) until then — never the actual panel.
 *
 * 2. Even setting that aside, Peel's own pointer-driven `content`
 *    (whatever `children` is) isn't safe to make the real click target
 *    either: `createPeel`'s per-frame `syncContentEvents` sets
 *    `content.style.pointerEvents = "none"` whenever the peel is "open"
 *    (by its own hover-physics, which starts animating within a frame of
 *    the cursor merely entering the zone) AND the pointer sits near the
 *    fold — which for a small tab is most of its own footprint. That's
 *    correct behavior when there's real content in `under` to fall
 *    through to; with nothing there, it would silently swallow clicks on
 *    the tab itself shortly after the cursor arrives, before the DM ever
 *    gets to click it. So the actual open/close control is a separate,
 *    plain, always-hit-testable `<button>` layered on top (a sibling of
 *    Peel, not inside it) — Peel's pointer-events juggling only ever
 *    touches its own subtree, never this sibling.
 *
 * Combined, this also resolves the hover-vs-click question the brief
 * raised: Peel's `mode="hover"` (kept at the owner's given value, since it
 * only drives the tab's own inert decorative curl) never gates the real
 * interaction. Opening/closing MonsterPanel/DmOverridesPanel is ordinary
 * React state toggled by a real click — once open, it stays open
 * regardless of where the cursor goes, so every button/input inside is
 * fully usable, exactly what a form-and-buttons DM panel needs.
 */
export function DmToolPeel({
  label,
  side,
  anchorClassName,
  testId,
  children,
}: {
  /** Short label on the tab, matching the revealed panel's own header
   * text (e.g. "Monsters", "DM Controls") so there's no mismatch between
   * what the tab promises and what appears. */
  label: string;
  /** Forwarded to Peel's own `side` — see the file doc comment: cosmetic
   * only today, kept for forward-compatibility. */
  side: TabSide;
  /** Positions this specific tab at its panel's own corner (own CSS
   * module). MonsterPanel and DmOverridesPanel sit in different corners
   * of room.module.css's untouched layout, so each gets its own
   * independent tab rather than sharing one "book" — a shared trigger
   * would either force both open together (defeating the declutter goal
   * whenever the DM only needs one) or need its own tab-switching UI the
   * brief never asked for. */
  anchorClassName: string;
  /** Root data-testid for the trigger button. */
  testId: string;
  /** The real panel (MonsterPanel or DmOverridesPanel), pre-built by the
   * caller with its normal props. Only mounted while revealed — passing
   * it as a prop doesn't render it until it's actually included in the
   * tree below, so it's never constructed/subscribed while collapsed. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className={[styles.tabAnchor, anchorClassName].join(" ")}>
        <Peel
          side={side}
          mode="hover"
          reveal={250}
          zone={200}
          curl={300}
          bow={75}
          shade={0.25}
          shine={1}
          shineDistance={1200}
          bulge={50}
          perspective={2000}
          smoothing={0.3}
          shineColor="auto"
        >
          {/* Decorative only (see point 2 above) — aria-hidden because the
              real accessible control is the overlay button below, which
              carries the actual name/state. */}
          <div className={styles.tabFace} aria-hidden="true">
            <span className={styles.tabLabel}>{label}</span>
            <Badge tone="red" className={styles.tabBadge}>
              DM
            </Badge>
          </div>
        </Peel>
        <button
          type="button"
          className={styles.tabHit}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${label} (DM only)`}
          onClick={() => setOpen((value) => !value)}
          data-testid={testId}
        />
      </div>
      {open ? children : null}
    </>
  );
}

/** Applied by the caller directly onto MonsterPanel/DmOverridesPanel's own
 * `className` prop (merged onto their root `<aside>`) — see this file's
 * `children` doc for why the entrance animation lands on the panel's own
 * root rather than a wrapping div here. */
export const dmToolRevealClassName = styles.reveal;
