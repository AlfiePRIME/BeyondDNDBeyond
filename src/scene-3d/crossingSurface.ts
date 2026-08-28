import { PLACED_OBJECT_SIZE } from "./PlacedObject";

/**
 * Bridges and stairs surface height + stairs tilt (a post-roadmap addition
 * building on 0053_crossing_structures.sql's map_objects.crossing_type) —
 * pure geometry derivation, no React/three.js scene graph here, mirroring
 * tokenSlide.ts's own "pure step, separate from the render-layer glue"
 * split.
 *
 * The bug this fixes: MapSurface.tsx's token/object Y-positioning
 * (`topY = baseHeight + elevation * elevationStepHeight`) reads only the
 * raw per-cell elevation — it has no idea that a crossing structure's own
 * GLB model occupies a DIFFERENT, higher Y range than that cell's bare
 * floor (a bridge's deck sits above its support posts' base; a stairway's
 * top tread sits well above its own bottom step). A token standing on that
 * cell today renders at the cell's bare floor height — inside/at-the-foot
 * of the model, not on the surface it's visually standing on.
 *
 * PRESET-AWARE, keyed by the crossing object's own resolved model URL — NOT
 * by the DB's crossing_type ('bridge' | 'stairs') alone. This module
 * originally keyed everything by crossing_type, back when crossing_type
 * and "which one fixed preset" were equivalent (every 'stairs' row was
 * necessarily THE ONE "Stairs" preset — MapEditor.tsx's own
 * crossingTypeForAsset only ever tagged that one named preset id). A second
 * stairs preset ("Stairs (Half)", 0082_stairs_half_preset.sql) broke that
 * equivalence: both stairs presets share the SAME crossing_type ('stairs',
 * since movement rules — the SRD climbing surcharge suppression — don't
 * care which stairs preset a DM picked), but they have DIFFERENT real
 * geometry (2 steps vs 4, different fit-scale factor since the half
 * preset's own max dimension is its width, not its run — see
 * STAIRS_HALF_RAW_MAX_DIM's own comment below) and therefore a DIFFERENT
 * real surface height. crossing_type alone can no longer answer "how tall
 * is the model actually standing under this token" — the object's own
 * model url can, and is exactly what MapSurface/GameRoom already resolve
 * for every object/token's own render (assetUrlById), so no new lookup
 * mechanism is needed, just a different key.
 *
 * These constants are re-measured against the REAL generated
 * public/assets/presets/{bridge,stairs,stairs-half}.glb files by
 * scripts/db/verify-crossing-structure-height.mjs, which fails loudly if a
 * future regeneration of any preset (scripts/assets/generate-bridge-
 * preset.mjs / generate-map-presets.mjs / generate-stairs-half-preset.mjs)
 * ever changes the geometry these numbers were measured from — the same
 * "must be recomputed the same way" caveat PlacedObject.tsx's own
 * WALL_FIT_TARGET_BY_URL comment already carries for wall-family presets
 * (whose own fit-target table is ALSO keyed by model url, the same
 * precedent this module now follows).
 */
export const BRIDGE_URL = "/assets/presets/bridge.glb";
export const STAIRS_URL = "/assets/presets/stairs.glb";
export const STAIRS_HALF_URL = "/assets/presets/stairs-half.glb";

