import { redirect } from "next/navigation";
import { Button, Panel, SectionHeader } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getProfile, isProfileComplete } from "@/data-access";
import { logout } from "./actions";
import styles from "./page.module.css";

export default async function Home() {
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
      <main className={styles.main}>
        <Panel title="BeyondDNDBeyond" tone="purple" glow className={styles.welcomePanel}>
          <SectionHeader eyebrow="Signed in" title={`Welcome, ${profile!.display_name}`} glitch />
          <p>
            You&apos;re authenticated and your profile is set up. The lobby, campaigns, and the
            3D table itself arrive in later prompts.
          </p>
          <form action={logout}>
            <Button type="submit" variant="ghost">
              Log out
            </Button>
          </form>
        </Panel>
      </main>
    </div>
  );
}
