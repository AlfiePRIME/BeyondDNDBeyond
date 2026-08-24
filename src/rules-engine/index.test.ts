import { describe, expect, it } from "vitest";
import { MODULE_NAME } from "@/rules-engine";

describe("rules-engine module", () => {
  it("is independently importable and testable", () => {
    expect(MODULE_NAME).toBe("rules-engine");
  });
});