// ---------------------------------------------------------------------
// Bridge — scripts/assets/generate-bridge-preset.mjs's buildBridge().
// Unchanged by the stairs-half addition.
// ---------------------------------------------------------------------
// The deck plank: `[new THREE.BoxGeometry(0.92, 0.06, 0.7), wood(), 0, 0.1, 0]`
// — a box of height 0.06 centered at y=0.1, so its own top face sits at
// raw y = 0.1 + 0.06/2 = 0.13. This is the ONLY walkable part of the
// model — the corner posts and handrails are decoration, not a surface a
// token stands on — so it is measured directly from the deck mesh alone,
// not from the whole model's bounding-box top (which is dominated by the
// handrails, well above the deck).
const BRIDGE_DECK_TOP_RAW_Y = 0.13;
// The model's own lowest point is the support posts' bottom, NOT the deck:
// `post = (x, z) => [CylinderGeometry(0.05, 0.06, 0.5, 8), iron(), x, -0.1, z]`
// — a cylinder of height 0.5 centered at y=-0.1, bottom at -0.1 - 0.25 =
// -0.35. PlacedObject.tsx's PropModel rebases the WHOLE model so its own
// measured bounding-box minimum lands at local y=0 (`offset = [...,
// -box.min.y*scale, ...]`), so every other point (including the deck top
// above) must be measured relative to THIS minimum, not to 0.
const BRIDGE_RAW_MIN_Y = -0.35;
// Real measured whole-model bounding box size.x (scripts/db/verify-
// crossing-structure-height.mjs) — the largest of the three dimensions,
// posts included (their x = ±0.46 plus their own ~0.06 radius reach
// slightly past the 0.92-wide deck on each side).
const BRIDGE_RAW_MAX_DIM = 1.04;

// ---------------------------------------------------------------------
// Stairs (full-height, unchanged) — generate-map-presets.mjs's buildStairs().
// ---------------------------------------------------------------------
// 4 full-height steps, each `BoxGeometry(1, height, 0.3)` with
// `height = 0.22 * (i + 1)` for i in [0, 3] — a constant slope: every step
// rises 0.22 over 0.3 of run, so the WHOLE flight (not just its two
// endpoints) shares one exact incline angle, used for the tilt below too.
// Unlike the bridge, the whole model's own top IS the walkable surface —
// the tallest (4th, i=3) step's own top face, at raw y = 0.22*4 = 0.88 —
// and its bottom (every step shares a common y=0 base) is already the
// model's own measured minimum, so no separate min-y correction is needed
// here the way the bridge's hanging support posts require above.
const STAIRS_STEP_RISE = 0.22;
const STAIRS_STEP_RUN = 0.3;
const STAIRS_STEP_COUNT = 4;

// ---------------------------------------------------------------------
// Stairs (Half) — scripts/assets/generate-stairs-half-preset.mjs's
// buildStairsHalf(): the SAME per-step rise/run as the full flight (a real
// short flight of stairs keeps the same riser/tread proportions as a
// longer one), just HALF AS MANY STEPS — 2, not 4 — so its total rise
// (0.44) is exactly half the full flight's (0.88): 1 terrain level where
// the existing preset is 2, per the project owner's own request.
// ---------------------------------------------------------------------
const STAIRS_HALF_STEP_RISE = 0.22;
const STAIRS_HALF_STEP_RUN = 0.3;
const STAIRS_HALF_STEP_COUNT = 2;

// PlacedObject.tsx's own fit target for every preset that isn't a
// wall-family piece (WALL_FIT_TARGET_BY_URL) — every one of these three
// presets fits here, so this is the SAME scale divisor PropModel actually
// applies at render time.
const FIT_SIZE = PLACED_OBJECT_SIZE;

const BRIDGE_SCALE = FIT_SIZE / BRIDGE_RAW_MAX_DIM;
const BRIDGE_SURFACE_HEIGHT = (BRIDGE_DECK_TOP_RAW_Y - BRIDGE_RAW_MIN_Y) * BRIDGE_SCALE;

const STAIRS_RAW_TOP_Y = STAIRS_STEP_RISE * STAIRS_STEP_COUNT; // 0.88
const STAIRS_RAW_MAX_DIM = STAIRS_STEP_RUN * STAIRS_STEP_COUNT; // 1.2 (the z-depth run, the model's largest dimension)
const STAIRS_SCALE = FIT_SIZE / STAIRS_RAW_MAX_DIM;
const STAIRS_SURFACE_HEIGHT = STAIRS_RAW_TOP_Y * STAIRS_SCALE;

