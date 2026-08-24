import { redirect } from "next/navigation";
import { Panel, SectionHeader } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getProfile, isProfileComplete } from "@/data-access";
import { ProfileSetupForm } from "./ProfileSetupForm";
import styles from "../auth.module.css";

export default async function ProfileSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const profile = await getProfile(supabase, user.id);
  if (isProfileComplete(profile)) {
    redirect("/");
  }

  return (
    <div className={styles.wrap}>
      <Panel title="One last thing" tone="teal" glow className={styles.panel}>
        <SectionHeader eyebrow="Almost there" title="Set your display name" />
        <ProfileSetupForm error={error} />
      </Panel>
    </div>
  );
}
