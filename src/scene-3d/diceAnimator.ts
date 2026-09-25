import { Euler, Quaternion, Vector3, type BufferGeometry } from "three";
import {
  DIE_FACE_NORMALS,
  DIE_SIZE,
  buildDieGeometry,
  dieKindForSides,
  facePlaneDistance,
  faceNormalForResult,
  type DieKind,
} from "./diceGeometry";

/** One physical die's roll input, already flattened out of whatever
 * roll_log breakdown shape produced it (the app layer's job — see
 * src/app/campaigns/[id]/roll/tumble.ts's buildDiceTumbleSpec). `id` is
 * unique per die PER ROLL (not just per roll) — two d6s in the same "2d6"
 * roll need independent tumbles, not mirrored ones, so it doubles as this
 * module's determinism seed. */
export interface DiceTumbleDieSpec {
  id: string;
  sides: number;
  result: number;
  /** Overrides diceGeometry.ts's DEFAULT_FACE_LABELS[kind] for this one
   * die's printed face decals AND its ResultBadge text (both read through
   * labelForResult, so they stay in agreement regardless of this field).
   * Absent for every ordinary die; today's one real user is a percentile
   * pair's own synthetic-1-10-indexed tens/ones face labels
   * (src/app/campaigns/[id]/roll/tumble.ts's buildDiceTumbleSpec) —
   * see docs/design/dice-numbers-and-physics.md §5. */
  labelSet?: readonly string[];
}

export type DiceAnimationPhase = "tumbling" | "settled";

export interface DicePose {
  position: readonly [number, number, number];
  /** Euler XYZ radians. */
  rotation: readonly [number, number, number];
  settled: boolean;
  /** SP8 (docs/design/dice-numbers-and-physics.md's own physics seam,
   * reused rather than re-invented): true on the exact frame(s) this die
   * was involved in a REAL Rapier collision-started event during this
   * step — the tray floor, a wall, or another die in the same roll. Always
   * false for scriptedDiceAnimator (no real collisions to report — see its
   * own step() below) and for physicsDiceAnimator before the WASM engine
   * has loaded (the defensive scriptedDiceAnimator delegation further
   * down). This is the RAW per-frame signal, deliberately never debounced
   * or rate-limited here — a real chaotic bounce phase can legitimately
   * report true on several close-together frames as a die catches, tips,
   * and re-catches. A caller wanting to trigger a sound on it
   * (useDiceTumble's own onImpact callback) owns its own throttling — see
   * DiceTumble.tsx's Die component, which is where that policy actually
   * lives. */
  impacted: boolean;
}

/**
 * The seam the physics upgrade below plugs into. Every caller (useDiceTumble
 * below, and transitively DiceTumble.tsx / the DiceLogPanel-GameRoom
 * trigger wiring) depends on nothing but this interface — a pure function
 * of (spec, elapsed seconds) → pose, with no React and no three.js scene
 * access. That purity is deliberate, the same injectable-seam shape as
 * rules-engine/dice.ts's RandomSource: it's what makes `scriptedDiceAnimator`
 * below unit-testable with plain assertions, and it's what `physicsDiceAnimator`
 * (further below) preserves to drop in as a straight replacement — stepping a
 * real `@dimforge/rapier3d-compat` physics world forward by `elapsedSeconds`
 * and reading the settling body's transform back out, still returning the
 * same `DicePose` shape, with zero changes to useDiceTumble, DiceTumble.tsx,
 * DiceLogPanel, or GameRoom. Swapping implementations is therefore choosing
 * which object a caller (DiceTumble.tsx's `pickDiceAnimator` call) points at,
 * not rewriting any call site. Unlike `scriptedDiceAnimator`, a physics-backed
 * implementation is unavoidably stateful (a live physics world persists
 * across calls) — see `physicsDiceAnimator`'s own doc comment for how that
 * statefulness is scoped and disposed of.
 *
 * `scriptedDiceAnimator` (this file) is deliberately NOT physics — no
 * collision, no mass — and stays exactly as it was before physics existed:
 * `physicsDiceAnimator`'s own per-roll cap (`MAX_PHYSICS_DICE_PER_ROLL`,
 * docs/design/dice-numbers-and-physics.md §9) falls back to it wholesale for
 * a roll with too many dice, or before the WASM engine has finished loading
 * (`pickDiceAnimator`'s own doc comment), so scriptedDiceAnimator remains a
 * real, load-bearing code path, not legacy scaffolding to delete.
 */
export interface DiceAnimator {
  step(spec: DiceTumbleDieSpec, elapsedSeconds: number): DicePose;
}

// Airborne tumble, then ease into the settle pose; SETTLE_SECONDS is the
// total time until `settled` flips true.
const TUMBLE_SECONDS = 0.55;
const SETTLE_SECONDS = 0.85;

// A die's starting point (before it eases toward its rest spot) sits this
// far from the tray's own center, in tray-local units — exported (not just
// module-private) so DiceTumble.tsx's trayRadiusForScale can derive a
// tray's real physical footprint from the SAME two numbers this animator
// actually uses, instead of a hand-copied duplicate of "0.42" that could
// silently drift from them. See spinQuaternionAt/the tumble step below for
// where these feed into the actual position math.
export const DICE_START_RADIUS_BASE = 0.28;
export const DICE_START_RADIUS_JITTER = 0.14;

