import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Badge, Panel, SectionHeader } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { listCampaignMembers, listCharactersForCampaign, isDM } from "@/data-access";
import { TransferDMForm } from "./TransferDMForm";
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

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href="/" className={styles.backLink}>
          ← Back to your campaigns
        </Link>

        <Panel title={campaign.name} tone="purple" glow>
          <SectionHeader eyebrow="Campaign" title="Roster" />
          <ul className={styles.memberList}>
            {members.map((member) => (
              <li key={member.user_id} className={styles.memberRow}>
                <span>{member.display_name ?? "Unnamed player"}</span>
                <Badge tone={member.role === "dm" ? "pink" : "teal"}>
                  {member.role === "dm" ? "DM" : "Player"}
                </Badge>
              </li>
            ))}
          </ul>
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
