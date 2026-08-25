// Simplified diagonal rule (DMG variant, not the alternating 5-10-5 rule):
// every cell entered costs a flat 5 ft regardless of direction. Range
// calculations, movement cost, and the future ruler tool all depend on
// this exact decision — see Prompt 9's README for why it was fixed here.
export const FEET_PER_CELL = 5;

// "void" is a cell with no floor at all (the non-rectangular-room-shapes
// feature): it renders as absent for every viewer and can never be entered,
// which this module expresses as an infinite movement cost — any path that
// includes a void cell sums to Infinity, so cost-based callers see
// "impassable" without a special case.
export type TerrainType = "normal" | "difficult" | "void";

export interface CellMovementParams {
  terrain: TerrainType;
  // Feet climbed to enter this cell; 0 or negative (descending/level) adds
  // no climbing cost.
  elevationDeltaFeet: number;
}

// Difficult terrain and climbing are independent costs that stack: a cell
// that is both difficult terrain and a climb pays both penalties.
export function cellMovementCost({ terrain, elevationDeltaFeet }: CellMovementParams): number {
  // A void cell cannot be entered at any price. Returning here (rather than
  // folding Infinity into horizontalCost) is just clarity — Infinity plus
  // any climb cost is still Infinity, so no elevation special-casing exists.
  if (terrain === "void") return Infinity;
  const horizontalCost = terrain === "difficult" ? FEET_PER_CELL * 2 : FEET_PER_CELL;
  // SRD climbing rule: 1 extra foot of movement per foot climbed, i.e. the
  // vertical portion costs double.
  const climbCost = elevationDeltaFeet > 0 ? elevationDeltaFeet * 2 : 0;
  return horizontalCost + climbCost;
}

export interface GridPoint {
  x: number;
  y: number;
}

export function gridCellDistance(from: GridPoint, to: GridPoint): number {
  return Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
}

export function gridDistanceFeet(from: GridPoint, to: GridPoint): number {
  return gridCellDistance(from, to) * FEET_PER_CELL;
}

// One stored elevation step is 5 vertical feet — the same unit as the flat
// 5 ft cell, so "one step up" and "one cell over" read as the same distance.
// map_cells.elevation deliberately stores steps, not feet (0014_maps.sql);
// this constant is the single place that conversion decision lives.
export const FEET_PER_ELEVATION_STEP = 5;

/**
 * The straight walk from `from` to `to`, excluding `from` itself: step
 * diagonally while both axes differ, then straight. Its length equals
 * gridCellDistance, so a plain drag over normal level ground costs exactly
 * the ruler distance. Movement UIs recompute this from the origin on every
 * hover — cost depends only on where you are, not how the mouse wobbled.
 */
export function straightCellPath(from: GridPoint, to: GridPoint): GridPoint[] {
  const path: GridPoint[] = [];
  let { x, y } = from;
  while (x !== to.x || y !== to.y) {
    x += Math.sign(to.x - x);
    y += Math.sign(to.y - y);
    path.push({ x, y });
  }
  return path;
}

export interface PathCell {
  terrain: TerrainType;
  elevationSteps: number;
}

/** Total cost of entering each cell in sequence, starting from a cell at
 * `originElevationSteps` — climbs are charged per cell-to-cell delta, so a
 * plateau costs its ascent once, not per cell walked along the top. */
export function pathMovementCost(
  originElevationSteps: number,
  entered: readonly PathCell[]
): number {
  let previousElevation = originElevationSteps;
  let total = 0;
  for (const cell of entered) {
    total += cellMovementCost({
      terrain: cell.terrain,
      elevationDeltaFeet: (cell.elevationSteps - previousElevation) * FEET_PER_ELEVATION_STEP,
    });
    previousElevation = cell.elevationSteps;
  }
  return total;
}

