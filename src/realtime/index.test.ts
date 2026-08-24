import { describe, expect, it } from "vitest";
import { MODULE_NAME, joinCampaignChannel, joinLobbyChannel } from "@/realtime";

describe("realtime module", () => {
  it("is independently importable and testable", () => {
    expect(MODULE_NAME).toBe("realtime");
  });

  it("exports the campaign channel factory from the main barrel", () => {
    expect(joinCampaignChannel).toBeTypeOf("function");
  });

  it("exports the lobby channel factory from the main barrel", () => {
    expect(joinLobbyChannel).toBeTypeOf("function");
  });
});
