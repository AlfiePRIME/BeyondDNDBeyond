import { describe, expect, it } from "vitest";
import { thumbnailCellColor } from "./thumbnail";

// Expected values independently cross-checked against MapSurface.tsx's real
// cellColor (three.js Color.lerp, linear-working-color-space) for every
// elevation step on both terrain types — see the review notes for Prompt 39.
// Locking these in guards against the two implementations silently drifting
// apart, since nothing else would catch that (they're deliberately not
// sharing code — see thumbnail.ts's header comment for why).
describe("thumbnailCellColor", () => {
  it("matches MapSurface's cellColor exactly for normal terrain at every elevation step", () => {
    expect(thumbnailCellColor("normal", 0)).toBe("#463a70");
    expect(thumbnailCellColor("normal", 1)).toBe("#62588a");
    expect(thumbnailCellColor("normal", 2)).toBe("#776e9f");
    expect(thumbnailCellColor("normal", 3)).toBe("#887fb1");
    expect(thumbnailCellColor("normal", 4)).toBe("#978dc1");
    expect(thumbnailCellColor("normal", 5)).toBe("#a49acf");
    expect(thumbnailCellColor("normal", 6)).toBe("#b0a5dc");
    // Elevation's contribution is capped (min(elevation*0.11, 0.66)) — steps
    // 6 and up are indistinguishable by design, matching cellColor exactly.
    expect(thumbnailCellColor("normal", 10)).toBe("#b0a5dc");
  });

  it("paints a void cell as the backdrop — absent, like the space around the map", () => {
    // tokens.css --surface, the BACKDROP constant renderMapThumbnail clears
    // the canvas with: a void cell is indistinguishable from no cell at all.
    expect(thumbnailCellColor("void", 0)).toBe("#060012");
    // Elevation never lightens a cell with no floor.
    expect(thumbnailCellColor("void", 5)).toBe("#060012");
    expect(thumbnailCellColor("void", 10)).toBe("#060012");
  });

  it("matches MapSurface's cellColor exactly for difficult terrain at every elevation step", () => {
    expect(thumbnailCellColor("difficult", 0)).toBe("#a85a24");
    expect(thumbnailCellColor("difficult", 1)).toBe("#b47242");
    expect(thumbnailCellColor("difficult", 2)).toBe("#c08455");
    expect(thumbnailCellColor("difficult", 3)).toBe("#ca9464");
    expect(thumbnailCellColor("difficult", 4)).toBe("#d4a271");
    expect(thumbnailCellColor("difficult", 5)).toBe("#ddaf7c");
    expect(thumbnailCellColor("difficult", 6)).toBe("#e6ba86");
    expect(thumbnailCellColor("difficult", 10)).toBe("#e6ba86");
  });

  it("paints a pit at its own flat base color regardless of (possibly negative) depth", () => {
    // Unlike normal/difficult, a pit's elevation is a floor height, not
    // "how high up" — the lightening axis is clamped at 0 (Math.max), so
    // every depth reads identically, matching MapSurface's own cellColor.
    expect(thumbnailCellColor("pit", 0)).toBe("#140f0c");
    expect(thumbnailCellColor("pit", -1)).toBe("#140f0c");
    expect(thumbnailCellColor("pit", -40)).toBe("#140f0c");
  });
});
