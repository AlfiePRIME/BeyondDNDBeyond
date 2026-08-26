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
  setUiPreferences,
  uploadAvatarFile,
  getAvatarSignedUrl,
  subscribeToProfileChanges,
  subscribeToUiPreferencesChanges,
  type Profile,
  type AvatarSource,
  type UiPreferences,
  type PanelLayoutEntry,
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
  setActionEconomyStrict,
  setDayNightMode,
  subscribeToCampaignChanges,
  type Campaign,
  type CampaignRole,
  type CampaignMembership,
  type CampaignMember,
  type DayNightMode,
} from "./campaigns";
export {
  createCharacter,
  listCharactersForCampaign,
  listCharactersForUser,
  getCharacter,
  updateCharacter,
  applyHpDelta,
  startConcentrating,
  stopConcentrating,
  subscribeToCharacterChanges,
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
  getForwardOffsetDeg,
  getForwardOffsetsForUrls,
  setForwardOffsetDeg,
  DEFAULT_FORWARD_OFFSET_DEG,
  type ModelOrientation,
} from "./modelOrientation";
export {
  getSeatOffset,
  getSeatOffsetsForCampaign,
  setSeatOffset,
  type SeatOffset,
} from "./seatOffsets";
export {
  getDiceTrayPreference,
  getDiceTrayPreferencesForCampaign,
  setDiceTrayPreference,
  DEFAULT_DICE_TRAY_PREFERENCE,
  type DiceTrayModelSource,
  type DiceTrayModelPreference,
} from "./diceTrayPreference";
export {
  createMap,
  createPopulatedMap,
  duplicateMap,
  listMapsForCampaign,
  getMap,
  listMapCells,
  upsertMapCells,
  setLiveMap,
  growMapGrid,
  MAP_GROWTH_EDGES,
  listMapFolders,
  createMapFolder,
  renameMapFolder,
  deleteMapFolder,
  setMapFolder,
  setMapThumbnail,
  uploadMapThumbnailFile,
  deleteMapThumbnailFile,
  getMapThumbnailSignedUrl,
  uploadMapReferenceImageFile,
  deleteMapReferenceImageFile,
  getMapReferenceImageSignedUrl,
  setMapReferenceImage,
  clearMapReferenceImage,
  LIGHT_LEVELS,
  GROUND_TYPES,
  WATER_FLOW_DIRECTIONS,
  type CampaignMap,
  type MapCell,
  type MapFolder,
  type NewMapCell,
  type NewMapObjectSeed,
  type LightLevel,
  type MapGrowthEdge,
  type GroundType,
  type WaterFlowDirection,
} from "./maps";
export {
  listMapObjects,
  createMapObject,
  restoreMapObject,
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
  listMapTokensForCampaign,
  getMapToken,
  getCharacterCurrentToken,
  placeCharacterToken,
  placeNpcToken,
  moveMapToken,
  moveCombatToken,
  transitionMapToken,
  setTokenAllegiance,
  deleteMapToken,
  TOKEN_ALLEGIANCES,
  type MapToken,
  type TokenAllegiance,
} from "./mapTokens";
export {
  listMapTransitions,
  listMapTransitionsForCampaign,
  createMapTransition,
  deleteMapTransition,
  type MapTransition,
} from "./mapTransitions";
export {
  listConcealedPits,
  createConcealedPit,
  deleteConcealedPit,
  type ConcealedPit,
} from "./concealedPits";
export {
  listLightSources,
  createLightSource,
  updateLightSource,
  deleteLightSource,
  LIGHT_SOURCE_BRIGHTNESSES,
  type LightSource,
  type LightSourceAnchor,
  type LightSourceBrightness,
} from "./lightSources";
export {
  listSeenCells,
  recordSeenCells,
  type MapSeenCell,
  type SeenCellSnapshot,
} from "./mapSeenCells";
export {
  getActiveCombatEncounter,
  getActiveCombatantForCharacter,
  listCombatCombatants,
  startCombat,
  advanceTurn,
  endCombat,
  setCombatantInitiative,
  setCombatantEconomyFlag,
  declareDisengage,
  addCombatant,
  addFreeformCombatant,
  applyNpcHpDelta,
  type CombatEncounter,
  type CombatCombatant,
  type CombatantEconomyFlag,
} from "./combat";
export {
  listMonsterStatBlocks,
  createMonsterStatBlock,
  updateMonsterStatBlock,
  deleteMonsterStatBlock,
  type MonsterAttack,
  type MonsterStatBlock,
  type UpdateMonsterStatBlockPatch,
} from "./monsterStatBlocks";
export {
  createOpportunityAttacks,
  listOpportunityAttacks,
  resolveOpportunityAttack,
  subscribeToOpportunityAttacks,
  type OpportunityAttack,
  type OpportunityAttackStatus,
} from "./opportunityAttacks";
export {
  listCombatantConditions,
  applyCondition,
  removeCondition,
  applyExhaustionDelta,
  subscribeToCombatantConditionChanges,
  type CombatantCondition,
} from "./conditions";
export {
  getEncounterVisionStats,
  listCombatantHiddenFrom,
  replaceHiddenAsHider,
  clearHiddenAsHider,
  subscribeToCombatantHiddenFromChanges,
  type CombatantHiddenFrom,
  type EncounterVisionStats,
} from "./hiddenFrom";
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
  listRollLog,
  subscribeToRollLog,
  resolveAttackDamage,
  resolveNpcAttackDamage,
  rollDeathSave,
  rollConcentrationSave,
  type RollKind,
  type RollModifierPart,
  type AttackResolution,
  type DeathSaveResolution,
  type ConcentrationSaveResolution,
  type HideObserverOutcome,
  type HideResolution,
  type D20RollBreakdown,
  type FreeformRollBreakdown,
  type RollBreakdown,
  type RollLogEntry,
  type RollVisibility,
} from "./rolls";
export {
  requestOverride,
  resolveOverride,
  consumeOverride,
  listActionOverrides,
  subscribeToActionOverrides,
  type ActionOverride,
  type ActionOverrideStatus,
} from "./actionOverrides";
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
