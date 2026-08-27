import { describe, expect, it } from "vitest";
import {
  curseBlessingToDraft,
  DEFAULT_CURSE_BLESSING_DRAFT,
  draftToCurseBlessing,
  isCurseBlessingDraftValid,
  type CurseBlessing,
  type CurseBlessingDraft,
} from "./mapObjectItems";

describe("draftToCurseBlessing", () => {
  it("returns null for a disabled draft, regardless of its other fields", () => {
    expect(draftToCurseBlessing({ ...DEFAULT_CURSE_BLESSING_DRAFT, enabled: false, kind: "cursed" })).toBeNull();
  });

  it("builds a narrative curse/blessing with a null effect", () => {
    expect(
      draftToCurseBlessing({
        ...DEFAULT_CURSE_BLESSING_DRAFT,
        enabled: true,
        kind: "blessed",
        resolution: "narrative",
        telegraphed: true,
      })
    ).toEqual({ kind: "blessed", resolution: "narrative", effect: null, telegraphed: true });
  });

  it("builds a mechanical hp_delta effect, parsing the string field to a number", () => {
    expect(
      draftToCurseBlessing({
        ...DEFAULT_CURSE_BLESSING_DRAFT,
        enabled: true,
        kind: "cursed",
        resolution: "mechanical",
        effectKind: "hp_delta",
        hpDelta: "-8",
      })
    ).toEqual({ kind: "cursed", resolution: "mechanical", effect: { kind: "hp_delta", delta: -8 }, telegraphed: false });
  });

  it("builds a mechanical condition effect", () => {
    expect(
      draftToCurseBlessing({
        ...DEFAULT_CURSE_BLESSING_DRAFT,
        enabled: true,
        resolution: "mechanical",
        effectKind: "condition",
        conditionKey: "poisoned",
      })
    ).toEqual({
      kind: "cursed",
      resolution: "mechanical",
      effect: { kind: "condition", conditionKey: "poisoned" },
      telegraphed: false,
    });
  });

  it("builds a mechanical resource_delta effect, trimming the resource name", () => {
    expect(
      draftToCurseBlessing({
        ...DEFAULT_CURSE_BLESSING_DRAFT,
        enabled: true,
        kind: "blessed",
        resolution: "mechanical",
        effectKind: "resource_delta",
        resourceName: "  Ki Points  ",
        resourceDelta: "2",
      })
    ).toEqual({
      kind: "blessed",
      resolution: "mechanical",
      effect: { kind: "resource_delta", resourceName: "Ki Points", delta: 2 },
      telegraphed: false,
    });
  });
});

describe("curseBlessingToDraft", () => {
  it("returns the default (disabled) draft for null", () => {
    expect(curseBlessingToDraft(null)).toEqual(DEFAULT_CURSE_BLESSING_DRAFT);
  });

  it("round-trips a narrative curse/blessing back through draftToCurseBlessing", () => {
    const original: CurseBlessing = { kind: "cursed", resolution: "narrative", effect: null, telegraphed: true };
    expect(draftToCurseBlessing(curseBlessingToDraft(original))).toEqual(original);
  });

  it("round-trips each mechanical effect kind back through draftToCurseBlessing", () => {
    const cases: CurseBlessing[] = [
      { kind: "cursed", resolution: "mechanical", effect: { kind: "hp_delta", delta: -5 }, telegraphed: false },
      {
        kind: "blessed",
        resolution: "mechanical",
        effect: { kind: "condition", conditionKey: "blinded" },
        telegraphed: true,
      },
      {
        kind: "cursed",
        resolution: "mechanical",
        effect: { kind: "resource_delta", resourceName: "Bardic Inspiration", delta: -1 },
        telegraphed: false,
      },
    ];
    for (const original of cases) {
      expect(draftToCurseBlessing(curseBlessingToDraft(original))).toEqual(original);
    }
  });
});

describe("isCurseBlessingDraftValid", () => {
  const base: CurseBlessingDraft = DEFAULT_CURSE_BLESSING_DRAFT;

  it("is always valid when disabled", () => {
    expect(isCurseBlessingDraftValid({ ...base, enabled: false, hpDelta: "not a number" })).toBe(true);
  });

  it("is always valid for narrative and condition-effect drafts", () => {
    expect(isCurseBlessingDraftValid({ ...base, enabled: true, resolution: "narrative" })).toBe(true);
    expect(
      isCurseBlessingDraftValid({ ...base, enabled: true, resolution: "mechanical", effectKind: "condition" })
    ).toBe(true);
  });

  it("rejects a blank or non-numeric hp_delta", () => {
    expect(
      isCurseBlessingDraftValid({ ...base, enabled: true, resolution: "mechanical", effectKind: "hp_delta", hpDelta: "" })
    ).toBe(false);
    expect(
      isCurseBlessingDraftValid({
        ...base,
        enabled: true,
        resolution: "mechanical",
        effectKind: "hp_delta",
        hpDelta: "abc",
      })
    ).toBe(false);
    expect(
      isCurseBlessingDraftValid({ ...base, enabled: true, resolution: "mechanical", effectKind: "hp_delta", hpDelta: "-3" })
    ).toBe(true);
  });

  it("rejects a resource_delta draft missing a resource name or a valid delta", () => {
    expect(
      isCurseBlessingDraftValid({
        ...base,
        enabled: true,
        resolution: "mechanical",
        effectKind: "resource_delta",
        resourceName: "  ",
        resourceDelta: "1",
      })
    ).toBe(false);
    expect(
      isCurseBlessingDraftValid({
        ...base,
        enabled: true,
        resolution: "mechanical",
        effectKind: "resource_delta",
        resourceName: "Ki Points",
        resourceDelta: "",
      })
    ).toBe(false);
    expect(
      isCurseBlessingDraftValid({
        ...base,
        enabled: true,
        resolution: "mechanical",
        effectKind: "resource_delta",
        resourceName: "Ki Points",
        resourceDelta: "-1",
      })
    ).toBe(true);
  });
});
