import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Panel } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  getMap,
  getProfile,
  isDM,
  listAssetsForCampaign,
  listMapCells,
  listMapObjects,
} from "@/data-access";
import { resolvePaletteAssets } from "../maps/[mapId]/edit/lib/assetUrl";
import { LiveMapView } from "./LiveMapView";
import styles from "./live-map.module.css";

/**
 * The live-map viewer: any member (not just the DM) sees whichever map
 * campaigns.live_map points at, read-only plus behavior triggering.
 * Deliberately minimal — rendering the map ON the 3D game table and the
 * DM's full live-map-switching flow are Prompt 29's scope.
 */
export default async function LiveMapPage({ params }: { params: Promise<{ id: string }> }) {
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

  const map = campaign.live_map ? await getMap(supabase, campaign.live_map) : null;

  if (!map) {
    return (
      <div className={styles.emptyPage}>
        <main className={styles.emptyMain}>
          <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
            ← Back to {campaign.name}
          </Link>
          <Panel title="Live map" tone="purple">
            <p className={styles.emptyHint} data-testid="no-live-map">
              No live map yet — the DM hasn&apos;t put one on the table.
            </p>
          </Panel>
        </main>
      </div>
    );
  }

  const [dm, profile, cells, objects, assets] = await Promise.all([
    isDM(supabase, campaignId, user.id),
    getProfile(supabase, user.id),
    listMapCells(supabase, map.id),
    listMapObjects(supabase, map.id),
    listAssetsForCampaign(supabase, campaignId),
  ]);
  const paletteAssets = await resolvePaletteAssets(supabase, assets);

  return (
    <LiveMapView
      campaignId={campaignId}
      campaignName={campaign.name}
      map={map}
      initialCells={cells}
      initialObjects={objects}
      assets={paletteAssets}
      isDM={dm}
      userId={user.id}
      displayName={profile?.display_name ?? null}
    />
  );
}
