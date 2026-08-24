import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Panel } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { isDM } from "@/data-access";
import { NewLorePageForm } from "./NewLorePageForm";
import styles from "../lore.module.css";

export default async function NewLorePagePage({ params }: { params: Promise<{ id: string }> }) {
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

  // Creating pages is DM-only (lore_pages' INSERT RLS) — a player landing
  // here by URL just goes back to the browsable index instead of getting a
  // form that's doomed to fail.
  if (!(await isDM(supabase, campaignId, user.id))) redirect(`/campaigns/${campaignId}/lore`);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href={`/campaigns/${campaignId}/lore`} className={styles.backLink}>
          ← Back to the lore index
        </Link>

        <Panel title="New lore page" tone="purple" glow>
          <p className={styles.hint}>Add a page to {campaign.name}&apos;s world.</p>
          <NewLorePageForm campaignId={campaignId} />
        </Panel>
      </main>
    </div>
  );
}
