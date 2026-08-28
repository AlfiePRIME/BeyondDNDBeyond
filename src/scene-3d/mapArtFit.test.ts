import { describe, expect, it } from "vitest";
import { computeMapArtFit } from "./mapArtFit";

describe("computeMapArtFit", () => {
  it("spans the grid exactly on both axes when the art's aspect ratio already matches the grid's", () => {
    const { planeWidth, planeHeight } = computeMapArtFit(10, 8, 1, 1000, 800);
    expect(planeWidth).toBeCloseTo(10, 5);
    expect(planeHeight).toBeCloseTo(8, 5);
  });

  it("contain-fits a square image onto a wider-than-tall grid, letterboxing the tighter (width) axis", () => {
    const { planeWidth, planeHeight } = computeMapArtFit(10, 8, 1, 1024, 1024);
    expect(planeHeight).toBeCloseTo(8, 5);
    expect(planeWidth).toBeCloseTo(8, 5); // square image, so width == height once fit
    expect(planeWidth).toBeLessThan(10);
  });

  it("contain-fits a wide image onto a taller-than-wide grid, letterboxing height", () => {
    const { planeWidth, planeHeight } = computeMapArtFit(6, 12, 1, 1200, 600);
    expect(planeWidth).toBeCloseTo(6, 5);
    expect(planeHeight).toBeCloseTo(3, 5);
    expect(planeHeight).toBeLessThan(12);
  });

  it("scales uniformly with cellSize — the game table's own fitted metrics, not the editor's fixed 1-unit cells", () => {
    const unit = computeMapArtFit(10, 8, 1, 1000, 800);
    const fitted = computeMapArtFit(10, 8, 2.5, 1000, 800);
    expect(fitted.planeWidth).toBeCloseTo(unit.planeWidth * 2.5, 5);
    expect(fitted.planeHeight).toBeCloseTo(unit.planeHeight * 2.5, 5);
  });

  it("tolerates a real-world near-but-not-exact aspect mismatch (renderMapArtControlImage's round-up-to-16 rounding)", () => {
    // A 20x15 grid targeting TARGET_LONG_EDGE rounds to e.g. 1024x784 rather
    // than a perfect 20:15 ratio — contain-fit must still produce a plane
    // that fits entirely within the grid footprint on both axes.
    const { planeWidth, planeHeight } = computeMapArtFit(20, 15, 1, 1024, 784);
    expect(planeWidth).toBeLessThanOrEqual(20 + 1e-9);
    expect(planeHeight).toBeLessThanOrEqual(15 + 1e-9);
    // One axis reaches the grid's own footprint exactly (the tighter one).
    expect(Math.min(20 - planeWidth, 15 - planeHeight)).toBeCloseTo(0, 5);
  });
});