// Where a die's local origin sits once at rest, in tray-local units — half
// a die's rendered size above the tray surface, roughly (exact per-shape
// half-extents vary slightly; one constant reads fine at this scale).
const REST_HEIGHT = 0.12;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// A tiny deterministic string hash (FNV-1a) — NOT cryptographic, just needs
// to spread `id` strings across [0, 1) consistently on every client so the
// same roll id always produces the same tumble everywhere, matching the
// broadcast's "same payload, same animation" requirement without shipping
// per-die randomness over the wire.
function seedFor(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

function spinQuaternionAt(seconds: number, seedA: number, seedB: number, seedC: number): Quaternion {
  const speed = 6 + seedA * 5;
  return new Quaternion().setFromEuler(
    new Euler(
      seconds * speed * (0.6 + seedB * 0.7),
      seconds * speed,
      seconds * speed * (0.4 + seedC * 0.8)
    )
  );
}

/**
 * A fixed, keyframed tumble-and-settle curve: fast multi-axis spin while
 * the die arcs from a scattered starting point toward the tray's rest spot,
 * then eases (position bounce, rotation slerp) into the pose that puts the
 * server-resolved face's real modeled normal (diceGeometry's
 * DIE_FACE_NORMALS) toward world +Y. Deliberately NOT physics — no
 * collision, no mass, no rigid body — cheap, stateless, and always available,
 * which is exactly why `physicsDiceAnimator` (below) falls back to this
 * verbatim implementation whenever a roll is above MAX_PHYSICS_DICE_PER_ROLL
 * or the WASM physics engine hasn't finished loading yet, rather than this
 * being legacy scaffolding physics superseded.
 */
export const scriptedDiceAnimator: DiceAnimator = {
  step(spec, elapsedSeconds) {
    const seedA = seedFor(spec.id);
    const seedB = seedFor(`${spec.id}:b`);
    const seedC = seedFor(`${spec.id}:c`);

    const startAngle = seedA * Math.PI * 2;
    const startRadius = DICE_START_RADIUS_BASE + seedB * DICE_START_RADIUS_JITTER;
    const startX = Math.cos(startAngle) * startRadius;
    const startZ = Math.sin(startAngle) * startRadius;
    const restX = (seedB - 0.5) * 0.16;
    const restZ = (seedC - 0.5) * 0.16;
    const posT = easeOutCubic(Math.min(elapsedSeconds / TUMBLE_SECONDS, 1));
    const x = startX + (restX - startX) * posT;
    const z = startZ + (restZ - startZ) * posT;

    let y = REST_HEIGHT;
    if (elapsedSeconds < TUMBLE_SECONDS) {
      const arcT = elapsedSeconds / TUMBLE_SECONDS;
      y = REST_HEIGHT + Math.sin(arcT * Math.PI) * 0.35;
    } else {
      const bounceT = Math.min(
        (elapsedSeconds - TUMBLE_SECONDS) / (SETTLE_SECONDS - TUMBLE_SECONDS),
        1
      );
      const bounce = Math.abs(Math.sin(bounceT * Math.PI * 2.4)) * 0.08 * (1 - bounceT);
      y = REST_HEIGHT + bounce;
    }

    const kind = dieKindForSides(spec.sides);
    const targetNormal = kind ? faceNormalForResult(kind, spec.result) : ([0, 1, 0] as const);
    const targetQuaternion = new Quaternion().setFromUnitVectors(
      new Vector3(...targetNormal),
      new Vector3(0, 1, 0)
    );

    let quaternion: Quaternion;
    if (elapsedSeconds < TUMBLE_SECONDS) {
      quaternion = spinQuaternionAt(elapsedSeconds, seedA, seedB, seedC);
    } else {
      const settleT = easeOutCubic(
        Math.min((elapsedSeconds - TUMBLE_SECONDS) / (SETTLE_SECONDS - TUMBLE_SECONDS), 1)
      );
      quaternion = spinQuaternionAt(TUMBLE_SECONDS, seedA, seedB, seedC).slerp(
        targetQuaternion,
        settleT
      );
    }
    const euler = new Euler().setFromQuaternion(quaternion);

    return {
      position: [x, y, z],
      rotation: [euler.x, euler.y, euler.z],
      settled: elapsedSeconds >= SETTLE_SECONDS,
      impacted: false,
    };
  },
};

// =============================================================================
// Physics-backed DiceAnimator (docs/design/dice-numbers-and-physics.md §6-§9).
//
// Library: @dimforge/rapier3d-compat, used directly (its imperative
// World/RigidBodyDesc/ColliderDesc API), NOT @react-three/rapier's JSX layer
// — the spike's own §6 reasoning: nothing about this DiceAnimator seam is
// declarative, and @react-three/rapier's whole value-add is its React
// component tree, which has no role to play behind a plain
// step(spec, elapsedSeconds) function.
//
// Reconciliation: real, unconstrained physics for the tumble, blended
// smoothly into the exact guaranteed-correct target orientation
// (faceNormalForResult) over a short settle window — the spike's §7 "option
// (b)". The physics phase's own natural outcome is NEVER consulted for
// correctness; only its LIVE pose at one fixed transition instant becomes the
// slerp/lerp's starting point. This is the one property this whole module
// exists to guarantee: however chaotic or "wrong-looking" the mid-air tumble
// gets, the settle always blends into faceNormalForResult(kind, spec.result)
// exactly, every single time.
// =============================================================================

/**
 * Lazily loaded — the WASM module is a real, multi-hundred-KB download
 * (docs/design/dice-numbers-and-physics.md §6's own measured artifact sizes)
 * that only a client actually opening a Game Room with dice should ever fetch,
 * never something every route's initial bundle pays for.
 */
type RapierNamespace = typeof import("@dimforge/rapier3d-compat");

let rapierModule: RapierNamespace | null = null;
let rapierLoadPromise: Promise<RapierNamespace> | null = null;

/**
 * Kicks off loading + WASM-initializing the physics engine, if not already
 * in flight — idempotent (a plain guard on `rapierLoadPromise`), so every
 * connected member's own DiceTumble mount effect can call this without
 * double-fetching. Fire-and-forget by design: nothing here needs to be
 * awaited by a caller, since `pickDiceAnimator` below just checks
 * `isDicePhysicsReady()` synchronously and falls back to
 * `scriptedDiceAnimator` for any roll that starts before this resolves —
 * there is no mid-roll "wait for physics" state to design around.
 */
export function preloadDicePhysics(): void {
  if (rapierLoadPromise) return;
  rapierLoadPromise = import("@dimforge/rapier3d-compat").then(async (mod) => {
    await mod.init();
    rapierModule = mod;
    return mod;
  });
  rapierLoadPromise.catch((error: unknown) => {
    // A real (if unlikely) failure mode — a browser without WASM support, a
    // network hiccup loading the module. isDicePhysicsReady() simply stays
    // false forever in that session, so every roll keeps using
    // scriptedDiceAnimator — never a crash, and never a chance of a
    // half-initialized physics engine producing a wrong-looking die (the
    // one non-negotiable correctness property this entire feature has).
    console.error("Dice physics engine failed to load; using the scripted dice animator instead.", error);
  });
}

/** Synchronous readiness check — see preloadDicePhysics's own doc comment. */
export function isDicePhysicsReady(): boolean {
  return rapierModule !== null;
}

// docs/design/dice-numbers-and-physics.md §9's own recommended STARTING
// point was ~20-24 (matching the fall-damage mechanic's own 20d6
// SRD-derived cap, docs/design/pits-and-falling.md), explicitly flagged
// there as "a starting recommendation, not a measured number... may be
// lowered once real numbers exist." scripts/perf/dice-physics-benchmark.mjs
// (the real, GPU-backed, 10-concurrent-tray Playwright measurement that
// spec itself calls for) found the ~20-24 estimate genuinely too high: the
// dominant cost at that dice count turns out to be RENDERING that many
// simultaneous decaled dice meshes (confirmed directly — forcing
// scriptedDiceAnimator, i.e. zero physics at all, for the same 240-die
// worst case already measured ~33ms/frame, right at perf-budgets.json's own
// render3d budget, before physics added anything), not physics computation
// itself (a raw, render-free Node micro-benchmark of the same 240-body/
// 10-world configuration measured well under 3ms/frame of pure physics).
// 8 is the real measured value: 10 concurrent trays × 8 dice each (80
// total, the worst case this cap allows) measured ~30-31ms average frame
// time on a real GPU-backed RTX 4060 Ti sandbox, matching perf-budgets.json's
// own baseline hardware — comfortably under the 33.3ms budget with real
// margin, where 10 and 12 measured right at or over budget (~32-35ms) on
// the same hardware. Still generous for any legitimate D&D roll (the design
// spike's own words: "1-2 d20s, a handful of damage dice, rarely double
// digits even for a big spell") — only a deliberately pathological freeform
// roll ever reaches this cap at all. A roll above this count falls back to
// scriptedDiceAnimator for its ENTIRE tumble (never a partial mix) — decided
// once per roll by `pickDiceAnimator`'s own doc comment, the same "swap
// which object a caller points at" mechanism this file's own DiceAnimator
// interface doc comment describes, just resolved per-roll instead of
// module-globally.
export const MAX_PHYSICS_DICE_PER_ROLL = 8;

/**
 * Chooses which DiceAnimator a whole roll should use — called once per roll
 * (DiceTumble.tsx's own `animator` useMemo, keyed on the active roll), never
 * per die or per frame, so a roll's dice always share the same animator for
 * their entire tumble. Falls back to `scriptedDiceAnimator` for two
 * independent reasons, both "the whole roll", never a partial mix:
 * `dieCount` above `MAX_PHYSICS_DICE_PER_ROLL` (§9's performance cap), or the
 * WASM physics engine not yet having finished loading in this session
 * (`isDicePhysicsReady()` — see preloadDicePhysics's own doc comment). Pure
 * (no side effects, does not itself trigger loading) — DiceTumble.tsx's own
 * mount effect is what calls `preloadDicePhysics()`.
 */
export function pickDiceAnimator(dieCount: number): DiceAnimator {
  if (!Number.isFinite(dieCount) || dieCount < 1 || dieCount > MAX_PHYSICS_DICE_PER_ROLL) {
    return scriptedDiceAnimator;
  }
  return isDicePhysicsReady() ? physicsDiceAnimator : scriptedDiceAnimator;
}

// ---- Tray boundary (§11's explicit non-goal: a simple analytic collider,
// never a custom tray model's own real geometry) ----

// Sized off this module's own DICE_START_RADIUS_BASE/JITTER (the scripted
// animator's existing single source of truth for "how far a die travels from
// tray center") plus a margin, rather than a hand-picked literal that could
// silently drift from them.
const PHYSICS_TRAY_RADIUS = DICE_START_RADIUS_BASE + DICE_START_RADIUS_JITTER + 0.18;
const PHYSICS_WALL_HEIGHT = 0.32;
// A circular wall approximated by a ring of flat box colliders — Rapier has
// no native "hollow cylinder" primitive, so this is the standard technique
// for a round boundary. 12 segments still reads as round at this tray's
// small radius (confirmed against real screenshots) while meaningfully
// cutting broad-phase collision-candidate-pair count versus a finer ring —
// scripts/perf/dice-physics-benchmark.mjs's own real measurement showed a
// 20-segment ring roughly DOUBLING per-frame physics cost versus 12 for no
// visible benefit, real budget that matters directly for MAX_PHYSICS_DICE_
// PER_ROLL's own worst-case headroom (§9).
const PHYSICS_WALL_SEGMENTS = 12;

/** Builds one roll's physics world's own static floor + wall — every roll
 * gets an identical boundary regardless of which tray model a member has
 * actually chosen to render (docs/design/dice-numbers-and-physics.md §11).
 * SP8: every collider here also opts into COLLISION_EVENTS (the floor and
 * every wall segment are real, audible impact surfaces — a die's very
 * first landing is almost always against the floor, not another die) so
 * physicsDiceAnimator's own event-draining loop (below) sees a genuine
 * "started" event the instant a die's collider first touches down. */
function buildTrayBoundary(Rapier: RapierNamespace, world: InstanceType<RapierNamespace["World"]>): void {
  const body = world.createRigidBody(Rapier.RigidBodyDesc.fixed());

  const floor = Rapier.ColliderDesc.cylinder(0.01, PHYSICS_TRAY_RADIUS)
    .setTranslation(0, -0.01, 0)
    .setFriction(0.8)
    .setRestitution(0.2)
    .setActiveEvents(Rapier.ActiveEvents.COLLISION_EVENTS);
  world.createCollider(floor, body);

  for (let i = 0; i < PHYSICS_WALL_SEGMENTS; i++) {
    const angle = (i / PHYSICS_WALL_SEGMENTS) * Math.PI * 2;
    const nextAngle = ((i + 1) / PHYSICS_WALL_SEGMENTS) * Math.PI * 2;
    const midAngle = (angle + nextAngle) / 2;
    const chordLength = 2 * PHYSICS_TRAY_RADIUS * Math.sin(Math.PI / PHYSICS_WALL_SEGMENTS);
    // A box's own local +X axis needs to point along this segment's tangent
    // direction, not radially outward — rotating a default box by
    // (midAngle + PI/2) around Y achieves exactly that (the same
    // setFromUnitVectors-adjacent "orient this local axis toward a computed
    // world direction" family of technique this file's own targetQuaternion
    // math and DiceTumble.tsx's decal placement both already use).
    const wallQuaternion = new Quaternion().setFromEuler(new Euler(0, midAngle + Math.PI / 2, 0));
    const wall = Rapier.ColliderDesc.cuboid(chordLength / 2, PHYSICS_WALL_HEIGHT / 2, 0.015)
      .setTranslation(
        Math.cos(midAngle) * PHYSICS_TRAY_RADIUS,
        PHYSICS_WALL_HEIGHT / 2,
        Math.sin(midAngle) * PHYSICS_TRAY_RADIUS
      )
      .setRotation({ x: wallQuaternion.x, y: wallQuaternion.y, z: wallQuaternion.z, w: wallQuaternion.w })
      .setFriction(0.5)
      .setRestitution(0.4)
      .setActiveEvents(Rapier.ActiveEvents.COLLISION_EVENTS);
    world.createCollider(wall, body);
  }
}

// ---- Collider construction (§8: from buildDieGeometry's own vertices,
// independent of the decorated visual mesh) ----

// A private cache, independent of DiceTumble.tsx's own geometryCache — same
// buildDieGeometry(kind, DIE_SIZE) call, same DIE_SIZE constant (imported
// from diceGeometry.ts, not a hand-copied duplicate), so the collider is
// mechanically the same shape/size as the rendered base mesh, just computed
// and cached separately since this module has no React/mount lifecycle of
// its own to share a cache through.
const dieGeometryCache = new Map<DieKind, BufferGeometry>();
function dieGeometryForPhysics(kind: DieKind): BufferGeometry {
  let geometry = dieGeometryCache.get(kind);
  if (!geometry) {
    geometry = buildDieGeometry(kind, DIE_SIZE);
    dieGeometryCache.set(kind, geometry);
  }
  return geometry;
}

/** `null` (a free-form roll's non-standard side count) reuses the exact same
 * icosahedron shape DiceTumble.tsx's own FallbackDieMesh renders for that
 * case (`buildDieGeometry("d20", DIE_SIZE)` IS that shape — both are a plain
 * `IcosahedronGeometry(DIE_SIZE)`), so the fallback collider matches the
 * fallback visual exactly, the same §8 guarantee as every standard kind. */
function colliderDescFor(Rapier: RapierNamespace, kind: DieKind | null): InstanceType<RapierNamespace["ColliderDesc"]> {
  if (kind === "d6") {
    // The simpler, cheaper analytic box collider the spike's §8 explicitly
    // recommends for the d6 specifically — a cube needs no convex-hull
    // computation at all. Half-extent matches buildDieGeometry's own d6 case
    // (`new BoxGeometry(size * 1.2, ...)`) exactly.
    const half = (DIE_SIZE * 1.2) / 2;
    return Rapier.ColliderDesc.cuboid(half, half, half);
  }
  const geometry = dieGeometryForPhysics(kind ?? "d20");
  const positions = geometry.attributes.position.array as Float32Array;
  const desc = Rapier.ColliderDesc.convexHull(positions);
  if (!desc) {
    // Rapier returns null only for a degenerate point set (e.g. all
    // coplanar) — never expected for any of this module's own real die
    // shapes, but a thrown error here is far preferable to silently
    // rendering a die with no collider at all (it would fall through the
    // tray floor forever, visibly broken, not just cosmetically wrong).
    throw new Error(`dice physics: convex hull construction failed for die kind "${kind ?? "fallback"}"`);
  }
  return desc;
}

/** The distance a die's local origin must sit above a flat floor once
 * oriented by `quaternion`, so the geometry's own lowest vertex touches
 * (never floats above or clips through) the floor plane at that exact
 * orientation. Computed generally from real vertex data — rather than
 * assuming every kind rests flush on a whole face (true for the five
 * centrally-symmetric solids per diceGeometry.ts's own facePlaneDistance,
 * but NOT true for the d4: a regular tetrahedron has no antipodal faces, so
 * forcing one face's normal to point up leaves a single VERTEX, not another
 * face, touching the floor) — so this one formula is correct for all six
 * kinds uniformly, no d4 special case needed. Computed once per die at body-
 * creation time (the target orientation is fixed for a die's whole
 * lifetime), never per frame. */

// ---- Defensive floor clamp (tunneling safety net, alongside CCD below) ----

// The MINIMUM a die's local origin can ever legitimately sit above the
// floor, for ANY orientation whatsoever — not just the one resting
// orientation restingOriginHeight computes for. `facePlaneDistance` is the
// perpendicular distance from a die's origin to its own nearest face plane,
// which diceGeometry.ts's own doc comment establishes is IDENTICAL for
// every face of all six kinds (an isohedral/centrally-symmetric
// construction) — i.e. it is this shape's real inscribed-sphere radius: the
// largest sphere centered on the origin that stays fully inside the solid.
// By definition of an insphere, every point on the die's own surface (every
// face, edge, AND vertex — not just face centers) lies at or beyond that
// radius from the origin, in every direction. So regardless of which face,
// edge, or vertex the die's real physics happens to be touching the floor
// with at any instant (a live tumble is NOT always resting flush on a
// face), the origin can never legitimately be closer to the floor than this
// value without the die's own geometry already clipping through the floor
// — a mathematically tight, not just empirically-tuned, lower bound. Cached
// per kind (the same "computed once, reused" shape as
// dieGeometryForPhysics/minOriginHeightCache's sibling caches in this file),
// since facePlaneDistance itself rebuilds a fresh BufferGeometry per call.
const minOriginHeightCache = new Map<DieKind, number>();
function minOriginHeightFor(kind: DieKind | null): number {
  const resolvedKind = kind ?? "d20"; // same fallback shape as restingOriginHeight/colliderDescFor.
  let height = minOriginHeightCache.get(resolvedKind);
  if (height === undefined) {
    height = facePlaneDistance(resolvedKind, DIE_SIZE);
    minOriginHeightCache.set(resolvedKind, height);
  }
  return height;
}

// A small safety margin subtracted from the mathematically-exact
// minOriginHeightFor bound above, so this clamp can never visibly fight a
// real, correctly-behaving physics contact: Rapier's own contact solver
// (like essentially every real-time rigid-body engine) allows a small,
// intentional amount of interpenetration slop at rest for stability, well
// under a centimeter at this scene's real-world-meter scale. 0.02 is a
// generous multiple of that (headroom against solver jitter/settling
// wobble genuinely nudging a resting die a few mm below its exact
// geometric minimum) while staying utterly negligible next to how far a
// die that actually tunneled through the floor will have fallen under
// unopposed gravity by the time this clamp is even consulted — CCD
// (createDieBody's own setCcdEnabled(true) call) should make that case
// essentially never happen at all; this is the rare defensive fallback for
// whatever edge case might still slip past it, not a routine correction.
export const FLOOR_CLAMP_SLOP = 0.02;

/** Clamps a die's raw physics-read Y so it can never render below the
 * tray's own floor (or, transitively, below whatever the die's floating
 * ResultBadge sits above it) — see this section's own doc comments for the
 * exact bound and why it's safe against ordinary resting/settling jitter.
 * Exported for diceAnimator.test.ts's own direct unit coverage of the clamp
 * math, independent of a real (slower, WASM-backed) physics run. */
export function clampDieOriginY(rawY: number, minOriginHeight: number): number {
  return Math.max(rawY, minOriginHeight - FLOOR_CLAMP_SLOP);
}

// ---- Simulate first, then replay (supersedes §7's blend-to-target) ----
//
// §7 originally ran live physics and, once a die went quiet, slerped it
// round to the server's face — the visible "it lands, then spins to the
// right number" players noticed. Now each roll is simulated headlessly to
// rest up front (a few milliseconds of Rapier), the face each die NATURALLY
// lands on is read off, and the die's rendering is offset by one of its own
// rotational symmetries that carries the server's face onto that landed
// face. Because the offset is a symmetry of the solid, the rendered die
// occupies exactly the space the simulated body does; it simply wears its
// numbers rotated, so the physically-landed face shows the server's number.
// Playback is the recorded trajectory — nothing is ever corrected on screen.

const SIM_DT = 1 / 120;
// A roll is finished once every die has been quiet for this long…
const SIM_QUIET_SECONDS = 0.25;
// …but never simulates longer than this (a die balanced on a wall edge).
const SIM_MAX_SECONDS = 5;
const SIM_MIN_SECONDS = 0.4;
// A body under both of these is considered "quiet" — units are the physics
// world's own m/s and rad/s at this scene's real-world-meter scale.
const LINEAR_SETTLE_THRESHOLD = 0.05;
const ANGULAR_SETTLE_THRESHOLD = 0.3;
// How flat a die must land to count: the landed face's normal·up. A d4 rests
// on a face, so its best upward face only ever reaches 1/3.
const FLAT_ENOUGH = 0.96;
const D4_FLAT_ENOUGH = 0.3;
// Re-throw (fresh random toss) when a die lands cocked, at most this often.
const MAX_THROW_ATTEMPTS = 6;
// Non-standard dice (no number layout to re-map) ease upright, and a die
// that stays tilted after every re-throw tips flat, over this long.
const UPRIGHT_BLEND_SECONDS = 0.3;

// A relatively gentle, honestly-randomized toss — the landed face is never
// steered; the numbers are re-mapped onto whatever face comes up.
const THROW_MAX_SPIN = 16; // rad/s per axis
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function parseRollId(dieId: string): string {
  const separator = dieId.lastIndexOf(":");
  return separator === -1 ? dieId : dieId.slice(0, separator);
}

function parseDieIndexWithinRoll(dieId: string): number {
  const separator = dieId.lastIndexOf(":");
  const index = Number(dieId.slice(separator + 1));
  return Number.isFinite(index) ? index : 0;
}

/** One die's recorded trajectory, at SIM_DT. */
interface RecordedDie {
  kind: DieKind | null;
  frames: number;
  /** xyz per frame. */
  positions: Float32Array;
  /** xyzw per frame. */
  quaternions: Float32Array;
  /** 1 on frames where this die started a real collision (for dice sounds). */
  impacts: Uint8Array;
  /** Applied after the body's rotation when rendering: a symmetry of the
   * die that puts the server's face where the body's landed face is. */
  labelOffset: Quaternion;
  /** Only when every re-throw still left this die resting tilted (leaning
   * on a wall or another die): the small world-space turn that lays the
   * landed face flat, eased in over the last moment like a die toppling. */
  tipFlat: Quaternion | null;
  minOriginHeight: number;
}

interface RecordedRoll {
  dice: Map<string, RecordedDie>;
}

const recordedRolls = new Map<string, RecordedRoll>();

// ---- Die symmetries ----

const symmetryCache = new Map<string, Quaternion>();
const uniqueVerticesCache = new Map<DieKind, Vector3[]>();

function uniqueVertices(kind: DieKind): Vector3[] {
  let vertices = uniqueVerticesCache.get(kind);
  if (vertices) return vertices;
  const position = dieGeometryForPhysics(kind).attributes.position;
  vertices = [];
  for (let i = 0; i < position.count; i++) {
    const vertex = new Vector3(position.getX(i), position.getY(i), position.getZ(i));
    if (!vertices.some((existing) => existing.distanceToSquared(vertex) < 1e-8)) vertices.push(vertex);
  }
  uniqueVerticesCache.set(kind, vertices);
  return vertices;
}

/** Largest distance any vertex moves to its nearest image vertex under
 * `rotation` (0 for an exact symmetry). */
function symmetryError(kind: DieKind, rotation: Quaternion): number {
  const vertices = uniqueVertices(kind);
  const moved = new Vector3();
  let worst = 0;
  for (const vertex of vertices) {
    moved.copy(vertex).applyQuaternion(rotation);
    let nearest = Infinity;
    for (const other of vertices) nearest = Math.min(nearest, other.distanceToSquared(moved));
    worst = Math.max(worst, nearest);
  }
  return Math.sqrt(worst);
}

/**
 * A rotation S that is a symmetry of `kind`'s solid and carries face
 * `fromIndex`'s normal onto face `toIndex`'s normal. Every standard die's
 * rotation group acts transitively on its faces, so one always exists: the
 * minimal rotation between the two normals, then the exact turn about the
 * destination normal that lines a vertex up with another vertex (tried for
 * every candidate vertex; the best-fitting one wins — the d10's kite faces
 * make that turn an irregular angle, so it has to be solved, not stepped).
 */
export function dieSymmetryBetweenFaces(kind: DieKind, fromIndex: number, toIndex: number): Quaternion {
  const key = `${kind}:${fromIndex}:${toIndex}`;
  const cached = symmetryCache.get(key);
  if (cached) return cached.clone();
  const normals = DIE_FACE_NORMALS[kind];
  const from = new Vector3(...normals[fromIndex]).normalize();
  const axis = new Vector3(...normals[toIndex]).normalize();
  const align = new Quaternion().setFromUnitVectors(from, axis);
  const vertices = uniqueVertices(kind);

  // A reference vertex well off the axis, after alignment.
  const project = (v: Vector3) => v.clone().sub(axis.clone().multiplyScalar(v.dot(axis)));
  const reference = vertices
    .map((v) => v.clone().applyQuaternion(align))
    .reduce((best, v) => (project(v).lengthSq() > project(best).lengthSq() ? v : best));
  const referenceHeight = reference.dot(axis);
  const referenceFlat = project(reference);

  let best = align;
  let bestError = symmetryError(kind, align);
  for (const candidate of vertices) {
    // Only vertices at the same height along the axis and the same distance
    // from it can be the reference vertex's image.
    if (Math.abs(candidate.dot(axis) - referenceHeight) > DIE_SIZE * 0.02) continue;
    const candidateFlat = project(candidate);
    if (Math.abs(candidateFlat.length() - referenceFlat.length()) > DIE_SIZE * 0.02) continue;
    const angle = Math.atan2(
      referenceFlat.clone().cross(candidateFlat).dot(axis),
      referenceFlat.dot(candidateFlat)
    );
    const rotation = new Quaternion().setFromAxisAngle(axis, angle).multiply(align);
    const error = symmetryError(kind, rotation);
    if (error < bestError) {
      best = rotation;
      bestError = error;
    }
  }
  symmetryCache.set(key, best.clone());
  return best;
}

function landedFace(kind: DieKind, rotation: Quaternion): { index: number; flatness: number } {
  const up = new Vector3(0, 1, 0).applyQuaternion(rotation.clone().invert());
  let index = 0;
  let flatness = -Infinity;
  DIE_FACE_NORMALS[kind].forEach((normal, i) => {
    const dot = up.x * normal[0] + up.y * normal[1] + up.z * normal[2];
    if (dot > flatness) {
      flatness = dot;
      index = i;
    }
  });
  return { index, flatness };
}

// ---- Headless simulation ----

function throwDie(
  Rapier: RapierNamespace,
  world: InstanceType<RapierNamespace["World"]>,
  spec: DiceTumbleDieSpec,
  kind: DieKind | null
) {
  const dieIndex = parseDieIndexWithinRoll(spec.id);
  const startAngle = dieIndex * GOLDEN_ANGLE + Math.random() * 0.8;
  const startRadius = Math.random() * (DICE_START_RADIUS_BASE * 0.7);
  const throwAngle = Math.random() * Math.PI * 2;
  const outwardSpeed = 0.25 + Math.random() * 0.35;
  const upSpeed = 0.9 + Math.random() * 0.6;
  const startRotation = new Quaternion().setFromEuler(
    new Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2)
  );
  const bodyDesc = Rapier.RigidBodyDesc.dynamic()
    .setTranslation(Math.cos(startAngle) * startRadius, 0.32 + Math.random() * 0.15, Math.sin(startAngle) * startRadius)
    .setRotation({ x: startRotation.x, y: startRotation.y, z: startRotation.z, w: startRotation.w })
    .setLinvel(Math.cos(throwAngle) * outwardSpeed, upSpeed, Math.sin(throwAngle) * outwardSpeed)
    .setAngvel({
      x: (Math.random() - 0.5) * 2 * THROW_MAX_SPIN,
      y: (Math.random() - 0.5) * 2 * THROW_MAX_SPIN,
      z: (Math.random() - 0.5) * 2 * THROW_MAX_SPIN,
    })
    .setLinearDamping(0.25)
    .setAngularDamping(0.35)
    .setCcdEnabled(true);
  const body = world.createRigidBody(bodyDesc);
  const collider = world.createCollider(
    colliderDescFor(Rapier, kind)
      .setFriction(0.7)
      .setRestitution(0.35)
      .setDensity(1)
      .setActiveEvents(Rapier.ActiveEvents.COLLISION_EVENTS),
    body
  );
  return { body, colliderHandle: collider.handle };
}

