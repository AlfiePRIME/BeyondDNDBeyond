import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  getActiveCombatEncounter,
  getDiceTrayPreferencesForCampaign,
  getMap,
  getMapArt,
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
import { DEFAULT_PAWN_COLOR, resolveAvatarUrl, type RoomMember } from "./avatar-url";
import { resolveHandout } from "./handout-url";
import { resolveCampaignPawnAppearance } from "./pawn-url";
import { mostRecentOwnToken } from "./vision";
import type { CombatState } from "./CombatPanel";
import { GameRoom, type LiveMapData } from "./GameRoom";

/**
 * Every one of this page's "initial*" reads is a nice-to-have — a fresh
 * fallback lets the client's own live subscriptions fill it in a moment
 * later, exactly like a first-ever visit with an empty campaign already
 * behaves. Only the campaign row itself and the member list are load-
 * bearing enough to legitimately fail the whole page. A single flaky
 * upstream hop (proxy hiccup, transient Supabase blip) on any ONE of these
 * secondary reads must not take down the entire room for every viewer —
 * confirmed as a real production incident where a large campaign's bigger
 * batch of concurrent reads made this exact class of failure far more
 * likely to actually happen than on a small/empty campaign.
 */
async function safe<T>(promise: Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    console.error(`room SSR: ${label} failed, falling back to default`, err);
    return fallback;
  }
}

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
      const profile = await safe(getProfile(supabase, member.user_id), null, `getProfile(${member.user_id})`);
      const avatar = await resolveAvatarUrl(
        supabase,
        profile?.avatar_source ?? null,
        profile?.avatar_ref ?? null
      );
      return {
        ...member,
        avatar_url: avatar.url,
        avatar_forward_offset_deg: avatar.forwardOffsetDeg,
        // Pawn Customization P1: every real profile row always has a
        // non-null value here (0079's column default) — the fallback below
        // only ever covers a member whose profile row itself failed to
        // load at all.
        default_pawn_color: profile?.default_pawn_color ?? DEFAULT_PAWN_COLOR,
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
  const currentUserProfile = await safe(getProfile(supabase, user.id), null, "getProfile(currentUser)");

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
    initialCharacterPawns,
    rosterNpcs,
    dmNoteRows,
    initialLorePages,
    initialLorePageLinks,
    seatOffsetsMap,
    diceTrayPreferencesMap,
    initialCampaignTokens,
    initialInteractionEvents,
  ] = await Promise.all([
    safe(listAssetsForCampaign(supabase, campaignId), [], "listAssetsForCampaign"),
    // Non-DM RLS only exposes the live map (plus, as of 0046, whichever map
    // their own character's token is currently on — but never a whole
    // browsable LIST of every map), and only the DM gets the picker — no
    // point fetching a list for players.
    currentUserIsDM
      ? safe(listMapsForCampaign(supabase, campaignId), [], "listMapsForCampaign")
      : Promise.resolve([]),
    // Characters RLS trims this per viewer: a player gets only their own,
    // the DM gets every campaign character — exactly who each may place.
    safe(listCharactersForCampaign(supabase, campaignId), [], "listCharactersForCampaign"),
    // Handouts RLS trims per viewer too: every row for the DM, revealed
    // rows only for a player.
    safe(listHandouts(supabase, campaignId), [], "listHandouts"),
    // Same DB-read reasoning as the live map: fresh joins see recent rolls
    // without having been subscribed when they landed.
    safe(listRollLog(supabase, campaignId), [], "listRollLog"),
    // Chat & Summary B4: same DB-read-not-broadcast reasoning as
    // listRollLog immediately above — a fresh join or reload sees the
    // campaign's full chat history without having been subscribed to
    // chat_messages' own postgres_changes feed when any of it was sent.
    // Every member's own RLS-readable rows (0067's SELECT policy is
    // whole-campaign, matching roll_log), so this is never trimmed per
    // viewer.
    safe(listChatMessages(supabase, campaignId), [], "listChatMessages"),
    // Monster stat blocks (Prompt 61), member-readable — AC auto-fill
    // for stat-blocked NPC targets needs them on every client.
    safe(listMonsterStatBlocks(supabase, campaignId), [], "listMonsterStatBlocks"),
    // Weather & Enemies C5: the GLOBAL monster template library (0073) —
    // fetched for EVERY campaign member, not just the DM (0073's own SELECT
    // policy is open to any authenticated user). MonsterPanel's "add from
    // library" browser is still DM-only UI, but GameRoom's own C6 token-model
    // resolution (the tableMap memo) runs per-viewer and needs
    // monsterTemplateById populated for every client — a player's own
    // browser is exactly the one that has to actually render a templated
    // monster's distinct model during play. See GameRoom.tsx's own
    // initialMonsterTemplates doc comment for the fuller history.
    safe(listMonsterTemplates(supabase), [], "listMonsterTemplates"),
    // Weather & Enemies C7: this campaign's own template-model overrides
    // (0075) — same reasoning as initialMonsterTemplates immediately above:
    // fetched for every member (0075's own SELECT policy is any campaign
    // member), since GameRoom's token-model resolution reads this
    // campaign-scoped override ahead of the template's own default_asset_id
    // for every viewer, not just the DM's.
    safe(listMonsterTemplateOverridesForCampaign(supabase, campaignId), [], "listMonsterTemplateOverridesForCampaign"),
    // Pawn Customization P2: every character's own pawn appearance (0080),
    // resolved to a loadable model URL — fetched for EVERY campaign member
    // (0080's SELECT policy is any campaign member, not owner-or-DM), the
    // exact same "every viewer needs this to render every OTHER player's
    // token too" reasoning as initialTemplateOverrides immediately above.
    safe(resolveCampaignPawnAppearance(supabase, campaignId), [], "resolveCampaignPawnAppearance"),
    // The narrative roster, only for the DM's book's Enemies (MonsterPanel)
    // name pre-fill; players never see the book, so no point fetching.
    currentUserIsDM ? safe(listNpcs(supabase, campaignId), [], "listNpcs") : Promise.resolve([]),
    // dm_notes' SELECT RLS (0020) has no member-read policy at all — same
    // DM-gated fetch convention as rosterNpcs above, for the book's Notes
    // page (DmNotes.tsx, embedded unmodified).
    currentUserIsDM ? safe(listDmNotes(supabase, campaignId), [], "listDmNotes") : Promise.resolve([]),
    // Lore pages/links are member-readable (matching the standalone /lore
    // route's own fetch) — the book's Lore page opens with no loading
    // flash for the DM, same as every other "initial*" prop here.
    safe(listLorePages(supabase, campaignId), [], "listLorePages"),
    safe(listLorePageLinksForCampaign(supabase, campaignId), [], "listLorePageLinksForCampaign"),
    // Movable chairs: every member's own stored chair offset, same
    // DB-read-not-broadcast reasoning as the live map/roll log above — a
    // fresh join or reload must land on wherever chairs currently ACTUALLY
    // are, not their computed defaults, without having been connected for
    // any of the seat-moved broadcasts that got them there.
    safe(getSeatOffsetsForCampaign(supabase, campaignId), new Map(), "getSeatOffsetsForCampaign"),
    // Per-member dice-tray-model preference (Prompt 8a/8b) — same DB-read-
    // not-broadcast reasoning as seatOffsetsMap above: a fresh join or
    // reload must render every connected member's own chosen tray model
    // without having been connected for the DICE_TRAY_PREFERENCE_EVENT
    // broadcast that set it.
    safe(getDiceTrayPreferencesForCampaign(supabase, campaignId), new Map(), "getDiceTrayPreferencesForCampaign"),
    // Per-viewer map transitions (0046): every map_token this viewer's own
    // RLS lets them read, campaign-wide — for a player, always includes
    // wherever their own character's token currently sits (even off the
    // shared live map, after a solo transition), used just below to derive
    // THIS viewer's own effective starting map; for the DM, every token on
    // every map, used by GameRoom's own map-picker to show which maps
    // currently have an active player token on them.
    safe(listMapTokensForCampaign(supabase, campaignId), [], "listMapTokensForCampaign"),
    // Chat & Summary B5: interaction_events at load time, DM-only per its
    // RLS (0059) — the same "empty array for a player, GameRoom never
    // fetches for one" convention as rosterNpcs/initialDmNotes above. Feeds
    // the book's new Activity page (DmBookActivityPage), kept live via
    // subscribeToInteractionEvents.
    currentUserIsDM
      ? safe(listInteractionEvents(supabase, campaignId), [], "listInteractionEvents")
      : Promise.resolve([]),
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
  // lands on the current combat state without having seen any broadcast. A
  // failure here degrades to "no active combat" — the client's own
  // subscription picks up the real state moments later, same as every
  // other secondary read on this page.
  const activeEncounter = await safe(getActiveCombatEncounter(supabase, campaignId), null, "getActiveCombatEncounter");
  let initialCombat: CombatState | null = null;
  if (activeEncounter) {
    const combatants = await safe(listCombatCombatants(supabase, activeEncounter.id), [], "listCombatCombatants");
    const combatantIds = combatants.map((combatant) => combatant.id);
    // Hidden-from pairs (Prompt 60) load alongside conditions — both are
    // member-readable per-combatant state the room renders from.
    const [conditions, hiddenFrom] = await Promise.all([
      safe(listCombatantConditions(supabase, combatantIds), [], "listCombatantConditions"),
      safe(listCombatantHiddenFrom(supabase, combatantIds), [], "listCombatantHiddenFrom"),
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
  // The whole bundle below is one coherent unit — cells/objects/tokens must
  // land together or not at all, so a failure ANYWHERE in this block falls
  // back to "no live map" (a real state the room already renders correctly,
  // e.g. a brand-new campaign) rather than a partially-populated map that
  // could itself crash client-side rendering. The client's own live
  // subscriptions/refreshLiveMap fill this in moments later regardless.
  try {
    if (effectiveMapId) {
      const map = await getMap(supabase, effectiveMapId);
      if (map) {
        const [cells, objects, tokens, lightSources, whiteboardTiles, mapArt] = await Promise.all([
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
          // Map Art Generation E5: null for a map with no accepted art —
          // member-readable (0077, can_read_map-gated, the same posture as
          // the map row itself), so the initial SSR render already knows
          // whether to render the live table's transparent-floor/faint-grid
          // mode with no client-side flash of ordinary opaque floor first.
          getMapArt(supabase, map.id),
        ]);
        // Map Editor Batch A4: which of this map's objects already hold
        // items — same second-query-after-objects reasoning as GameRoom's
        // own refreshLiveMap (this bundle's live-reload counterpart).
        const containerItems = await listItemsForMapObjects(supabase, objects.map((object) => object.id));
        const containerObjectIds = new Set(
          containerItems.flatMap((item) => (item.map_object_id ? [item.map_object_id] : []))
        );
        initialLiveMap = { map, cells, objects, tokens, lightSources, whiteboardTiles, mapArt, containerObjectIds };
      }
    }
  } catch (err) {
    console.error("room SSR: live map bundle failed, falling back to no live map", err);
    initialLiveMap = null;
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
      initialCharacterPawns={initialCharacterPawns}
      rosterNpcs={rosterNpcs}
      initialHandouts={initialHandouts}
      initialCombat={initialCombat}
      initialRolls={initialRolls}
      initialChatMessages={initialChatMessages}
      initialActionEconomyStrict={campaign.action_economy_strict}
      initialDayNightMode={campaign.day_night_mode}
      initialCalmMusicEnabled={campaign.calm_music_enabled}
      initialCombatMusicEnabled={campaign.combat_music_enabled}
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