const STAIRS_HALF_RAW_TOP_Y = STAIRS_HALF_STEP_RISE * STAIRS_HALF_STEP_COUNT; // 0.44
// UNLIKE the full flight, the half flight's own largest dimension is its
// WIDTH (1, buildStairsHalf()'s own unchanged `BoxGeometry(1, height, run)`
// x-size), not its run: 2 steps * 0.3 run = 0.6 < 1. Real measured
// (scripts/db/verify-crossing-structure-height.mjs, a fresh GLTFLoader
// Box3 of the actual generated stairs-half.glb) — NOT assumed from the
// formula alone, exactly the caveat this module's own top comment
// promises. This makes the half preset WIDTH-constrained rather than
// depth-constrained, giving it a larger fit-scale factor (less shrinkage)
// than the full flight.
const STAIRS_HALF_RAW_MAX_DIM = 1;
const STAIRS_HALF_SCALE = FIT_SIZE / STAIRS_HALF_RAW_MAX_DIM;
const STAIRS_HALF_SURFACE_HEIGHT = STAIRS_HALF_RAW_TOP_Y * STAIRS_HALF_SCALE;

const SURFACE_HEIGHT_BY_URL: Record<string, number> = {
  [BRIDGE_URL]: BRIDGE_SURFACE_HEIGHT,
  [STAIRS_URL]: STAIRS_SURFACE_HEIGHT,
  [STAIRS_HALF_URL]: STAIRS_HALF_SURFACE_HEIGHT,
};

/**
 * How far ABOVE this cell's own live-elevation floor a token/object
 * standing on a crossing structure's footprint should render — in the SAME
 * cell-relative units `MapSurfaceMetrics.cellSize` already scales
 * cell width/depth by (multiply by `cellSize`, exactly like the object
 * marker's own `scale={cellSize}` group scales the model itself), ADDED to
 * (never replacing) the existing `baseHeight + elevation * elevationStepHeight`
 * formula — the raw cell elevation is still what's rendered, this is
 * strictly additive on top of it. `null`/`undefined`/any url that isn't one
 * of the three known crossing presets above adds exactly 0, rendering at
 * exactly today's height — every cell with no crossing structure, and
 * every token/object before this feature, included.
 *
 * `url` is the crossing object's own resolved model url (asset_library's
 * model_ref for a preset) — the SAME url MapSurface/GameRoom already
 * resolve for rendering that object's model, not a new lookup.
 */
export function crossingSurfaceHeight(url: string | null | undefined): number {
  return url ? (SURFACE_HEIGHT_BY_URL[url] ?? 0) : 0;
}

/** The full-height stairs flight's own constant incline angle (radians) —
 * `atan(rise / run)`, real geometry, not a tuned/eyeballed value. Exported
 * for the verify script's own real-measurement cross-check. */
export const STAIRS_SLOPE_RADIANS = Math.atan2(STAIRS_STEP_RISE, STAIRS_STEP_RUN);

/**
 * The pitch (radians, rotation about a token's own local X axis) a token
 * standing on the FULL-HEIGHT STAIRS footprint tilts by, before the yaw
 * reorients that pitch axis to match the specific stairs object's own
 * placement rotation.
 *
 * Sign derivation: buildStairs() rises along local +Z (step i's own z
 * center increases with i, and so does its height) — i.e. local +Z is this
 * model's own "uphill" direction before any placement rotation. Three.js's
 * rotation-about-+X convention maps a unit +Z vector to
 * (0, -sin(pitch), cos(pitch)): a POSITIVE pitch tips +Z DOWN (y
 * decreases), so tipping the uphill direction UP instead needs a NEGATIVE
 * pitch — hence the negation here, not STAIRS_SLOPE_RADIANS directly. This
 * is also exactly "perpendicular to the slope, facing uphill" — the
 * physically-correct way to stand on an incline (a token's local +Y axis
 * ends up parallel to the ramp surface's own normal); confirmed both by
 * hand (Rx/Ry matrix algebra) and by a real three.js computation of where
 * an authored directional model's own front-facing geometry (e.g.
 * generate-monster-presets.mjs's buildGoblin(), whose eyes/blade sit at
 * local +Z) ends up in world space after this exact transform: it lands on
 * the SAME side as the stairs object's own real, rotated uphill end, for
 * every one of the object's 4 placement rotations (0/90/180/270) — see
 * this prompt's own final report for the full investigation. There is NO
 * sign to "fix" here for the reported pawn-orientation bug; see
 * crossingTiltPitchRadians's own doc comment for where the REAL gap was
 * found instead.
 */
