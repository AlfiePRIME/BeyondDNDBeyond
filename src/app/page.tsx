import { redirect } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  getProfile,
  isProfileComplete,
  listCampaignMembers,
  listCampaignsForUser,
  listCharactersForUser,
} from "@/data-access";
import { AppNav } from "./AppNav";
import { ReadyToPlay, type LiveGame } from "./ReadyToPlay";
import { LiveGamesRefresher } from "./LiveGamesRefresher";
import { CreateCampaignForm } from "./campaigns/CreateCampaignForm";
import { JoinCampaignForm } from "./campaigns/JoinCampaignForm";
import { PageTransition } from "./PageTransition";
import styles from "./page.module.css";

export const metadata = { title: "Home" };

/**
 * Home: the old Lobby and Campaigns pages merged into one place — who's
 * online and Start (ReadyToPlay), every campaign with a direct way in, and
 * creating/joining a campaign. Presence itself is app-wide (LobbyProvider),
 * so nobody has to sit on this page to be pulled into a session.
 */
export default async function HomePage() {
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

  const [memberships, characters] = await Promise.all([
    listCampaignsForUser(supabase, user.id),
    listCharactersForUser(supabase, user.id),
  ]);

  // A game is "in progress" while live or paused (session_started_at set).
  const inProgress = memberships.filter(
    ({ campaign }) => campaign.session_active || campaign.session_started_at !== null
  );
  const liveGames: LiveGame[] = await Promise.all(
    inProgress.map(async ({ campaign }) => {
      const members = await listCampaignMembers(supabase, campaign.id).catch(() => []);
      return {
        campaignId: campaign.id,
        campaignName: campaign.name,
        hostName: members.find((member) => member.role === "dm")?.display_name ?? null,
        paused: !campaign.session_active,
      };
    })
  );
  const hostableCampaigns = memberships.map(({ campaign }) => ({
    id: campaign.id,
    name: campaign.name,
    inProgress: campaign.session_active || campaign.session_started_at !== null,
  }));

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <AppNav currentPath="/" userLabel={profile!.display_name} />
        <PageTransition className={styles.content}>

        <LiveGamesRefresher campaignIds={memberships.map(({ campaign }) => campaign.id)} />
        <ReadyToPlay
          currentUserId={user.id}
          currentUserDisplayName={profile!.display_name}
          liveGames={liveGames}
          hostableCampaigns={hostableCampaigns}
        />

        <section className={styles.section} aria-labelledby="your-campaigns-title" data-testid="campaigns-dashboard">
          <h2 id="your-campaigns-title" className={styles.sectionTitle}>
            Your campaigns
          </h2>
          {memberships.length === 0 ? (
            <p className={styles.emptyState} data-testid="lobby-campaigns-zero-state">
              You&apos;re not in any campaigns yet. Create one below, or ask your DM for an invite code and join
              theirs.
            </p>
          ) : (
            <ul className={styles.campaignGrid}>
              {memberships.map(({ role, campaign }, index) => {
                const character = characters.find((c) => c.campaign?.id === campaign.id);
                const live = campaign.session_active;
                const paused = !live && campaign.session_started_at !== null;
                return (
                  <li
                    key={campaign.id}
                    className={`${styles.campaignCard} ${live ? styles.campaignCardLive : ""}`}
                    style={{ "--stagger": index } as React.CSSProperties}
                    data-testid={`lobby-campaign-row-${campaign.id}`}
                  >
                    <div className={styles.cardHeader}>
                      <Link
                        href={`/campaigns/${campaign.id}`}
                        transitionTypes={["nav-forward"]}
                        className={styles.campaignName}
                      >
                        {campaign.name}
                      </Link>
                      <Badge tone={role === "dm" ? "pink" : "teal"}>{role === "dm" ? "DM" : "Player"}</Badge>
                    </div>

                    <p className={styles.cardStatus}>
                      <span
                        className={`${styles.statusDot} ${live ? styles.statusDotLive : paused ? styles.statusDotPaused : ""}`}
                        aria-hidden="true"
                      />
                      {live ? "Session live now" : paused ? "Session paused" : "No session running"}
                    </p>

                    <div className={styles.characterStatus}>
                      {character ? (
                        <>
                          <Link
                            href={`/campaigns/${campaign.id}/characters/${character.id}`}
                            className={styles.characterLink}
                            data-testid={`lobby-character-link-${campaign.id}`}
                          >
                            {character.name}
                          </Link>
                          <span className={styles.characterMeta}>
                            {character.class} {character.level}
                          </span>
                        </>
                      ) : role === "dm" ? (
                        <span className={styles.noCharacterHint} data-testid={`lobby-no-character-${campaign.id}`}>
                          You&apos;re the DM here
                        </span>
                      ) : (
                        <span className={styles.noCharacterHint} data-testid={`lobby-no-character-${campaign.id}`}>
                          No character yet —{" "}
                          <Link href={`/campaigns/${campaign.id}/characters/new`}>create one</Link>
                        </span>
                      )}
                    </div>

                    {role === "dm" ? (
                      <p className={styles.inviteCode}>
                        Invite code <code>{campaign.invite_code}</code>
                      </p>
                    ) : null}

                    <div className={styles.cardActions}>
                      {live || paused ? (
                        <Link
                          href={`/campaigns/${campaign.id}/room`}
                          className={styles.primaryAction}
                          data-testid={`join-game-${campaign.id}`}
                        >
                          {live ? "Join game ▸" : "Rejoin"}
                        </Link>
                      ) : null}
                      <Link
                        href={`/campaigns/${campaign.id}`}
                        transitionTypes={["nav-forward"]}
                        className={live ? styles.secondaryAction : styles.tonalAction}
                        data-testid={`open-campaign-${campaign.id}`}
                      >
                        Open campaign
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={styles.section} aria-labelledby="new-campaign-title">
          <h2 id="new-campaign-title" className={styles.sectionTitle}>
            Start or join a campaign
          </h2>
          <div className={styles.formsRow}>
            <div className={styles.formCard}>
              <h3 className={styles.formTitle}>Create a campaign</h3>
              <p className={styles.formHint}>You&apos;ll be its first DM and get an invite code to share.</p>
              <CreateCampaignForm />
            </div>
            <div className={styles.formCard}>
              <h3 className={styles.formTitle}>Join a campaign</h3>
              <p className={styles.formHint}>Your DM can find the invite code on their campaign page.</p>
              <JoinCampaignForm />
            </div>
          </div>
        </section>
        </PageTransition>
      </main>
    </div>
  );
}
