import { describe, expect, it } from "vitest";
import { MODULE_NAME, joinCampaignChannel } from "@/realtime";

describe("realtime module", () => {
  it("is independently importable and testable", () => {
    expect(MODULE_NAME).toBe("realtime");
  });

  it("exports the campaign channel factory from the main barrel", () => {
    expect(joinCampaignChannel).toBeTypeOf("function");
  });
});
