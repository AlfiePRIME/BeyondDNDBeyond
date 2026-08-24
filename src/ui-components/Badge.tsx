import type { HTMLAttributes } from "react";
import styles from "./ui.module.css";

export type BadgeTone = "purple" | "pink" | "teal" | "orange" | "red" | "neutral";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Color tone. Defaults to "neutral" (muted, no accent pull). */
  tone?: BadgeTone;
  /**
   * Adds a status dot that slowly "breathes" (ported breathe-opacity
   * vocabulary) — for live states like "connected" or "in initiative".
   */
  pulse?: boolean;
}

const TONE_CLASS: Record<BadgeTone, string | undefined> = {
  purple: styles.badgeTonePurple,
  pink: styles.badgeTonePink,
  teal: styles.badgeToneTeal,
  orange: styles.badgeToneOrange,
  red: styles.badgeToneRed,
  neutral: undefined,
};

/** Mono uppercase tag chip in the ported label convention. */
export function Badge({ tone = "neutral", pulse = false, className, children, ...rest }: BadgeProps) {
  const classes = [styles.badge, TONE_CLASS[tone], className].filter(Boolean).join(" ");
  return (
    <span className={classes} {...rest}>
      {pulse ? <span className={styles.badgeDot} aria-hidden /> : null}
      {children}
    </span>
  );
}
