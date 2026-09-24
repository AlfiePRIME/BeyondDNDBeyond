import { describe, expect, it } from "vitest";
import {
  mergeAppliedConditions,
  selfConditionRollEffects,
  targetConditionAttackEffects,
  type AppliedCondition,
} from "./conditionRollEffects";

const on = (key: string): AppliedCondition => ({ condition_key: key, level: null });
const exhaustion = (level: number): AppliedCondition => ({ condition_key: "exhaustion", level });

describe("mergeAppliedConditions", () => {
  it("unions by key and keeps the higher exhaustion level", () => {
    const merged = mergeAppliedConditions(
      [on("poisoned"), exhaustion(1)],
      [on("poisoned"), on("prone"), exhaustion(3)]
    );
    expect(merged.map((c) => c.condition_key).sort()).toEqual(["exhaustion", "poisoned", "prone"]);
    expect(merged.find((c) => c.condition_key === "exhaustion")?.level).toBe(3);
  });
});

describe("selfConditionRollEffects", () => {
  it("gives a poisoned attacker disadvantage and an invisible one advantage", () => {
    expect(selfConditionRollEffects([on("poisoned")], "attack").disadvantageSources).toEqual([
      "attacker is Poisoned",
    ]);
    expect(selfConditionRollEffects([on("invisible")], "attack").advantageSources).toEqual([
      "attacker is Invisible",
    ]);
  });

  it("applies prone/restrained/blinded/frightened attacker disadvantage", () => {
    for (const key of ["prone", "restrained", "blinded", "frightened"]) {
      expect(selfConditionRollEffects([on(key)], "attack").disadvantageSources, key).toHaveLength(1);
    }
  });

  it("gives ability checks disadvantage from poisoned and exhaustion 1+", () => {
    expect(selfConditionRollEffects([on("poisoned")], "ability_check").disadvantageSources).toEqual([
      "Poisoned",
    ]);
    expect(selfConditionRollEffects([exhaustion(1)], "ability_check").disadvantageSources).toEqual([
      "Exhaustion (level 1)",
    ]);
    // Poisoned doesn't touch saves.
    expect(
      selfConditionRollEffects([on("poisoned")], "saving_throw", "constitution").disadvantageSources
    ).toEqual([]);
  });

  it("applies exhaustion 3+ to attacks and saves but not below", () => {
    expect(selfConditionRollEffects([exhaustion(2)], "attack").disadvantageSources).toEqual([]);
    expect(
      selfConditionRollEffects([exhaustion(2)], "saving_throw", "wisdom").disadvantageSources
    ).toEqual([]);
    expect(selfConditionRollEffects([exhaustion(3)], "attack").disadvantageSources).toEqual([
      "attacker is Exhaustion (level 3)",
    ]);
    expect(
      selfConditionRollEffects([exhaustion(3)], "saving_throw", "wisdom").disadvantageSources
    ).toEqual(["Exhaustion (level 3)"]);
  });

  it("gives restrained disadvantage on Dexterity saves only", () => {
    expect(
      selfConditionRollEffects([on("restrained")], "saving_throw", "dexterity").disadvantageSources
    ).toEqual(["Restrained"]);
    expect(
      selfConditionRollEffects([on("restrained")], "saving_throw", "strength").disadvantageSources
    ).toEqual([]);
  });

  it("auto-fails Strength and Dexterity saves while paralyzed/stunned/unconscious/petrified", () => {
    for (const key of ["paralyzed", "stunned", "unconscious", "petrified"]) {
      expect(
        selfConditionRollEffects([on(key)], "saving_throw", "strength").autoFailReason,
        key
      ).toMatch(/automatically fails/);
      expect(
        selfConditionRollEffects([on(key)], "saving_throw", "dexterity").autoFailReason,
        key
      ).not.toBeNull();
      expect(
        selfConditionRollEffects([on(key)], "saving_throw", "wisdom").autoFailReason,
        key
      ).toBeNull();
    }
    expect(
      selfConditionRollEffects([on("poisoned")], "saving_throw", "strength").autoFailReason
    ).toBeNull();
  });

  it("ignores unknown keys and exhaustion level 0", () => {
    const effects = selfConditionRollEffects([on("bogus"), exhaustion(0)], "ability_check");
    expect(effects).toEqual({ advantageSources: [], disadvantageSources: [], autoFailReason: null });
  });
});

describe("targetConditionAttackEffects", () => {
  it("reports the flat attacks-against flags regardless of distance", () => {
    expect(targetConditionAttackEffects([on("blinded")], null).advantageSources).toEqual([
      "target has Blinded (advantage against)",
    ]);
    expect(targetConditionAttackEffects([on("invisible")], 30).disadvantageSources).toEqual([
      "target has Invisible (disadvantage against)",
    ]);
  });

  it("splits prone by range: advantage within 5 ft, disadvantage beyond", () => {
    expect(targetConditionAttackEffects([on("prone")], 5).advantageSources).toHaveLength(1);
    expect(targetConditionAttackEffects([on("prone")], 5).disadvantageSources).toHaveLength(0);
    expect(targetConditionAttackEffects([on("prone")], 10).disadvantageSources).toHaveLength(1);
    expect(targetConditionAttackEffects([on("prone")], 10).advantageSources).toHaveLength(0);
    // Unknown distance: no range-dependent source either way.
    const unknown = targetConditionAttackEffects([on("prone")], null);
    expect(unknown.advantageSources.length + unknown.disadvantageSources.length).toBe(0);
  });

  it("makes hits on a paralyzed or unconscious target within 5 ft critical", () => {
    for (const key of ["paralyzed", "unconscious"]) {
      expect(targetConditionAttackEffects([on(key)], 5).autoCriticalReason, key).toMatch(/critical/);
      expect(targetConditionAttackEffects([on(key)], 10).autoCriticalReason, key).toBeNull();
      expect(targetConditionAttackEffects([on(key)], null).autoCriticalReason, key).toBeNull();
    }
    expect(targetConditionAttackEffects([on("stunned")], 5).autoCriticalReason).toBeNull();
  });
});
