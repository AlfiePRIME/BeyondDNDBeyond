import { Euler, Quaternion, Vector3 } from "three";
import { dieKindForSides, faceNormalForResult } from "./diceGeometry";

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
}

export type DiceAnimationPhase = "tumbling" | "settled";

export interface DicePose {
  position: readonly [number, number, number];
  /** Euler XYZ radians. */
  rotation: readonly [number, number, number];
  settled: boolean;
}

/**
 * The seam a future physics upgrade plugs into. Every caller (useDiceTumble
 * below, and transitively DiceTumble.tsx / the DiceLogPanel-GameRoom
 * trigger wiring) depends on nothing but this interface — a pure function
 * of (spec, elapsed seconds) → pose, with no React and no three.js scene
 * access. That purity is deliberate, the same injectable-seam shape as
 * rules-engine/dice.ts's RandomSource: it's what makes `scriptedDiceAnimator`
 * below unit-testable with plain assertions, and it's what a future
 * @react-three/rapier-backed implementation would need to preserve to drop
 * in as a straight replacement — e.g. stepping a physics world forward by
 * `elapsedSeconds` and reading the settling body's transform back out,
 * still returning the same `DicePose` shape, with zero changes to
 * useDiceTumble, DiceTumble.tsx, DiceLogPanel, or GameRoom. Swapping
 * implementations is therefore choosing which object DEFAULT_DICE_ANIMATOR
 * points at, not rewriting any call site.
 *
 * Today's `scriptedDiceAnimator` is explicitly NOT physics — see its own
 * doc comment — because Phase D's brief is a scripted tumble-and-settle
 * with scaffolding for a future physics upgrade, not the upgrade itself.
 */
export interface DiceAnimator {
  step(spec: DiceTumbleDieSpec, elapsedSeconds: number): DicePose;
}

// Airborne tumble, then ease into the settle pose; SETTLE_SECONDS is the
// total time until `settled` flips true.
const TUMBLE_SECONDS = 0.55;
const SETTLE_SECONDS = 0.85;

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
 * collision, no mass, no @react-three/rapier body — because that's a
 * separate, larger future upgrade (rigid-body dice actually interacting
 * with the table and each other); this is scaffolding for that upgrade
 * (the DiceAnimator seam above), not an attempt at it.
 */
export const scriptedDiceAnimator: DiceAnimator = {
  step(spec, elapsedSeconds) {
    const seedA = seedFor(spec.id);
    const seedB = seedFor(`${spec.id}:b`);
    const seedC = seedFor(`${spec.id}:c`);

    const startAngle = seedA * Math.PI * 2;
    const startRadius = 0.28 + seedB * 0.14;
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
