import { redirect } from "next/navigation";
import Link from "next/link";
import { Button, Panel, SectionHeader } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getProfile, isProfileComplete } from "@/data-access";
import { logout } from "./actions";
import { LobbyPresence } from "./LobbyPresence";
import styles from "./page.module.css";

export default async function LobbyPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const profile = await getProfile(supabase, user.id);
  if (!isProfileComplete(profile)) {
    redirect("/profile-setup");
  }

  return (
    <div className={styles.page}>
      <main className={styles.lobby}>
        <Panel
          title="BeyondDNDBeyond"
          tone="purple"
          headerActions={
            <span className={styles.headerActions}>
              <Link href="/campaigns" className={styles.navLink}>
                Your campaigns
              </Link>
              <form action={logout}>
                <Button type="submit" variant="ghost" size="sm">
                  Log out
                </Button>
              </form>
            </span>
          }
        >
          <SectionHeader eyebrow="Signed in" title={`Welcome, ${profile!.display_name}`} glitch />
        </Panel>

        <Panel title="The Lobby" tone="teal" glow>
          <p className={styles.lobbyHint}>
            Everyone signed in right now gathers here — grab a seat while the party assembles.
          </p>
          <LobbyPresence currentUserId={user.id} currentUserDisplayName={profile!.display_name} />
        </Panel>
      </main>
    </div>
  );
}