interface SimulatedThrow {
  dice: Map<string, Omit<RecordedDie, "labelOffset" | "tipFlat">>;
  /** The worst (least flat) landing among the roll's standard dice. */
  worstFlatnessMargin: number;
}

function simulateThrow(Rapier: RapierNamespace, specs: readonly DiceTumbleDieSpec[]): SimulatedThrow {
  const world = new Rapier.World({ x: 0, y: -9.81, z: 0 });
  const eventQueue = new Rapier.EventQueue(true);
  try {
    world.timestep = SIM_DT;
    buildTrayBoundary(Rapier, world);
    const maxFrames = Math.ceil(SIM_MAX_SECONDS / SIM_DT) + 1;
    const dice = specs.map((spec) => {
      const kind = dieKindForSides(spec.sides);
      const { body, colliderHandle } = throwDie(Rapier, world, spec, kind);
      return {
        spec,
        kind,
        body,
        colliderHandle,
        positions: new Float32Array(maxFrames * 3),
        quaternions: new Float32Array(maxFrames * 4),
        impacts: new Uint8Array(maxFrames),
      };
    });
    const handleToDie = new Map(dice.map((die) => [die.colliderHandle, die]));

    let frame = 0;
    let quietFrames = 0;
    const quietNeeded = Math.ceil(SIM_QUIET_SECONDS / SIM_DT);
    const record = () => {
      for (const die of dice) {
        const t = die.body.translation();
        const r = die.body.rotation();
        die.positions.set([t.x, t.y, t.z], frame * 3);
        die.quaternions.set([r.x, r.y, r.z, r.w], frame * 4);
      }
    };
    record();
    while (frame < maxFrames - 1) {
      world.step(eventQueue);
      frame++;
      eventQueue.drainCollisionEvents((handle1, handle2, started) => {
        if (!started) return;
        const a = handleToDie.get(handle1);
        if (a) a.impacts[frame] = 1;
        const b = handleToDie.get(handle2);
        if (b) b.impacts[frame] = 1;
      });
      record();
      const allQuiet = dice.every((die) => {
        const v = die.body.linvel();
        const w = die.body.angvel();
        return (
          Math.hypot(v.x, v.y, v.z) < LINEAR_SETTLE_THRESHOLD && Math.hypot(w.x, w.y, w.z) < ANGULAR_SETTLE_THRESHOLD
        );
      });
      quietFrames = allQuiet ? quietFrames + 1 : 0;
      if (frame * SIM_DT >= SIM_MIN_SECONDS && quietFrames >= quietNeeded) break;
    }

    const frames = frame + 1;
    let worstFlatnessMargin = Infinity;
    const recorded = new Map<string, Omit<RecordedDie, "labelOffset" | "tipFlat">>();
    for (const die of dice) {
      const base = (frames - 1) * 4;
      const finalRotation = new Quaternion(
        die.quaternions[base],
        die.quaternions[base + 1],
        die.quaternions[base + 2],
        die.quaternions[base + 3]
      );
      const finite = [finalRotation.x, finalRotation.y, finalRotation.z, finalRotation.w].every(Number.isFinite);
      if (!finite) worstFlatnessMargin = -Infinity;
      else if (die.kind) {
        const { flatness } = landedFace(die.kind, finalRotation);
        worstFlatnessMargin = Math.min(worstFlatnessMargin, flatness - (die.kind === "d4" ? D4_FLAT_ENOUGH : FLAT_ENOUGH));
      }
      recorded.set(die.spec.id, {
        kind: die.kind,
        frames,
        positions: die.positions.subarray(0, frames * 3),
        quaternions: die.quaternions.subarray(0, frames * 4),
        impacts: die.impacts.subarray(0, frames),
        minOriginHeight: minOriginHeightFor(die.kind),
      });
    }
    return { dice: recorded, worstFlatnessMargin };
  } finally {
    // Rapier's WASM memory isn't garbage-collected — the recording is plain
    // JS arrays, so the world can go the moment simulation ends.
    eventQueue.free();
    world.free();
  }
}

