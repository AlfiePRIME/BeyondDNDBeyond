import { redirect } from "next/navigation";
import Link from "next/link";
import { Badge, Panel, SectionHeader } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getProfile, listCampaignsForUser, listCharactersForUser } from "@/data-access";
import { AvatarPicker } from "./AvatarPicker";
import { DisplayNameForm } from "./DisplayNameForm";
import { CharacterCreateLauncher } from "./CharacterCreateLauncher";
import { CampaignManageRow } from "./CampaignManageRow";
import styles from "./account.module.css";

export default async function AccountPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [profile, memberships, characters] = await Promise.all([
    getProfile(supabase, user.id),
    listCampaignsForUser(supabase, user.id),
    listCharactersForUser(supabase, user.id),
  ]);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href="/campaigns" className={styles.backLink}>
          ← Back to your campaigns
        </Link>

        <Panel title="Profile" tone="purple" glow>
          <SectionHeader eyebrow="Account" title="Display name" />
          <DisplayNameForm initialDisplayName={profile?.display_name ?? ""} />

          <SectionHeader eyebrow="Account" title="Your avatar" />
          <p className={styles.pickerHint}>
            Pick a preset figure or upload your own low-poly model. This is how the table will see
            you.
          </p>
          <AvatarPicker
            userId={user.id}
            initialSource={profile?.avatar_source ?? null}
            initialRef={profile?.avatar_ref ?? null}
          />
        </Panel>

        <Panel title="Character library" tone="teal">
          {characters.length === 0 ? (
            <p className={styles.emptyHint}>
              You don&apos;t own any characters yet — create or import one below.
            </p>
          ) : (
            <ul className={styles.rowList}>
              {characters.map((character) => (
                <li key={character.id} className={styles.row}>
                  {character.campaign ? (
                    <Link
                      href={`/campaigns/${character.campaign.id}/characters/${character.id}`}
                      className={styles.characterLink}
                    >
                      {character.name}
                    </Link>
                  ) : (
                    <span>{character.name}</span>
                  )}
                  <span className={styles.characterMeta}>
                    <Badge tone="teal">
                      {character.class} {character.level}
                    </Badge>
                    <Badge tone="purple">{character.campaign?.name ?? "No campaign"}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <CharacterCreateLauncher memberships={memberships} />
          {memberships.length === 0 ? (
            <p className={styles.emptyHint}>
              Join or create a campaign from the <Link href="/campaigns">dashboard</Link> first — characters
              live inside a campaign.
            </p>
          ) : null}
        </Panel>

        <Panel title="Campaigns" tone="pink">
          {memberships.length === 0 ? (
            <p className={styles.emptyHint}>
              You&apos;re not in any campaigns yet — create one or join with an invite code from the{" "}
              <Link href="/campaigns">dashboard</Link>.
            </p>
          ) : (
            <div className={styles.campaignsGrid}>
              {memberships.map((membership) => (
                <CampaignManageRow key={membership.campaign.id} membership={membership} />
              ))}
            </div>
          )}
        </Panel>
      </main>
    </div>
  );
}
