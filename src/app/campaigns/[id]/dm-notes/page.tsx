import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Panel } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { listDmNotes, isDM } from "@/data-access";
import { DmNotes } from "./DmNotes";
import styles from "./dm-notes.module.css";

export default async function CampaignDmNotesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: campaign, error } = await supabase
    .from("campaigns")
    .select()
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  // RLS hides campaigns you're not a member of — same 404 reasoning as the
  // campaign detail page.
  if (!campaign) notFound();

  const currentUserIsDM = await isDM(supabase, campaignId, user.id);
  // Unlike NPCs/lore/session log, this page has nothing to show a non-DM at
  // all — dm_notes' SELECT RLS (0020) returns zero rows for them regardless,
  // so a player landing here would just see a confusing empty page. Bounce
  // them back rather than let the UI imply a feature they can't use, same
  // instinct as redirecting a non-DM away from /lore/new.
  if (!currentUserIsDM) redirect(`/campaigns/${campaignId}`);

  // listDmNotes orders oldest-first (matching every other narrative list);
  // reversed here since a private scratchpad reads better newest-on-top.
  const notes = (await listDmNotes(supabase, campaignId)).reverse();

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← Back to {campaign.name}
        </Link>

        <Panel title="DM notes" tone="pink" glow>
          <p className={styles.hint}>
            Private to you — nothing here is readable by any player, at the data layer.
          </p>
          <DmNotes campaignId={campaignId} initialNotes={notes} />
        </Panel>
      </main>
    </div>
  );
}
