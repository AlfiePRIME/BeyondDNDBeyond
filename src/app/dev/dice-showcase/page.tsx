"use client";

/*
 * Dev-only dice-numbering showcase (docs/design/dice-numbers-and-physics.md
 * §4/§5) — the src/app/dev/ui-showcase precedent, applied to dice: every
 * standard die kind's real printed-number face decals, rendered through the
 * ACTUAL production DiceTumble component (not a mockup or a hand-drawn
 * reproduction), close enough to actually read the numbers. The Game
 * Room's own camera/UI never gets this close (a die is a small, table-scale
 * prop viewed from across a table, not a focal point, and the room's own
 * panel layout sits directly over a personal tray's usual on-screen spot),
 * so this is the one place to eyeball "are the decals legible/correctly
 * placed/correctly oriented" without a physical die in hand. No auth on
 * purpose, same as ui-showcase.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import { DiceTumble, type DiceTumbleHandle, type DiceTumbleSpec } from "@/scene-3d";
import styles from "./dice-showcase.module.css";

// One interesting (non-1, non-max) result per standard kind — exercises a
// real settle-and-orient, not just "does face 1 render".
// A non-1 result per standard kind, chosen for two independent reasons:
// (1) it exercises a real settle-and-orient, not just "does face 1 render",
// and (2) it's a screenshot-framing pick for THIS preview's own tight fixed
// camera specifically — the pre-existing ResultBadge is nested inside the
// same <group> the die's own settle ROTATION is applied to (DiceTumble.tsx's
// Die component, unchanged by this feature), so its [0, 0.22, 0] offset
// gets carried through that rotation before Billboard re-faces it toward
// the camera; depending on which face normal settles to world-up, the
// badge can end up displaced in a direction other than "straight up" (e.g.
// d4's own result=3/result=4 rotate that offset to point mostly DOWN, well
// outside this preview's own cropped canvas — a real property of the
// existing scripted settle math, not something this feature changes or
// needs to fix). `id` only affects each die's random start-position/tumble
// jitter (diceAnimator.ts's seedFor), not this rotation, so a "-c" suffix
// is a harmless, purely-cosmetic seed pick for the same reason.
const STANDARD_KINDS: readonly { sides: number; result: number; title: string; id: string }[] = [
  { sides: 4, result: 2, title: "d4", id: "preview-d4-c" },
  { sides: 6, result: 6, title: "d6", id: "preview-d6-c" },
  { sides: 8, result: 7, title: "d8", id: "preview-d8-c" },
  { sides: 10, result: 9, title: "d10", id: "preview-d10-c" },
  { sides: 12, result: 11, title: "d12", id: "preview-d12-c" },
  { sides: 20, result: 6, title: "d20", id: "preview-d20-c" },
];

// The exact percentile-pair decomposition src/app/campaigns/[id]/roll/
// tumble.ts's own percentileDicePair produces for an authoritative roll of
// 57 (docs/design/dice-numbers-and-physics.md §5's own worked boundary
// example) — reproduced by hand here since this preview only needs the
// resulting DiceTumbleSpec shape, not the app-layer roll_log flattening
// tumble.ts actually does end to end (that path has its own real unit tests
// — tumble.test.ts — and its own real Playwright coverage).
const PERCENTILE_TENS_LABELS = ["00", "10", "20", "30", "40", "50", "60", "70", "80", "90"];
const PERCENTILE_ONES_LABELS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const PERCENTILE_EXAMPLE: DiceTumbleSpec = {
  id: "preview-percentile-57",
  dice: [
    { sides: 10, result: 6, labelSet: PERCENTILE_TENS_LABELS }, // Prints "50".
    { sides: 10, result: 8, labelSet: PERCENTILE_ONES_LABELS }, // Prints "7" -> 50 + 7 = 57.
  ],
};

function DicePreviewCell({ title, spec }: { title: string; spec: DiceTumbleSpec }) {
  const handleRef = useRef<DiceTumbleHandle | null>(null);
  // A settled-and-lingering roll is only visible for LINGER_MS before the
  // tray clears and waits for the next `play()` call — too narrow a window
  // to reliably screenshot against a fixed sleep. Instead, loop: the
  // instant this tray's own queue empties (a roll just finished its whole
  // tumble-settle-linger cycle), immediately queue the SAME roll again, so
  // a settled die stays on screen essentially continuously for as long as
  // this page stays open. `settled` mirrors DiceTumbleProps.onDieSettled
  // into the DOM so a screenshot script can wait for the deterministic
  // "decals + badge are both showing" moment instead of guessing a delay.
  const [settled, setSettled] = useState(false);

  const handleQueueChange = useCallback(
    (queue: readonly string[]) => {
      if (queue.length === 0) {
        setSettled(false);
        handleRef.current?.play(spec);
      }
    },
    [spec]
  );
  const handleDieSettled = useCallback(() => setSettled(true), []);

  useEffect(() => {
    handleRef.current?.play(spec);
    // Intentionally mount-only: `spec` is a fresh object identity per
    // render at the call site below, but this cell only ever wants to
    // kick off its own loop once, the instant its own DiceTumble handle is
    // ready — handleQueueChange above is what keeps it going after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.cell} data-testid={`dice-preview-${title}`}>
      <div className={styles.cellLabel}>{title}</div>
      <div data-testid={`dice-preview-settled-${title}`} hidden>
        {JSON.stringify(settled)}
      </div>
      <Canvas>
        <PerspectiveCamera
          makeDefault
          position={[0, 0.95, 0.24]}
          fov={58}
          onUpdate={(camera) => camera.lookAt(0, 0.19, 0)}
        />
        <ambientLight intensity={1.15} />
        <directionalLight position={[1, 2, 1]} intensity={1.4} />
        <directionalLight position={[-1, 1, -1]} intensity={0.5} />
        <DiceTumble
          ref={handleRef}
          trayPosition={[0, 0, 0]}
          scale={1}
          onQueueChange={handleQueueChange}
          onDieSettled={handleDieSettled}
        />
      </Canvas>
    </div>
  );
}

export default function DiceShowcasePage() {
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Dice numbering showcase</h1>
      <p className={styles.subtitle}>
        Every standard die kind&apos;s real printed-number face decals, plus a percentile
        (d100) pair, rendered through the production DiceTumble component and camera-framed
        close enough to actually read.
      </p>
      <div className={styles.grid}>
        {STANDARD_KINDS.map(({ sides, result, title, id }) => (
          <DicePreviewCell key={title} title={title} spec={{ id, dice: [{ sides, result }] }} />
        ))}
        <DicePreviewCell title="d100 (percentile pair, 50+7=57)" spec={PERCENTILE_EXAMPLE} />
      </div>
    </main>
  );
}
