import Link from "next/link";
import { Button } from "@/ui-components";
import { logout } from "./actions";
import styles from "./AppNav.module.css";

interface NavLinkDef {
  href: string;
  label: string;
  testId: string;
}

const NAV_LINKS: NavLinkDef[] = [
  { href: "/", label: "Lobby", testId: "app-nav-link-lobby" },
  { href: "/campaigns", label: "Your Campaigns", testId: "app-nav-link-campaigns" },
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
  if (href === "/") return currentPath === "/";
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
    <nav className={styles.nav} aria-label="Main" data-testid="app-nav">
      <ul className={styles.navList}>
        {NAV_LINKS.map(({ href, label, testId }) => {
          const active = isActive(href, currentPath);
          return (
            <li key={href}>
              <Link
                href={href}
                className={active ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
                aria-current={active ? "page" : undefined}
                data-testid={testId}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
      <span className={styles.navActions}>
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
