import { describe, expect, it } from "vitest";
import {
  MAX_CHARACTER_LEVEL,
  XP_LEVEL_THRESHOLDS,
  levelForXp,
  xpThresholdForLevel,
  xpToNextLevel,
} from "./experience";

describe("XP_LEVEL_THRESHOLDS", () => {
  it("covers all 20 levels, strictly increasing from 0", () => {
    expect(XP_LEVEL_THRESHOLDS).toHaveLength(20);
    expect(XP_LEVEL_THRESHOLDS[0]).toBe(0);
    for (let i = 1; i < XP_LEVEL_THRESHOLDS.length; i++) {
      expect(XP_LEVEL_THRESHOLDS[i]).toBeGreaterThan(XP_LEVEL_THRESHOLDS[i - 1]);
    }
  });

  it("matches the SRD's published anchors", () => {
    expect(XP_LEVEL_THRESHOLDS[1]).toBe(300); // level 2
    expect(XP_LEVEL_THRESHOLDS[4]).toBe(6500); // level 5
    expect(XP_LEVEL_THRESHOLDS[10]).toBe(85000); // level 11
    expect(XP_LEVEL_THRESHOLDS[19]).toBe(355000); // level 20
  });
});

describe("levelForXp", () => {
  it("is level 1 at 0 XP", () => {
    expect(levelForXp(0)).toBe(1);
  });

  it("stays at the lower level just under a threshold", () => {
    expect(levelForXp(299)).toBe(1);
    expect(levelForXp(899)).toBe(2);
    expect(levelForXp(354999)).toBe(19);
  });

  it("advances exactly ON a threshold", () => {
    expect(levelForXp(300)).toBe(2);
    expect(levelForXp(900)).toBe(3);
    expect(levelForXp(6500)).toBe(5);
    expect(levelForXp(355000)).toBe(20);
  });

  it("caps at level 20 no matter how much XP piles up", () => {
    expect(levelForXp(355001)).toBe(20);
    expect(levelForXp(9999999)).toBe(20);
  });

  it("clamps a (DB-impossible) negative total to level 1", () => {
    expect(levelForXp(-50)).toBe(1);
  });
});

describe("xpThresholdForLevel", () => {
  it("returns each level's minimum total", () => {
    expect(xpThresholdForLevel(1)).toBe(0);
    expect(xpThresholdForLevel(2)).toBe(300);
    expect(xpThresholdForLevel(20)).toBe(355000);
  });

  it("clamps out-of-range levels into 1-20", () => {
    expect(xpThresholdForLevel(0)).toBe(0);
    expect(xpThresholdForLevel(25)).toBe(355000);
  });
});

describe("xpToNextLevel", () => {
  it("reports the next threshold and the remaining gap", () => {
    expect(xpToNextLevel(0, 1)).toEqual({ nextLevel: 2, threshold: 300, remaining: 300 });
    expect(xpToNextLevel(250, 1)).toEqual({ nextLevel: 2, threshold: 300, remaining: 50 });
  });

  it("reports 0 remaining once the threshold is met but the level not yet taken (suggest-then-confirm)", () => {
    expect(xpToNextLevel(300, 1)).toEqual({ nextLevel: 2, threshold: 300, remaining: 0 });
    expect(xpToNextLevel(5000, 3)).toEqual({ nextLevel: 4, threshold: 2700, remaining: 0 });
  });

  it("is null at the level 20 cap", () => {
    expect(xpToNextLevel(355000, MAX_CHARACTER_LEVEL)).toBeNull();
    expect(xpToNextLevel(0, 20)).toBeNull();
  });
});