/**
 * Simulates a whole roll (all its dice together, so they still collide with
 * each other and the tray) and stores the recording the animator replays.
 * Idempotent per roll id. DiceTumble calls this with every die in the roll
 * as the roll starts; a die the animator meets without a prepared roll is
 * simulated on its own as a fallback.
 */
export function prepareDicePhysicsRoll(rollId: string, specs: readonly DiceTumbleDieSpec[]): void {
  if (!rapierModule || recordedRolls.has(rollId) || specs.length === 0) return;
  const Rapier = rapierModule;
  let best: SimulatedThrow | null = null;
  for (let attempt = 0; attempt < MAX_THROW_ATTEMPTS; attempt++) {
    const simulated = simulateThrow(Rapier, specs);
    if (!best || simulated.worstFlatnessMargin > best.worstFlatnessMargin) best = simulated;
    if (simulated.worstFlatnessMargin >= 0) break;
  }
  const dice = new Map<string, RecordedDie>();
  for (const spec of specs) {
    const die = best!.dice.get(spec.id)!;
    let labelOffset = new Quaternion();
    let tipFlat: Quaternion | null = null;
    if (die.kind) {
      const base = (die.frames - 1) * 4;
      const finalRotation = new Quaternion(
        die.quaternions[base],
        die.quaternions[base + 1],
        die.quaternions[base + 2],
        die.quaternions[base + 3]
      );
      const landed = landedFace(die.kind, finalRotation).index;
      const faceCount = DIE_FACE_NORMALS[die.kind].length;
      const target = Math.min(Math.max(Math.round(spec.result) - 1, 0), faceCount - 1);
      labelOffset = dieSymmetryBetweenFaces(die.kind, target, landed);
      const { flatness } = landedFace(die.kind, finalRotation);
      if (die.kind !== "d4" && flatness < FLAT_ENOUGH) {
        const landedUp = new Vector3(...DIE_FACE_NORMALS[die.kind][landed]).normalize().applyQuaternion(finalRotation);
        tipFlat = new Quaternion().setFromUnitVectors(landedUp, new Vector3(0, 1, 0));
      }
    }
    dice.set(spec.id, { ...die, labelOffset, tipFlat });
  }
  recordedRolls.set(rollId, { dice });
}

