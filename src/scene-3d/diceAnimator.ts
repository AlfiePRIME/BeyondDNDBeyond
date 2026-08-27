import { Euler, Quaternion, Vector3, type BufferGeometry } from "three";
import { DIE_SIZE, buildDieGeometry, dieKindForSides, faceNormalForResult, type DieKind } from "./diceGeometry";

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
 * actually chosen to render (docs/design/dice-numbers-and-physics.md §11). */
function buildTrayBoundary(Rapier: RapierNamespace, world: InstanceType<RapierNamespace["World"]>): void {
  const body = world.createRigidBody(Rapier.RigidBodyDesc.fixed());

  const floor = Rapier.ColliderDesc.cylinder(0.01, PHYSICS_TRAY_RADIUS)
    .setTranslation(0, -0.01, 0)
    .setFriction(0.8)
    .setRestitution(0.2);
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
      .setRestitution(0.4);
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
const restingVertexScratch = new Vector3();
function restingOriginHeight(kind: DieKind | null, quaternion: Quaternion): number {
  const geometry = dieGeometryForPhysics(kind ?? "d20");
  const position = geometry.attributes.position;
  let minY = Infinity;
  for (let i = 0; i < position.count; i++) {
    restingVertexScratch.set(position.getX(i), position.getY(i), position.getZ(i));
    restingVertexScratch.applyQuaternion(quaternion);
    if (restingVertexScratch.y < minY) minY = restingVertexScratch.y;
  }
  return -minY;
}

// ---- Reconciliation timing (§7) ----

// Same neighborhood as the scripted animator's own TUMBLE_SECONDS/
// SETTLE_SECONDS above, widened slightly since a real simulation's natural
// settle time genuinely varies (unlike the scripted version's fixed
// schedule) — the spike's own suggested starting point, tuned by feel.
const MIN_PHYSICS_SECONDS = 0.4;
const MAX_PHYSICS_SECONDS = 1.2;
const SETTLE_BLEND_SECONDS = 0.3;
// A body under both of these is considered "quiet" — units are the physics
// world's own m/s and rad/s at this scene's real-world-meter scale (three.js
// AVATAR_HEIGHT === 1.7 for a human — confirmed, not assumed — so ordinary
// Earth gravity and everyday velocity/angular-velocity numbers both apply
// directly here with no separate scale factor to invent).
const LINEAR_SETTLE_THRESHOLD = 0.05;
const ANGULAR_SETTLE_THRESHOLD = 0.3;

// Physics-engine hygiene against a slow/janky real animation frame: never
// advance the simulation by one huge, unstable timestep — sub-step in
// bounded increments, capped so one pathological stall (a backgrounded tab
// resuming) can't spend unbounded CPU catching up in a single step() call.
const MAX_SUBSTEP_SECONDS = 1 / 60;
const MAX_SUBSTEPS_PER_FRAME = 6;

// A relatively gentle, honestly-randomized toss (§7: since the settle is
// unconditionally corrected regardless of the natural outcome, there is no
// reason to bias — or even carefully tune — these numbers toward "looking
// like it might land right"; they only need to look like a real toss).
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

interface DiePhysicsRecord {
  body: InstanceType<RapierNamespace["RigidBody"]>;
  /** Fixed for this die's whole lifetime — the exact orientation
   * faceNormalForResult(kind, spec.result) demands, computed once at body
   * creation (same technique scriptedDiceAnimator's own targetQuaternion
   * uses). */
  targetQuaternion: Quaternion;
  targetHeight: number;
  /** Non-null once this die has transitioned from "live physics" to
   * "blending into the guaranteed target" — set exactly once, at the first
   * frame that trips MIN_PHYSICS_SECONDS+quiet or MAX_PHYSICS_SECONDS. */
  transitionElapsed: number | null;
  snapshotPosition: [number, number, number] | null;
  snapshotQuaternion: Quaternion | null;
}

interface RollPhysicsWorld {
  world: InstanceType<RapierNamespace["World"]>;
  dice: Map<string, DiePhysicsRecord>;
  lastSteppedElapsed: number;
  /** Count of this roll's own dice that haven't transitioned yet — once this
   * hits 0, the shared world no longer needs stepping at all (every die's
   * pose is now a pure function of its own frozen snapshot + elapsed time),
   * a real (if modest) CPU saving during a roll's LINGER_MS tail. */
  pendingCount: number;
}

const rollWorlds = new Map<string, RollPhysicsWorld>();

function getOrCreateRollWorld(Rapier: RapierNamespace, rollId: string): RollPhysicsWorld {
  let roll = rollWorlds.get(rollId);
  if (!roll) {
    const world = new Rapier.World({ x: 0, y: -9.81, z: 0 });
    buildTrayBoundary(Rapier, world);
    roll = { world, dice: new Map(), lastSteppedElapsed: 0, pendingCount: 0 };
    rollWorlds.set(rollId, roll);
  }
  return roll;
}

function createDieBody(Rapier: RapierNamespace, roll: RollPhysicsWorld, spec: DiceTumbleDieSpec): DiePhysicsRecord {
  const kind = dieKindForSides(spec.sides);
  const targetNormal = kind ? faceNormalForResult(kind, spec.result) : ([0, 1, 0] as const);
  // Same Quaternion().setFromUnitVectors technique scriptedDiceAnimator's own
  // targetQuaternion (above) and DiceTumble.tsx's decal placement both
  // already use: the rotation that carries this face's local normal onto
  // world +Y.
  const targetQuaternion = new Quaternion().setFromUnitVectors(new Vector3(...targetNormal), new Vector3(0, 1, 0));
  const targetHeight = restingOriginHeight(kind, targetQuaternion);

  // Spread multiple dice in the same roll around the tray via a golden-angle
  // spiral keyed on each die's own index (ActiveTumble's `${rollId}:${index}`
  // id convention) — avoids stacking near-identical starting positions for a
  // large multi-die roll (which would otherwise resolve as a small explosive
  // initial-overlap correction) without needing to know the roll's total
  // die count up front. Actual throw velocity/spin is genuinely randomized
  // (Math.random(), not this id-derived spread) — §7/§10's own explicit
  // point that a client-local physics throw is free to be honestly random
  // with zero coupling to correctness, and different clients replaying the
  // identical roll id are EXPECTED to see different-looking tumbles.
  const dieIndex = parseDieIndexWithinRoll(spec.id);
  const startAngle = dieIndex * GOLDEN_ANGLE + Math.random() * 0.8;
  const startRadius = Math.random() * (DICE_START_RADIUS_BASE * 0.7);
  const startX = Math.cos(startAngle) * startRadius;
  const startZ = Math.sin(startAngle) * startRadius;
  const startY = 0.32 + Math.random() * 0.15;

  // Tuned (empirically, against real screenshots) so a thrown die's real
  // worst-case horizontal travel — starting radius + outwardSpeed × real
  // hang time under gravity — stays in the same rough visual envelope
  // scriptedDiceAnimator's own DICE_START_RADIUS_BASE/JITTER (~0.42) always
  // guaranteed deterministically: real physics with unconstrained energy
  // could otherwise throw a die past a tight camera's own framing
  // (confirmed directly — /dev/dice-showcase's close-up preview camera,
  // sized for the old scripted animator's own bounded arc, visibly lost
  // dice off-frame before this tuning) or, in a small personal tray, closer
  // to PHYSICS_TRAY_RADIUS's own wall than looks natural. Still genuinely
  // randomized per-throw (§7/§10 — no coupling to correctness either way).
  const throwAngle = Math.random() * Math.PI * 2;
  const outwardSpeed = 0.25 + Math.random() * 0.35;
  const upSpeed = 0.9 + Math.random() * 0.6;

  const startRotation = new Quaternion().setFromEuler(
    new Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2)
  );

  const bodyDesc = Rapier.RigidBodyDesc.dynamic()
    .setTranslation(startX, startY, startZ)
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
  const body = roll.world.createRigidBody(bodyDesc);
  const colliderDesc = colliderDescFor(Rapier, kind).setFriction(0.7).setRestitution(0.35).setDensity(1);
  roll.world.createCollider(colliderDesc, body);

  const record: DiePhysicsRecord = {
    body,
    targetQuaternion,
    targetHeight,
    transitionElapsed: null,
    snapshotPosition: null,
    snapshotQuaternion: null,
  };
  roll.dice.set(spec.id, record);
  roll.pendingCount++;
  return record;
}

