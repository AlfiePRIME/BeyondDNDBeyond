import { useRef, useState, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import { scriptedDiceAnimator, type DiceAnimationPhase, type DiceAnimator, type DiceTumbleDieSpec } from "./diceAnimator";

export interface DiceAnimationHandle {
  /** Attach to the die's <group> — position/rotation are written onto it
   * imperatively every frame, not through React state, so a tumble doesn't
   * cost a re-render at 60fps for a value the mesh only ever reads. */
  ref: RefObject<Group | null>;
  /** The only state worth re-rendering for: "tumbling" while animating,
   * "settled" once at rest (e.g. so a caller knows when it's safe to show
   * the result badge, or to advance a roll queue). */
  phase: DiceAnimationPhase;
}

/**
 * The one calling convention every consumer depends on — see DiceAnimator's
 * doc comment in diceAnimator.ts for the full seam rationale. This hook
 * itself is intentionally tiny and framework-only (useFrame plumbing); ALL
 * of the actual tumble behavior lives in `animator`, which defaults to
 * today's scripted implementation but can be overridden per-call (tests, or
 * eventually a physics-backed alternative) without touching this file.
 *
 * Callers remount per roll via `key={spec.id}` (DiceTumble.tsx does this)
 * rather than this hook watching `spec.id` itself — a fresh mount gives a
 * fresh ref/elapsed-time clock/phase for free, which is simpler than
 * resetting animator state mid-life.
 *
 * `onImpact` (SP8) fires imperatively, straight out of this same per-frame
 * useFrame callback, on every frame `animator.step()` reports
 * `pose.impacted` — never through React state (the same reason position/
 * rotation are written onto `ref` directly below rather than re-rendering):
 * a real chaotic bounce phase can report an impact on several frames in
 * close succession, and routing that through state would both be needlessly
 * slow and risk coalescing/dropping events under React's own batching. This
 * hook is deliberately just a pass-through of the RAW per-frame signal —
 * DicePose.impacted's own doc comment is explicit that it is never
 * debounced at the source — so `onImpact` can fire more than once in quick
 * succession; whatever the caller does with it (DiceTumble.tsx's Die
 * component playing a rate-limited sound) owns that policy, not this hook.
 * Never called for `scriptedDiceAnimator` (always reports `impacted: false`
 * — no real collisions to report).
 */
export function useDiceTumble(
  spec: DiceTumbleDieSpec,
  animator: DiceAnimator = scriptedDiceAnimator,
  onImpact?: () => void
): DiceAnimationHandle {
  const ref = useRef<Group>(null);
  const startElapsedRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<DiceAnimationPhase>("tumbling");

  useFrame((state) => {
    if (startElapsedRef.current === null) startElapsedRef.current = state.clock.elapsedTime;
    const elapsedSeconds = state.clock.elapsedTime - startElapsedRef.current;
    const pose = animator.step(spec, elapsedSeconds);

    const group = ref.current;
    if (group) {
      group.position.set(pose.position[0], pose.position[1], pose.position[2]);
      group.rotation.set(pose.rotation[0], pose.rotation[1], pose.rotation[2]);
    }
    if (pose.impacted) onImpact?.();
    if (pose.settled && phase !== "settled") setPhase("settled");
  });

  return { ref, phase };
}
