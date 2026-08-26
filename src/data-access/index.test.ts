import { describe, expect, it } from "vitest";
import {
  MODULE_NAME,
  getProfile,
  upsertProfile,
  isProfileComplete,
  createMap,
  listMapsForCampaign,
  getMap,
  listMapCells,
  upsertMapCells,
  listMapObjects,
  createMapObject,
  updateMapObject,
  deleteMapObject,
  setLiveMap,
  setMapObjectBehavior,
  triggerMapObject,
  parseMapObjectBehavior,
  listMapTokens,
  listMapTokensForCampaign,
  getMapToken,
  getCharacterCurrentToken,
  placeCharacterToken,
  placeNpcToken,
  moveMapToken,
  setTokenAllegiance,
  deleteMapToken,
  TOKEN_ALLEGIANCES,
  listMapTransitionsForCampaign,
  setHouseRules,
  listNpcs,
  createNpc,
  updateNpc,
  deleteNpc,
  listLorePages,
  createLorePage,
  updateLorePage,
  deleteLorePage,
  listLorePageLinks,
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
  getActiveCombatEncounter,
  getActiveCombatantForCharacter,
  listCombatCombatants,
  startCombat,
  advanceTurn,
  endCombat,
  setCombatantInitiative,
  listCombatantConditions,
  applyCondition,
  removeCondition,
  applyExhaustionDelta,
  subscribeToCombatantConditionChanges,
  listDmNotes,
  createDmNote,
  updateDmNote,
  deleteDmNote,
  requestOverride,
  resolveOverride,
  consumeOverride,
  listActionOverrides,
  subscribeToActionOverrides,
  getForwardOffsetDeg,
  getForwardOffsetsForUrls,
  setForwardOffsetDeg,
  DEFAULT_FORWARD_OFFSET_DEG,
  getSeatOffset,
  getSeatOffsetsForCampaign,
  setSeatOffset,
} from "@/data-access";

