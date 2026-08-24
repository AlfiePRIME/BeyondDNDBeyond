import { describe, expect, it } from "vitest";
import { MODULE_NAME } from "@/scene-3d";

describe("scene-3d module", () => {
  it("is independently importable and testable", () => {
    expect(MODULE_NAME).toBe("scene-3d");
  });
});
