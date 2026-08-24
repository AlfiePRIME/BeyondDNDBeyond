import { describe, expect, it } from "vitest";
import { MODULE_NAME } from "@/realtime";

describe("realtime module", () => {
  it("is independently importable and testable", () => {
    expect(MODULE_NAME).toBe("realtime");
  });
});
