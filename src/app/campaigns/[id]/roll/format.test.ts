import { describe, expect, it } from "vitest";
import type { AttackResolution, RollLogEntry } from "@/data-access";
import { advantageReasonText, attackOutcomeText, rollHeadline } from "./format";

function entry(breakdown: RollLogEntry["breakdown"], total = 12): RollLogEntry {
  return {
    id: "r1",
    campaign_id: "c1",
    roller_user_id: "u1",
    character_id: null,
    kind: "save",
    breakdown,
    total,
    visibility: "public",
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("rollHeadline", () => {
  it("states an automatic failure instead of the total", () => {
    const headline = rollHeadline(
      entry({
        type: "d20",
        label: "Dexterity save",
        mode: "normal",
        d20Rolls: [18],
        d20Result: 18,
        modifiers: [],
        autoFailReason: "Paralyzed — automatically fails Strength and Dexterity saves",
      })
    );
    expect(headline).toBe(
      "Dexterity save — automatic failure (Paralyzed — automatically fails Strength and Dexterity saves)"
    );
  });
});

describe("advantageReasonText", () => {
  it("reads a non-attack breakdown's sources", () => {
    expect(advantageReasonText({ disadvantageSources: ["Poisoned"], advantageSources: [] })).toBe(
      "Disadvantage — Poisoned"
    );
  });

  it("appends an auto-crit reason", () => {
    expect(
      advantageReasonText({
        advantageSources: ["target has Paralyzed (advantage against)"],
        disadvantageSources: [],
        autoCriticalReason: "target has Paralyzed (hit within 5 ft is a critical hit)",
      })
    ).toBe(
      "Advantage — target has Paralyzed (advantage against) · Critical — target has Paralyzed (hit within 5 ft is a critical hit)"
    );
  });
});

describe("attackOutcomeText", () => {
  it("labels a non-natural critical hit", () => {
    const attack = { natural20: false, natural1: false, hit: true, critical: true } as AttackResolution;
    expect(attackOutcomeText(attack)).toBe("Critical hit");
  });
});