export const STAIRS_TILT_PITCH_RADIANS = -STAIRS_SLOPE_RADIANS;

/** The half-height stairs flight's own constant incline angle (radians) —
 * measured the same way as STAIRS_SLOPE_RADIANS. Uses the IDENTICAL
 * rise/run ratio as the full flight (see buildStairsHalf()'s own top
 * comment for why), so this happens to equal STAIRS_SLOPE_RADIANS exactly
 * — a real, measured consequence of that geometry choice, not an
 * assumption; a differently-proportioned half preset would NOT necessarily
 * share this angle, which is exactly why this is its own independent
 * measured constant rather than a reference to the full flight's. */
export const STAIRS_HALF_SLOPE_RADIANS = Math.atan2(STAIRS_HALF_STEP_RISE, STAIRS_HALF_STEP_RUN);

/** The half-height stairs' own tilt pitch — see STAIRS_TILT_PITCH_RADIANS's
 * own doc comment for the sign derivation, identical reasoning applied to
 * this preset's own (here, numerically identical) slope angle. */
export const STAIRS_HALF_TILT_PITCH_RADIANS = -STAIRS_HALF_SLOPE_RADIANS;

const TILT_PITCH_RADIANS_BY_URL: Record<string, number> = {
  [STAIRS_URL]: STAIRS_TILT_PITCH_RADIANS,
  [STAIRS_HALF_URL]: STAIRS_HALF_TILT_PITCH_RADIANS,
  // bridge.glb deliberately absent: a bridge's deck is flat — see
  // isStairsPresetUrl's own doc comment for why a bridge never tilts.
};

/**
 * The real, measured tilt-pitch magnitude (radians) for the SPECIFIC
 * stairs preset `url` names, or 0 for anything else (a bridge, no crossing
 * structure, or an unrecognized url) — resolves by which stairs preset a
 * given crossing-structure object actually uses, not a single hardcoded
 * stairs constant, so the half-height preset's own (here numerically
 * identical, but independently measured) incline angle is what a token
 * standing on IT actually tilts by, never accidentally reusing a different
 * preset's constant.
 */
export function crossingTiltPitchRadians(url: string | null | undefined): number {
  return url ? (TILT_PITCH_RADIANS_BY_URL[url] ?? 0) : 0;
}

/**
 * True for either stairs preset's own model url (matched structurally by
 * url, the same PlacedObject.tsx's isWallFamilyUrl/isBuildingPresetUrl
 * precedent) — false for the bridge, no crossing structure, or any other
 * url. A bridge's own deck is flat (BRIDGE_DECK_TOP_RAW_Y is a single,
 * level plank) — only a stairs-family preset's incline ever tilts a token
 * standing on it; this is the single source of truth MapSurface.tsx's own
 * "does this token tilt at all" gate reads, so a future third stairs
 * variant only needs a new TILT_PITCH_RADIANS_BY_URL entry, not a second
 * gate to keep in sync.
 */
export function isStairsPresetUrl(url: string | null | undefined): boolean {
  return url !== null && url !== undefined && Object.hasOwn(TILT_PITCH_RADIANS_BY_URL, url);
}