/** Frees a finished roll's Rapier World (and, per Rapier's own docs, every
 * body/collider it owns — no need to free those individually). Rapier's WASM
 * memory is NOT garbage-collected by the JS engine, so skipping this would
 * be a real, slow memory leak across a long session with many rolls
 * (docs/design/dice-numbers-and-physics.md §7's own explicit warning). Safe
 * to call for any roll id, including one that never used physics at all
 * (scripted-animator-only rolls never appear in `rollWorlds`) — a plain
 * no-op in that case, so DiceTumble.tsx's own onDone hook can call this
 * unconditionally for every finished roll without knowing which animator it
 * used.
 */
export function disposeDicePhysicsRoll(rollId: string): void {
  const roll = rollWorlds.get(rollId);
  if (!roll) return;
  roll.world.free();
  rollWorlds.delete(rollId);
}

const eulerScratch = new Euler();
const quaternionScratch = new Quaternion();

// Rapier's own translation()/rotation()/linvel()/angvel() accept an optional
// `target` object to write into instead of allocating a fresh one — the
// standard hot-path pattern for a physics binding read every frame for
// every body (confirmed directly: passing a target returns that SAME
// object, mutated in place). With up to MAX_PHYSICS_DICE_PER_ROLL dice per
// tray across every connected member's own tray simultaneously, this read
// happens up to a few hundred times per animation frame in the real
// multi-tray worst case (§9) — reusing one shared set of Rapier-native
// scratch objects (lazily constructed once real Rapier types exist, below)
// measurably cuts GC pressure versus 4 fresh allocations per die per frame.
// Safe to share a single pool: each step() call fully consumes these values
// (copying whatever it needs into this module's own three.js scratch
// objects or a plain array) before any other die's step() call can run.
let rapierTranslationScratch: InstanceType<RapierNamespace["Vector3"]> | null = null;
let rapierRotationScratch: InstanceType<RapierNamespace["Quaternion"]> | null = null;
let rapierLinvelScratch: InstanceType<RapierNamespace["Vector3"]> | null = null;
let rapierAngvelScratch: InstanceType<RapierNamespace["Vector3"]> | null = null;

