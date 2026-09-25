import { ViewTransition, type ReactNode } from "react";

/**
 * Animates a page's content when navigating between pages (the nav bar
 * itself stays anchored — see AppNav). Links tagged `nav-forward` /
 * `nav-back` (going deeper into a campaign, or back out) use M3's shared-
 * axis slide; any other navigation between top-level pages uses M3's fade
 * through. The CSS lives in globals.css. Must wrap each page's own content
 * (not a layout — layouts persist across navigations, so they never enter
 * or exit).
 */
export function PageTransition({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ViewTransition
      enter={{ "nav-forward": "nav-forward", "nav-back": "nav-back", default: "fade-through" }}
      exit={{ "nav-forward": "nav-forward", "nav-back": "nav-back", default: "fade-through" }}
      default="none"
    >
      <div className={className}>{children}</div>
    </ViewTransition>
  );
}
