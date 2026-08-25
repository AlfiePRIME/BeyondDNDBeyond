import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  getActiveCombatEncounter,
  getMap,
  getProfile,
  listAssetsForCampaign,
  listCampaignMembers,
  listCharactersForCampaign,
  listCombatCombatants,
  listCombatantConditions,
  listHandouts,
  listMapCells,
  listMapObjects,
  listMapsForCampaign,
  listMapTokens,
  listRollLog,
} from "@/data-access";
import { resolvePaletteAssets } from "../maps/[mapId]/edit/lib/assetUrl";
import { resolveAvatarUrl, type RoomMember } from "./avatar-url";
import { resolveHandout } from "./handout-url";
import type { CombatState } from "./CombatPanel";
import { GameRoom, type LiveMapData } from "./GameRoom";

export default async function GameRoomPage({ params }: { params: Promise<{ id: string }> }) {
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
  // RLS returns no row for a campaign you're not a member of — same 404
  // reasoning as the campaign detail page.
  if (!campaign) notFound();

  const members = await listCampaignMembers(supabase, campaignId);
  const roomMembers: RoomMember[] = await Promise.all(
    members.map(async (member) => {
      const profile = await getProfile(supabase, member.user_id);
      return {
        ...member,
        avatar_url: await resolveAvatarUrl(
          supabase,
          profile?.avatar_source ?? null,
          profile?.avatar_ref ?? null
        ),
      };
    })
  );

  const currentMember = roomMembers.find((member) => member.user_id === user.id);
  const currentUserIsDM = currentMember?.role === "dm";

  // The DB read here (not any broadcast) is what makes fresh joins and
  // reloads land on the currently-live map — a client that wasn't connected
  // when the DM switched never saw the live-map-changed event.
  const [assets, availableMaps, characters, handoutRows, initialRolls] = await Promise.all([
    listAssetsForCampaign(supabase, campaignId),
    // Non-DM RLS only exposes the live map anyway, and only the DM gets the
    // picker — no point fetching a list for players.
    currentUserIsDM ? listMapsForCampaign(supabase, campaignId) : Promise.resolve([]),
    // Characters RLS trims this per viewer: a player gets only their own,
    // the DM gets every campaign character — exactly who each may place.
    listCharactersForCampaign(supabase, campaignId),
    // Handouts RLS trims per viewer too: every row for the DM, revealed
    // rows only for a player.
    listHandouts(supabase, campaignId),
    // Same DB-read reasoning as the live map: fresh joins see recent rolls
    // without having been subscribed when they landed.
    listRollLog(supabase, campaignId),
  ]);
  const initialHandouts = await Promise.all(
    handoutRows.map((handout) => resolveHandout(supabase, handout))
  );
  const paletteAssets = await resolvePaletteAssets(supabase, assets);

  // Same DB-read reasoning as the live map above: a fresh join or reload
  // lands on the current combat state without having seen any broadcast.
  const activeEncounter = await getActiveCombatEncounter(supabase, campaignId);
  let initialCombat: CombatState | null = null;
  if (activeEncounter) {
    const combatants = await listCombatCombatants(supabase, activeEncounter.id);
    const conditions = await listCombatantConditions(
      supabase,
      combatants.map((combatant) => combatant.id)
    );
    initialCombat = { encounter: activeEncounter, combatants, conditions };
  }

  let initialLiveMap: LiveMapData | null = null;
  if (campaign.live_map) {
    const map = await getMap(supabase, campaign.live_map);
    if (map) {
      const [cells, objects, tokens] = await Promise.all([
        listMapCells(supabase, map.id),
        listMapObjects(supabase, map.id),
        listMapTokens(supabase, map.id),
      ]);
      initialLiveMap = { map, cells, objects, tokens };
    }
  }

  return (
    <GameRoom
      campaignId={campaignId}
      campaignName={campaign.name}
      members={roomMembers}
      currentUserId={user.id}
      currentUserIsDM={currentUserIsDM}
      currentUserDisplayName={currentMember?.display_name ?? null}
      initialLiveMap={initialLiveMap}
      availableMaps={availableMaps}
      assets={paletteAssets}
      characters={characters}
      initialHandouts={initialHandouts}
      initialCombat={initialCombat}
      initialRolls={initialRolls}
    />
  );
}