/**
 * The physics-backed DiceAnimator (docs/design/dice-numbers-and-physics.md
 * §7-§9) — selected via `pickDiceAnimator`, never constructed/used directly
 * by DiceTumble.tsx. One Rapier World per ROLL (not per die), lazily created
 * on first sight of that roll's id (parsed back out of `spec.id`'s
 * `${rollId}:${index}` convention) and explicitly freed by
 * `disposeDicePhysicsRoll` once the roll finishes.
 *
 * Unlike `scriptedDiceAnimator`, this is NOT a pure function of its
 * arguments — a live physics world is unavoidably stateful, exactly as this
 * file's own `DiceAnimator` doc comment anticipates. Calling `step` twice
 * with identical `(spec, elapsedSeconds)` is safe and returns the same pose
 * (the shared world only ever advances past an `elapsedSeconds` value it has
 * already seen once), but calling it with strictly increasing
 * `elapsedSeconds` values is the only supported usage — exactly what
 * useDiceTumble.ts's own useFrame loop already does for every DiceAnimator.
 */
export const physicsDiceAnimator: DiceAnimator = {
  step(spec, elapsedSeconds) {
    if (!rapierModule) {
      // Defensive only — pickDiceAnimator never selects this animator until
      // isDicePhysicsReady() is true. Falling back per-call here (rather
      // than throwing) keeps this animator safe to call directly too, e.g.
      // from a test that wants to exercise it before awaiting readiness.
      return scriptedDiceAnimator.step(spec, elapsedSeconds);
    }
    const Rapier = rapierModule;
    if (!rapierTranslationScratch) {
      rapierTranslationScratch = new Rapier.Vector3(0, 0, 0);
      rapierRotationScratch = new Rapier.Quaternion(0, 0, 0, 1);
      rapierLinvelScratch = new Rapier.Vector3(0, 0, 0);
      rapierAngvelScratch = new Rapier.Vector3(0, 0, 0);
    }
    const rollId = parseRollId(spec.id);
    const roll = getOrCreateRollWorld(Rapier, rollId);
    let record = roll.dice.get(spec.id);
    if (!record) record = createDieBody(Rapier, roll, spec);

    // Step the shared world AT MOST ONCE PER FRAME (docs/design/dice-numbers-
    // and-physics.md §7) — the first die of this roll to call step() at a
    // new elapsedSeconds value advances the whole world by the elapsed gap;
    // every other die's own step() call at that SAME elapsedSeconds this
    // frame just reads its already-updated transform below, without
    // stepping again. Skipped entirely once every die in the roll has
    // already transitioned (pendingCount === 0) — nothing left that needs
    // live physics.
    if (roll.pendingCount > 0 && elapsedSeconds > roll.lastSteppedElapsed) {
      let remaining = Math.min(
        elapsedSeconds - roll.lastSteppedElapsed,
        MAX_SUBSTEP_SECONDS * MAX_SUBSTEPS_PER_FRAME
      );
      while (remaining > 1e-9) {
        const dt = Math.min(remaining, MAX_SUBSTEP_SECONDS);
        roll.world.timestep = dt;
        roll.world.step();
        remaining -= dt;
      }
    }
    roll.lastSteppedElapsed = elapsedSeconds;

    if (record.transitionElapsed === null) {
      const linvel = record.body.linvel(rapierLinvelScratch!);
      const angvel = record.body.angvel(rapierAngvelScratch!);
      const linSpeed = Math.hypot(linvel.x, linvel.y, linvel.z);
      const angSpeed = Math.hypot(angvel.x, angvel.y, angvel.z);
      const quiet = linSpeed < LINEAR_SETTLE_THRESHOLD && angSpeed < ANGULAR_SETTLE_THRESHOLD;
      const reachedMin = elapsedSeconds >= MIN_PHYSICS_SECONDS;
      const reachedMax = elapsedSeconds >= MAX_PHYSICS_SECONDS;

      const translation = record.body.translation(rapierTranslationScratch!);
      const rotation = record.body.rotation(rapierRotationScratch!);
      const isFinitePose =
        Number.isFinite(translation.x) &&
        Number.isFinite(translation.y) &&
        Number.isFinite(translation.z) &&
        Number.isFinite(rotation.x) &&
        Number.isFinite(rotation.y) &&
        Number.isFinite(rotation.z) &&
        Number.isFinite(rotation.w);

      if (!isFinitePose || reachedMax || (reachedMin && quiet)) {
        // Snapshot exactly once, at this fixed transition instant — from
        // here on, this die's pose is a pure function of elapsed time and
        // this frozen snapshot, never physics again (§7's own "the natural
        // outcome of the physics phase is simply never consulted"). A
        // non-finite pose (a real, if rare, numerical edge case — e.g. an
        // unlucky simultaneous multi-body collision) snapshots to the
        // guaranteed-correct target directly rather than ever risking a
        // NaN/garbage frame reaching the screen.
        record.snapshotPosition = isFinitePose
          ? [translation.x, translation.y, translation.z]
          : [0, record.targetHeight, 0];
        record.snapshotQuaternion = isFinitePose
          ? new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
          : record.targetQuaternion.clone();
        record.transitionElapsed = elapsedSeconds;
        roll.pendingCount = Math.max(0, roll.pendingCount - 1);
      } else {
        eulerScratch.setFromQuaternion(quaternionScratch.set(rotation.x, rotation.y, rotation.z, rotation.w));
        return {
          position: [translation.x, translation.y, translation.z],
          rotation: [eulerScratch.x, eulerScratch.y, eulerScratch.z],
          settled: false,
        };
      }
    }

    // Blend from the frozen live snapshot into the guaranteed-correct target
    // pose (§7) — rotation slerps into targetQuaternion exactly like
    // scriptedDiceAnimator's own settle phase; position keeps physics's own
    // natural (x, z) landing spot (there is no "wrong" landing spot, only a
    // wrong FACE, so nothing there needs correcting) but eases height into
    // targetHeight, the exact resting height THIS orientation demands — a
    // die that settled face-down on the "wrong" side needs a small
    // lift-and-settle to end up flush on the corrected face, which reads as
    // a real die's own last damped wobble, not a snap.
    const [snapshotX, snapshotY, snapshotZ] = record.snapshotPosition!;
    const blendT = Math.min((elapsedSeconds - record.transitionElapsed!) / SETTLE_BLEND_SECONDS, 1);
    const eased = easeOutCubic(blendT);
    quaternionScratch.copy(record.snapshotQuaternion!).slerp(record.targetQuaternion, eased);
    eulerScratch.setFromQuaternion(quaternionScratch);
    const y = snapshotY + (record.targetHeight - snapshotY) * eased;

    return {
      position: [snapshotX, y, snapshotZ],
      rotation: [eulerScratch.x, eulerScratch.y, eulerScratch.z],
      settled: blendT >= 1,
    };
  },
};
