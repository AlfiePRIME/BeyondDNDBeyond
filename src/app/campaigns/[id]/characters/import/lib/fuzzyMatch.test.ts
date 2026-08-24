import { describe, expect, it } from "vitest";
import { bestFuzzyMatch, similarity } from "./fuzzyMatch";

describe("similarity", () => {
  it("scores an exact match as 1", () => {
    expect(similarity("Dragonborn", "Dragonborn")).toBe(1);
  });

  it("is case- and punctuation-insensitive", () => {
    expect(similarity("dragonborn", "Dragonborn")).toBe(1);
    expect(similarity("Drag-on born!", "Dragonborn")).toBe(1);
  });

  it("tolerates a small OCR misread", () => {
    // real OCR output seen against the sample PDF's Dragonborn field
    expect(similarity("Dragon porn", "Dragonborn")).toBeGreaterThan(0.85);
  });

  it("scores unrelated strings low", () => {
    expect(similarity("Wizard", "Dragonborn")).toBeLessThan(0.3);
  });
});

describe("bestFuzzyMatch", () => {
  const races = ["Human", "Elf", "Dwarf", "Dragonborn", "Tiefling"];

  it("finds the right option despite OCR noise", () => {
    expect(bestFuzzyMatch("Dragon porn", races)).toBe("Dragonborn");
  });

  it("returns null when nothing clears the threshold", () => {
    expect(bestFuzzyMatch("xyzzy plugh", races)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(bestFuzzyMatch("", races)).toBeNull();
  });
});
