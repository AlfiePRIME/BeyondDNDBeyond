import { gridDistanceFeet, type GridPoint } from "./movement";

// Pure perception/vision rules engine (Prompt 56): given an observer's
// position, their vision capability (darkvision range, and whether a
// condition currently blocks their vision outright), and a cell's ambient
// light plus whatever resolved light sources reach it, what visibility
// tier does the observer get on that cell? DB-free like quickActions.ts/
// opportunityAttacks.ts — the caller (a future Game Room/map-rendering
// layer, Prompt 58) resolves every object/token-anchored light source to a
// concrete position first (this module has no idea what a map_objects row
// or a token is), exactly like computeQuickActions/computeOpportunityAttacks
// take pre-resolved hostile/target positions rather than looking them up.
//
// The condition override is generic by construction, not by a special
// case: `ObserverVision.visionBlocked` is a plain boolean the CALLER
// derives from the real mechanism (whatever active `combatant_conditions`
// row has a catalog `ConditionEffects.blocksVision: true` — see
// srd/conditions.ts, Prompt 47). This module never reads a condition key,
// a condition catalog, or any condition's name — any condition
// that carries (or ever gains) `blocksVision: true` produces identical
// behavior here for free, with zero changes to this file. That is the
// "per-condition vision effect property" the task asks for; it already
// existed (Prompt 47) and is reused verbatim rather than duplicated.
//
// Wall/line-of-sight blocking is explicitly OUT of scope here (the future
// upgrade Prompt 55's LOS flag on map objects is laid for) — only light,
// range, and the condition override are resolved.
//
// The darkvision-in-darkness rule below is a DELIBERATE simplification,
// specified exactly as written in the task text rather than "corrected"
// toward stricter SRD nuance: RAW, darkvision technically renders
// darkness as dim light (not bright), so a darkvision creature in total
// darkness is, strictly, in the same "dim" boat as a torch-lit patch —
// dimly perceived, not fully. This engine instead upgrades BOTH dim and
// dark cells straight to "full" once within darkvision range, matching
// the task's own house-rule-style framing ("darkvision treats darkness as
// dim light" used to justify FULL visibility). Implemented as specified,
// not inferred or corrected.

export type VisibilityTier = "full" | "dim" | "none";

/**
 * Mirrors data-access/maps.ts's `LightLevel` (`LIGHT_LEVELS`,
 * migration 0036) structurally, three values ordered bright > dim > dark.
 * rules-engine cannot import data-access (module boundary,
 * eslint-plugin-boundaries) — the same reason `QuickActionInventoryItem`
 * mirrors `InventoryItem` instead of importing it. A `MapCell.light_level`
 * value is directly assignable here with zero conversion; keep this in
 * sync with `LIGHT_LEVELS` if that vocabulary ever grows.
 */
export type CellLightLevel = "bright" | "dim" | "dark";

const LIGHT_RANK: Record<CellLightLevel, number> = { dark: 0, dim: 1, bright: 2 };

/**
 * A light source already resolved to a concrete map position — mirrors
 * data-access/lightSources.ts's `LightSource` structurally (same boundary
 * reason as `CellLightLevel` above), but flattened to exactly what this
 * engine needs: nothing here knows about `map_id`, the three-way
 * cell/object/token anchor XOR, or how to look one up. The caller resolves
 * an object- or token-anchored light to its carrier's current position
 * every time this runs, the same way a carried torch's light moves with
 * whoever's holding it.
 */
export interface ResolvedLightSource {
  position: GridPoint;
  radiusFeet: number;
  /** Matches `LightSource.brightness` (`LightSourceBrightness`) — a light
   * source is never itself "dark", only bright or dim. */
  brightness: "bright" | "dim";
}

/**
 * The observer-side inputs this engine needs — mirrors
 * `Character.darkvision_feet` plus a caller-derived condition summary.
 */
export interface ObserverVision {
  /** `Character.darkvision_feet`, verbatim: null is normal vision only, a
   * number is the darkvision range in feet. */
  darkvisionFeet: number | null;
  /** True when any of the observer's currently active conditions carries
   * `ConditionEffects.blocksVision: true` (Prompt 47's blinded, petrified,
   * and unconscious all already do). The caller resolves this from its own
   * `combatant_conditions` lookup against the `CONDITIONS` catalog — this
   * module stays DB-free and generic, and never inspects a condition key
   * itself. */
  visionBlocked: boolean;
}

export interface ComputeVisibilityTierParams {
  observerPosition: GridPoint;
  vision: ObserverVision;
  cellPosition: GridPoint;
  cellAmbientLight: CellLightLevel;
  lightSources: readonly ResolvedLightSource[];
}

