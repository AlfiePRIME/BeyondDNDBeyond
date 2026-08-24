import { describe, expect, it } from "vitest";
import { MODULE_NAME } from "@/data-access";

describe("data-access module", () => {
  it("is independently importable and testable", () => {
    expect(MODULE_NAME).toBe("data-access");
  });
});
