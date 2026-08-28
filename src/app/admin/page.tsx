import { redirect } from "next/navigation";
import Link from "next/link";
import { Panel } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getProfile, getAppSettings } from "@/data-access";
import { AdminSettingsForm } from "./AdminSettingsForm";
import styles from "./admin.module.css";

/**
 * AI Backend & Admin D2 — the admin-only provider/settings page. Per the
 * project owner, this is a plain page-level access gate matching how every
 * DM-only page in this app already self-checks (e.g.
 * campaigns/[id]/dm-notes/page.tsx and campaigns/[id]/lore/new/page.tsx):
 * session first, then the relevant role flag, redirecting away if either
 * fails — no shared "protected layout" component exists anywhere in this
 * codebase, and this page doesn't introduce one either.
 *
 * Unlike those campaign-scoped pages (which 404 on a hidden campaign then
 * redirect non-DMs back to a campaign-relative page), /admin is a top-level
 * route with no campaign context, so a failed check sends the visitor to
 * /login (no session) or the Lobby "/" (signed in, not an admin) — the
 * project owner's own suggested targets.
 */
export default async function AdminSettingsPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getProfile(supabase, user.id);
  // Deliberately checked in application code, not just relied on via RLS
  // alone — this redirect is what keeps a non-admin from ever seeing this
  // page's form at all, on top of app_settings' own is_app_admin()-gated
  // RLS (0072) that would reject their reads/writes anyway if they somehow
  // reached it.
  if (!profile?.is_admin) redirect("/");

  const settings = await getAppSettings(supabase);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href="/" className={styles.backLink}>
          ← Back to the Lobby
        </Link>

        <Panel title="Admin — AI provider settings" tone="purple" glow>
          <p className={styles.hint}>
            Deployment-wide AI provider configuration. Only app admins can see or change this.
          </p>
          {settings ? (
            <AdminSettingsForm initialSettings={settings} />
          ) : (
            <p className={styles.errorText} data-testid="admin-settings-missing">
              Settings could not be loaded.
            </p>
          )}
        </Panel>
      </main>
    </div>
  );
}
