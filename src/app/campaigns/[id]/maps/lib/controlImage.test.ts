import { describe, expect, it } from "vitest";
import type { MapCell } from "@/data-access";
import { DEFAULT_CELL, overlayFromRows, type CellState } from "../[mapId]/edit/lib/cellGrid";
import {
  controlImageCategory,
  controlImageCellColor,
  renderMapArtControlImage,
  renderMapArtControlImagePng,
} from "./controlImage";

function cell(overrides: Partial<CellState> = {}): CellState {
  return { ...DEFAULT_CELL, ...overrides };
}

describe("controlImageCategory", () => {
  it("is void whenever terrain is void, regardless of ground or elevation", () => {
    expect(controlImageCategory(cell({ terrain: "void" }))).toBe("void");
    expect(controlImageCategory(cell({ terrain: "void", ground: "grass", elevation: 5 }))).toBe("void");
  });

  it("uses ground when it's not 'default', overriding terrain entirely", () => {
    expect(controlImageCategory(cell({ terrain: "normal", ground: "water" }))).toBe("water");
    // The exact combination water's own movement-cost design relies on: a
    // DIFFICULT water cell still renders as water, not the hazard hue.
    expect(controlImageCategory(cell({ terrain: "difficult", ground: "water" }))).toBe("water");
  });

  it("falls back to terrain (normal/difficult/pit) on default ground", () => {
    expect(controlImageCategory(cell({ terrain: "normal", ground: "default" }))).toBe("normal");
    expect(controlImageCategory(cell({ terrain: "difficult", ground: "default" }))).toBe("difficult");
    expect(controlImageCategory(cell({ terrain: "pit", ground: "default" }))).toBe("pit");
  });
});

// Expected RGB values independently computed from the same HSL formula
// controlImage.ts's hslToRgb implements, at the module's real
// HUE_BY_CATEGORY/SATURATION constants — the same "lock in independently
// cross-checked values" convention thumbnail.test.ts already uses for
// thumbnailCellColor, so a future accidental palette edit fails a test
// instead of silently shipping.
describe("controlImageCellColor", () => {
  it("paints void as flat near-black, regardless of elevation", () => {
    expect(controlImageCellColor(cell({ terrain: "void" }))).toEqual([10, 10, 10]);
    expect(controlImageCellColor(cell({ terrain: "void", elevation: 8 }))).toEqual([10, 10, 10]);
  });

  it("matches the tuned palette's isolated water hue (210deg) at elevation 0", () => {
    expect(controlImageCellColor(cell({ ground: "water" }))).toEqual([18, 102, 186]);
  });

  it("keeps water's hue at least 130 degrees from stone and 90 from pit — the live-tested fix", () => {
    // §5.3 of the research doc: this specific asymmetric spacing (not a
    // generic "more separation" rule) is what fixed a real water/stone
    // bleed bug found live against the ComfyUI instance. Locking in the
    // exact shipped values guards against silently drifting back toward
    // the even-spacing arrangement that caused it.
    expect(controlImageCellColor(cell({ ground: "stone" }))).toEqual([186, 18, 74]);
    expect(controlImageCellColor(cell({ terrain: "pit" }))).toEqual([186, 18, 186]);
  });

  it("matches the tuned palette for every real ground type at elevation 0", () => {
    expect(controlImageCellColor(cell({ ground: "grass" }))).toEqual([74, 186, 18]);
    expect(controlImageCellColor(cell({ ground: "rock" }))).toEqual([186, 74, 18]);
    expect(controlImageCellColor(cell({ ground: "forest" }))).toEqual([18, 186, 18]);
    expect(controlImageCellColor(cell({ ground: "dense_forest" }))).toEqual([18, 186, 74]);
    expect(controlImageCellColor(cell({ ground: "path" }))).toEqual([186, 130, 18]);
    expect(controlImageCellColor(cell({ ground: "sand" }))).toEqual([186, 186, 18]);
    expect(controlImageCellColor(cell({ ground: "swamp" }))).toEqual([130, 186, 18]);
    expect(controlImageCellColor(cell({ ground: "stone" }))).toEqual([186, 18, 74]);
  });

  it("matches the tuned palette for terrain-driven categories at elevation 0", () => {
    expect(controlImageCellColor(cell({ terrain: "normal", ground: "default" }))).toEqual([186, 18, 130]);
    expect(controlImageCellColor(cell({ terrain: "difficult" }))).toEqual([186, 18, 18]);
    expect(controlImageCellColor(cell({ terrain: "pit" }))).toEqual([186, 18, 186]);
  });

  it("bands elevation into 4 discrete lightness steps rather than a continuous lerp", () => {
    // forest's hue (120deg) used throughout — the exact band edges
    // (<=1, <=3, <=6, else) mirror the PoC's lightnessForElevation.
    expect(controlImageCellColor(cell({ ground: "forest", elevation: 0 }))).toEqual([18, 186, 18]);
    expect(controlImageCellColor(cell({ ground: "forest", elevation: 1 }))).toEqual([18, 186, 18]);
    expect(controlImageCellColor(cell({ ground: "forest", elevation: 2 }))).toEqual([32, 233, 32]);
    expect(controlImageCellColor(cell({ ground: "forest", elevation: 3 }))).toEqual([32, 233, 32]);
    expect(controlImageCellColor(cell({ ground: "forest", elevation: 4 }))).toEqual([88, 238, 88]);
    expect(controlImageCellColor(cell({ ground: "forest", elevation: 6 }))).toEqual([88, 238, 88]);
    expect(controlImageCellColor(cell({ ground: "forest", elevation: 7 }))).toEqual([144, 244, 144]);
    expect(controlImageCellColor(cell({ ground: "forest", elevation: 10 }))).toEqual([144, 244, 144]);
  });

  it("clamps a pit's negative elevation to the lowest band, same as thumbnailCellColor's clamp", () => {
    const flat = controlImageCellColor(cell({ terrain: "pit", elevation: 0 }));
    expect(controlImageCellColor(cell({ terrain: "pit", elevation: -1 }))).toEqual(flat);
    expect(controlImageCellColor(cell({ terrain: "pit", elevation: -40 }))).toEqual(flat);
  });

  it("ground overrides terrain's hazard color, mirroring thumbnailCellColor's own precedence", () => {
    const grassColor = controlImageCellColor(cell({ terrain: "normal", ground: "grass" }));
    expect(controlImageCellColor(cell({ terrain: "difficult", ground: "grass" }))).toEqual(grassColor);
  });

  it("water_flow_direction never affects color — purely decorative, per cellGrid.ts's own contract", () => {
    const south = controlImageCellColor(cell({ ground: "water", waterFlow: "south" }));
    const north = controlImageCellColor(cell({ ground: "water", waterFlow: "north" }));
    const none = controlImageCellColor(cell({ ground: "water", waterFlow: null }));
    expect(south).toEqual(north);
    expect(south).toEqual(none);
  });
});

