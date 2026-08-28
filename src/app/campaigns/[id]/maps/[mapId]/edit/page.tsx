import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  getMap,
  getMapArt,
  isDM,
  isMapArtConfigured,
  listAssetsForCampaign,
  listCharactersForCampaign,
  listConcealedPits,
  listLightSources,
  listMapCells,
  listMapObjects,
  listMapsForCampaign,
  listMapTokens,
  listMapTransitions,
} from "@/data-access";
// The map editor's "Generate Area" tool is generateMapArea.ts, which is
// Anthropic-only regardless of app_settings.active_provider (structured,
// forced-tool-use output the common generateText() interface doesn't cover
// for the other two providers yet — see providers/anthropic.ts's
// isAnthropicConfigured doc comment). Gating this button on the
// multi-provider isAiConfigured() would light it up whenever ANY provider
// is configured (e.g. Ollama) even though clicking it would still only ever
// call Anthropic and fail.
import { isAnthropicConfigured } from "@/ai";
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

  const [
    cells,
    objects,
    assets,
    campaignMaps,
    transitions,
    concealedPits,
    tokens,
    lightSources,
    characters,
    mapArtEnabled,
    mapArt,
  ] = await Promise.all([
    listMapCells(supabase, mapId),
    listMapObjects(supabase, mapId),
    listAssetsForCampaign(supabase, campaignId),
    listMapsForCampaign(supabase, campaignId),
    listMapTransitions(supabase, mapId),
    listConcealedPits(supabase, mapId),
    listMapTokens(supabase, mapId),
    listLightSources(supabase, mapId),
    // Names for PC-token anchor options in the light-source picker — the
    // DM reads every campaign character under 0008's SELECT policy.
    listCharactersForCampaign(supabase, campaignId),
    // Map Art Generation E4: isMapArtConfigured() is the same boolean-only,
    // service-role-backed, ANY-DM-safe check aiEnabled's own isAnthropicConfigured
    // is for the (Anthropic-only) generate-area tool — see that import's own
    // comment above for why a plain multi-provider check would be wrong here
    // too, and appSettings.ts's isMapArtConfigured doc comment for the RLS
    // gap this closes.
    isMapArtConfigured(),
    getMapArt(supabase, mapId),
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
      aiEnabled={isAnthropicConfigured()}
      mapArtEnabled={mapArtEnabled}
      initialMapArt={mapArt}
      campaignMaps={campaignMaps}
      initialTransitions={transitions}
      initialConcealedPits={concealedPits}
      initialTokens={tokens}
      initialLightSources={lightSources}
      characterNameById={Object.fromEntries(
        characters.map((character) => [character.id, character.name])
      )}
    />
  );
}
