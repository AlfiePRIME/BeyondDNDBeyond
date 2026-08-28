import { redirect } from "next/navigation";
import Link from "next/link";
import { Badge, ForceField, Panel, SectionHeader } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getProfile, isProfileComplete, listCampaignsForUser, listCharactersForUser } from "@/data-access";
import { AppNav } from "./AppNav";
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

  const [memberships, characters] = await Promise.all([
    listCampaignsForUser(supabase, user.id),
    listCharactersForUser(supabase, user.id),
  ]);

  return (
    <ForceField
      shape="hexagon"
      cellScale={20}
      lineWidth={0.03}
      gridOpacity={0.15}
      gridReveal="click"
      gridRevealStrength={0}
      gridRevealRadius={250}
      gridFade={0.35}
      flowIntensity={1.7}
      flowSpeed={0.85}
      flashIntensity={0.1}
      edgeGlow={0.7}
      hoverGlow={0.25}
      hoverRadius={350}
      hoverCharge={1.6}
      hideOnHover={false}
      rippleIntensity={0}
      rippleSpeed={0.1}
      rippleBlend={1}
      refraction={30}
      aberration={4.1}
      haze={0.2}
      pageReact={0}
      tint={0.1}
      reveal={1}
      dim={0}
      bloom={1}
      grain={0.2}
      color={[0.6235, 0.1961, 1]}
      edgeColor={[0.6275, 0.1608, 1]}
    >
      <div className={styles.page}>
        <main className={styles.lobby}>
          <AppNav currentPath="/" userLabel={profile!.display_name} />

          <Panel title="BeyondDNDBeyond" tone="purple">
            <SectionHeader eyebrow="Signed in" title={`Welcome, ${profile!.display_name}`} glitch />
          </Panel>

          <Panel title="Your campaigns" tone="pink">
            {memberships.length === 0 ? (
              <div className={styles.zeroState} data-testid="lobby-campaigns-zero-state">
                <p className={styles.zeroStateText}>
                  You&apos;re not in any campaigns yet — create one or join with an invite code to
                  get your first adventure going.
                </p>
                <Link
                  href="/campaigns"
                  className={styles.zeroStateCta}
                  data-testid="lobby-campaigns-cta"
                >
                  Go to Campaigns →
                </Link>
              </div>
            ) : (
              <ul className={styles.dashboardList}>
                {memberships.map(({ role, campaign }) => {
                  const character = characters.find((c) => c.campaign?.id === campaign.id);
                  return (
                    <li
                      key={campaign.id}
                      className={styles.dashboardRow}
                      data-testid={`lobby-campaign-row-${campaign.id}`}
                    >
                      <div className={styles.dashboardRowHeader}>
                        <Link href={`/campaigns/${campaign.id}`} className={styles.campaignName}>
                          {campaign.name}
                        </Link>
                        <Badge tone={role === "dm" ? "pink" : "teal"}>
                          {role === "dm" ? "DM" : "Player"}
                        </Badge>
                      </div>
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
                            <Badge tone="teal">
                              {character.class} {character.level}
                            </Badge>
                          </>
                        ) : (
                          <span
                            className={styles.noCharacterHint}
                            data-testid={`lobby-no-character-${campaign.id}`}
                          >
                            No character here yet —{" "}
                            <Link href={`/campaigns/${campaign.id}/characters/new`}>
                              create one
                            </Link>
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="The Lobby" tone="teal" glow>
            <p className={styles.lobbyHint}>
              Everyone signed in right now gathers here — grab a seat while the party assembles.
            </p>
            <LobbyPresence
              currentUserId={user.id}
              currentUserDisplayName={profile!.display_name}
              initialSoundSettings={profile!.ui_preferences?.soundSettings}
            />
          </Panel>
        </main>
      </div>
    </ForceField>
  );
}
