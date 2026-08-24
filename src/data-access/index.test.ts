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

  it("treats a profile with no display name as incomplete", () => {
    expect(isProfileComplete(null)).toBe(false);
    expect(isProfileComplete({ id: "x", display_name: null, avatar_source: null, avatar_ref: null, created_at: "" })).toBe(
      false
    );
    expect(isProfileComplete({ id: "x", display_name: "  ", avatar_source: null, avatar_ref: null, created_at: "" })).toBe(
      false
    );
  });

  it("treats a profile with a display name as complete", () => {
    expect(
      isProfileComplete({ id: "x", display_name: "Vex", avatar_source: null, avatar_ref: null, created_at: "" })
    ).toBe(true);
  });
});
