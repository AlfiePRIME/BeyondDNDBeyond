import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { listLorePages, listLorePageLinks, isDM } from "@/data-access";
import { LorePageView } from "./LorePageView";
import styles from "../lore.module.css";

export default async function LorePageDetailPage({
  params,
}: {
  params: Promise<{ id: string; pageId: string }>;
}) {
  const { id: campaignId, pageId } = await params;
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

  // The full campaign page list serves triple duty: locating this page (also
  // 404ing a pageId reached via a URL for the wrong campaign, since the list
  // is campaign-scoped), titling this page's links, and populating the DM's
  // add-a-link picker.
  const [pages, links, currentUserIsDM] = await Promise.all([
    listLorePages(supabase, campaignId),
    listLorePageLinks(supabase, pageId),
    isDM(supabase, campaignId, user.id),
  ]);

  const page = pages.find((p) => p.id === pageId);
  if (!page) notFound();

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href={`/campaigns/${campaignId}/lore`} className={styles.backLink}>
          ← Back to the lore index
        </Link>

        <LorePageView
          campaignId={campaignId}
          initialPage={page}
          initialLinks={links}
          allPages={pages}
          canManage={currentUserIsDM}
        />
      </main>
    </div>
  );
}
