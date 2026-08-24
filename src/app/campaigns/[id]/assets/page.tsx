import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Panel } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { listAssetsForCampaign, isDM } from "@/data-access";
import { AssetPalette } from "./AssetPalette";
import styles from "./assets.module.css";

export default async function CampaignAssetsPage({ params }: { params: Promise<{ id: string }> }) {
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

  // Any member can browse the palette (matching asset_library's read RLS);
  // only the DM gets the upload control.
  const [assets, currentUserIsDM] = await Promise.all([
    listAssetsForCampaign(supabase, campaignId),
    isDM(supabase, campaignId, user.id),
  ]);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← Back to {campaign.name}
        </Link>

        <Panel title="Asset palette" tone="teal" glow>
          <p className={styles.paletteHint}>
            Props available for {campaign.name}&apos;s maps — the built-in set plus this
            campaign&apos;s own uploads.
          </p>
          <AssetPalette campaignId={campaignId} initialAssets={assets} canUpload={currentUserIsDM} />
        </Panel>
      </main>
    </div>
  );
}
