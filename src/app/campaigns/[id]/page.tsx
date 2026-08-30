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

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
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
          headerActions={
            <span className={styles.charactersActions}>
              {currentUserIsDM ? <InviteCodeBadge inviteCode={campaign.invite_code} /> : null}
              {currentUserIsDM ? (
                <Link href={`/campaigns/${campaignId}/maps`} className={styles.createLink}>
                  Map editor
                </Link>
              ) : null}
              {currentUserIsDM ? (
                <Link
                  href={`/campaigns/${campaignId}/dm-notes`}
                  className={styles.createLink}
                  data-testid="dm-notes-link"
                >
                  DM notes
                </Link>
              ) : null}
              <Link href={`/campaigns/${campaignId}/assets`} className={styles.createLink}>
                Asset palette
              </Link>
              <Link href={`/campaigns/${campaignId}/npcs`} className={styles.createLink}>
                NPC roster
              </Link>
              <Link href={`/campaigns/${campaignId}/lore`} className={styles.createLink}>
                World &amp; lore
              </Link>
              <Link href={`/campaigns/${campaignId}/session-log`} className={styles.createLink}>
                Session log
              </Link>
              <Link href={`/campaigns/${campaignId}/room`} className={styles.createLink}>
                Enter the Game Room →
              </Link>
            </span>
          }
        >
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
            <div className={styles.personalCta} data-testid="personal-character-cta">
              <p className={styles.personalCtaText}>
                You don&apos;t have a character in this campaign yet — create one to join the adventure.
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