/**
 * A cell's effective light level: the brightest of its own authored
 * ambient value and every resolved light source's contribution whose
 * radius reaches it (`gridDistanceFeet(source.position, cellPosition) <=
 * source.radiusFeet`, the same inclusive meets-it-counts convention every
 * range query in this module uses). Light only ever brightens a cell
 * relative to its ambient value — it never darkens one — and when several
 * sources overlap, the single brightest applicable contribution wins, not
 * the closest source or the last one in the input array. A source whose
 * radius doesn't reach the cell contributes nothing, however bright it is.
 */
export function effectiveLightLevel(
  cellPosition: GridPoint,
  cellAmbientLight: CellLightLevel,
  lightSources: readonly ResolvedLightSource[]
): CellLightLevel {
  let brightest = cellAmbientLight;
  for (const source of lightSources) {
    if (gridDistanceFeet(source.position, cellPosition) > source.radiusFeet) continue;
    if (LIGHT_RANK[source.brightness] > LIGHT_RANK[brightest]) {
      brightest = source.brightness;
    }
  }
  return brightest;
}

/**
 * The visibility tier one observer gets on one cell.
 *
 * 1. `vision.visionBlocked` short-circuits everything: `"none"` for this
 *    cell (and, by construction, every cell — a blocked observer gets
 *    `"none"` back regardless of what's passed for light/range), full
 *    stop. This is the ONLY thing that overrides the light/range
 *    computation below.
 * 2. Otherwise, resolve the cell's effective light level
 *    (`effectiveLightLevel`, ambient plus any reaching light sources).
 * 3. Bright effective light is `"full"` for anyone who can see at all
 *    (darkvision or not — darkvision never demotes bright light). Dim or
 *    dark effective light is `"full"` when the cell is within the
 *    observer's darkvision range (`vision.darkvisionFeet !== null &&
 *    gridDistanceFeet(observerPosition, cellPosition) <=
 *    vision.darkvisionFeet`) — see the module-level comment on why dark
 *    upgrades all the way to `"full"` rather than the stricter RAW `"dim"`
 *    — else dim light is `"dim"` and darkness is `"none"`.
 */
export function computeVisibilityTier(params: ComputeVisibilityTierParams): VisibilityTier {
  const { observerPosition, vision, cellPosition, cellAmbientLight, lightSources } = params;

  if (vision.visionBlocked) return "none";

  const effective = effectiveLightLevel(cellPosition, cellAmbientLight, lightSources);
  if (effective === "bright") return "full";

  const withinDarkvision =
    vision.darkvisionFeet !== null &&
    gridDistanceFeet(observerPosition, cellPosition) <= vision.darkvisionFeet;

  if (effective === "dim") return withinDarkvision ? "full" : "dim";
  return withinDarkvision ? "full" : "none"; // effective === "dark"
}

/** One cell or token to resolve, tagged with whatever opaque id the caller
 * already indexes it by (an "x,y" map-cell key, a token id, ...) — passed
 * through unchanged in the result, the same `tokenId`-in/`tokenId`-out
 * shape `QuickActionTargetInput`/`QuickAction.targetTokenIds` uses. */
export interface VisibilityCellInput {
  id: string;
  position: GridPoint;
  ambientLight: CellLightLevel;
}

export interface VisibilityResult {
  id: string;
  tier: VisibilityTier;
}

export interface ComputeVisibilityTiersParams {
  observerPosition: GridPoint;
  vision: ObserverVision;
  lightSources: readonly ResolvedLightSource[];
  cells: readonly VisibilityCellInput[];
}

/**
 * The bulk form of `computeVisibilityTier`: one observer against every
 * cell/token position they might care about in a single call — the shape
 * Prompt 58 needs to sweep a map's full cell grid (and every token's
 * position, which is just another `{id, position, ambientLight}` — a
 * token's cell) in one pass per observer. Input order is preserved, one
 * result per input cell, exactly like `computeQuickActions`/
 * `computeOpportunityAttacks` preserve their callers' input order.
 */
export function computeVisibilityTiers(
  params: ComputeVisibilityTiersParams
): VisibilityResult[] {
  const { observerPosition, vision, lightSources, cells } = params;
  return cells.map((cell) => ({
    id: cell.id,
    tier: computeVisibilityTier({
      observerPosition,
      vision,
      cellPosition: cell.position,
      cellAmbientLight: cell.ambientLight,
      lightSources,
    }),
  }));
}
