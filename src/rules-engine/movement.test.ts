import { describe, expect, it } from "vitest";
import {
  cellMovementCost,
  computeReachableCells,
  gridCellDistance,
  gridDistanceFeet,
  pathMovementCost,
  spreadPositionsAround,
  straightCellPath,
  type GridPoint,
  type MovementCellInput,
  type TerrainType,
} from "./movement";

describe("cellMovementCost", () => {
  it("costs a flat 5 ft to enter a normal, level cell", () => {
    expect(cellMovementCost({ terrain: "normal", elevationDeltaFeet: 0 })).toBe(5);
  });

  it("costs extra for an elevation change alone", () => {
    const normalCost = cellMovementCost({ terrain: "normal", elevationDeltaFeet: 0 });
    const climbCost = cellMovementCost({ terrain: "normal", elevationDeltaFeet: 5 });
    expect(climbCost).toBeGreaterThan(normalCost);
    expect(climbCost).toBe(15); // 5 ft base + (5 ft climbed x2)
  });

  it("costs double for difficult terrain alone", () => {
    expect(cellMovementCost({ terrain: "difficult", elevationDeltaFeet: 0 })).toBe(10);
  });

  it("stacks difficult terrain and an elevation change in the same move", () => {
    const stacked = cellMovementCost({ terrain: "difficult", elevationDeltaFeet: 5 });
    const terrainOnly = cellMovementCost({ terrain: "difficult", elevationDeltaFeet: 0 });
    const climbOnly = cellMovementCost({ terrain: "normal", elevationDeltaFeet: 5 });
    expect(stacked).toBe(20); // 10 ft (difficult) + 10 ft (climb 5 ft x2)
    expect(stacked).toBeGreaterThan(terrainOnly);
    expect(stacked).toBeGreaterThan(climbOnly);
  });

  it("does not add climb cost when descending or staying level", () => {
    expect(cellMovementCost({ terrain: "normal", elevationDeltaFeet: -5 })).toBe(5);
  });

  it("costs Infinity to enter a void cell — impassable, not merely expensive", () => {
    expect(cellMovementCost({ terrain: "void", elevationDeltaFeet: 0 })).toBe(Infinity);
  });

  it("costs Infinity for a void cell regardless of the elevation delta", () => {
    expect(cellMovementCost({ terrain: "void", elevationDeltaFeet: 25 })).toBe(Infinity);
    expect(cellMovementCost({ terrain: "void", elevationDeltaFeet: -25 })).toBe(Infinity);
  });

  // Pits and falling (docs/design/pits-and-falling.md §7): entering a pit is
  // costed exactly like ordinary ground — the SRD imposes no movement-cost
  // penalty for walking into a hole, only a status-effect consequence
  // (src/rules-engine/falling.ts) resolved alongside the move commit, not
  // here. In particular a pit is NOT "difficult" terrain, and descending
  // into one (the overwhelmingly common case — a pit's own elevation is
  // usually lower than the mover's) is free, the same "descending or level
  // adds no climbing cost" rule as any other downward step.
  it("costs a flat 5 ft to enter a pit cell, same as normal ground", () => {
    expect(cellMovementCost({ terrain: "pit", elevationDeltaFeet: 0 })).toBe(
      cellMovementCost({ terrain: "normal", elevationDeltaFeet: 0 })
    );
  });

  it("costs nothing extra to descend into a pit, regardless of depth", () => {
    expect(cellMovementCost({ terrain: "pit", elevationDeltaFeet: -50 })).toBe(5);
  });

  // Bridges and stairs (a post-roadmap addition): both are placed map
  // OBJECTS (mapObjects.ts's crossing_type), never a terrain_type — see
  // this file's own CrossingType doc comment. `crossing` is optional and
  // every test above already exercises the omitted-field default; this
  // block is the one place that pins down what each value actually does.
  describe("crossing (bridges and stairs)", () => {
    it("a bridge waives the difficult-terrain doubling — costs the plain 5 ft instead", () => {
      expect(
        cellMovementCost({ terrain: "difficult", elevationDeltaFeet: 0, crossing: "bridge" })
      ).toBe(5);
    });

    it("a bridge on normal or pit terrain changes nothing — both already cost the plain 5 ft", () => {
      expect(cellMovementCost({ terrain: "normal", elevationDeltaFeet: 0, crossing: "bridge" })).toBe(
        5
      );
      expect(cellMovementCost({ terrain: "pit", elevationDeltaFeet: 0, crossing: "bridge" })).toBe(5);
    });

    it("a bridge never overrides void — still Infinity", () => {
      expect(cellMovementCost({ terrain: "void", elevationDeltaFeet: 0, crossing: "bridge" })).toBe(
        Infinity
      );
    });

    it("a bridge does not touch the climbing surcharge — only stairs do", () => {
      expect(
        cellMovementCost({ terrain: "difficult", elevationDeltaFeet: 5, crossing: "bridge" })
      ).toBe(15); // 5 ft (bridge-waived difficult) + 10 ft climb (unwaived), same as normal+climb
    });

    it("stairs waive the SRD climbing surcharge entirely", () => {
      expect(cellMovementCost({ terrain: "normal", elevationDeltaFeet: 5, crossing: "stairs" })).toBe(
        5
      );
      expect(cellMovementCost({ terrain: "normal", elevationDeltaFeet: 50, crossing: "stairs" })).toBe(
        5
      );
    });

    it("stairs do not touch the difficult-terrain doubling — only bridges do", () => {
      expect(
        cellMovementCost({ terrain: "difficult", elevationDeltaFeet: 5, crossing: "stairs" })
      ).toBe(10); // 10 ft (difficult, unwaived) + 0 ft climb (waived)
    });

    it("stairs change nothing when there is no elevation change to waive", () => {
      expect(cellMovementCost({ terrain: "normal", elevationDeltaFeet: 0, crossing: "stairs" })).toBe(
        cellMovementCost({ terrain: "normal", elevationDeltaFeet: 0 })
      );
    });

    it("a null crossing behaves exactly like an omitted one", () => {
      expect(cellMovementCost({ terrain: "difficult", elevationDeltaFeet: 5, crossing: null })).toBe(
        cellMovementCost({ terrain: "difficult", elevationDeltaFeet: 5 })
      );
    });
  });
});