/** Drops a finished roll's recording. Safe for any roll id, including one
 * that never used physics. (The physics world itself is already freed as
 * soon as the roll's simulation finishes.) */
export function disposeDicePhysicsRoll(rollId: string): void {
  recordedRolls.delete(rollId);
}

const eulerScratch = new Euler();
const quaternionScratch = new Quaternion();
const nextQuaternionScratch = new Quaternion();
const tipScratch = new Quaternion();

/**
 * The physics-backed DiceAnimator — selected via `pickDiceAnimator`. Replays
 * the roll's pre-simulated trajectory (see prepareDicePhysicsRoll), so a
 * given (spec, elapsedSeconds) always returns the same pose, and the die
 * comes to rest on the server's number exactly where physics put it.
 */
export const physicsDiceAnimator: DiceAnimator = {
  step(spec, elapsedSeconds) {
    if (!rapierModule) {
      return scriptedDiceAnimator.step(spec, elapsedSeconds);
    }
    const rollId = parseRollId(spec.id);
    if (!recordedRolls.get(rollId)?.dice.has(spec.id)) {
      // Not prepared with the whole roll (or a die the roll didn't list) —
      // simulate this die on its own under its own sub-roll id.
      const soloId = `${rollId}#${spec.id}`;
      prepareDicePhysicsRoll(soloId, [spec]);
      const solo = recordedRolls.get(soloId);
      if (solo) {
        const roll = recordedRolls.get(rollId) ?? { dice: new Map<string, RecordedDie>() };
        roll.dice.set(spec.id, solo.dice.get(spec.id)!);
        recordedRolls.set(rollId, roll);
        recordedRolls.delete(soloId);
      }
    }
    const die = recordedRolls.get(rollId)?.dice.get(spec.id);
    if (!die) return scriptedDiceAnimator.step(spec, elapsedSeconds);

    const exactFrame = Math.max(0, elapsedSeconds / SIM_DT);
    const frameA = Math.min(Math.floor(exactFrame), die.frames - 1);
    const frameB = Math.min(frameA + 1, die.frames - 1);
    const t = frameB === frameA ? 0 : exactFrame - frameA;

    const px = die.positions[frameA * 3] + (die.positions[frameB * 3] - die.positions[frameA * 3]) * t;
    const py = die.positions[frameA * 3 + 1] + (die.positions[frameB * 3 + 1] - die.positions[frameA * 3 + 1]) * t;
    const pz = die.positions[frameA * 3 + 2] + (die.positions[frameB * 3 + 2] - die.positions[frameA * 3 + 2]) * t;
    quaternionScratch.fromArray(die.quaternions, frameA * 4);
    nextQuaternionScratch.fromArray(die.quaternions, frameB * 4);
    quaternionScratch.slerp(nextQuaternionScratch, t);
    quaternionScratch.multiply(die.labelOffset);

    const endSeconds = (die.frames - 1) * SIM_DT;
    let settled = elapsedSeconds >= endSeconds;
    if (die.tipFlat) {
      const blend = Math.min(Math.max((elapsedSeconds - endSeconds) / UPRIGHT_BLEND_SECONDS, 0), 1);
      tipScratch.identity().slerp(die.tipFlat, easeOutCubic(blend));
      quaternionScratch.premultiply(tipScratch);
      settled = blend >= 1;
    }
    if (!die.kind) {
      // Non-standard die: no numbers to re-map, so ease it upright at the end.
      const blend = Math.min(Math.max((elapsedSeconds - endSeconds) / UPRIGHT_BLEND_SECONDS, 0), 1);
      quaternionScratch.slerp(new Quaternion(), easeOutCubic(blend));
      settled = blend >= 1;
    }
    eulerScratch.setFromQuaternion(quaternionScratch);

    // Any collision since the previous display frame counts (the recording
    // is finer-grained than the display's frame rate).
    const previousFrame = Math.max(0, Math.floor(Math.max(0, elapsedSeconds - 1 / 60) / SIM_DT));
    let impacted = false;
    for (let f = previousFrame + 1; f <= frameA && !impacted; f++) impacted = die.impacts[f] === 1;

    const finite = [px, py, pz].every(Number.isFinite);
    return {
      position: finite ? [px, clampDieOriginY(py, die.minOriginHeight), pz] : [0, die.minOriginHeight, 0],
      rotation: [eulerScratch.x, eulerScratch.y, eulerScratch.z],
      settled,
      impacted,
    };
  },
};
