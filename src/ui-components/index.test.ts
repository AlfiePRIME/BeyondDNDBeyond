import { describe, expect, it } from "vitest";
import { MODULE_NAME } from "@/ui-components";

describe("ui-components module", () => {
  it("is independently importable and testable", () => {
    expect(MODULE_NAME).toBe("ui-components");
  });
});
