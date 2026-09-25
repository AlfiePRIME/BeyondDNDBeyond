import Link from "next/link";
import { ViewTransition } from "react";
import { Button } from "@/ui-components";
import { logout } from "./actions";
import { OnlineIndicator } from "./OnlineIndicator";
import styles from "./AppNav.module.css";

interface NavLinkDef {
  href: string;
  label: string;
  testId: string;
}

// Home is the merged Lobby + Campaigns page; every campaign page lives
// under it, so it stays highlighted inside a campaign too.
const NAV_LINKS: NavLinkDef[] = [
  { href: "/", label: "Home", testId: "app-nav-link-home" },
  { href: "/account", label: "Account", testId: "app-nav-link-account" },
];

export interface AppNavProps {
  /** The requesting page's own route (e.g. `/`, `/campaigns`, `/campaigns/abc-123`). Used to
   * highlight whichever nav link owns the current route — exact match, or a prefix match for
   * links other than "/" so a campaign detail page still highlights "Your Campaigns". */
  currentPath: string;
  /** Best-available display label for the signed-in user (display name, falling back to
   * email) — callers should reuse whatever they've already fetched rather than querying again. */
  userLabel?: string | null;
}

function isActive(href: string, currentPath: string): boolean {
  if (href === "/") return currentPath === "/" || currentPath.startsWith("/campaigns");
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

/**
 * Shared top-level nav bar for the pre-game pages (Lobby, Campaigns, Account, Campaign
 * detail) — the only way to reach every top-level section (notably `/account`, which
 * previously had no inbound link anywhere in the app). Plain server component: the caller
 * passes its own route as `currentPath` rather than this component doing any client-side
 * route matching.
 */
export function AppNav({ currentPath, userLabel }: AppNavProps) {
  return (
    // Anchored during page transitions (see globals.css) so only the content
    // below it moves; the active pill morphs from one link to the next.
    <nav className={styles.nav} aria-label="Main" data-testid="app-nav" style={{ viewTransitionName: "app-nav" }}>
      <ul className={styles.navList} style={{ viewTransitionName: "app-nav-links" }}>
        {NAV_LINKS.map(({ href, label, testId }, index) => {
          const active = isActive(href, currentPath);
          const currentIndex = NAV_LINKS.findIndex((link) => isActive(link.href, currentPath));
          return (
            <li key={href} className={styles.navItem}>
              {active ? (
                <ViewTransition name="app-nav-active" share="nav-pill" default="none">
                  <span className={styles.navPill} aria-hidden="true" />
                </ViewTransition>
              ) : null}
              <Link
                href={href}
                className={active ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
                aria-current={active ? "page" : undefined}
                transitionTypes={index > currentIndex ? ["nav-forward"] : ["nav-back"]}
                data-testid={testId}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
      <span className={styles.navActions}>
        <OnlineIndicator />
        {userLabel ? <span className={styles.navUser}>{userLabel}</span> : null}
        <form action={logout}>
          <Button type="submit" variant="ghost" size="sm" data-testid="app-nav-logout">
            Log out
          </Button>
        </form>
      </span>
    </nav>
  );
}