describe("gridDistanceFeet", () => {
  it("treats diagonal movement as a flat 5 ft per cell, same as orthogonal", () => {
    const orthogonal = gridDistanceFeet({ x: 0, y: 0 }, { x: 3, y: 0 });
    const diagonal = gridDistanceFeet({ x: 0, y: 0 }, { x: 3, y: 3 });
    expect(orthogonal).toBe(15);
    expect(diagonal).toBe(15);
  });
});

describe("straightCellPath", () => {
  it("returns an empty path when origin and target are the same cell", () => {
    expect(straightCellPath({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([]);
  });

  it("walks straight lines and excludes the origin", () => {
    expect(straightCellPath({ x: 1, y: 1 }, { x: 4, y: 1 })).toEqual([
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
    ]);
  });

  it("steps diagonally first, matching gridCellDistance in length", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 4, y: 2 };
    const path = straightCellPath(from, to);
    expect(path).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
    ]);
    expect(path).toHaveLength(gridCellDistance(from, to));
  });

  it("handles negative directions", () => {
    expect(straightCellPath({ x: 3, y: 3 }, { x: 1, y: 2 })).toEqual([
      { x: 2, y: 2 },
      { x: 1, y: 2 },
    ]);
  });
});

describe("pathMovementCost", () => {
  const normal = (elevationSteps: number) => ({ terrain: "normal" as const, elevationSteps });
  const difficult = (elevationSteps: number) => ({ terrain: "difficult" as const, elevationSteps });
  const voidCell = (elevationSteps: number) => ({ terrain: "void" as const, elevationSteps });

  it("costs 5 ft per cell over normal level ground", () => {
    expect(pathMovementCost(0, [normal(0), normal(0), normal(0)])).toBe(15);
  });

  it("charges a climb on the cell-to-cell delta, once per ascent", () => {
    // Up one 5 ft step (5 + 10), then along the plateau (5), then down (5).
    expect(pathMovementCost(0, [normal(1), normal(1), normal(0)])).toBe(25);
  });

  it("stacks difficult terrain with a climb in the same entered cell", () => {
    // 10 ft difficult + 10 ft for the 5 ft climb.
    expect(pathMovementCost(0, [difficult(1)])).toBe(20);
  });

  it("sums mixed terrain, climbs, and descents across a path", () => {
    // normal level (5) + difficult climb (10 + 10) + normal descent (5).
    expect(pathMovementCost(0, [normal(0), difficult(1), normal(0)])).toBe(30);
  });

  it("charges nothing for an empty path", () => {
    expect(pathMovementCost(3, [])).toBe(0);
  });

  it("sums to Infinity when any entered cell is void, wherever it falls in the path", () => {
    expect(pathMovementCost(0, [voidCell(0)])).toBe(Infinity);
    expect(pathMovementCost(0, [normal(0), voidCell(0), normal(0)])).toBe(Infinity);
    expect(pathMovementCost(0, [normal(0), difficult(1), voidCell(2)])).toBe(Infinity);
  });

  it("stays Infinity even when the path descends after the void cell", () => {
    // Descending past a void cell can never 'refund' the impassable cost.
    expect(pathMovementCost(5, [voidCell(5), normal(0)])).toBe(Infinity);
  });

  it("threads a per-cell crossing structure through to cellMovementCost", () => {
    // A bridged difficult cell mid-path costs the same as if it were plain
    // normal ground either side of it.
    const bridged = pathMovementCost(0, [
      normal(0),
      { terrain: "difficult" as const, elevationSteps: 0, crossing: "bridge" as const },
      normal(0),
    ]);
    expect(bridged).toBe(pathMovementCost(0, [normal(0), normal(0), normal(0)]));

    // Stairs onto a raised cell waive the climb; the very next cell (no
    // stairs there) still pays for its OWN delta normally — the waiver is
    // per-cell, not a blanket "no more climbing costs this path".
    const staired = pathMovementCost(0, [
      { terrain: "normal" as const, elevationSteps: 1, crossing: "stairs" as const },
      normal(1),
    ]);
    expect(staired).toBe(10); // 5 ft (stairs, climb waived) + 5 ft (level with previous)
  });
});

