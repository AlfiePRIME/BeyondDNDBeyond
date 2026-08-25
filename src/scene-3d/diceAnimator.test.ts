import { describe, expect, it } from "vitest";
import { Euler, Quaternion, Vector3 } from "three";
import { scriptedDiceAnimator, type DiceTumbleDieSpec } from "./diceAnimator";
import { faceNormalForResult } from "./diceGeometry";

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