describe("data-access module", () => {
  it("is independently importable and testable", () => {
    expect(MODULE_NAME).toBe("data-access");
  });

  it("exports the environment-agnostic profile functions from the main barrel", () => {
    expect(getProfile).toBeTypeOf("function");
    expect(upsertProfile).toBeTypeOf("function");
    expect(isProfileComplete).toBeTypeOf("function");
  });

  it("exports the map and cell functions from the main barrel", () => {
    expect(createMap).toBeTypeOf("function");
    expect(listMapsForCampaign).toBeTypeOf("function");
    expect(getMap).toBeTypeOf("function");
    expect(listMapCells).toBeTypeOf("function");
    expect(upsertMapCells).toBeTypeOf("function");
  });

  it("exports the map object functions from the main barrel", () => {
    expect(listMapObjects).toBeTypeOf("function");
    expect(createMapObject).toBeTypeOf("function");
    expect(updateMapObject).toBeTypeOf("function");
    expect(deleteMapObject).toBeTypeOf("function");
  });

  it("exports the behavior and live-map functions from the main barrel", () => {
    expect(setLiveMap).toBeTypeOf("function");
    expect(setMapObjectBehavior).toBeTypeOf("function");
    expect(triggerMapObject).toBeTypeOf("function");
    expect(parseMapObjectBehavior).toBeTypeOf("function");
  });

  it("exports the map token functions from the main barrel", () => {
    expect(listMapTokens).toBeTypeOf("function");
    expect(listMapTokensForCampaign).toBeTypeOf("function");
    expect(getMapToken).toBeTypeOf("function");
    expect(getCharacterCurrentToken).toBeTypeOf("function");
    expect(placeCharacterToken).toBeTypeOf("function");
    expect(placeNpcToken).toBeTypeOf("function");
    expect(moveMapToken).toBeTypeOf("function");
    expect(setTokenAllegiance).toBeTypeOf("function");
    expect(deleteMapToken).toBeTypeOf("function");
    expect(TOKEN_ALLEGIANCES).toEqual(["party", "hostile", "neutral"]);
  });

  it("exports the campaign-wide map transitions function from the main barrel (0046)", () => {
    expect(listMapTransitionsForCampaign).toBeTypeOf("function");
  });

  it("exports the combat functions from the main barrel", () => {
    expect(getActiveCombatEncounter).toBeTypeOf("function");
    expect(listCombatCombatants).toBeTypeOf("function");
    expect(startCombat).toBeTypeOf("function");
    expect(advanceTurn).toBeTypeOf("function");
    expect(endCombat).toBeTypeOf("function");
    expect(setCombatantInitiative).toBeTypeOf("function");
  });

  it("exports the combatant condition functions from the main barrel", () => {
    expect(getActiveCombatantForCharacter).toBeTypeOf("function");
    expect(listCombatantConditions).toBeTypeOf("function");
    expect(applyCondition).toBeTypeOf("function");
    expect(removeCondition).toBeTypeOf("function");
    expect(applyExhaustionDelta).toBeTypeOf("function");
    expect(subscribeToCombatantConditionChanges).toBeTypeOf("function");
  });

  it("treats a profile with no display name as incomplete", () => {
    expect(isProfileComplete(null)).toBe(false);
    expect(
      isProfileComplete({
        id: "x",
        display_name: null,
        avatar_source: null,
        avatar_ref: null,
        created_at: "",
        ui_preferences: { panelLayout: {} },
      })
    ).toBe(false);
    expect(
      isProfileComplete({
        id: "x",
        display_name: "  ",
        avatar_source: null,
        avatar_ref: null,
        created_at: "",
        ui_preferences: { panelLayout: {} },
      })
    ).toBe(false);
  });

  it("treats a profile with a display name as complete", () => {
    expect(
      isProfileComplete({
        id: "x",
        display_name: "Vex",
        avatar_source: null,
        avatar_ref: null,
        created_at: "",
        ui_preferences: { panelLayout: {} },
      })
    ).toBe(true);
  });

  it("exports house rules and NPC functions from the main barrel", () => {
    expect(setHouseRules).toBeTypeOf("function");
    expect(listNpcs).toBeTypeOf("function");
    expect(createNpc).toBeTypeOf("function");
    expect(updateNpc).toBeTypeOf("function");
    expect(deleteNpc).toBeTypeOf("function");
  });

  it("exports the lore page and lore page link functions from the main barrel", () => {
    expect(listLorePages).toBeTypeOf("function");
    expect(createLorePage).toBeTypeOf("function");
    expect(updateLorePage).toBeTypeOf("function");
    expect(deleteLorePage).toBeTypeOf("function");
    expect(listLorePageLinks).toBeTypeOf("function");
    expect(linkLorePages).toBeTypeOf("function");
    expect(unlinkLorePages).toBeTypeOf("function");
  });

  it("exports the quest functions from the main barrel", () => {
    expect(listQuests).toBeTypeOf("function");
    expect(createQuest).toBeTypeOf("function");
    expect(updateQuest).toBeTypeOf("function");
    expect(setQuestStatus).toBeTypeOf("function");
    expect(deleteQuest).toBeTypeOf("function");
    expect(QUEST_STATUSES).toEqual(["active", "completed", "abandoned"]);
  });

  it("exports the session log functions from the main barrel", () => {
    expect(listSessionLogEntries).toBeTypeOf("function");
    expect(createSessionLogEntry).toBeTypeOf("function");
    expect(updateSessionLogEntry).toBeTypeOf("function");
    expect(deleteSessionLogEntry).toBeTypeOf("function");
  });

  it("exports the handout functions from the main barrel", () => {
    expect(listHandouts).toBeTypeOf("function");
    expect(createHandout).toBeTypeOf("function");
    expect(setHandoutRevealed).toBeTypeOf("function");
    expect(deleteHandout).toBeTypeOf("function");
  });

  it("exports the DM note functions from the main barrel", () => {
    expect(listDmNotes).toBeTypeOf("function");
    expect(createDmNote).toBeTypeOf("function");
    expect(updateDmNote).toBeTypeOf("function");
    expect(deleteDmNote).toBeTypeOf("function");
  });

  it("exports the action override functions from the main barrel", () => {
    expect(requestOverride).toBeTypeOf("function");
    expect(resolveOverride).toBeTypeOf("function");
    expect(consumeOverride).toBeTypeOf("function");
    expect(listActionOverrides).toBeTypeOf("function");
    expect(subscribeToActionOverrides).toBeTypeOf("function");
  });

  it("exports the model orientation functions from the main barrel", () => {
    expect(getForwardOffsetDeg).toBeTypeOf("function");
    expect(getForwardOffsetsForUrls).toBeTypeOf("function");
    expect(setForwardOffsetDeg).toBeTypeOf("function");
    expect(DEFAULT_FORWARD_OFFSET_DEG).toBe(0);
  });

  it("exports the seat offset functions from the main barrel", () => {
    expect(getSeatOffset).toBeTypeOf("function");
    expect(getSeatOffsetsForCampaign).toBeTypeOf("function");
    expect(setSeatOffset).toBeTypeOf("function");
  });
});
