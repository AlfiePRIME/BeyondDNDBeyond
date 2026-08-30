import { describe, expect, it } from "vitest";
import { MAP_OBJECT_ACTIONS, parseMapObjectBehavior, parseObjectMovementConfig } from "./mapObjects";

describe("parseMapObjectBehavior", () => {
  it("treats the column default ({}) as no behavior", () => {
    expect(parseMapObjectBehavior({})).toBeNull();
  });

  it("rejects an unknown action", () => {
    expect(parseMapObjectBehavior({ action: "explode" })).toBeNull();
    expect(parseMapObjectBehavior({ action: 7 })).toBeNull();
  });

  it("parses every known action with defaults for the optional fields", () => {
    for (const action of MAP_OBJECT_ACTIONS) {
      expect(parseMapObjectBehavior({ action })).toEqual({
        action,
        content: null,
        playerTriggerable: false,
        triggerOnStepOn: false,
        triggered: false,
      });
    }
  });

  it("round-trips a fully configured reveal", () => {
    expect(
      parseMapObjectBehavior({
        action: "reveal_text",
        content: "You find 30 gold pieces",
        playerTriggerable: true,
        triggerOnStepOn: true,
        triggered: true,
      })
    ).toEqual({
      action: "reveal_text",
      content: "You find 30 gold pieces",
      playerTriggerable: true,
      triggerOnStepOn: true,
      triggered: true,
    });
  });

  it("fails closed on malformed field types", () => {
    const behavior = parseMapObjectBehavior({
      action: "toggle_state",
      content: 42,
      playerTriggerable: "yes",
      triggerOnStepOn: "yes",
      triggered: "true",
    });
    expect(behavior).toEqual({
      action: "toggle_state",
      content: null,
      playerTriggerable: false,
      triggerOnStepOn: false,
      triggered: false,
    });
  });

  it("defaults triggerOnStepOn to false when omitted (every object placed before Map Editor Batch A6)", () => {
    expect(
      parseMapObjectBehavior({ action: "toggle_state", triggered: true })?.triggerOnStepOn
    ).toBe(false);
  });
});

describe("parseObjectMovementConfig", () => {
  it("defaults standable to false on the column default ({}) — every object placed before this feature", () => {
    expect(parseObjectMovementConfig({}).standable).toBe(false);
  });

  it("parses standable: true", () => {
    expect(parseObjectMovementConfig({ standable: true }).standable).toBe(true);
  });

  it("fails closed on a non-boolean standable value, same posture as blocksMovement/requiredCheck", () => {
    expect(parseObjectMovementConfig({ standable: "yes" }).standable).toBe(false);
    expect(parseObjectMovementConfig({ standable: 1 }).standable).toBe(false);
  });

  it("standable is fully independent of blocksMovement — every combination is representable, neither implies the other", () => {
    expect(parseObjectMovementConfig({ standable: true, blocksMovement: true })).toEqual({
      standable: true,
      blocksMovement: true,
      requiredCheck: null,
    });
    expect(parseObjectMovementConfig({ standable: true, blocksMovement: false })).toEqual({
      standable: true,
      blocksMovement: false,
      requiredCheck: null,
    });
    expect(parseObjectMovementConfig({ standable: false, blocksMovement: true })).toEqual({
      standable: false,
      blocksMovement: true,
      requiredCheck: null,
    });
  });
});
