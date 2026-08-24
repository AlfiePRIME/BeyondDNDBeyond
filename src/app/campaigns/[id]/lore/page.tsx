import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Panel } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { listLorePages, listLorePageLinksForCampaign, isDM } from "@/data-access";
import { LoreIndex } from "./LoreIndex";
import styles from "./lore.module.css";

export default async function CampaignLorePage({ params }: { params: Promise<{ id: string }> }) {
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

  // Any member can browse the wiki (matching lore_pages' read RLS from 0020);
  // only the DM gets the create control.
  const [pages, links, currentUserIsDM] = await Promise.all([
    listLorePages(supabase, campaignId),
    listLorePageLinksForCampaign(supabase, campaignId),
    isDM(supabase, campaignId, user.id),
  ]);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← Back to {campaign.name}
        </Link>

        <Panel
          title="World & lore"
          tone="purple"
          glow
          headerActions={
            currentUserIsDM ? (
              <Link
                href={`/campaigns/${campaignId}/lore/new`}
                className={styles.createLink}
                data-testid="create-lore-page-button"
              >
                + New page
              </Link>
            ) : null
          }
        >
          <p className={styles.hint}>
            The world of {campaign.name}, one page at a time — places, factions, legends, and how
            they connect.
          </p>
          <LoreIndex campaignId={campaignId} pages={pages} links={links} canManage={currentUserIsDM} />
        </Panel>
      </main>
    </div>
  );
}
