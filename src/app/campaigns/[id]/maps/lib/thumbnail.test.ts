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

  // Ground type (the post-roadmap addition) is omittable/"default" — a
  // third argument that defaults to "default" for every pre-existing call
  // site above, none of which needed to change. These lock in the eight
  // real ground types' own base/high pairs, independently cross-checked
  // against MapSurface.tsx's real cellColor (three.js Color.lerp) the exact
  // way the terrain cases above are, so the two stay pixel-identical.
  it("a 'default' or omitted ground type falls back to the terrain-driven palette — no change from before ground types existed", () => {
    expect(thumbnailCellColor("normal", 3, "default")).toBe(thumbnailCellColor("normal", 3));
    expect(thumbnailCellColor("difficult", 3, "default")).toBe(thumbnailCellColor("difficult", 3));
  });

  it("matches MapSurface's cellColor exactly for every real ground type, overriding terrain's palette", () => {
    expect(thumbnailCellColor("normal", 0, "grass")).toBe("#3d6b2f");
    expect(thumbnailCellColor("normal", 1, "grass")).toBe("#577f41");
    expect(thumbnailCellColor("normal", 3, "grass")).toBe("#789f5a");
    expect(thumbnailCellColor("normal", 10, "grass")).toBe("#9cc275");
    // Ground type wins over terrain's own palette — a DIFFICULT cell
    // painted grass still renders grass, not the amber difficult pair.
    expect(thumbnailCellColor("difficult", 0, "grass")).toBe("#3d6b2f");

    expect(thumbnailCellColor("normal", 0, "forest")).toBe("#204a2c");
    expect(thumbnailCellColor("normal", 3, "forest")).toBe("#4d7a52");
    expect(thumbnailCellColor("normal", 10, "forest")).toBe("#679969");

    expect(thumbnailCellColor("normal", 0, "dense_forest")).toBe("#122c19");
    expect(thumbnailCellColor("normal", 3, "dense_forest")).toBe("#2d5031");
    expect(thumbnailCellColor("normal", 10, "dense_forest")).toBe("#3d6741");

    expect(thumbnailCellColor("normal", 0, "rock")).toBe("#8a6f47");
    expect(thumbnailCellColor("normal", 3, "rock")).toBe("#a9926c");
    expect(thumbnailCellColor("normal", 10, "rock")).toBe("#c2ac85");

    expect(thumbnailCellColor("normal", 0, "stone")).toBe("#4a5a6e");
    expect(thumbnailCellColor("normal", 3, "stone")).toBe("#838d9b");
    expect(thumbnailCellColor("normal", 10, "stone")).toBe("#a6b0bb");

    expect(thumbnailCellColor("normal", 0, "path")).toBe("#7a5c3a");
    expect(thumbnailCellColor("normal", 3, "path")).toBe("#a2845d");
    expect(thumbnailCellColor("normal", 10, "path")).toBe("#c0a175");

    expect(thumbnailCellColor("normal", 0, "sand")).toBe("#c8b06a");
    expect(thumbnailCellColor("normal", 3, "sand")).toBe("#d7c48d");
    expect(thumbnailCellColor("normal", 10, "sand")).toBe("#e6d6a7");

    expect(thumbnailCellColor("normal", 0, "swamp")).toBe("#414a2c");
    expect(thumbnailCellColor("normal", 3, "swamp")).toBe("#616c40");
    expect(thumbnailCellColor("normal", 10, "swamp")).toBe("#78854e");

    // Water (the water-terrain addition) — values independently computed
    // from three.js's real Color.lerp against the same base/high pair
    // MapSurface's GROUND_COLORS.water uses, the identical cross-check
    // method every other entry above already relies on.
    expect(thumbnailCellColor("normal", 0, "water")).toBe("#155377");
    expect(thumbnailCellColor("normal", 1, "water")).toBe("#306f8b");
    expect(thumbnailCellColor("normal", 3, "water")).toBe("#4d96ac");
    expect(thumbnailCellColor("normal", 10, "water")).toBe("#69bfd1");
    // Ground type wins over terrain's own palette here too — a DIFFICULT
    // water cell (the exact combination water's own movement-cost design
    // relies on) still renders water, not the amber difficult pair.
    expect(thumbnailCellColor("difficult", 0, "water")).toBe("#155377");
  });

  it("a void cell paints as the backdrop regardless of ground type — no floor, no color", () => {
    expect(thumbnailCellColor("void", 0, "grass")).toBe("#060012");
    expect(thumbnailCellColor("void", 5, "stone")).toBe("#060012");
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