describe("renderMapArtControlImage", () => {
  it("is deterministic — identical grid/overlay input produces byte-identical output", () => {
    const overlay = new Map<string, CellState>([
      ["2,2", cell({ ground: "water" })],
      ["5,5", cell({ terrain: "void" })],
    ]);
    const first = renderMapArtControlImage(16, 16, overlay);
    const second = renderMapArtControlImage(16, 16, overlay);
    expect(first.width).toBe(second.width);
    expect(first.height).toBe(second.height);
    expect(first.rgb.equals(second.rgb)).toBe(true);
  });

  it("sizes a square grid to exactly the 1024px target long edge (already a multiple of 16)", () => {
    const { width, height } = renderMapArtControlImage(16, 16, new Map());
    expect(width).toBe(1024);
    expect(height).toBe(1024);
  });

  it("rounds a non-square grid's dimensions up to a multiple of 16 — matches E1's real large-outdoor fixture", () => {
    // The research doc's own timing table (§8) records this exact
    // resolution (1008x672) for the 48x32 large-outdoor fixture — a
    // real, previously-observed value, not a newly invented expectation.
    const { width, height } = renderMapArtControlImage(48, 32, new Map());
    expect(width).toBe(1008);
    expect(height).toBe(672);
    expect(width % 16).toBe(0);
    expect(height % 16).toBe(0);
  });

  it("falls back to the provided default cell for any key missing from the sparse overlay", () => {
    const overlay = new Map<string, CellState>([["0,0", cell({ ground: "water" })]]);
    const { width, rgb } = renderMapArtControlImage(4, 4, overlay);
    const cellPx = width / 4;
    // A far corner cell absent from the overlay renders as DEFAULT_CELL's
    // own color (plain default-ground "normal" floor), not water.
    const offset = (3 * cellPx * width + 3 * cellPx) * 3;
    const expected = controlImageCellColor(DEFAULT_CELL);
    expect([rgb[offset], rgb[offset + 1], rgb[offset + 2]]).toEqual(expected);
  });

  it("leaves zero gap between same-category neighboring cells — a solid merged region", () => {
    // Every cell in a 4x4 grid painted the same non-default ground: the
    // entire canvas must be one uniform color, including exactly at each
    // internal cell boundary (thumbnail.ts's CELL_GAP_RATIO would leave a
    // backdrop-colored seam here; this renderer must not).
    const overlay = new Map<string, CellState>();
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) overlay.set(`${x},${y}`, cell({ ground: "sand" }));
    }
    const { width, height, rgb } = renderMapArtControlImage(4, 4, overlay);
    const expected = controlImageCellColor(cell({ ground: "sand" }));
    let uniform = true;
    for (let i = 0; i < width * height; i++) {
      const o = i * 3;
      if (rgb[o] !== expected[0] || rgb[o + 1] !== expected[1] || rgb[o + 2] !== expected[2]) {
        uniform = false;
        break;
      }
    }
    expect(uniform).toBe(true);
  });

  it("runs against a real MapCell[] row shape (listMapCells's own return type) via overlayFromRows without crashing", () => {
    // Exactly the shape listMapCells(supabase, mapId) resolves to — a
    // sparse, non-default-only row set — reconstructed into an overlay via
    // the app's own overlayFromRows, never a hand-built fixture shape.
    const rows: MapCell[] = [
      {
        map_id: "test-map",
        x: 0,
        y: 0,
        elevation: 0,
        terrain_type: "void",
        light_level: "bright",
        ground_type: "default",
        water_flow_direction: null,
      },
      {
        map_id: "test-map",
        x: 3,
        y: 2,
        elevation: 4,
        terrain_type: "normal",
        light_level: "dim",
        ground_type: "stone",
        water_flow_direction: null,
      },
      {
        map_id: "test-map",
        x: 5,
        y: 5,
        elevation: 0,
        terrain_type: "normal",
        light_level: "bright",
        ground_type: "water",
        water_flow_direction: "east",
      },
      {
        map_id: "test-map",
        x: 6,
        y: 6,
        elevation: -2,
        terrain_type: "pit",
        light_level: "dark",
        ground_type: "default",
        water_flow_direction: null,
      },
    ];
    const overlay = overlayFromRows(rows);

    expect(() => renderMapArtControlImage(16, 16, overlay)).not.toThrow();

    const { width, height, rgb } = renderMapArtControlImage(16, 16, overlay);
    expect(rgb.length).toBe(width * height * 3);

    const cellPx = width / 16;
    const colorAt = (gx: number, gy: number): [number, number, number] => {
      const offset = (gy * cellPx * width + gx * cellPx) * 3;
      return [rgb[offset], rgb[offset + 1], rgb[offset + 2]];
    };
    expect(colorAt(0, 0)).toEqual([10, 10, 10]); // void wall
    expect(colorAt(5, 5)).toEqual(controlImageCellColor(overlay.get("5,5")!)); // water
    expect(colorAt(6, 6)).toEqual(controlImageCellColor(overlay.get("6,6")!)); // pit, negative elevation
  });
});

describe("renderMapArtControlImagePng", () => {
  it("produces a real PNG (correct signature bytes and IHDR dimensions)", () => {
    const overlay = new Map<string, CellState>([["1,1", cell({ ground: "water" })]]);
    const png = renderMapArtControlImagePng(8, 8, overlay);

    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR chunk data starts right after an 8-byte signature, 4-byte
    // length, and 4-byte "IHDR" type — width/height are its first 8 bytes.
    const ihdrWidth = png.readUInt32BE(16);
    const ihdrHeight = png.readUInt32BE(20);
    const expectedDims = renderMapArtControlImage(8, 8, overlay);
    expect(ihdrWidth).toBe(expectedDims.width);
    expect(ihdrHeight).toBe(expectedDims.height);
  });

  it("is deterministic — identical input produces byte-identical PNG bytes", () => {
    const overlay = new Map<string, CellState>([["2,3", cell({ terrain: "difficult" })]]);
    const first = renderMapArtControlImagePng(10, 10, overlay);
    const second = renderMapArtControlImagePng(10, 10, overlay);
    expect(first.equals(second)).toBe(true);
  });
});
