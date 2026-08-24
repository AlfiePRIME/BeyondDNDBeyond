import type { HTMLAttributes, ReactNode } from "react";
import styles from "./ui.module.css";

export type PanelTone = "purple" | "pink" | "teal" | "none";

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Optional header label, rendered in the mono uppercase convention. */
  title?: ReactNode;
  /** Right-aligned header content (badges, actions). Only shown with a title. */
  headerActions?: ReactNode;
  /** Accent color for the top edge + title. Defaults to "purple". */
  tone?: PanelTone;
  /** Adds the tone's ambient glow shadow. Off by default — use sparingly. */
  glow?: boolean;
  children?: ReactNode;
}

const TONE_CLASS: Record<PanelTone, string | undefined> = {
  purple: styles.panelTonePurple,
  pink: styles.panelTonePink,
  teal: styles.panelToneTeal,
  none: undefined,
};

const GLOW_CLASS: Record<PanelTone, string | undefined> = {
  purple: styles.panelGlowPurple,
  pink: styles.panelGlowPink,
  teal: styles.panelGlowTeal,
  none: undefined,
};

/**
 * Surface container with a 1px energized top edge in its tone color.
 * Body copy stays on solid --text for legibility; the neon lives in the
 * chrome.
 */
export function Panel({
  title,
  headerActions,
  tone = "purple",
  glow = false,
  className,
  children,
  ...rest
}: PanelProps) {
  const classes = [
    styles.panel,
    TONE_CLASS[tone],
    glow ? GLOW_CLASS[tone] : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section className={classes} {...rest}>
      {title !== undefined ? (
        <header className={styles.panelHeader}>
          <span className={styles.panelTitle}>{title}</span>
          {headerActions}
        </header>
      ) : null}
      <div className={styles.panelBody}>{children}</div>
    </section>
  );
}
