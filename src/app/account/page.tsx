import { redirect } from "next/navigation";
import Link from "next/link";
import { Panel, SectionHeader } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getProfile } from "@/data-access";
import { AvatarPicker } from "./AvatarPicker";
import styles from "./account.module.css";

// Minimal for now — Prompt 15 expands this route into the full Account page
// (profile settings, character library, campaign management).
export default async function AccountPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getProfile(supabase, user.id);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href="/" className={styles.backLink}>
          ← Back to your campaigns
        </Link>

        <Panel title="Account" tone="purple" glow>
          <SectionHeader eyebrow="Profile" title="Your avatar" />
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
      </main>
    </div>
  );
}
