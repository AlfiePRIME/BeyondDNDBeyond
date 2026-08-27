import { describe, expect, it } from "vitest";
import { MAP_OBJECT_ACTIONS, parseMapObjectBehavior } from "./mapObjects";

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
