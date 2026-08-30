import { redirect } from "next/navigation";
import Link from "next/link";
import { Panel, SectionHeader } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getProfile, listCampaignsForUser, listCharactersForUser } from "@/data-access";
import { AppNav } from "../AppNav";
import { AvatarPicker } from "./AvatarPicker";
import { PawnColorPicker } from "./PawnColorPicker";
import { NameLabelPicker } from "./NameLabelPicker";
import { DisplayNameForm } from "./DisplayNameForm";
import { CharacterCreateLauncher } from "./CharacterCreateLauncher";
import { CharacterLibraryRow } from "./CharacterLibraryRow";
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
        <AppNav currentPath="/account" userLabel={profile?.display_name || user.email} />

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

          <SectionHeader eyebrow="Account" title="Your map token color" />
          <p className={styles.pickerHint}>
            The color your character&apos;s pawn uses on the map table, in every campaign, whenever
            that character has no custom uploaded model. This is separate from your avatar above.
          </p>
          <PawnColorPicker userId={user.id} initialColor={profile?.default_pawn_color ?? "#1ec8c8"} />

          <SectionHeader eyebrow="Account" title="Your name label" />
          <p className={styles.pickerHint}>
            The floating label shown above your seat at the table, in every campaign, so everyone
            knows who is who.
          </p>
          <NameLabelPicker
            userId={user.id}
            initialColor={profile?.name_label_color ?? "#ede0ff"}
            initialSize={profile?.name_label_size ?? "medium"}
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
                <CharacterLibraryRow key={character.id} character={character} />
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
