// Two synthetic test maps for the E1 research spike, standing in for real
// campaign data (none is available in this environment). Built as sparse
// MapCell[] rows — the real storage shape (src/data-access/maps.ts) — per
// the sparse-storage convention every real map already uses: only
// non-default cells are listed, and a void border/background is filled in
// explicitly (a fresh map has no rows at all, which defaults to open normal
// floor everywhere, not walls — these fixtures paint void deliberately to
// get walls/chasms, exactly like a DM would with the void terrain brush).
//
// Both fixtures deliberately exercise water, elevation, and walls (void)
// per the E1 brief: SMALL_MAP is a single bounded room, LARGE_MAP mixes
// outdoor ground types with a carved dungeon room and a lake.
import { cell } from "./mapShapes.mjs";

function filled(width, height, factory) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const built = factory(x, y);
      if (built) rows.push(cell(x, y, built));
    }
  }
  return rows;
}

function distance(x, y, cx, cy) {
  return Math.hypot(x - cx, y - cy);
}

// --- SMALL_MAP: a 16x16 single stone room -----------------------------
// Walled on all sides (void), a raised dais in the NE corner, a water pool
// in the SW corner, a rubble patch (difficult terrain) in the middle, a
// pit near the east wall, and a dirt path leading in through a south
// doorway gap in the wall.
export const SMALL_MAP = {
  name: "small-room",
  gridWidth: 16,
  gridHeight: 16,
  cells: filled(16, 16, (x, y) => {
    const isBorder = x === 0 || y === 0 || x === 15 || y === 15;
    const isSouthDoorway = y === 15 && x >= 7 && x <= 8;
    if (isBorder && !isSouthDoorway) return { terrain: "void" };

    // Dais: raised stone platform, NE corner, elevation rises toward the
    // corner in two steps.
    if (x >= 10 && x <= 13 && y >= 1 && y <= 4) {
      const corner = distance(x, y, 13, 1);
      return { terrain: "normal", ground: "stone", elevation: corner < 2 ? 4 : 2 };
    }

    // Water pool, SW corner, roughly circular.
    if (distance(x, y, 3, 12) < 3.2) {
      return { terrain: "normal", ground: "water", waterFlow: "south" };
    }

    // Rubble patch, center — difficult terrain, default ground so the
    // terrain-driven hazard color shows.
    if (x >= 6 && x <= 9 && y >= 6 && y <= 9 && distance(x, y, 7.5, 7.5) < 2.4) {
      return { terrain: "difficult" };
    }

    // A pit near the east wall.
    if (x === 12 && y === 8) return { terrain: "pit", elevation: -2 };
    if (x === 13 && y === 8) return { terrain: "pit", elevation: -2 };

    // Dirt path leading in from the south doorway.
    if (isSouthDoorway || (x >= 7 && x <= 8 && y >= 11 && y <= 14)) {
      return { terrain: "normal", ground: "path" };
    }

    // Everywhere else in the room: plain stone floor.
    return { terrain: "normal", ground: "stone" };
  }),
};

// --- LARGE_MAP: a 48x32 outdoor area with a carved ruin -----------------
// Grass field background, a forest block (with a denser core and one
// difficult-terrain undergrowth patch), a lake fringed by sand and swamp,
// a dirt path connecting a walled stone ruin (with an elevation staircase
// and an interior pit) back out to the lakeshore.
export const LARGE_MAP = {
  name: "large-outdoor",
  gridWidth: 48,
  gridHeight: 32,
  cells: filled(48, 32, (x, y) => {
    // Lake: an ellipse in the NW, sand fringe just outside it, swamp beyond
    // the sand on the side nearer the forest.
    const lakeD = Math.hypot((x - 12) / 1.5, y - 9);
    if (lakeD < 5) return { terrain: "normal", ground: "water", waterFlow: "east" };
    if (lakeD < 6.4) return { terrain: "normal", ground: "sand" };
    if (lakeD < 8 && x > 12) return { terrain: "normal", ground: "swamp" };

    // Forest block, east-central, with a denser core and an undergrowth
    // (difficult terrain, default ground) patch along its southern edge.
    const inForestBlock = x >= 26 && x <= 43 && y >= 3 && y <= 18;
    if (inForestBlock) {
      const denseCore = x >= 31 && x <= 38 && y >= 7 && y <= 13;
      if (denseCore) return { terrain: "normal", ground: "dense_forest" };
      const undergrowth = y >= 15 && y <= 18 && x >= 28 && x <= 40;
      if (undergrowth) return { terrain: "difficult", ground: "forest" };
      return { terrain: "normal", ground: "forest" };
    }

    // Stone ruin, walled room in the south, with a doorway on its north
    // wall connecting to the path, and a staircase terracing up to the
    // east, plus one interior pit.
    const ruinX0 = 16,
      ruinX1 = 33,
      ruinY0 = 20,
      ruinY1 = 29;
    const inRuinBounds = x >= ruinX0 && x <= ruinX1 && y >= ruinY0 && y <= ruinY1;
    if (inRuinBounds) {
      const onWall = x === ruinX0 || x === ruinX1 || y === ruinY0 || y === ruinY1;
      const isDoorway = y === ruinY0 && x >= 23 && x <= 24;
      if (onWall && !isDoorway) return { terrain: "void" };
      if (x === 28 && y === 25) return { terrain: "pit", elevation: -3 };
      // Staircase: elevation rises in bands moving east across the room.
      const band = Math.floor((x - ruinX0) / 4);
      return { terrain: "normal", ground: "stone", elevation: Math.min(band, 4) };
    }

    // Dirt path: a corridor connecting the ruin's north doorway up to the
    // lakeshore, laid out as two straight legs.
    const onVerticalLeg = x >= 23 && x <= 24 && y >= 10 && y < ruinY0;
    const onHorizontalLeg = y >= 9 && y <= 10 && x >= 16 && x <= 24;
    if (onVerticalLeg || onHorizontalLeg) return { terrain: "normal", ground: "path" };

    // Everywhere else: open grass field.
    return { terrain: "normal", ground: "grass" };
  }),
};

export const TEST_MAPS = [SMALL_MAP, LARGE_MAP];
