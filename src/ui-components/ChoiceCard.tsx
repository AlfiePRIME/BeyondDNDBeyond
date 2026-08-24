import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./ui.module.css";

export interface ChoiceCardProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  /** Whether this card is the current pick in its group (aria-pressed). */
  selected?: boolean;
  /** Card heading, rendered in the mono uppercase convention. */
  title: ReactNode;
  /** Small mono metadata line under the title. */
  meta?: ReactNode;
  /** Optional body copy (trait lists, bundle contents). */
  children?: ReactNode;
}

/**
 * Selectable option card for pick-one/pick-many groups (races, classes,
 * equipment bundles, spells). A real toggle `<button>` so it's keyboard
 * operable; selection state lives with the caller.
 */
export function ChoiceCard({
  selected = false,
  title,
  meta,
  type = "button",
  className,
  children,
  ...rest
}: ChoiceCardProps) {
  const classes = [styles.choiceCard, selected ? styles.choiceCardSelected : undefined, className]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} aria-pressed={selected} className={classes} {...rest}>
      <span className={styles.choiceCardTitle}>{title}</span>
      {meta !== undefined ? <span className={styles.choiceCardMeta}>{meta}</span> : null}
      {children !== undefined ? <span className={styles.choiceCardBody}>{children}</span> : null}
    </button>
  );
}
