import { redirect } from "next/navigation";

/**
 * Prompt 28's standalone live-map viewer, retired in Prompt 29: the live map
 * now renders on the physical table in the Game Room, which also owns the
 * POI trigger panel and the DM's live-map picker. The route survives only as
 * a redirect so old links land in the right place.
 */
export default async function LiveMapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  redirect(`/campaigns/${campaignId}/room`);
}
