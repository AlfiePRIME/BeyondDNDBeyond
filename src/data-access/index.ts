// Public entry point for the data-access module — the environment-agnostic
// parts. This is the ONLY module allowed to import @supabase/supabase-js
// (or @supabase/ssr) directly — enforced by eslint-plugin-boundaries (see
// eslint.config.mjs). Every other module goes through here (or one of the
// sub-entry-points below) for persistence.
//
// Four additional entry points exist for code that Next.js restricts to a
// specific runtime, or (supabase-service-role) that deliberately bypasses
// RLS entirely — importing them from this main barrel would leak
// server/edge-only code (e.g. next/headers) into client bundles and break
// the build, or make an RLS-bypassing client too easy to reach for by
// accident:
//   @/data-access/supabase-server       — Server Components/Actions/Route Handlers
//   @/data-access/supabase-browser      — Client Components
//   @/data-access/supabase-middleware   — Edge Middleware
//   @/data-access/supabase-service-role — AI Backend & Admin D3's narrow,
//                                          server-side-only exception (see
//                                          that file's own doc comment and
//                                          src/ai/activeProvider.ts)
//
// Note on client creation generally: there is no shared/singleton Supabase
// client — each of the four create*Client functions builds a fresh
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
  setDefaultPawnColor,
  setNameLabelColor,
  setNameLabelSize,
  setUiPreferences,
  uploadAvatarFile,
  getAvatarSignedUrl,
  subscribeToProfileChanges,
  subscribeToUiPreferencesChanges,
  DEFAULT_SOUND_SETTINGS,
  type Profile,
  type AvatarSource,
  type NameLabelSize,
  type UiPreferences,
  type PanelLayoutEntry,
  type SoundSettings,
  type DmBookSize,
} from "./profiles";
export {
  listCharacterPawnsForCampaign,
  getCharacterPawn,
  setCharacterPawnModel,
  uploadCharacterPawnModelFile,
  getCharacterPawnSignedUrl,
  type CharacterPawn,
} from "./characterPawns";
export {
  listCampaignsForUser,
  createCampaign,
  joinCampaignByInviteCode,
  renameCampaign,
  deleteCampaign,
  leaveCampaign,
  isDM,
  listCampaignMembers,
  removeCampaignMember,
  transferDM,
  startSession,
  endSession,
  pauseSession,
  resumeSession,
  setHouseRules,
  setActionEconomyStrict,
  setDayNightMode,
  setCalmMusicEnabled,
  setCombatMusicEnabled,
  setWeather,
  applyWeatherTick,
  subscribeToCampaignChanges,
  type Campaign,
  type CampaignRole,
  type CampaignMembership,
  type CampaignMember,
  type DayNightMode,
  type WeatherKind,
} from "./campaigns";
export {
  createCharacter,
  listCharactersForCampaign,
  listCharactersForUser,
  getCharacter,
  updateCharacter,
  deleteCharacter,
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
  getDmBookOffset,
  setDmBookOffset,
  type DmBookOffset,
} from "./dmBookOffset";
export {
  getDmTrayOffset,
  setDmTrayOffset,
  type DmTrayOffset,
} from "./dmTrayOffset";
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
  listMapsLinkingInto,
  deleteMap,
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
  getMapArt,
  uploadMapArtFile,
  deleteMapArtFile,
  getMapArtSignedUrl,
  acceptMapArt,
  LIGHT_LEVELS,
  GROUND_TYPES,
  WATER_FLOW_DIRECTIONS,
  type CampaignMap,
  type MapCell,
  type MapFolder,
  type MapArt,
  type NewMapCell,
  type NewMapObjectSeed,
  type LightLevel,
  type MapGrowthEdge,
  type GroundType,
  type WaterFlowDirection,
  type LinkedFromMap,
} from "./maps";
export {
  listMapObjects,
  createMapObject,
  restoreMapObject,
  updateMapObject,
  deleteMapObject,
  setMapObjectBehavior,
  triggerMapObject,
  revealAllPendingMapObjects,
  parseMapObjectBehavior,
  parseObjectMovementConfig,
  subscribeToMapObjectChanges,
  MAP_OBJECT_ACTIONS,
  type MapObject,
  type MapObjectAction,
  type MapObjectBehavior,
  type ObjectMovementConfig,
  type PlacedObjectAsset,
  type CrossingType,
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
  rotateMapToken,
  deleteMapToken,
  TOKEN_ALLEGIANCES,
  type MapToken,
  type TokenAllegiance,
} from "./mapTokens";
export {
  listMapTransitions,
  listMapTransitionsForCampaign,
  listMapTransitionAnchors,
  createMapTransition,
  deleteMapTransition,
  type MapTransition,
  type MapTransitionAnchor,
} from "./mapTransitions";
export {
  listConcealedPits,
  createConcealedPit,
  deleteConcealedPit,
  type ConcealedPit,
} from "./concealedPits";
export {
  createInteractionEvent,
  listInteractionEvents,
  listInteractionEventsInRange,
  subscribeToInteractionEvents,
  type InteractionEvent,
} from "./interactionEvents";
export {
  listContainerItems,
  listItemsForMapObjects,
  addContainerItem,
  updateContainerItem,
  removeContainerItem,
  claimContainerItem,
  isCurseBlessingDraftValid,
  draftToCurseBlessing,
  curseBlessingToDraft,
  DEFAULT_CURSE_BLESSING_DRAFT,
  type MapObjectItem,
  type ContainerRef,
  type CurseBlessing,
  type CurseBlessingKind,
  type CurseBlessingResolution,
  type CurseBlessingEffect,
  type CurseBlessingDraft,
} from "./mapObjectItems";
export {
  listWhiteboardTiles,
  saveWhiteboardTiles,
  clearWhiteboard,
  type WhiteboardTile,
  type WhiteboardTileChange,
} from "./whiteboardTiles";
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
  createMonsterStatBlockFromTemplate,
  updateMonsterStatBlock,
  deleteMonsterStatBlock,
  type MonsterAttack,
  type MonsterStatBlock,
  type UpdateMonsterStatBlockPatch,
} from "./monsterStatBlocks";
export {
  listMonsterTemplates,
  type MonsterTemplate,
} from "./monsterTemplates";
export {
  listMonsterTemplateOverridesForCampaign,
  setMonsterTemplateOverride,
  deleteMonsterTemplateOverride,
  type MonsterTemplateOverride,
} from "./monsterTemplateOverrides";
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
  applyResourceDelta,
  shortRest,
  longRest,
  type CharacterResource,
  type CreateCharacterResourceParams,
  type ResourceRecharge,
} from "./characterResources";
export {
  listRollLog,
  listRollLogInRange,
  subscribeToRollLog,
  resolveAttackDamage,
  resolveNpcAttackDamage,
  resolvePcAttackOnNpcDamage,
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
// Chat & Summary B1's data model — B3 (the floating chat bubble) and B4
// (the persistent chat log panel) are its first consumers, so this barrel
// entry didn't exist until now.
export {
  listChatMessages,
  listChatMessagesInRange,
  sendChatMessage,
  editChatMessage,
  subscribeToChatMessages,
  type ChatMessage,
} from "./chat";
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
  SESSION_SUMMARY_HIGHLIGHT_CATEGORIES,
  listSessionSummaryHighlights,
  createSessionSummaryHighlights,
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
  type SessionSummaryHighlightCategory,
  type SessionSummaryHighlight,
  type Handout,
  type DmNote,
} from "./narrative";
// AI Backend & Admin D2's admin settings UI — its own data-access module
// since app_settings (D1, 0072) doesn't fit any existing file's scope
// (not profile, campaign, character, asset, or narrative data). Map Art
// Generation E2 (0076) extends the same table/module with ComfyUI config
// and isMapArtConfigured() — see appSettings.ts's own doc comments.
export {
  getAppSettings,
  updateAppSettings,
  getRawAiProviderConfig,
  isMapArtConfigured,
  getRawMapArtConfig,
  type AiProvider,
  type AppSettings,
  type AppSettingsUpdate,
  type RawAiProviderConfig,
  type RawMapArtConfig,
} from "./appSettings";
// Sound Effects SP2's admin override system — see 0084_sound_overrides.sql
// and soundOverrides.ts's own header comment for why `soundKey` is typed as
// a plain string here rather than importing SoundKey from "@/audio" (this
// module must not depend upward on a feature module that itself depends on
// data-access).
export {
  listSoundOverrides,
  getSoundOverride,
  getSoundOverridePublicUrl,
  setSoundOverride,
  deleteSoundOverride,
  type SoundOverride,
} from "./soundOverrides";

export const MODULE_NAME = "data-access" as const;