/** One cell of a whole-grid sweep, tagged with its own position — the same
 * "flat list of {position, ...per-cell fields}" shape `perception.ts`'s
 * `VisibilityCellInput` already uses for a full-map sweep (there: `{id,
 * position, ambientLight}`; here: terrain + elevation instead of light).
 * Named for reuse beyond `computeReachableCells` alone — the ruler tool
 * this file's `FEET_PER_CELL` comment promises will want the same
 * terrain/elevation-by-position sweep. */
export interface MovementCellInput {
  position: GridPoint;
  terrain: TerrainType;
  elevationSteps: number;
}

export interface ComputeReachableCellsParams {
  /** Where the token currently stands. Always comes back in the result at
   * 0 ft — a token can always "move" nowhere, matching `pathMovementCost`
   * charging nothing for an empty path. */
  origin: GridPoint;
  /**
   * Every real cell's terrain + elevation, one entry per cell — the same
   * whole-map sweep shape `computeVisibilityTiers` already takes
   * (`cells: readonly VisibilityCellInput[]`), built the same way: densify
   * GameRoom's sparse `cellOverlay`/`overlayFromRows` map (overlay entry,
   * or `DEFAULT_CELL` where absent) into one entry per in-bounds cell,
   * same as `buildDenseCells` already does for rendering. A point with NO
   * entry here — off the edge of whatever this list describes — is
   * treated exactly like an explicit void cell: "outside the walkable
   * map" is already this app's own wording for void (GameRoom's
   * `VOID_CELL_MESSAGE`), so a caller only has to describe real cells,
   * never hand-paint a void border around the map.
   */
  cells: readonly MovementCellInput[];
  /** Feet of movement available this move, e.g. the token's remaining
   * speed for the turn. */
  budgetFeet: number;
  /**
   * Cells other tokens currently occupy (never the moving token's own
   * cell). Judgment call, documented here because nothing forced one
   * answer on its own:
   *
   * Passing THROUGH an occupied cell is already unrestricted in this app
   * today — `dragPathCost`/`moveMapToken`/`moveCombatToken` and the
   * placement flow never inspect other tokens' positions for any cell
   * along a route, the only rejection guard anywhere is void terrain, and
   * the map-transition handler explicitly documents that "tokens may
   * share a cell here as anywhere else". So an occupied cell costs and
   * relays onward exactly like any other cell of its terrain here too —
   * existing behavior already answers that half.
   *
   * There is no existing behavior to consult for the other half, though:
   * no "highlight valid destinations" feature exists yet to have already
   * decided whether an occupied cell should be OFFERED as a place to
   * land. This function takes the more useful and conventional stance for
   * that new feature — an occupied cell is excluded from the returned
   * set as a destination, so the highlight this feeds suggests empty
   * cells to move to rather than inviting a drop directly on top of
   * another token. This is a UI-highlight policy layered on top of, not a
   * change to, move legality: it does not touch `moveMapToken` /
   * `moveCombatToken`, which keep allowing a manual drag onto an occupied
   * cell exactly as before. The origin is exempt from this filter — a
   * token can always stay where it stands even if, unusually, another
   * token already shares that cell.
   */
  occupiedCells?: readonly GridPoint[];
}

const OFF_GRID_CELL: PathCell = { terrain: "void", elevationSteps: 0 };

function pointKey(point: GridPoint): string {
  return `${point.x},${point.y}`;
}

