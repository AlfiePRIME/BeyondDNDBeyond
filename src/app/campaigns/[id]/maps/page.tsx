import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Panel } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { isDM, listMapFolders, listMapsForCampaign } from "@/data-access";
import { MapsManager } from "./MapsManager";
import styles from "./maps.module.css";

export default async function CampaignMapsPage({ params }: { params: Promise<{ id: string }> }) {
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
  if (!campaign) notFound();

  // Map building is DM-only end to end (unlike the asset palette, which any
  // member can browse) — non-DM members get the same 404 as non-members.
  if (!(await isDM(supabase, campaignId, user.id))) notFound();

  const [maps, folders] = await Promise.all([
    listMapsForCampaign(supabase, campaignId),
    listMapFolders(supabase, campaignId),
  ]);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← Back to {campaign.name}
        </Link>

        <Panel title="Maps" tone="purple" glow>
          <p className={styles.mapsHint}>
            Battle maps for {campaign.name} — sculpt elevation and paint terrain, then pick one to
            go live during a session.
          </p>
          <MapsManager campaignId={campaignId} initialMaps={maps} initialFolders={folders} />
        </Panel>
      </main>
    </div>
  );
}
