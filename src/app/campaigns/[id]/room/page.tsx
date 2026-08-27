import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  getActiveCombatEncounter,
  getDiceTrayPreferencesForCampaign,
  getMap,
  getProfile,
  getSeatOffsetsForCampaign,
  listAssetsForCampaign,
  listCampaignMembers,
  listCharactersForCampaign,
  listChatMessages,
  listCombatCombatants,
  listCombatantConditions,
  listCombatantHiddenFrom,
  listDmNotes,
  listHandouts,
  listInteractionEvents,
  listItemsForMapObjects,
  listLightSources,
  listLorePages,
  listLorePageLinksForCampaign,
  listMapCells,
  listMapObjects,
  listMapsForCampaign,
  listMapTokens,
  listMapTokensForCampaign,
  listMonsterStatBlocks,
  listMonsterTemplateOverridesForCampaign,
  listMonsterTemplates,
  listNpcs,
  listRollLog,
  listWhiteboardTiles,
} from "@/data-access";
import { resolvePaletteAssets } from "../maps/[mapId]/edit/lib/assetUrl";
import { resolveAvatarUrl, type RoomMember } from "./avatar-url";
import { resolveHandout } from "./handout-url";
import { mostRecentOwnToken } from "./vision";
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
      const avatar = await resolveAvatarUrl(
        supabase,
        profile?.avatar_source ?? null,
        profile?.avatar_ref ?? null
      );
      return {
        ...member,
        avatar_url: avatar.url,
        avatar_forward_offset_deg: avatar.forwardOffsetDeg,
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
    initialChatMessages,
    initialStatBlocks,
    initialMonsterTemplates,
    initialTemplateOverrides,
    rosterNpcs,
    dmNoteRows,
    initialLorePages,
    initialLorePageLinks,
    seatOffsetsMap,
    diceTrayPreferencesMap,
    initialCampaignTokens,
    initialInteractionEvents,
  ] = await Promise.all([
    listAssetsForCampaign(supabase, campaignId),
    // Non-DM RLS only exposes the live map (plus, as of 0046, whichever map
    // their own character's token is currently on — but never a whole
    // browsable LIST of every map), and only the DM gets the picker — no
    // point fetching a list for players.
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
    // Chat & Summary B4: same DB-read-not-broadcast reasoning as
    // listRollLog immediately above — a fresh join or reload sees the
    // campaign's full chat history without having been subscribed to
    // chat_messages' own postgres_changes feed when any of it was sent.
    // Every member's own RLS-readable rows (0067's SELECT policy is
    // whole-campaign, matching roll_log), so this is never trimmed per
    // viewer.
    listChatMessages(supabase, campaignId),
    // Monster stat blocks (Prompt 61), member-readable — AC auto-fill
    // for stat-blocked NPC targets needs them on every client.
    listMonsterStatBlocks(supabase, campaignId),
    // Weather & Enemies C5: the GLOBAL monster template library (0073),
    // only for the DM's book's Enemies (MonsterPanel) "add from library"
    // browser — same DM-gated fetch convention as rosterNpcs immediately
    // below (0073's SELECT policy is actually open to any authenticated
    // user, but no non-DM surface reads it today, so there's no point
    // fetching it for a player).
    currentUserIsDM ? listMonsterTemplates(supabase) : Promise.resolve([]),
    // Weather & Enemies C7: this campaign's own template-model overrides
    // (0075) — the SAME DM-gated fetch convention as initialMonsterTemplates
    // immediately above (0075's own SELECT policy is actually open to any
    // campaign member, but no non-DM surface reads it today either, for the
    // exact same reason: MonsterPanel's override upload UI is DM-only). See
    // GameRoom.tsx's own initialTemplateOverrides/initialMonsterTemplates
    // doc comments for the resulting pre-existing player-visibility gap
    // this inherits (only the DM's own view resolves a template's model at
    // all today, override or not).
    currentUserIsDM
      ? listMonsterTemplateOverridesForCampaign(supabase, campaignId)
      : Promise.resolve([]),
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
    // Movable chairs: every member's own stored chair offset, same
    // DB-read-not-broadcast reasoning as the live map/roll log above — a
    // fresh join or reload must land on wherever chairs currently ACTUALLY
    // are, not their computed defaults, without having been connected for
    // any of the seat-moved broadcasts that got them there.
    getSeatOffsetsForCampaign(supabase, campaignId),
    // Per-member dice-tray-model preference (Prompt 8a/8b) — same DB-read-
    // not-broadcast reasoning as seatOffsetsMap above: a fresh join or
    // reload must render every connected member's own chosen tray model
    // without having been connected for the DICE_TRAY_PREFERENCE_EVENT
    // broadcast that set it.
    getDiceTrayPreferencesForCampaign(supabase, campaignId),
    // Per-viewer map transitions (0046): every map_token this viewer's own
    // RLS lets them read, campaign-wide — for a player, always includes
    // wherever their own character's token currently sits (even off the
    // shared live map, after a solo transition), used just below to derive
    // THIS viewer's own effective starting map; for the DM, every token on
    // every map, used by GameRoom's own map-picker to show which maps
    // currently have an active player token on them.
    listMapTokensForCampaign(supabase, campaignId),
    // Chat & Summary B5: interaction_events at load time, DM-only per its
    // RLS (0059) — the same "empty array for a player, GameRoom never
    // fetches for one" convention as rosterNpcs/initialDmNotes above. Feeds
    // the book's new Activity page (DmBookActivityPage), kept live via
    // subscribeToInteractionEvents.
    currentUserIsDM ? listInteractionEvents(supabase, campaignId) : Promise.resolve([]),
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

  // Per-viewer map transitions (0046): a player's own effective "current
  // map" is wherever their own character's token actually is — NOT
  // campaign.live_map — the moment those two diverge (a solo transition
  // crossing). mostRecentOwnToken (vision.ts) is the same "which of my own
  // placed characters is the one at the table" tie-break GameRoom's own
  // visionMasking/turn-camera logic already uses, just run here at SSR time
  // against every map_token this viewer's own RLS makes readable
  // campaign-wide, not one single map's worth. Falls back to
  // campaign.live_map — the shared default — when the viewer has no token
  // of their own anywhere (nobody has placed one yet, or a spectator/DM):
  // this is what makes an existing single-shared-map campaign, where
  // nobody has ever split up, land on EXACTLY the same map it always did.
  const ownCharacterIds = new Set(
    characters.filter((character) => character.owner_id === user.id).map((character) => character.id)
  );
  const ownTokenMapId = currentUserIsDM
    ? null
    : (mostRecentOwnToken(initialCampaignTokens, ownCharacterIds)?.map_id ?? null);
  const effectiveMapId = ownTokenMapId ?? campaign.live_map;

  let initialLiveMap: LiveMapData | null = null;
  if (effectiveMapId) {
    const map = await getMap(supabase, effectiveMapId);
    if (map) {
      const [cells, objects, tokens, lightSources, whiteboardTiles] = await Promise.all([
        listMapCells(supabase, map.id),
        listMapObjects(supabase, map.id),
        listMapTokens(supabase, map.id),
        // Loaded for the client's per-player vision computation (Prompt 58)
        // — members read the live map's lights under the 0036 RLS.
        listLightSources(supabase, map.id),
        // Whiteboard drawing layer (Prompt 3, docs/design/whiteboard-drawing-layer.md
        // §5.3) — member-readable (0058), so the initial SSR render already
        // shows the DM's drawing with no client-side flash-of-blank-board.
        listWhiteboardTiles(supabase, map.id),
      ]);
      // Map Editor Batch A4: which of this map's objects already hold
      // items — same second-query-after-objects reasoning as GameRoom's
      // own refreshLiveMap (this bundle's live-reload counterpart).
      const containerItems = await listItemsForMapObjects(supabase, objects.map((object) => object.id));
      const containerObjectIds = new Set(
        containerItems.flatMap((item) => (item.map_object_id ? [item.map_object_id] : []))
      );
      initialLiveMap = { map, cells, objects, tokens, lightSources, whiteboardTiles, containerObjectIds };
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
      // The raw campaigns.live_map column (0046) — distinct from
      // initialLiveMap above, which is whichever map's FULL bundle this
      // VIEWER should start on. GameRoom needs the shared default
      // separately: it's the fallback a token-less player's view still
      // follows live, and the DM's own view starts there too (their own
      // local pick from then on).
      initialCampaignLiveMapId={campaign.live_map}
      initialCampaignTokens={initialCampaignTokens}
      availableMaps={availableMaps}
      assets={paletteAssets}
      characters={characters}
      initialStatBlocks={initialStatBlocks}
      initialMonsterTemplates={initialMonsterTemplates}
      initialTemplateOverrides={initialTemplateOverrides}
      rosterNpcs={rosterNpcs}
      initialHandouts={initialHandouts}
      initialCombat={initialCombat}
      initialRolls={initialRolls}
      initialChatMessages={initialChatMessages}
      initialActionEconomyStrict={campaign.action_economy_strict}
      initialDayNightMode={campaign.day_night_mode}
      initialWeatherKind={campaign.weather_kind}
      initialWeatherMechanical={campaign.weather_mechanical}
      initialSessionActive={campaign.session_active}
      initialSessionStartedAt={campaign.session_started_at}
      initialUiPreferences={currentUserProfile?.ui_preferences ?? { panelLayout: {} }}
      initialDmNotes={initialDmNotes}
      initialLorePages={initialLorePages}
      initialLorePageLinks={initialLorePageLinks}
      initialInteractionEvents={initialInteractionEvents}
      // A Map isn't a serializable Server → Client component prop — see
      // GameRoom's own initialSeatOffsets doc comment for why this crosses
      // as a plain array of pairs instead, reconstructed into a Map there.
      initialSeatOffsets={[...seatOffsetsMap.entries()]}
      initialDiceTrayPreferences={[...diceTrayPreferencesMap.entries()]}
    />
  );
}
