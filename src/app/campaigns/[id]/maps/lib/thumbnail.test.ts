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
});