/**
 * Every grid cell a token could stop on within `budgetFeet` of movement
 * from `origin` — a cost-limited graph search (Dijkstra: edge weights from
 * `cellMovementCost` are never negative, so settling in increasing-cost
 * order is safe) over the whole grid, rather than a single priced path, to
 * answer "where COULD this token go" instead of "what does going here
 * cost". Movement is 8-directional (matching `straightCellPath`'s
 * diagonal-first routing and `gridCellDistance`'s Chebyshev measure), and
 * a diagonal entry costs the same flat rate as an orthogonal one, per this
 * module's fixed diagonal rule — so on uniform terrain the reachable set
 * is exactly the Chebyshev square of radius `floor(budgetFeet /
 * costPerCell)`.
 *
 * Terrain, difficult terrain, elevation, and void all resolve through the
 * exact same `cellMovementCost` a committed move is charged with (climbs
 * accounted the same cell-to-cell-delta way `pathMovementCost` already
 * does), so a cell can never come back reachable here and then turn out
 * unaffordable when a move there is actually priced, or vice versa.
 *
 * Void needs no special case, verified rather than assumed: `
 * cellMovementCost` already returns `Infinity` for void terrain (and for
 * any point this function is never told about — see `cells` above), so
 * the tentative cost through one is `Infinity`. The edge is rejected by an
 * explicit `Number.isFinite` check rather than only the `<= budgetFeet`
 * comparison, because `Infinity <= Infinity` is true in JS — without that
 * guard, an unbounded budget would let a void cell slip in as "reachable
 * at infinite cost". With the guard, a void cell is both never itself
 * reachable and never relaxed onward to whatever lies past it, at any
 * budget including an unbounded one.
 */
export function computeReachableCells(params: ComputeReachableCellsParams): GridPoint[] {
  const { origin, cells, budgetFeet, occupiedCells = [] } = params;

  const cellByKey = new Map<string, PathCell>();
  for (const cell of cells) {
    cellByKey.set(pointKey(cell.position), {
      terrain: cell.terrain,
      elevationSteps: cell.elevationSteps,
    });
  }
  const cellAt = (point: GridPoint): PathCell => cellByKey.get(pointKey(point)) ?? OFF_GRID_CELL;

  const occupiedKeys = new Set(occupiedCells.map(pointKey));
  const originKey = pointKey(origin);

  const bestCostFeet = new Map<string, number>([[originKey, 0]]);
  const settled = new Set<string>();
  // Points known but not yet settled. May hold stale duplicates from a
  // relaxation that was later improved on — cheap to skip via `settled`
  // once popped, and simpler than removing them from the middle up front.
  const frontier: GridPoint[] = [origin];

  while (frontier.length > 0) {
    let bestIndex = -1;
    let currentCostFeet = Infinity;
    for (let i = 0; i < frontier.length; i++) {
      const candidateKey = pointKey(frontier[i]);
      if (settled.has(candidateKey)) continue;
      const cost = bestCostFeet.get(candidateKey) ?? Infinity;
      if (cost < currentCostFeet) {
        currentCostFeet = cost;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) break; // everything left in the frontier is stale
    const current = frontier.splice(bestIndex, 1)[0];
    const currentKey = pointKey(current);
    if (settled.has(currentKey)) continue;
    settled.add(currentKey);
    const currentElevationSteps = cellAt(current).elevationSteps;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const neighbor: GridPoint = { x: current.x + dx, y: current.y + dy };
        const neighborKey = pointKey(neighbor);
        if (settled.has(neighborKey)) continue;
        const neighborCell = cellAt(neighbor);
        const edgeCostFeet = cellMovementCost({
          terrain: neighborCell.terrain,
          elevationDeltaFeet:
            (neighborCell.elevationSteps - currentElevationSteps) * FEET_PER_ELEVATION_STEP,
        });
        const tentativeCostFeet = currentCostFeet + edgeCostFeet;
        if (!Number.isFinite(tentativeCostFeet) || tentativeCostFeet > budgetFeet) continue;
        const knownCostFeet = bestCostFeet.get(neighborKey);
        if (knownCostFeet === undefined || tentativeCostFeet < knownCostFeet) {
          bestCostFeet.set(neighborKey, tentativeCostFeet);
          frontier.push(neighbor);
        }
      }
    }
  }

  return [...bestCostFeet.keys()]
    .filter((key) => key === originKey || !occupiedKeys.has(key))
    .map((key) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y };
    });
}
