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
  listCombatantHiddenFrom,
  listDmNotes,
  listHandouts,
  listLightSources,
  listLorePages,
  listLorePageLinksForCampaign,
  listMapCells,
  listMapObjects,
  listMapsForCampaign,
  listMapTokens,
  listMonsterStatBlocks,
  listNpcs,
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

  // Read once for SSR, same as every other "initial*" prop below — a
  // returning user's saved Game Room panel layout (Phase B) renders
  // correctly on the very first paint, no loading flash. Not derived from
  // the roomMembers loop above (which only keeps each member's avatar_url)
  // since ui_preferences is the CALLER's own, private-enough-to-fetch-once
  // document, not table-public roster data.
  const currentUserProfile = await getProfile(supabase, user.id);

  // The DB read here (not any broadcast) is what makes fresh joins and
  // reloads land on the currently-live map — a client that wasn't connected
  // when the DM switched never saw the live-map-changed event.
  const [
    assets,
    availableMaps,
    characters,
    handoutRows,
    initialRolls,
    initialStatBlocks,
    rosterNpcs,
    dmNoteRows,
    initialLorePages,
    initialLorePageLinks,
  ] = await Promise.all([
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
    // Monster stat blocks (Prompt 61), member-readable — AC auto-fill
    // for stat-blocked NPC targets needs them on every client.
    listMonsterStatBlocks(supabase, campaignId),
    // The narrative roster, only for the DM's book's Enemies (MonsterPanel)
    // name pre-fill; players never see the book, so no point fetching.
    currentUserIsDM ? listNpcs(supabase, campaignId) : Promise.resolve([]),
    // dm_notes' SELECT RLS (0020) has no member-read policy at all — same
    // DM-gated fetch convention as rosterNpcs above, for the book's Notes
    // page (DmNotes.tsx, embedded unmodified).
    currentUserIsDM ? listDmNotes(supabase, campaignId) : Promise.resolve([]),
    // Lore pages/links are member-readable (matching the standalone /lore
    // route's own fetch) — the book's Lore page opens with no loading
    // flash for the DM, same as every other "initial*" prop here.
    listLorePages(supabase, campaignId),
    listLorePageLinksForCampaign(supabase, campaignId),
  ]);
  // listDmNotes orders oldest-first (matching every other narrative list);
  // reversed here since the book's Notes page reads better newest-on-top —
  // the exact same reversal /dm-notes/page.tsx does for the standalone
  // route.
  const initialDmNotes = [...dmNoteRows].reverse();
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
    const combatantIds = combatants.map((combatant) => combatant.id);
    // Hidden-from pairs (Prompt 60) load alongside conditions — both are
    // member-readable per-combatant state the room renders from.
    const [conditions, hiddenFrom] = await Promise.all([
      listCombatantConditions(supabase, combatantIds),
      listCombatantHiddenFrom(supabase, combatantIds),
    ]);
    initialCombat = { encounter: activeEncounter, combatants, conditions, hiddenFrom };
  }

  let initialLiveMap: LiveMapData | null = null;
  if (campaign.live_map) {
    const map = await getMap(supabase, campaign.live_map);
    if (map) {
      const [cells, objects, tokens, lightSources] = await Promise.all([
        listMapCells(supabase, map.id),
        listMapObjects(supabase, map.id),
        listMapTokens(supabase, map.id),
        // Loaded for the client's per-player vision computation (Prompt 58)
        // — members read the live map's lights under the 0036 RLS.
        listLightSources(supabase, map.id),
      ]);
      initialLiveMap = { map, cells, objects, tokens, lightSources };
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
      initialStatBlocks={initialStatBlocks}
      rosterNpcs={rosterNpcs}
      initialHandouts={initialHandouts}
      initialCombat={initialCombat}
      initialRolls={initialRolls}
      initialActionEconomyStrict={campaign.action_economy_strict}
      initialDayNightMode={campaign.day_night_mode}
      initialUiPreferences={currentUserProfile?.ui_preferences ?? { panelLayout: {} }}
      initialDmNotes={initialDmNotes}
      initialLorePages={initialLorePages}
      initialLorePageLinks={initialLorePageLinks}
    />
  );
}
