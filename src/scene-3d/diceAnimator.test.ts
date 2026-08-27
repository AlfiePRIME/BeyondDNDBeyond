import { beforeAll, describe, expect, it } from "vitest";
import { Euler, Quaternion, Vector3 } from "three";
import {
  MAX_PHYSICS_DICE_PER_ROLL,
  disposeDicePhysicsRoll,
  isDicePhysicsReady,
  physicsDiceAnimator,
  pickDiceAnimator,
  preloadDicePhysics,
  scriptedDiceAnimator,
  type DiceAnimator,
  type DiceTumbleDieSpec,
} from "./diceAnimator";
import { DIE_KINDS, faceNormalForResult, type DieKind } from "./diceGeometry";

const SPEC: DiceTumbleDieSpec = { id: "roll-1:0", sides: 20, result: 17 };

describe("scriptedDiceAnimator.step", () => {
  it("is not settled at the start of the tumble", () => {
    expect(scriptedDiceAnimator.step(SPEC, 0).settled).toBe(false);
  });

  it("is settled well after the tumble should have finished", () => {
    expect(scriptedDiceAnimator.step(SPEC, 5).settled).toBe(true);
  });

  it("is a pure function of (spec, elapsed) — same inputs, same pose every time", () => {
    const a = scriptedDiceAnimator.step(SPEC, 0.3);
    const b = scriptedDiceAnimator.step(SPEC, 0.3);
    expect(a).toEqual(b);
  });

  it("gives two different dice in the same roll independent (non-identical) tumbles", () => {
    const dieA: DiceTumbleDieSpec = { id: "roll-2:0", sides: 6, result: 3 };
    const dieB: DiceTumbleDieSpec = { id: "roll-2:1", sides: 6, result: 3 };
    const poseA = scriptedDiceAnimator.step(dieA, 0.2);
    const poseB = scriptedDiceAnimator.step(dieB, 0.2);
    expect(poseA.position).not.toEqual(poseB.position);
  });

  it("settles with the server-given face's real modeled normal pointing world-up", () => {
    const finalPose = scriptedDiceAnimator.step(SPEC, 10);
    expect(finalPose.settled).toBe(true);
    const quaternion = new Quaternion().setFromEuler(new Euler(...finalPose.rotation));
    const targetNormal = new Vector3(...faceNormalForResult("d20", SPEC.result));
    const rotated = targetNormal.clone().applyQuaternion(quaternion);
    expect(rotated.x).toBeCloseTo(0, 4);
    expect(rotated.y).toBeCloseTo(1, 4);
    expect(rotated.z).toBeCloseTo(0, 4);
  });

  it("falls back to a plain up-facing pose for a non-standard side count (e.g. a free-form d100)", () => {
    const oddSpec: DiceTumbleDieSpec = { id: "roll-3:0", sides: 100, result: 42 };
    expect(() => scriptedDiceAnimator.step(oddSpec, 10)).not.toThrow();
    expect(scriptedDiceAnimator.step(oddSpec, 10).settled).toBe(true);
  });
});

// -----------------------------------------------------------------------
// pickDiceAnimator — this describe block deliberately runs BEFORE the
// physicsDiceAnimator describe block below (Vitest runs top-level describes
// in file declaration order, and preloadDicePhysics is never called at
// module scope), so this is the one place isDicePhysicsReady() is still
// reliably false — the "physics engine hasn't finished loading yet" half of
// pickDiceAnimator's own fallback contract.
// -----------------------------------------------------------------------
describe("pickDiceAnimator before the physics engine has loaded", () => {
  it("falls back to scriptedDiceAnimator regardless of die count", () => {
    expect(isDicePhysicsReady()).toBe(false);
    expect(pickDiceAnimator(1)).toBe(scriptedDiceAnimator);
    expect(pickDiceAnimator(4)).toBe(scriptedDiceAnimator);
  });
});

