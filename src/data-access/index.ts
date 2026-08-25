// Public entry point for the data-access module — the environment-agnostic
// parts. This is the ONLY module allowed to import @supabase/supabase-js
// (or @supabase/ssr) directly — enforced by eslint-plugin-boundaries (see
// eslint.config.mjs). Every other module goes through here (or one of the
// sub-entry-points below) for persistence.
//
// Three additional entry points exist for code that Next.js restricts to a
// specific runtime — importing them from this main barrel would leak
// server/edge-only code (e.g. next/headers) into client bundles and break
// the build:
//   @/data-access/supabase-server     — Server Components/Actions/Route Handlers
//   @/data-access/supabase-browser    — Client Components
//   @/data-access/supabase-middleware — Edge Middleware
//
// Note on client creation generally: there is no shared/singleton Supabase
// client — each of the three create*Client functions builds a fresh
// instance per call. A single shared instance would leak one user's
// session/cookies into another user's request on the server.
//
// SupabaseClient is re-exported (type-only) so other modules can type a
// "caller passes in a client" parameter (e.g. realtime's joinCampaignChannel)
// without importing @supabase/supabase-js themselves.
export type { SupabaseClient } from "@supabase/supabase-js";
export {
  getProfile,
  upsertProfile,
  isProfileComplete,
  setProfileAvatar,
  uploadAvatarFile,
  getAvatarSignedUrl,
  subscribeToProfileChanges,
  type Profile,
  type AvatarSource,
} from "./profiles";
export {
  listCampaignsForUser,
  createCampaign,
  joinCampaignByInviteCode,
  renameCampaign,
  deleteCampaign,
  leaveCampaign,
  isDM,
  listCampaignMembers,
  transferDM,
  startSession,
  endSession,
  setHouseRules,
  type Campaign,
  type CampaignRole,
  type CampaignMembership,
  type CampaignMember,
} from "./campaigns";
export {
  createCharacter,
  listCharactersForCampaign,
  listCharactersForUser,
  getCharacter,
  updateCharacter,
  type Character,
  type OwnedCharacter,
  type CreateCharacterParams,
  type UpdateCharacterPatch,
  type InventoryItem,
  type KnownSpell,
} from "./characters";
export {
  listAssetsForCampaign,
  uploadMapAssetFile,
  createCustomAsset,
  getMapAssetSignedUrl,
  type MapAsset,
  type AssetSourceType,
} from "./assets";
export {
  createMap,
  listMapsForCampaign,
  getMap,
  listMapCells,
  upsertMapCells,
  setLiveMap,
  listMapFolders,
  createMapFolder,
  renameMapFolder,
  deleteMapFolder,
  setMapFolder,
  setMapThumbnail,
  uploadMapThumbnailFile,
  deleteMapThumbnailFile,
  getMapThumbnailSignedUrl,
  type CampaignMap,
  type MapCell,
  type MapFolder,
} from "./maps";
export {
  listMapObjects,
  createMapObject,
  updateMapObject,
  deleteMapObject,
  setMapObjectBehavior,
  triggerMapObject,
  parseMapObjectBehavior,
  MAP_OBJECT_ACTIONS,
  type MapObject,
  type MapObjectAction,
  type MapObjectBehavior,
  type PlacedObjectAsset,
} from "./mapObjects";
export {
  listMapTokens,
  placeCharacterToken,
  placeNpcToken,
  moveMapToken,
  setTokenAllegiance,
  deleteMapToken,
  TOKEN_ALLEGIANCES,
  type MapToken,
  type TokenAllegiance,
} from "./mapTokens";
export {
  listCharacterResources,
  createCharacterResource,
  setCharacterResourceUses,
  shortRest,
  longRest,
  type CharacterResource,
  type CreateCharacterResourceParams,
  type ResourceRecharge,
} from "./characterResources";
export {
  listNpcs,
  createNpc,
  updateNpc,
  deleteNpc,
  uploadNpcPortraitFile,
  getNpcPortraitSignedUrl,
  listLorePages,
  createLorePage,
  updateLorePage,
  deleteLorePage,
  listLorePageLinks,
  listLorePageLinksForCampaign,
  linkLorePages,
  unlinkLorePages,
  listQuests,
  createQuest,
  updateQuest,
  setQuestStatus,
  deleteQuest,
  QUEST_STATUSES,
  listSessionLogEntries,
  createSessionLogEntry,
  updateSessionLogEntry,
  deleteSessionLogEntry,
  listHandouts,
  createHandout,
  setHandoutRevealed,
  deleteHandout,
  uploadHandoutFile,
  getHandoutSignedUrl,
  listDmNotes,
  createDmNote,
  updateDmNote,
  deleteDmNote,
  type Npc,
  type UpdateNpcPatch,
  type LorePage,
  type LorePageLink,
  type Quest,
  type QuestStatus,
  type SessionLogEntry,
  type Handout,
  type DmNote,
} from "./narrative";

export const MODULE_NAME = "data-access" as const;
