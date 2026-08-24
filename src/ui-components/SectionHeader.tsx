import type { HTMLAttributes, ReactNode } from "react";
import styles from "./ui.module.css";

export interface SectionHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** Small mono eyebrow line above the title (gets a teal "//" prefix). */
  eyebrow?: ReactNode;
  /** The heading text. Plain string required when `glitch` is on. */
  title: string;
  /** Heading level for the underlying element. Defaults to h2. */
  as?: "h1" | "h2" | "h3" | "h4";
  /**
   * Layers the ported glitch-a/glitch-b CRT blips over the title.
   * Decorative only (aria-hidden layers) and collapsed under
   * prefers-reduced-motion by the tokens file.
   */
  glitch?: boolean;
  /** Right-aligned content on the title row (buttons, badges). */
  actions?: ReactNode;
}

/**
 * Section heading in the display face with a purple→pink hairline rule.
 * The optional glitch treatment reuses the ported keyframe vocabulary —
 * it never invents new motion.
 */
export function SectionHeader({
  eyebrow,
  title,
  as: Heading = "h2",
  glitch = false,
  actions,
  className,
  ...rest
}: SectionHeaderProps) {
  const classes = [styles.sectionHeader, className].filter(Boolean).join(" ");
  return (
    <div className={classes} {...rest}>
      {eyebrow !== undefined ? <span className={styles.sectionEyebrow}>{eyebrow}</span> : null}
      <div className={styles.sectionTitleRow}>
        <span className={styles.sectionTitleWrap}>
          <Heading className={styles.sectionTitle}>{title}</Heading>
          {glitch ? (
            <>
              <span aria-hidden className={`${styles.sectionGlitchLayer} ${styles.sectionGlitchA}`}>
                {title}
              </span>
              <span aria-hidden className={`${styles.sectionGlitchLayer} ${styles.sectionGlitchB}`}>
                {title}
              </span>
            </>
          ) : null}
        </span>
        {actions}
      </div>
      <div className={styles.sectionRule} aria-hidden />
    </div>
  );
}