describe("physicsDiceAnimator.step (before preloadDicePhysics — defensive fallback)", () => {
  it("delegates to scriptedDiceAnimator rather than throwing", () => {
    const spec: DiceTumbleDieSpec = { id: "physics-not-ready:0", sides: 20, result: 9 };
    expect(physicsDiceAnimator.step(spec, 0)).toEqual(scriptedDiceAnimator.step(spec, 0));
  });
});

// -----------------------------------------------------------------------
// physicsDiceAnimator — real @dimforge/rapier3d-compat physics
// (docs/design/dice-numbers-and-physics.md §6-§9). Loading + WASM-
// initializing the engine is real async work (confirmed to run correctly
// under plain Node/vitest, not just a browser bundler), so every test below
// waits for it once via this describe's own beforeAll.
//
// Unlike scriptedDiceAnimator, this is no longer assertable as a pure
// function of (spec, elapsed) — a live physics world is unavoidably
// stateful (this file's own DiceAnimator doc comment anticipates exactly
// this). What IS assertable, and the one property that actually matters
// (docs/design/dice-numbers-and-physics.md's own "escalate rather than ship
// a wrong number" instruction): every roll settles on faceNormalForResult's
// exact target, regardless of the real, randomized, genuinely-chaotic
// physics tumble that precedes it.
// -----------------------------------------------------------------------
describe("physicsDiceAnimator (after the WASM engine has loaded)", () => {
  let uniqueId = 0;
  function nextRollId(label: string): string {
    uniqueId += 1;
    return `physics-test-${label}-${uniqueId}`;
  }

  /** Steps `animator` forward in small synthetic frame increments (not real
   * wall-clock time — elapsedSeconds is just a parameter) until it reports
   * settled or a generous ceiling is reached, returning the final pose. */
  function runToSettled(spec: DiceTumbleDieSpec, animator: DiceAnimator = physicsDiceAnimator) {
    const dt = 1 / 60;
    let pose = animator.step(spec, 0);
    for (let t = dt; t <= 3 && !pose.settled; t += dt) {
      pose = animator.step(spec, t);
    }
    return pose;
  }

  beforeAll(async () => {
    preloadDicePhysics();
    // preloadDicePhysics is fire-and-forget by design (see its own doc
    // comment) — poll isDicePhysicsReady() with a generous bound rather
    // than reaching into the module's private load promise.
    for (let attempt = 0; attempt < 400 && !isDicePhysicsReady(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(isDicePhysicsReady()).toBe(true);
  });

  it("is not settled at the very start of the tumble", () => {
    const rollId = nextRollId("start");
    const spec: DiceTumbleDieSpec = { id: `${rollId}:0`, sides: 20, result: 12 };
    expect(physicsDiceAnimator.step(spec, 0).settled).toBe(false);
    disposeDicePhysicsRoll(rollId);
  });

  it.each(DIE_KINDS)("settles %s on the exact server-given face, real modeled normal pointing world-up", (kind) => {
    const sides = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20 }[kind as DieKind];
    for (const result of [1, Math.ceil(sides / 2), sides]) {
      const rollId = nextRollId(`${kind}-${result}`);
      const spec: DiceTumbleDieSpec = { id: `${rollId}:0`, sides, result };
      const finalPose = runToSettled(spec);
      expect(finalPose.settled).toBe(true);
      const quaternion = new Quaternion().setFromEuler(new Euler(...finalPose.rotation));
      const targetNormal = new Vector3(...faceNormalForResult(kind as DieKind, result));
      const rotated = targetNormal.clone().applyQuaternion(quaternion);
      expect(rotated.x).toBeCloseTo(0, 3);
      expect(rotated.y).toBeCloseTo(1, 3);
      expect(rotated.z).toBeCloseTo(0, 3);
      disposeDicePhysicsRoll(rollId);
    }
  });

  it("settles a non-standard side count (e.g. an odd free-form roll) without throwing, face pointing up", () => {
    const rollId = nextRollId("odd");
    const spec: DiceTumbleDieSpec = { id: `${rollId}:0`, sides: 7, result: 3 };
    const finalPose = runToSettled(spec);
    expect(finalPose.settled).toBe(true);
    const quaternion = new Quaternion().setFromEuler(new Euler(...finalPose.rotation));
    const up = new Vector3(0, 1, 0).applyQuaternion(quaternion);
    expect(up.y).toBeCloseTo(1, 3);
    disposeDicePhysicsRoll(rollId);
  });

  it("gives two different dice in the same roll independent (non-identical) tumbles", () => {
    const rollId = nextRollId("independent");
    const dieA: DiceTumbleDieSpec = { id: `${rollId}:0`, sides: 6, result: 3 };
    const dieB: DiceTumbleDieSpec = { id: `${rollId}:1`, sides: 6, result: 3 };
    const poseA = physicsDiceAnimator.step(dieA, 1 / 60);
    const poseB = physicsDiceAnimator.step(dieB, 1 / 60);
    expect(poseA.position).not.toEqual(poseB.position);
    disposeDicePhysicsRoll(rollId);
  });

  it("advances a roll's shared physics world AT MOST ONCE per elapsedSeconds tick", () => {
    const rollId = nextRollId("shared-world");
    const dieA: DiceTumbleDieSpec = { id: `${rollId}:0`, sides: 6, result: 2 };
    const dieB: DiceTumbleDieSpec = { id: `${rollId}:1`, sides: 6, result: 5 };
    // t=0: both bodies are created; nothing has stepped yet (0 is not > the
    // world's own initial lastSteppedElapsed of 0).
    physicsDiceAnimator.step(dieA, 0);
    physicsDiceAnimator.step(dieB, 0);
    // t=0.05 (well under MIN_PHYSICS_SECONDS, so still genuinely tumbling —
    // neither die has transitioned to the guaranteed-correct blend yet,
    // which is what makes this comparison meaningful rather than trivially
    // true): die A's own call advances the shared world once; die B's own
    // call at the SAME elapsedSeconds must NOT advance it a second time.
    const poseA1 = physicsDiceAnimator.step(dieA, 0.05);
    physicsDiceAnimator.step(dieB, 0.05);
    const poseA2 = physicsDiceAnimator.step(dieA, 0.05);
    expect(poseA2).toEqual(poseA1);
    disposeDicePhysicsRoll(rollId);
  });

  it("disposeDicePhysicsRoll frees the world without throwing, and a later roll under the same id starts fresh", () => {
    const rollId = nextRollId("dispose");
    const spec: DiceTumbleDieSpec = { id: `${rollId}:0`, sides: 20, result: 4 };
    physicsDiceAnimator.step(spec, 0);
    physicsDiceAnimator.step(spec, 1 / 60);
    expect(() => disposeDicePhysicsRoll(rollId)).not.toThrow();
    // Reusing the exact same id after disposal must not throw (a freed
    // Rapier World being touched again is the one real way this could
    // crash) and must behave like a brand-new roll (not settled at t=0).
    expect(() => physicsDiceAnimator.step(spec, 0)).not.toThrow();
    expect(physicsDiceAnimator.step(spec, 0).settled).toBe(false);
    disposeDicePhysicsRoll(rollId);
  });

  it("disposeDicePhysicsRoll is a safe no-op for a roll id that never used physics", () => {
    expect(() => disposeDicePhysicsRoll("never-touched-physics-roll-id")).not.toThrow();
  });

  it("pickDiceAnimator returns physicsDiceAnimator at or under the cap, once physics is ready", () => {
    expect(pickDiceAnimator(1)).toBe(physicsDiceAnimator);
    expect(pickDiceAnimator(MAX_PHYSICS_DICE_PER_ROLL)).toBe(physicsDiceAnimator);
  });

  it("pickDiceAnimator falls back to scriptedDiceAnimator above MAX_PHYSICS_DICE_PER_ROLL, even though physics is ready", () => {
    expect(pickDiceAnimator(MAX_PHYSICS_DICE_PER_ROLL + 1)).toBe(scriptedDiceAnimator);
  });

  it("pickDiceAnimator falls back to scriptedDiceAnimator for a non-positive die count", () => {
    expect(pickDiceAnimator(0)).toBe(scriptedDiceAnimator);
  });
});
