import { redirect } from "next/navigation";
import { Badge, Button, Panel, SectionHeader } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getProfile, isProfileComplete, listCampaignsForUser } from "@/data-access";
import { logout } from "./actions";
import { CreateCampaignForm } from "./CreateCampaignForm";
import { JoinCampaignForm } from "./JoinCampaignForm";
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

  const memberships = await listCampaignsForUser(supabase, user.id);

  return (
    <div className={styles.page}>
      <main className={styles.dashboard}>
        <Panel
          title="BeyondDNDBeyond"
          tone="purple"
          headerActions={
            <form action={logout}>
              <Button type="submit" variant="ghost" size="sm">
                Log out
              </Button>
            </form>
          }
        >
          <SectionHeader eyebrow="Signed in" title={`Welcome, ${profile!.display_name}`} glitch />
        </Panel>

        <Panel title="Your campaigns" tone="purple">
          {memberships.length === 0 ? (
            <p className={styles.emptyState}>
              You&apos;re not in any campaigns yet — create one or join with an invite code below.
            </p>
          ) : (
            <ul className={styles.campaignList}>
              {memberships.map(({ role, campaign }) => (
                <li key={campaign.id} className={styles.campaignRow}>
                  <div>
                    <span className={styles.campaignName}>{campaign.name}</span>{" "}
                    <Badge tone={role === "dm" ? "pink" : "teal"}>{role === "dm" ? "DM" : "Player"}</Badge>
                  </div>
                  {role === "dm" ? (
                    <span className={styles.inviteCode}>
                      Invite code: <code>{campaign.invite_code}</code>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className={styles.formsRow}>
          <Panel title="Create a campaign" tone="pink" className={styles.formPanel}>
            <CreateCampaignForm />
          </Panel>
          <Panel title="Join a campaign" tone="teal" className={styles.formPanel}>
            <JoinCampaignForm />
          </Panel>
        </div>
      </main>
    </div>
  );
}
