import { describe, expect, it } from "vitest";
import {
  cleanFreeText,
  extractBonus,
  extractClassAndLevel,
  extractFeet,
  extractFirstInt,
  matchRowsToOcrText,
  pickMostAlphabeticLine,
} from "./parseFields";

describe("extractFirstInt", () => {
  it("finds a digit run inside OCR noise", () => {
    expect(extractFirstInt("| 17 |")).toBe(17);
    expect(extractFirstInt("25")).toBe(25);
  });

  it("respects the max digit count", () => {
    expect(extractFirstInt("1,000", 2)).toBe(1);
  });

  it("returns null when there's nothing to find", () => {
    expect(extractFirstInt("no digits here")).toBeNull();
  });
});

describe("extractFeet", () => {
  it("reads the D&D Beyond speed format", () => {
    expect(extractFeet("30 ft. (Walking)")).toBe(30);
    expect(extractFeet("| 30 ft. (Walking)")).toBe(30);
  });

  it("returns null without a ft suffix", () => {
    expect(extractFeet("Walking")).toBeNull();
  });
});

describe("extractClassAndLevel", () => {
  it("splits a clean class + level banner value", () => {
    expect(extractClassAndLevel("Rogue 2")).toEqual({ classRaw: "Rogue", level: 2 });
  });

  it("tolerates surrounding OCR noise", () => {
    expect(extractClassAndLevel("| Rogue 2 i\n—_— =")).toEqual({ classRaw: "Rogue", level: 2 });
  });

  it("handles multi-word class-adjacent text and no gap before the digit", () => {
    expect(extractClassAndLevel("Eldritch Knight Fighter 5")).toMatchObject({ level: 5 });
  });

  it("returns null when there's no digit run", () => {
    expect(extractClassAndLevel("Rogue")).toBeNull();
  });
});

describe("pickMostAlphabeticLine / cleanFreeText", () => {
  it("picks the line with the most letters", () => {
    expect(pickMostAlphabeticLine("10DIN URMum |")).toBe("10DIN URMum");
  });

  it("prefers a real line over stray symbol noise", () => {
    expect(pickMostAlphabeticLine("TheFatherOfCommunism =\n---")).toBe("TheFatherOfCommunism");
  });

  it("strips characters outside the safe free-text set", () => {
    expect(cleanFreeText("Robin@@@ URMum###")).toBe("Robin URMum");
  });
});

describe("extractBonus", () => {
  it("defaults to positive when no sign is present", () => {
    expect(extractBonus("O +5 Dexterity")).toBe(5);
  });

  it("reads a negative bonus", () => {
    expect(extractBonus("O -1 Strength")).toBe(-1);
  });

  it("rejects implausibly large magnitudes", () => {
    expect(extractBonus("O 43 Something")).toBeNull();
  });

  it("returns null with no digits", () => {
    expect(extractBonus("no numbers")).toBeNull();
  });
});

describe("matchRowsToOcrText", () => {
  it("pairs names to the right line even with a stray extra line", () => {
    const ocrText = [
      "O +3 Acrobatics DEX",
      "P +3 Animal Handling WIS",
      "O +2 Arcana INT",
      "Standard Actions",
      "P +3 Persuasion CHA",
    ].join("\n");
    const rows = matchRowsToOcrText(["Acrobatics", "Animal Handling", "Arcana", "Persuasion"], ocrText);
    expect(rows).toEqual([
      { name: "Acrobatics", bonus: 3 },
      { name: "Animal Handling", bonus: 3 },
      { name: "Arcana", bonus: 2 },
      { name: "Persuasion", bonus: 3 },
    ]);
  });

  it("leaves a row's bonus null when no line matches confidently", () => {
    const rows = matchRowsToOcrText(["Stealth"], "complete garbage !!! ###");
    expect(rows).toEqual([{ name: "Stealth", bonus: null }]);
  });

  it("doesn't double-assign the same line to two names", () => {
    const ocrText = "O +3 Acrobatics DEX";
    const rows = matchRowsToOcrText(["Acrobatics", "Athletics"], ocrText);
    expect(rows[0]).toEqual({ name: "Acrobatics", bonus: 3 });
    expect(rows[1].bonus).toBeNull();
  });
});
