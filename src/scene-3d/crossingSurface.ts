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
 * Design choice — a COMPUTED CONSTANT per crossing type, not a new
 * map_objects DB column: crossing_type is a closed two-value enum
 * ('bridge' | 'stairs', 0053's own CHECK constraint) where EVERY row of a
 * given value already resolves to the exact same one fixed,
 * procedurally-generated preset asset — MapEditor.tsx's own
 * crossingTypeForAsset only ever tags the ONE specific named "Bridge" or
 * "Stairs" preset at creation time; no custom/uploaded asset can ever carry
 * a crossing_type (see @/data-access's CrossingType doc comment). A DB
 * column would therefore hold the identical hardcoded value on every row of
 * a given type, forever — pure redundant duplication with no per-row
 * variation the app can ever produce. Deriving it here instead, from the
 * SAME real measured geometry PlacedObject.tsx's own PropModel fits at
 * render time (Box3 + PLACED_OBJECT_SIZE/maxDim), needs no migration and
 * can never drift from a stale seeded value re-applied at a different
 * migration version in a different environment.
 *
 * These constants are re-measured against the REAL generated
 * public/assets/presets/{bridge,stairs}.glb files by
 * scripts/db/verify-crossing-structure-height.mjs, which fails loudly if a
 * future regeneration of either preset (scripts/assets/generate-bridge-
 * preset.mjs / generate-map-presets.mjs) ever changes the geometry these
 * numbers were measured from — the same "must be recomputed the same way"
 * caveat PlacedObject.tsx's own WALL_FIT_TARGET_BY_URL comment already
 * carries for wall-family presets.
 */
export type CrossingSurfaceType = "bridge" | "stairs";

// ---------------------------------------------------------------------
// Bridge — scripts/assets/generate-bridge-preset.mjs's buildBridge().
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
// Stairs — scripts/assets/generate-map-presets.mjs's buildStairs().
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

// PlacedObject.tsx's own fit target for every preset that isn't a
// wall-family piece (WALL_FIT_TARGET_BY_URL) — bridge.glb and stairs.glb
// both fit here, so this is the SAME scale divisor PropModel actually
// applies at render time.
const FIT_SIZE = PLACED_OBJECT_SIZE;

const BRIDGE_SCALE = FIT_SIZE / BRIDGE_RAW_MAX_DIM;
const BRIDGE_SURFACE_HEIGHT = (BRIDGE_DECK_TOP_RAW_Y - BRIDGE_RAW_MIN_Y) * BRIDGE_SCALE;

const STAIRS_RAW_TOP_Y = STAIRS_STEP_RISE * STAIRS_STEP_COUNT; // 0.88
const STAIRS_RAW_MAX_DIM = STAIRS_STEP_RUN * STAIRS_STEP_COUNT; // 1.2 (the z-depth run, the model's largest dimension)
const STAIRS_SCALE = FIT_SIZE / STAIRS_RAW_MAX_DIM;
const STAIRS_SURFACE_HEIGHT = STAIRS_RAW_TOP_Y * STAIRS_SCALE;

const SURFACE_HEIGHT_BY_TYPE: Record<CrossingSurfaceType, number> = {
  bridge: BRIDGE_SURFACE_HEIGHT,
  stairs: STAIRS_SURFACE_HEIGHT,
};

/**
 * How far ABOVE this cell's own live-elevation floor a token/object
 * standing on a crossing structure's footprint should render — in the SAME
 * cell-relative units `MapSurfaceMetrics.cellSize` already scales
 * cell width/depth by (multiply by `cellSize`, exactly like the object
 * marker's own `scale={cellSize}` group scales the model itself), ADDED to
 * (never replacing) the existing `baseHeight + elevation * elevationStepHeight`
 * formula — the raw cell elevation is still what's rendered, this is
 * strictly additive on top of it. `null`/`undefined` (every cell with no
 * crossing structure, and every token/object before this feature) adds
 * exactly 0, rendering at exactly today's height.
 */
export function crossingSurfaceHeight(type: CrossingSurfaceType | null | undefined): number {
  return type ? SURFACE_HEIGHT_BY_TYPE[type] : 0;
}

/** The stairs flight's own constant incline angle (radians) — `atan(rise /
 * run)`, real geometry, not a tuned/eyeballed value. Exported for the
 * verify script's own real-measurement cross-check. */
export const STAIRS_SLOPE_RADIANS = Math.atan2(STAIRS_STEP_RISE, STAIRS_STEP_RUN);

/**
 * The pitch (radians, rotation about a token's own local X axis) a token
 * standing on a STAIRS footprint tilts by, before the yaw below reorients
 * that pitch axis to match the specific stairs object's own placement
 * rotation.
 *
 * Sign derivation: buildStairs() above rises along local +Z (step i's own z
 * center increases with i, and so does its height) — i.e. local +Z is this
 * model's own "uphill" direction before any placement rotation. Three.js's
 * rotation-about-+X convention maps a unit +Z vector to
 * (0, -sin(pitch), cos(pitch)): a POSITIVE pitch tips +Z DOWN (y
 * decreases), so tipping the uphill direction UP instead needs a NEGATIVE
 * pitch — hence the negation here, not STAIRS_SLOPE_RADIANS directly.
 */
export const STAIRS_TILT_PITCH_RADIANS = -STAIRS_SLOPE_RADIANS;