describe("computeReachableCells", () => {
  const origin: GridPoint = { x: 0, y: 0 };

  /** A square patch of cells from -radius..radius on both axes, every one
   * `terrain` at `elevationSteps`, except any point in `voidPoints`, which
   * is void instead — generous enough bounds that a shrunk reachable set
   * is provably terrain's doing, never the described grid running out. */
  function uniformGrid(
    radius: number,
    terrain: TerrainType = "normal",
    elevationSteps = 0,
    voidPoints: readonly GridPoint[] = []
  ): MovementCellInput[] {
    const voidKeys = new Set(voidPoints.map((p) => `${p.x},${p.y}`));
    const cells: MovementCellInput[] = [];
    for (let x = -radius; x <= radius; x++) {
      for (let y = -radius; y <= radius; y++) {
        const isVoid = voidKeys.has(`${x},${y}`);
        cells.push({
          position: { x, y },
          terrain: isVoid ? "void" : terrain,
          elevationSteps: isVoid ? 0 : elevationSteps,
        });
      }
    }
    return cells;
  }

  /** Every point with Chebyshev distance <= radius from the origin — the
   * exact shape a flat per-cell cost produces, since gridCellDistance IS
   * that Chebyshev distance. */
  function square(radius: number): GridPoint[] {
    const points: GridPoint[] = [];
    for (let x = -radius; x <= radius; x++) {
      for (let y = -radius; y <= radius; y++) {
        points.push({ x, y });
      }
    }
    return points;
  }

  function keysOf(points: readonly GridPoint[]): string[] {
    return points.map((p) => `${p.x},${p.y}`).sort();
  }

  it("reaches exactly the Chebyshev square a flat per-cell cost implies on an open grid", () => {
    const budgetFeet = 15; // 3 cells at the flat 5 ft rate
    const result = computeReachableCells({ origin, cells: uniformGrid(6), budgetFeet });
    expect(keysOf(result)).toEqual(keysOf(square(3)));
  });

  it("every returned cell is affordable by pathMovementCost along a real path, and the ring just beyond it is not", () => {
    const budgetFeet = 15;
    const result = computeReachableCells({ origin, cells: uniformGrid(6), budgetFeet });
    const resultKeys = new Set(keysOf(result));
    const flatPathCost = (point: GridPoint) =>
      pathMovementCost(
        0,
        straightCellPath(origin, point).map(() => ({ terrain: "normal" as const, elevationSteps: 0 }))
      );

    // Uniform terrain makes straightCellPath provably optimal (any route
    // takes at least gridCellDistance steps, and every step costs the same
    // flat rate here), so this is a genuine affordability check, not just
    // a check against one arbitrary route.
    for (const point of result) {
      expect(flatPathCost(point)).toBeLessThanOrEqual(budgetFeet);
    }

    const justBeyond = square(4).filter((p) => Math.max(Math.abs(p.x), Math.abs(p.y)) === 4);
    for (const point of justBeyond) {
      expect(flatPathCost(point)).toBeGreaterThan(budgetFeet);
      expect(resultKeys.has(`${point.x},${point.y}`)).toBe(false);
    }
  });

  it("difficult terrain shrinks the reachable set for the same budget", () => {
    const budgetFeet = 15;
    const normalResult = computeReachableCells({
      origin,
      cells: uniformGrid(6, "normal"),
      budgetFeet,
    });
    const difficultResult = computeReachableCells({
      origin,
      cells: uniformGrid(6, "difficult"),
      budgetFeet,
    });
    // floor(15 / 10 ft-per-cell) = 1 cell of movement.
    expect(keysOf(difficultResult)).toEqual(keysOf(square(1)));
    expect(difficultResult.length).toBeLessThan(normalResult.length);
  });

  it("a void wall blocks every path through it, not just the wall cells themselves", () => {
    const wallY = 2;
    const wallPoints: GridPoint[] = [];
    for (let x = -10; x <= 10; x++) wallPoints.push({ x, y: wallY });
    const budgetFeet = 50; // 10 cells — comfortably past y=5 if nothing blocked it
    const result = computeReachableCells({
      origin,
      cells: uniformGrid(10, "normal", 0, wallPoints),
      budgetFeet,
    });
    expect(result.some((p) => p.y === wallY)).toBe(false); // the wall itself
    expect(result.some((p) => p.y > wallY)).toBe(false); // and everything past it
    expect(result.some((p) => p.y === wallY - 1)).toBe(true); // right up against it, though
  });

  it("a void cell is never reachable, even with an unbounded budget, and never routes through to cells beyond it", () => {
    const result = computeReachableCells({
      origin,
      cells: uniformGrid(3, "normal", 0, [{ x: 1, y: 0 }]),
      budgetFeet: Infinity,
    });
    const resultKeys = new Set(keysOf(result));
    expect(resultKeys.has("1,0")).toBe(false);
    // An unlimited budget reaches literally everything else in the
    // described grid — the void cell is the only exclusion.
    for (let x = -3; x <= 3; x++) {
      for (let y = -3; y <= 3; y++) {
        if (x === 1 && y === 0) continue;
        expect(resultKeys.has(`${x},${y}`)).toBe(true);
      }
    }
  });

  it("an elevation climb consumes extra budget, consistent with pathMovementCost's cell-to-cell accounting", () => {
    // A single 5 ft step up starting at x=1, for every y — so reaching any
    // x>=1 cell always pays the climb exactly once, on first crossing.
    const cells: MovementCellInput[] = [];
    for (let x = -10; x <= 10; x++) {
      for (let y = -10; y <= 10; y++) {
        cells.push({ position: { x, y }, terrain: "normal", elevationSteps: x >= 1 ? 1 : 0 });
      }
    }
    const budgetFeet = 15;
    const result = computeReachableCells({ origin, cells, budgetFeet });
    const resultKeys = new Set(keysOf(result));

    // pathMovementCost(0, [normal(1), normal(1)]) below is exactly what it
    // costs to walk 2 cells onto and along the plateau: 15 ft to enter the
    // first raised cell (5 ft base + 10 ft for the 5 ft climb), then 5 ft
    // more for the second cell at the same elevation (no further delta).
    expect(
      pathMovementCost(0, [
        { terrain: "normal", elevationSteps: 1 },
        { terrain: "normal", elevationSteps: 1 },
      ])
    ).toBe(20);

    expect(resultKeys.has("1,0")).toBe(true); // exactly at budget: 15
    expect(resultKeys.has("2,0")).toBe(false); // would cost 20
    expect(resultKeys.has("-3,0")).toBe(true); // same Chebyshev distance, flat side: only 15
  });

  it("always includes the origin at zero cost, matching pathMovementCost's empty-path cost", () => {
    expect(pathMovementCost(0, [])).toBe(0);
    const result = computeReachableCells({ origin, cells: uniformGrid(2), budgetFeet: 0 });
    expect(result).toEqual([origin]);
  });

  it("passes through an occupied cell at its normal cost, but never offers the cell itself as a destination", () => {
    const budgetFeet = 10; // exactly 2 cells of movement
    const result = computeReachableCells({
      origin,
      cells: uniformGrid(6),
      budgetFeet,
      occupiedCells: [{ x: 1, y: 0 }],
    });
    const resultKeys = new Set(keysOf(result));
    expect(resultKeys.has("1,0")).toBe(false); // occupied — excluded as a landing spot
    expect(resultKeys.has("2,0")).toBe(true); // still reached, by walking through (1,0)
  });

  it("still includes the origin even when another token already shares that cell", () => {
    const result = computeReachableCells({
      origin,
      cells: uniformGrid(2),
      budgetFeet: 10,
      occupiedCells: [origin],
    });
    expect(result.some((p) => p.x === origin.x && p.y === origin.y)).toBe(true);
  });

  // Movement Collision & Gated Interaction Checks: blockedCells (a placed
  // object, e.g. a wall or a table) is a HARD block, unlike occupiedCells
  // just above -- these two mirror the "a void wall blocks every path
  // through it" / "a void cell is never reachable ... never routes through"
  // tests above exactly, just via blockedCells on ordinary normal terrain
  // instead of void terrain, to prove it's the same impassable-cell
  // mechanism, not a new one.
  describe("blockedCells (placed objects)", () => {
    it("a blocked cell is never reachable, even with an unbounded budget, and never routes through to cells beyond it", () => {
      const result = computeReachableCells({
        origin,
        cells: uniformGrid(3),
        budgetFeet: Infinity,
        blockedCells: [{ x: 1, y: 0 }],
      });
      const resultKeys = new Set(keysOf(result));
      expect(resultKeys.has("1,0")).toBe(false);
      // An unlimited budget reaches literally everything else in the
      // described grid -- the blocked cell is the only exclusion.
      for (let x = -3; x <= 3; x++) {
        for (let y = -3; y <= 3; y++) {
          if (x === 1 && y === 0) continue;
          expect(resultKeys.has(`${x},${y}`)).toBe(true);
        }
      }
    });

    it("a wall of blocked cells blocks every path through it, not just the wall cells themselves", () => {
      const wallY = 2;
      const wallPoints: GridPoint[] = [];
      for (let x = -10; x <= 10; x++) wallPoints.push({ x, y: wallY });
      const budgetFeet = 50; // 10 cells -- comfortably past y=5 if nothing blocked it
      const result = computeReachableCells({
        origin,
        cells: uniformGrid(10),
        budgetFeet,
        blockedCells: wallPoints,
      });
      expect(result.some((p) => p.y === wallY)).toBe(false); // the wall itself
      expect(result.some((p) => p.y > wallY)).toBe(false); // and everything past it
      expect(result.some((p) => p.y === wallY - 1)).toBe(true); // right up against it, though
    });

    it("still includes the origin even when a blocking object somehow occupies that exact cell", () => {
      const result = computeReachableCells({
        origin,
        cells: uniformGrid(2),
        budgetFeet: 10,
        blockedCells: [origin],
      });
      expect(result.some((p) => p.x === origin.x && p.y === origin.y)).toBe(true);
    });

    it("passing through an occupied cell still costs its ordinary rate, unlike a blocked cell which costs Infinity", () => {
      // Same budget as the occupiedCells test above (10 ft = 2 diagonal
      // cells), but blocking every cell 2 could possibly be reached
      // through in exactly 2 steps (x=1, y in -1..1 -- the only
      // intermediate cells 2 diagonal-first steps from the origin can ever
      // pass through on the way to (2,0), by Chebyshev-distance
      // arithmetic), rather than just (1,0) alone: a single blocked cell
      // on an open 8-directional grid can be walked AROUND at the same
      // flat per-cell rate (e.g. via (1,1)), so isolating the "genuinely
      // impassable, not just avoided" property needs every alternate route
      // closed off too.
      const budgetFeet = 10;
      const result = computeReachableCells({
        origin,
        cells: uniformGrid(6),
        budgetFeet,
        blockedCells: [
          { x: 1, y: -1 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
      });
      const resultKeys = new Set(keysOf(result));
      expect(resultKeys.has("1,0")).toBe(false); // blocked
      expect(resultKeys.has("2,0")).toBe(false); // and unreachable through it, unlike occupiedCells
    });
  });

  // Bridges and stairs: computeReachableCells is the exact sweep
  // reachableCellSetForToken (GameRoom.tsx) feeds off the map's live
  // objects, so this is the same guarantee the rules-engine README
  // documents for cellMovementCost/pathMovementCost — a bridged/staired
  // cell can never highlight as reachable and then turn out unaffordable
  // (or vice versa) once the whole-grid sweep carries `crossing` too.
  it("bridging every cell of a difficult grid restores the plain-terrain reach", () => {
    // The exact grids the existing "difficult terrain shrinks the reachable
    // set" test above already proved apart (square(1) vs. square(3)) — this
    // proves a bridge on every cell erases that gap entirely, the same
    // "identical mechanism, not a new one" structural proof
    // verify-water-terrain.mjs uses for water+difficult vs. plain difficult.
    const budgetFeet = 15;
    const plainResult = computeReachableCells({ origin, cells: uniformGrid(6, "normal"), budgetFeet });
    const difficultResult = computeReachableCells({
      origin,
      cells: uniformGrid(6, "difficult"),
      budgetFeet,
    });
    const bridgedCells: MovementCellInput[] = uniformGrid(6, "difficult").map((cell) => ({
      ...cell,
      crossing: "bridge" as const,
    }));
    const bridgedResult = computeReachableCells({ origin, cells: bridgedCells, budgetFeet });

    expect(keysOf(difficultResult)).not.toEqual(keysOf(plainResult));
    expect(keysOf(bridgedResult)).toEqual(keysOf(plainResult));
  });

  it("stairs onto a raised cell reach exactly as far as if there were no climb at all", () => {
    // Raise every x>=1 cell by 2 steps (10 ft): entering (1,0) from the
    // origin costs 5 ft base + 20 ft climb (10 ft x2) = 25 ft, over the 15
    // ft budget, so it's unreachable without help.
    const raisedAtOne = uniformGrid(6).map((cell) =>
      cell.position.x >= 1 ? { ...cell, elevationSteps: 2 } : cell
    );
    const budgetFeet = 15;
    const unstairedResult = computeReachableCells({ origin, cells: raisedAtOne, budgetFeet });
    expect(new Set(keysOf(unstairedResult)).has("1,0")).toBe(false);

    // Stairs on (1,0) alone waive ONLY that cell's own climb — it now costs
    // the flat 5 ft, same as ordinary level ground, and becomes reachable
    // again despite still being a 10 ft-higher cell.
    const stairedAtOne = raisedAtOne.map((cell) =>
      cell.position.x === 1 && cell.position.y === 0 ? { ...cell, crossing: "stairs" as const } : cell
    );
    const stairedResult = computeReachableCells({ origin, cells: stairedAtOne, budgetFeet });
    expect(new Set(keysOf(stairedResult)).has("1,0")).toBe(true);
  });
});

describe("spreadPositionsAround", () => {
  const center: GridPoint = { x: 5, y: 5 };
  const keyOf = (point: GridPoint) => `${point.x},${point.y}`;

  it("returns just the center for a single requested point", () => {
    const result = spreadPositionsAround(center, 1, () => false);
    expect(result).toEqual([center]);
  });

  it("returns N distinct points for N requested, all around an unblocked open area", () => {
    const result = spreadPositionsAround(center, 5, () => false);
    expect(result).toHaveLength(5);
    expect(new Set(result.map(keyOf)).size).toBe(5);
  });

  it("includes the center itself first, before any ring point", () => {
    const result = spreadPositionsAround(center, 4, () => false);
    expect(result[0]).toEqual(center);
  });

  it("prefers points CLOSER to center — every found point is within the smallest radius that could satisfy the count", () => {
    // The center + the 8-cell radius-1 ring holds exactly 9 points; asking
    // for all 9 should never reach out to radius 2.
    const result = spreadPositionsAround(center, 9, () => false);
    for (const point of result) {
      expect(Math.max(Math.abs(point.x - center.x), Math.abs(point.y - center.y))).toBeLessThanOrEqual(1);
    }
  });

  it("skips blocked points (e.g. the center itself already occupied) and finds the count elsewhere", () => {
    const result = spreadPositionsAround(center, 3, (point) => point.x === center.x && point.y === center.y);
    expect(result).toHaveLength(3);
    expect(result.some((point) => keyOf(point) === keyOf(center))).toBe(false);
  });

  it("respects map-bounds-style blocking (e.g. a corner near the edge) by expanding outward instead of off-grid", () => {
    const corner: GridPoint = { x: 0, y: 0 };
    const isBlocked = (point: GridPoint) => point.x < 0 || point.y < 0;
    const result = spreadPositionsAround(corner, 5, isBlocked);
    expect(result).toHaveLength(5);
    for (const point of result) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns fewer than the requested count (not an infinite loop) when the whole map is blocked", () => {
    const result = spreadPositionsAround(center, 5, () => true);
    expect(result).toEqual([]);
  });

  it("returns fewer than the requested count when only a handful of cells are actually open", () => {
    const open = new Set([keyOf(center), keyOf({ x: 6, y: 5 }), keyOf({ x: 4, y: 5 })]);
    const result = spreadPositionsAround(center, 10, (point) => !open.has(keyOf(point)));
    expect(result).toHaveLength(3);
    expect(new Set(result.map(keyOf))).toEqual(open);
  });
});
