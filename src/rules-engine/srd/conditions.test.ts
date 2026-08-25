import { describe, expect, it } from "vitest";
import {
  CONDITIONS,
  CONDITION_BY_KEY,
  EXHAUSTION_KEY,
  EXHAUSTION_LEVEL_DESCRIPTIONS,
  MAX_EXHAUSTION_LEVEL,
  exhaustionEffects,
} from "./conditions";
import type { ConditionEffects } from "./types";

describe("CONDITIONS", () => {
  it("covers exactly the 14 on/off SRD conditions, without exhaustion", () => {
    expect(CONDITIONS.map((c) => c.key).sort()).toEqual([
      "blinded",
      "charmed",
      "deafened",
      "frightened",
      "grappled",
      "incapacitated",
      "invisible",
      "paralyzed",
      "petrified",
      "poisoned",
      "prone",
      "restrained",
      "stunned",
      "unconscious",
    ]);
    expect(CONDITIONS.some((c) => (c.key as string) === EXHAUSTION_KEY)).toBe(false);
  });

  it("gives every condition a unique badge abbreviation", () => {
    const abbreviations = CONDITIONS.map((c) => c.abbreviation);
    expect(new Set(abbreviations).size).toBe(CONDITIONS.length);
    for (const abbreviation of abbreviations) expect(abbreviation).toMatch(/^[A-Z]{2}$/);
  });

  it("marks the four fully-disabling conditions with the SRD's shared trio", () => {
    // Paralyzed, petrified, stunned, and unconscious all read "incapacitated",
    // "automatically fails Strength and Dexterity saving throws", and
    // "attack rolls against the creature have advantage" in the SRD.
    for (const key of ["paralyzed", "petrified", "stunned", "unconscious"] as const) {
      const effects = CONDITION_BY_KEY.get(key)?.effects;
      expect(effects?.incapacitated, key).toBe(true);
      expect(effects?.autoFailStrDexSaves, key).toBe(true);
      expect(effects?.attacksAgainstHaveAdvantage, key).toBe(true);
      expect(effects?.speedZero, key).toBe(true);
    }
  });

  it("flags blinded as vision-blocking for the perception engine", () => {
    const blinded = CONDITION_BY_KEY.get("blinded")?.effects;
    expect(blinded?.blocksVision).toBe(true);
    expect(blinded?.attacksAgainstHaveAdvantage).toBe(true);
    expect(blinded?.ownAttacksHaveDisadvantage).toBe(true);
  });

  it("marks the unaware conditions as blocking both senses", () => {
    for (const key of ["petrified", "unconscious"] as const) {
      const effects = CONDITION_BY_KEY.get(key)?.effects;
      expect(effects?.blocksVision, key).toBe(true);
      expect(effects?.blocksHearing, key).toBe(true);
    }
    expect(CONDITION_BY_KEY.get("deafened")?.effects.blocksHearing).toBe(true);
    expect(CONDITION_BY_KEY.get("deafened")?.effects.blocksVision).toBe(false);
  });

  it("flags invisible as hidden with the attack-roll pair swapped", () => {
    const invisible = CONDITION_BY_KEY.get("invisible")?.effects;
    expect(invisible?.hiddenFromSight).toBe(true);
    expect(invisible?.attacksAgainstHaveDisadvantage).toBe(true);
    expect(invisible?.ownAttacksHaveAdvantage).toBe(true);
  });

  it("zeroes speed for grappled and restrained, halves it for prone", () => {
    expect(CONDITION_BY_KEY.get("grappled")?.effects.speedZero).toBe(true);
    expect(CONDITION_BY_KEY.get("restrained")?.effects.speedZero).toBe(true);
    expect(CONDITION_BY_KEY.get("prone")?.effects.speedHalved).toBe(true);
    expect(CONDITION_BY_KEY.get("prone")?.effects.speedZero).toBe(false);
  });

  it("leaves prone's range-dependent attacks-against split out of the flags", () => {
    const prone = CONDITION_BY_KEY.get("prone")?.effects;
    expect(prone?.attacksAgainstHaveAdvantage).toBe(false);
    expect(prone?.attacksAgainstHaveDisadvantage).toBe(false);
    expect(prone?.ownAttacksHaveDisadvantage).toBe(true);
  });

  it("gives poisoned and frightened attack and ability-check disadvantage", () => {
    for (const key of ["poisoned", "frightened"] as const) {
      const effects = CONDITION_BY_KEY.get(key)?.effects;
      expect(effects?.ownAttacksHaveDisadvantage, key).toBe(true);
      expect(effects?.abilityChecksHaveDisadvantage, key).toBe(true);
    }
  });
});

describe("exhaustionEffects", () => {
  it("matches the SRD's per-level additions", () => {
    expect(exhaustionEffects(1).abilityChecksHaveDisadvantage).toBe(true);
    expect(exhaustionEffects(1).speedHalved).toBe(false);
    expect(exhaustionEffects(2).speedHalved).toBe(true);
    expect(exhaustionEffects(2).ownAttacksHaveDisadvantage).toBe(false);
    expect(exhaustionEffects(3).ownAttacksHaveDisadvantage).toBe(true);
    expect(exhaustionEffects(3).savingThrowsHaveDisadvantage).toBe(true);
    expect(exhaustionEffects(4).speedZero).toBe(false);
    expect(exhaustionEffects(5).speedZero).toBe(true);
  });

  it("is cumulative — each level's flags are a superset of the level below", () => {
    for (let level = 2; level <= MAX_EXHAUSTION_LEVEL; level++) {
      const below = exhaustionEffects(level - 1);
      const current = exhaustionEffects(level);
      for (const flag of Object.keys(below) as (keyof ConditionEffects)[]) {
        if (below[flag]) expect(current[flag], `${flag} at level ${level}`).toBe(true);
      }
    }
  });

  it("has no active flags at level 0", () => {
    expect(Object.values(exhaustionEffects(0)).every((flag) => flag === false)).toBe(true);
  });

  it("describes every level through death at 6", () => {
    for (let level = 1; level <= MAX_EXHAUSTION_LEVEL; level++) {
      expect(EXHAUSTION_LEVEL_DESCRIPTIONS[level]).toBeTruthy();
    }
    expect(EXHAUSTION_LEVEL_DESCRIPTIONS[6]).toBe("Death.");
  });
});
