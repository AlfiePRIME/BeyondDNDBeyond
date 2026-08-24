import type { ButtonHTMLAttributes } from "react";
import styles from "./ui.module.css";

export type ButtonVariant = "primary" | "accent" | "teal" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual tone. Defaults to the filled purple "primary". */
  variant?: ButtonVariant;
  /** Padding/font scale. Defaults to "md". */
  size?: ButtonSize;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: styles.buttonPrimary,
  accent: styles.buttonAccent,
  teal: styles.buttonTeal,
  danger: styles.buttonDanger,
  ghost: styles.buttonGhost,
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: styles.buttonSm,
  md: styles.buttonMd,
  lg: styles.buttonLg,
};

/**
 * Neon/CRT button. Real `<button>` (defaults to type="button"), glow on
 * hover and keyboard focus, monospace uppercase label per the ported
 * label convention.
 */
export function Button({
  variant = "primary",
  size = "md",
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  const classes = [styles.button, VARIANT_CLASS[variant], SIZE_CLASS[size], className]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={classes} {...rest} />;
}
