import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Badge, Panel, SectionHeader } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { listCampaignMembers, listCharactersForCampaign, isDM } from "@/data-access";
import { AppNav } from "../../AppNav";
import { TransferDMForm } from "./TransferDMForm";
import { RemoveMemberForm } from "./RemoveMemberForm";
import { CampaignRoster } from "./CampaignRoster";
import { HouseRules } from "./HouseRules";
import { InviteCodeBadge } from "./InviteCodeBadge";
import styles from "./campaign.module.css";

export const metadata = { title: "Campaign" };

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: campaignId } = await params;
  const sessionEnded = (await searchParams).sessionEnded !== undefined;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select()
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError) throw campaignError;
  // RLS returns no row (not an error) for a campaign you're not a member
  // of — that's indistinguishable from "doesn't exist" from this user's
  // point of view, so a 404 is the right response either way.
  if (!campaign) notFound();

  const [members, characters, currentUserIsDM] = await Promise.all([
    listCampaignMembers(supabase, campaignId),
    listCharactersForCampaign(supabase, campaignId),
    isDM(supabase, campaignId, user.id),
  ]);

  const otherMembers = members.filter((m) => m.user_id !== user.id);
  const currentUserDisplayName = members.find((m) => m.user_id === user.id)?.display_name ?? null;
  const currentUserHasCharacter = characters.some((character) => character.owner_id === user.id);
  // RemoveMemberForm's own list, restricted to players even though
  // otherMembers already excludes the DM themself — there is only ever one
  // DM per campaign, so this is belt-and-suspenders, matching the same
  // explicit role check the new campaign_members DELETE policy itself uses
  // (0099_dm_remove_member.sql): this control must never target another DM.
  const otherPlayers = otherMembers.filter((m) => m.role === "player");
  const sessionState: "live" | "paused" | "none" = campaign.session_active
    ? "live"
    : campaign.session_started_at
      ? "paused"
      : "none";
  const base = `/campaigns/${campaignId}`;
  const tools: { href: string; icon: string; name: string; blurb: string; testId?: string }[] = [
    ...(currentUserIsDM
      ? [
          { href: `${base}/maps`, icon: "🗺️", name: "Maps", blurb: "Build and organize battle maps" },
          {
            href: `${base}/party`,
            icon: "🛡️",
            name: "Party dashboard",
            blurb: "XP, levels, conditions",
            testId: "party-dashboard-link",
          },
          { href: `${base}/dm-notes`, icon: "🔒", name: "DM notes", blurb: "Private prep notes", testId: "dm-notes-link" },
        ]
      : []),
    { href: `${base}/npcs`, icon: "🎭", name: "NPC roster", blurb: "Who the party has met" },
    { href: `${base}/lore`, icon: "📖", name: "World & lore", blurb: "Places, factions, history" },
    { href: `${base}/session-log`, icon: "📜", name: "Session log", blurb: "Recaps of past sessions" },
    { href: `${base}/assets`, icon: "📦", name: "Asset palette", blurb: "3D props and models" },
  ];
  const characterNamesByOwner = characters.reduce<Record<string, string[]>>((acc, character) => {
    (acc[character.owner_id] ??= []).push(character.name);
    return acc;
  }, {});

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <AppNav currentPath={`/campaigns/${campaignId}`} userLabel={currentUserDisplayName ?? user.email} />

        <Panel
          title={campaign.name}
          tone="purple"
          glow
          headerActions={currentUserIsDM ? <InviteCodeBadge inviteCode={campaign.invite_code} /> : null}
        >
          {sessionEnded ? (
            <p className={styles.sessionNotice} role="status" data-testid="session-ended-notice">
              The session has ended — thanks for playing.
            </p>
          ) : null}
          <div className={styles.sessionBar} data-testid="session-status">
            <span className={styles.sessionState}>
              <span
                className={`${styles.sessionDot} ${
                  sessionState === "live" ? styles.sessionDotLive : sessionState === "paused" ? styles.sessionDotPaused : ""
                }`}
                aria-hidden="true"
              />
              {sessionState === "live"
                ? "Session in progress"
                : sessionState === "paused"
                  ? "Session paused"
                  : "No session running"}
              {sessionState === "none" ? (
                <span className={styles.sessionHint}>
                  — start one from the <Link href="/">Lobby</Link> once the party is online
                </span>
              ) : null}
            </span>
            <Link href={`/campaigns/${campaignId}/room`} className={styles.enterRoom}>
              Enter the Game Room →
            </Link>
          </div>

          <nav className={styles.toolGrid} aria-label="Campaign tools">
            {tools.map((tool) => (
              <Link key={tool.href} href={tool.href} className={styles.toolTile} data-testid={tool.testId}>
                <span className={styles.toolIcon} aria-hidden="true">
                  {tool.icon}
                </span>
                <span className={styles.toolText}>
                  <span className={styles.toolName}>{tool.name}</span>
                  <span className={styles.toolBlurb}>{tool.blurb}</span>
                </span>
              </Link>
            ))}
          </nav>

          <SectionHeader eyebrow="Campaign" title="Roster" />
          <CampaignRoster
            campaignId={campaignId}
            currentUserId={user.id}
            currentUserDisplayName={currentUserDisplayName}
            members={members}
          />
        </Panel>

        <Panel
          title="Characters"
          tone="teal"
          headerActions={
            <span className={styles.charactersActions}>
              <Link href={`/campaigns/${campaignId}/characters/new`} className={styles.createLink}>
                + Create a character
              </Link>
              <Link href={`/campaigns/${campaignId}/characters/import`} className={styles.createLink}>
                Import from D&D Beyond PDF
              </Link>
            </span>
          }
        >
          {!currentUserHasCharacter ? (
            <div
              className={`${styles.personalCta} ${currentUserIsDM ? styles.personalCtaSoft : ""}`}
              data-testid="personal-character-cta"
            >
              <p className={styles.personalCtaText}>
                {currentUserIsDM
                  ? "You're running this campaign, so you don't need a character — but you can make one if you also play."
                  : "You don't have a character in this campaign yet — create one to join the adventure."}
              </p>
              <span className={styles.charactersActions}>
                <Link href={`/campaigns/${campaignId}/characters/new`} className={styles.createLink}>
                  + Create a character
                </Link>
                <Link href={`/campaigns/${campaignId}/characters/import`} className={styles.createLink}>
                  Import from D&D Beyond PDF
                </Link>
              </span>
            </div>
          ) : null}
          {characters.length === 0 ? (
            <p className={styles.emptyHint}>No characters yet — create one to join the adventure.</p>
          ) : (
            <ul className={styles.memberList}>
              {characters.map((character) => (
                <li key={character.id} className={styles.memberRow}>
                  <Link
                    href={`/campaigns/${campaignId}/characters/${character.id}`}
                    className={styles.characterLink}
                  >
                    {character.name}
                  </Link>
                  <span className={styles.characterMeta}>
                    <Badge tone="purple">{character.race}</Badge>
                    <Badge tone="teal">
                      {character.class} {character.level}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="House rules" tone="teal">
          <HouseRules
            campaignId={campaignId}
            initialHouseRules={campaign.house_rules}
            canManage={currentUserIsDM}
          />
        </Panel>

        {currentUserIsDM ? (
          <Panel title="Remove a player" tone="pink" data-testid="remove-member-panel">
            <p className={styles.transferHint}>
              Remove a player from this campaign. This permanently deletes their character(s) here too — it
              can&apos;t be undone.
            </p>
            <RemoveMemberForm
              campaignId={campaignId}
              players={otherPlayers}
              charactersByOwner={characterNamesByOwner}
            />
          </Panel>
        ) : null}

        {currentUserIsDM ? (
          <Panel title="Transfer DM" tone="pink">
            <p className={styles.transferHint}>
              Hand the DM role to another member. You&apos;ll become a player in this campaign.
            </p>
            <TransferDMForm campaignId={campaignId} otherMembers={otherMembers} />
          </Panel>
        ) : null}
      </main>
    </div>
  );
}
