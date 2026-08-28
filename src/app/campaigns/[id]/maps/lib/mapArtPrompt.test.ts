import { describe, expect, it } from "vitest";
import { DEFAULT_CELL, type CellState } from "../[mapId]/edit/lib/cellGrid";
import { buildMapArtPrompt } from "./mapArtPrompt";

function cell(overrides: Partial<CellState> = {}): CellState {
  return { ...DEFAULT_CELL, ...overrides };
}

describe("buildMapArtPrompt", () => {
  it("only mentions categories actually present in the grid", () => {
    const overlay = new Map<string, CellState>([
      ["0,0", cell({ terrain: "void" })],
      ["1,0", cell({ ground: "water" })],
    ]);
    const prompt = buildMapArtPrompt(2, 1, overlay, DEFAULT_CELL);
    expect(prompt).toContain("stone walls");
    expect(prompt).toContain("water");
    expect(prompt).not.toContain("sandy ground");
    expect(prompt).not.toContain("forest tree canopy");
  });

  it("includes plain floor (normal) when the default cell is used anywhere", () => {
    const prompt = buildMapArtPrompt(1, 1, new Map(), DEFAULT_CELL);
    expect(prompt).toContain("plain unadorned floor");
  });

  it("asserts the reference image IS the map and forbids rearranging it (the live-tested wording fix)", () => {
    const prompt = buildMapArtPrompt(1, 1, new Map(), DEFAULT_CELL);
    expect(prompt).toMatch(/IS the top-down floorplan/);
    expect(prompt).toMatch(/do not redesign, rearrange, resize, duplicate, or tile/);
  });

  it("always includes the elevation note", () => {
    const prompt = buildMapArtPrompt(1, 1, new Map(), DEFAULT_CELL);
    expect(prompt).toContain("raised higher");
  });

  it("uses the DM's own style note when given one, trimmed", () => {
    const prompt = buildMapArtPrompt(1, 1, new Map(), DEFAULT_CELL, "  a moody watercolor style  ");
    expect(prompt.trim().endsWith("a moody watercolor style")).toBe(true);
  });

  it("falls back to the generic closing instruction when no style note is given", () => {
    const promptUndefined = buildMapArtPrompt(1, 1, new Map(), DEFAULT_CELL, undefined);
    const promptBlank = buildMapArtPrompt(1, 1, new Map(), DEFAULT_CELL, "   ");
    expect(promptUndefined).toContain("Render with realistic top-down textures");
    expect(promptBlank).toContain("Render with realistic top-down textures");
  });

  it("orders the legend with structural elements before decorative ground dressing", () => {
    const overlay = new Map<string, CellState>([
      ["0,0", cell({ terrain: "void" })],
      ["1,0", cell({ ground: "grass" })],
      ["2,0", cell({ terrain: "difficult" })],
    ]);
    const prompt = buildMapArtPrompt(3, 1, overlay, DEFAULT_CELL);
    const wallsIndex = prompt.indexOf("stone walls");
    const hazardIndex = prompt.indexOf("rubble/hazard");
    const grassIndex = prompt.indexOf("open grass");
    expect(wallsIndex).toBeGreaterThan(-1);
    expect(hazardIndex).toBeGreaterThan(-1);
    expect(grassIndex).toBeGreaterThan(-1);
    expect(wallsIndex).toBeLessThan(hazardIndex);
    expect(hazardIndex).toBeLessThan(grassIndex);
  });
});
