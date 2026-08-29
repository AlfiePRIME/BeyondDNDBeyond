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
//
// "pit" (docs/design/pits-and-falling.md) is a cell with a floor, just a
// lower one — its own `elevation` stores the pit's absolute floor height,
// negative permitted specifically for this terrain type. Deliberately NOT
// costed as "difficult" here: cellMovementCost treats it exactly like
// "normal" ground (a flat 5 ft, descending for free like any other downward
// step — see this file's climbCost comment), because the SRD imposes no
// entry-cost penalty for walking into a hole; the real consequence (fall
// damage, prone) is a status-effect side effect resolved alongside the move
// commit, in src/rules-engine/falling.ts, not a movement-cost concern.
export type TerrainType = "normal" | "difficult" | "void" | "pit";

// Bridges and stairs (a post-roadmap addition): both are placed map OBJECTS
// (src/data-access/mapObjects.ts's own `crossing_type` column), never a
// terrain_type — an object overlays a cell's existing terrain without
// replacing it, which is exactly "you can walk across without falling into
// (or paying full price for) what's still there underneath". Structurally
// matches data-access's CrossingType — the same MapSurfaceGroundType/
// GroundType decoupling precedent scene-3d already uses — so this module
// stays data-access-free (see quickActions.ts's/perception.ts's own
// "rules-engine cannot import data-access" notes); the two types are kept
// in sync by hand rather than by an import.
//
// The `crossing` field below is OPTIONAL and defaults to no crossing
// structure, so every pre-existing call site (movement.test.ts,
// verify-water-terrain.mjs, every GameRoom.tsx call that predates this
// addition) keeps compiling and behaving byte-for-byte identically without
// ever mentioning it.
//
// 'bridge' waives the difficult-terrain doubling below (water's own
// movement penalty, reused wholesale per water-terrain's design) for
// whichever cell it sits on; it does NOT touch void (Infinity, still
// returned unconditionally below — objects can never even be placed on a
// void cell, so this never actually arises) and needs no pit-specific
// branch here, since a pit ALREADY costs the plain 5 ft to enter (see this
// file's own long-standing comment above `TerrainType` — the real pit
// consequence, fall damage/prone, is a status-effect side effect resolved
// in GameRoom.tsx's handleTokenLanded/falling.ts, never a movement COST
// concern, so a bridge's fall-suppression lives entirely there, not here).
//
// 'stairs' waives the SRD climbing surcharge for whichever cell it sits on
// — the destination-cell-only shape a pit's own fall-trigger already
// established (keyed off the cell entered, not a stored two-cell
// relationship), so a DM places Stairs on the higher cell of a climb the
// same way they'd place a Bridge on the pit/water cell being crossed.
export type CrossingType = "bridge" | "stairs";

export interface CellMovementParams {
  terrain: TerrainType;
  // Feet climbed to enter this cell; 0 or negative (descending/level) adds
  // no climbing cost.
  elevationDeltaFeet: number;
  /** Absent/null: no crossing structure on this cell — every cost behaves
   * exactly as before this field existed. See CrossingType's own doc
   * comment for what each value suppresses. */
  crossing?: CrossingType | null;
}

