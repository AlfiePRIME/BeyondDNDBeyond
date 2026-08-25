import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  getMap,
  isDM,
  listAssetsForCampaign,
  listCharactersForCampaign,
  listLightSources,
  listMapCells,
  listMapObjects,
  listMapsForCampaign,
  listMapTokens,
  listMapTransitions,
} from "@/data-access";
import { isAiConfigured } from "@/ai";
import { MapEditor } from "./MapEditor";
import { resolvePaletteAssets } from "./lib/assetUrl";

export default async function MapEditPage({
  params,
}: {
  params: Promise<{ id: string; mapId: string }>;
}) {
  const { id: campaignId, mapId } = await params;
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

  // The editor is DM-only end to end: a member who isn't the DM gets the
  // same 404 as a non-member, not a read-only or broken editor. RLS is the
  // primary enforcement (it hides non-live maps and blocks cell writes for
  // non-DMs); this guard is defense in depth with a clear failure mode.
  if (!(await isDM(supabase, campaignId, user.id))) notFound();

  const map = await getMap(supabase, mapId);
  if (!map || map.campaign_id !== campaignId) notFound();

  const [cells, objects, assets, campaignMaps, transitions, tokens, lightSources, characters] =
    await Promise.all([
      listMapCells(supabase, mapId),
      listMapObjects(supabase, mapId),
      listAssetsForCampaign(supabase, campaignId),
      listMapsForCampaign(supabase, campaignId),
      listMapTransitions(supabase, mapId),
      listMapTokens(supabase, mapId),
      listLightSources(supabase, mapId),
      // Names for PC-token anchor options in the light-source picker — the
      // DM reads every campaign character under 0008's SELECT policy.
      listCharactersForCampaign(supabase, campaignId),
    ]);
  const paletteAssets = await resolvePaletteAssets(supabase, assets);

  return (
    <MapEditor
      campaignId={campaignId}
      campaignName={campaign.name}
      map={map}
      initialCells={cells}
      initialObjects={objects}
      assets={paletteAssets}
      aiEnabled={isAiConfigured()}
      campaignMaps={campaignMaps}
      initialTransitions={transitions}
      initialTokens={tokens}
      initialLightSources={lightSources}
      characterNameById={Object.fromEntries(
        characters.map((character) => [character.id, character.name])
      )}
    />
  );
}