// Difficult terrain and climbing are independent costs that stack: a cell
// that is both difficult terrain and a climb pays both penalties. A bridge
// waives only the terrain half; stairs waive only the climb half — the two
// structures are deliberately orthogonal, so a cell carrying either one
// (never both: the editor only ever places one object per cell) can't
// silently do the other's job too.
export function cellMovementCost({
  terrain,
  elevationDeltaFeet,
  crossing,
}: CellMovementParams): number {
  // A void cell cannot be entered at any price. Returning here (rather than
  // folding Infinity into horizontalCost) is just clarity — Infinity plus
  // any climb cost is still Infinity, so no elevation special-casing exists.
  // A crossing structure never overrides this: objects can't be placed on a
  // void cell in the first place (MapEditor.tsx's VOID_OBJECT_MESSAGE
  // guard), so this is a documented non-issue, not a gap.
  if (terrain === "void") return Infinity;
  const horizontalCost =
    terrain === "difficult" && crossing !== "bridge" ? FEET_PER_CELL * 2 : FEET_PER_CELL;
  // SRD climbing rule: 1 extra foot of movement per foot climbed, i.e. the
  // vertical portion costs double — waived entirely when stairs are
  // present, ascending or descending alike (descending is already free
  // below, so stairs only ever change the ascending case).
  const climbCost = crossing === "stairs" ? 0 : elevationDeltaFeet > 0 ? elevationDeltaFeet * 2 : 0;
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
  /** See CrossingType's doc comment above — a bridge/stairs object sitting
   * on THIS cell. Absent/null for every cell with no such object, which is
   * every cell on every map that predates this addition. */
  crossing?: CrossingType | null;
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
      crossing: cell.crossing,
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
  /** See PathCell.crossing's own doc comment — same optional, same default. */
  crossing?: CrossingType | null;
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
  /**
   * Movement Collision & Gated Interaction Checks: cells a placed map
   * OBJECT (a wall, a table, ...) physically occupies -- a HARD block,
   * unlike `occupiedCells` above. A blocked cell behaves exactly like void
   * terrain (see cellMovementCost's own doc comment): excluded from the
   * returned set entirely, AND never relaxed onward as a stepping stone to
   * whatever lies past it -- walking a token through a solid wall to reach
   * a cell on the far side is exactly as impossible as walking it through
   * void. This is the real difference from `occupiedCells`, which still
   * lets a path pass THROUGH an occupied cell at its ordinary cost; a
   * blocked cell never does. The origin is exempt from this filter too,
   * the same `occupiedCells` reasoning: a token already standing somewhere
   * (however it got there) can always "move" nowhere.
   */
  blockedCells?: readonly GridPoint[];
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
  const { origin, cells, budgetFeet, occupiedCells = [], blockedCells = [] } = params;

  const cellByKey = new Map<string, PathCell>();
  for (const cell of cells) {
    cellByKey.set(pointKey(cell.position), {
      terrain: cell.terrain,
      elevationSteps: cell.elevationSteps,
      crossing: cell.crossing,
    });
  }
  const cellAt = (point: GridPoint): PathCell => cellByKey.get(pointKey(point)) ?? OFF_GRID_CELL;

  const occupiedKeys = new Set(occupiedCells.map(pointKey));
  const blockedKeys = new Set(blockedCells.map(pointKey));
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
        // A blocked cell (a placed object, see blockedCells' own doc
        // comment) is exactly as impassable as void terrain -- funneled
        // through the SAME Infinity + Number.isFinite guard below, rather
        // than a separate `continue`, so it's never itself reachable and
        // never relaxed onward to whatever lies past it, at any budget
        // including an unbounded one.
        const edgeCostFeet = blockedKeys.has(neighborKey)
          ? Infinity
          : cellMovementCost({
              terrain: neighborCell.terrain,
              elevationDeltaFeet:
                (neighborCell.elevationSteps - currentElevationSteps) * FEET_PER_ELEVATION_STEP,
              crossing: neighborCell.crossing,
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

/**
 * `count` distinct grid points near `center`, for spreading a group that
 * would otherwise all land on the exact same cell — a whole party crossing
 * a map transition together, for instance, which previously stacked every
 * mover on the transition's single stored entry cell. A ring-by-ring
 * spiral search (the center cell itself first, then the 8-cell ring at
 * Chebyshev distance 1, then distance 2, and so on outward), skipping any
 * point the caller's `isBlocked` predicate rejects — typically: off the
 * map's edge, void terrain, or already occupied by an unrelated token — so
 * this stays a plain grid-geometry utility with no knowledge of what "the
 * map" or "occupied" actually mean; the caller composes those checks.
 *
 * Returns FEWER than `count` points only if the search exhausts a generous
 * radius (200 cells out) without finding enough open ground — a
 * pathologically small or void-choked map — so a caller must not assume
 * the result is always exactly `count` long.
 */
export function spreadPositionsAround(
  center: GridPoint,
  count: number,
  isBlocked: (point: GridPoint) => boolean
): GridPoint[] {
  const found: GridPoint[] = [];
  const seen = new Set<string>();
  const tryPoint = (point: GridPoint) => {
    if (found.length >= count) return;
    const key = pointKey(point);
    if (seen.has(key)) return;
    seen.add(key);
    if (isBlocked(point)) return;
    found.push(point);
  };

  tryPoint(center);
  for (let radius = 1; found.length < count && radius <= 200; radius++) {
    for (let x = center.x - radius; x <= center.x + radius && found.length < count; x++) {
      tryPoint({ x, y: center.y - radius });
      tryPoint({ x, y: center.y + radius });
    }
    for (let y = center.y - radius + 1; y <= center.y + radius - 1 && found.length < count; y++) {
      tryPoint({ x: center.x - radius, y });
      tryPoint({ x: center.x + radius, y });
    }
  }
  return found;
}
