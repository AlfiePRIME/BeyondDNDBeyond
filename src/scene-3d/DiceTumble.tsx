"use client";

import {
  memo,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Billboard } from "@react-three/drei";
import { BufferGeometry, CanvasTexture, SRGBColorSpace } from "three";
import { TABLE_TOP, TABLE_SURFACE_Y } from "./table";
import { buildDieGeometry, dieKindForSides, type DieKind } from "./diceGeometry";
import { useDiceTumble } from "./useDiceTumble";
import type { DiceTumbleDieSpec } from "./diceAnimator";

/** One roll's worth of dice for the tumble to animate — the plain,
 * data-access-free shape this module exposes to the app layer (the
 * MapSurfaceCell/CampaignMember decoupling precedent: scene-3d never
 * imports RollLogEntry/RollBreakdown directly). `id` is the roll's own id,
 * reused as the React key that remounts a fresh set of dice per roll. See
 * src/app/campaigns/[id]/roll/tumble.ts's buildDiceTumbleSpec for the one
 * place a RollLogEntry gets translated into this. */
export interface DiceTumbleSpec {
  id: string;
  dice: readonly { sides: number; result: number }[];
}

export interface DiceTumbleHandle {
  /** Queues `spec` to tumble — plays immediately if nothing is currently
   * animating, otherwise waits its turn (see DiceTumble's doc comment). */
  play(spec: DiceTumbleSpec): void;
}

export interface DiceTumbleProps {
  /** Fired whenever the FIFO queue's membership changes (a `play()` call
   * appending, or a completed roll's `onDone` shifting it off) — never on
   * every animation frame, since the queue is plain `useState`, not the
   * imperative per-frame plumbing `useDiceTumble` uses. This is a pure
   * observability hook, not read by DiceTumble itself: GameRoom mirrors it
   * into a hidden DOM node (the `visionDebug`/`tableSurfaceDebug`
   * precedent in GameRoom.tsx) so verify-dice-tumble.mjs's Playwright
   * checks have something to read — a WebGL scene has no DOM of its own to
   * inspect, and pixel-diffing a canvas can't distinguish "which roll" or
   * "dropped vs. still queued". Index 0 is always the currently-animating
   * roll; the rest are waiting their turn. */
  onQueueChange?: (rollIds: readonly string[]) => void;
  /** Where this tray sits in the scene — defaults to `DEFAULT_TRAY_POSITION`
   * (the original fixed corner nook), so every existing caller's behavior
   * is byte-for-byte unchanged. Phase 3 (the DM's private dice) mounts a
   * SECOND `DiceTumble` with this overridden to a spot in front of the DM's
   * own seat, so a private roll lands somewhere only the DM's own camera
   * naturally sees — see GameRoom.tsx's `dmPrivateTrayPosition`. */
  trayPosition?: readonly [number, number, number];
}

const DIE_SIZE = 0.13;
const FALLBACK_COLOR = "#8f86ad"; // Same placeholder tone as SeatAvatar/PlacedObject.
const DIE_COLOR = "#c9482f";
const TRAY_COLOR = "#2a2140"; // Matches GameTableScene's seat-cushion tone.
// Exported: GameRoom.tsx's movable-chair collision avoidance
// (seating.ts's resolveChairDrop) treats the shared tray as one of the
// obstacles a dropped chair must clear, and needs this same real radius —
// not a hand-copied guess that could silently drift from it.
export const TRAY_RADIUS = 0.55;

// How long a fully-settled roll's result stays legible before the next
// queued roll takes over the tray.
const LINGER_MS = 1100;
const MAX_QUEUE = 8;

function FallbackDieMesh() {
  return (
    <mesh castShadow receiveShadow>
      <icosahedronGeometry args={[DIE_SIZE, 0]} />
      <meshStandardMaterial color={FALLBACK_COLOR} roughness={0.5} />
    </mesh>
  );
}

// Built once per shape (not per instance/roll) — cheap (six possible
// shapes, tiny meshes) and keeps every simultaneous die of the same kind
// (e.g. "4d6") sharing one geometry object, the ordinary
// multi-mesh-one-geometry three.js practice.
const geometryCache = new Map<DieKind, BufferGeometry>();

function geometryFor(kind: DieKind): BufferGeometry {
  let geometry = geometryCache.get(kind);
  if (!geometry) {
    geometry = buildDieGeometry(kind, DIE_SIZE);
    geometryCache.set(kind, geometry);
  }
  return geometry;
}

/** Renders the real modeled shape for one of the six standard dice (built
 * procedurally — see diceGeometry.ts), or a plain placeholder icosahedron
 * for anything else. A free-form roll can produce an odd side count (d100,
 * d3, d2, ...) with no matching shape, and rather than fail to render, it
 * still tumbles and still gets the billboarded result badge, just not a
 * faithful model. That's out of scope here because the quick-roll buttons
 * this phase adds only ever produce the six standard kinds. */
function DieMesh({ sides }: { sides: number }) {
  const kind = dieKindForSides(sides);
  // Hooks must run unconditionally regardless of `kind`, so the memo itself
  // stays a no-op (null) rather than being skipped — the fallback below
  // branches on the VALUE, not on whether the hook ran.
  const geometry = useMemo(() => (kind ? geometryFor(kind) : null), [kind]);
  if (!kind || !geometry) return <FallbackDieMesh />;
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial color={DIE_COLOR} roughness={0.45} />
    </mesh>
  );
}

const resultBadgeTextureCache = new Map<string, CanvasTexture>();

// Same cached 2D-canvas-texture technique as MapSurface's condition/HP
// badges — a handful of distinct short labels, so one texture per label
// costs nothing per frame and needs no font asset.
function resultBadgeTexture(label: string): CanvasTexture {
  let texture = resultBadgeTextureCache.get(label);
  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#16102a";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = "#1ec8c8";
      context.lineWidth = 4;
      context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
      context.fillStyle = "#1ec8c8";
      context.font = "bold 34px monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(label, canvas.width / 2, canvas.height / 2 + 2);
    }
    texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    resultBadgeTextureCache.set(label, texture);
  }
  return texture;
}

/** Billboarded above a settled die so its result reads from every seat
 * around the table regardless of the die's final orientation — this, not
 * the mesh's own pose, is what actually carries the number unambiguously
 * (see diceGeometry.ts's doc comment on why the mesh alone can't). */
const ResultBadge = memo(function ResultBadge({ value }: { value: number }) {
  return (
    <Billboard position={[0, 0.22, 0]}>
      <mesh>
        <planeGeometry args={[0.22, 0.15]} />
        <meshBasicMaterial map={resultBadgeTexture(String(value))} transparent />
      </mesh>
    </Billboard>
  );
});

function Die({
  spec,
  onSettled,
}: {
  spec: DiceTumbleDieSpec;
  onSettled: (id: string) => void;
}) {
  const { ref, phase } = useDiceTumble(spec);

  useEffect(() => {
    if (phase === "settled") onSettled(spec.id);
  }, [phase, spec.id, onSettled]);

  return (
    <group ref={ref}>
      <DieMesh sides={spec.sides} />
      {phase === "settled" ? <ResultBadge value={spec.result} /> : null}
    </group>
  );
}

/** Mounts one roll's dice, tracks when every one of them has individually
 * settled, and fires `onDone` after a short linger so the result stays
 * legible before the tray clears for the next queued roll. */
function ActiveTumble({ spec, onDone }: { spec: DiceTumbleSpec; onDone: () => void }) {
  const dice = useMemo<DiceTumbleDieSpec[]>(
    () => spec.dice.map((die, index) => ({ ...die, id: `${spec.id}:${index}` })),
    [spec]
  );
  const settledIdsRef = useRef<Set<string>>(new Set());
  const [allSettled, setAllSettled] = useState(false);

  const handleSettled = useCallback(
    (id: string) => {
      settledIdsRef.current.add(id);
      if (settledIdsRef.current.size >= dice.length) setAllSettled(true);
    },
    [dice.length]
  );

  useEffect(() => {
    if (!allSettled) return;
    const timer = setTimeout(onDone, LINGER_MS);
    return () => clearTimeout(timer);
  }, [allSettled, onDone]);

  return (
    <>
      {dice.map((die) => (
        <Die key={die.id} spec={die} onSettled={handleSettled} />
      ))}
    </>
  );
}

function DiceTray() {
  return (
    <mesh position={[0, -0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <circleGeometry args={[TRAY_RADIUS, 32]} />
      <meshStandardMaterial color={TRAY_COLOR} roughness={0.85} />
    </mesh>
  );
}

// A fixed, modest corner nook — inset further than the table legs so it
// never collides with one, and (per computeTableMapMetrics's own margin
// reasoning) inside the border of bare tabletop every live map leaves
// visible around itself, so a tumble never sits on top of the map, tokens,
// or camera controls. The shared tray's default; overridable per-instance
// via the `trayPosition` prop (Phase 3's DM-private second tray). Exported
// alongside TRAY_RADIUS for the movable-chair collision avoidance
// (GameRoom.tsx's resolveChairDrop obstacle list) — the shared tray always
// sits exactly here, so this is the one real value to check a dropped
// chair against, not a hand-copied duplicate of it.
export const DEFAULT_TRAY_POSITION: readonly [number, number, number] = [
  TABLE_TOP.width / 2 - 0.85,
  TABLE_SURFACE_Y + 0.01,
  -(TABLE_TOP.depth / 2 - 0.85),
];

/**
 * Mounted once as a sibling of GameTableScene inside the Game Room's
 * <Canvas> (GameRoom.tsx), in its own fixed corner of the table by default —
 * see DEFAULT_TRAY_POSITION/`trayPosition`. Exposes an imperative
 * `play(spec)` handle rather than a `rolls` prop: GameRoom calls it once for
 * its own roll (immediately, no network round trip) and once from the
 * DICE_ROLLED_EVENT broadcast handler for every other roll, and this
 * component owns turning that stream of `play()` calls into a well-behaved
 * single-file animation. As of Phase 3, GameRoom also mounts a SECOND
 * instance — DM-only, `trayPosition` overridden to a spot in front of the
 * DM's own seat — for private rolls that must never broadcast; the two
 * instances are otherwise identical and share none of their own state.
 *
 * Overlapping rolls are handled with a plain FIFO queue rather than trying
 * to lay multiple simultaneous tumbles out in the tray's small footprint:
 * a new `play()` while one is still animating is appended (deduped by
 * spec.id against re-delivery, capped at MAX_QUEUE as a defensive backstop
 * against a pathological burst), and each queued roll gets its own full,
 * uninterrupted tumble-settle-linger cycle in turn. `ActiveTumble` is keyed
 * by `spec.id`, so advancing the queue is a full remount — every die's
 * ref/animation-clock/phase starts completely fresh, with no chance of a
 * new roll's dice inheriting or clobbering the previous roll's Three.js
 * state.
 */
export const DiceTumble = forwardRef<DiceTumbleHandle, DiceTumbleProps>(function DiceTumble(
  { onQueueChange, trayPosition = DEFAULT_TRAY_POSITION },
  ref
) {
  const [queue, setQueue] = useState<DiceTumbleSpec[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      play(spec: DiceTumbleSpec) {
        setQueue((current) => {
          if (current.some((queued) => queued.id === spec.id)) return current;
          if (current.length >= MAX_QUEUE) return current;
          return [...current, spec];
        });
      },
    }),
    []
  );

  useEffect(() => {
    onQueueChange?.(queue.map((spec) => spec.id));
  }, [queue, onQueueChange]);

  const active = queue[0] ?? null;
  const handleDone = useCallback(() => {
    setQueue((current) => current.slice(1));
  }, []);

  return (
    <group position={trayPosition as [number, number, number]}>
      <DiceTray />
      {active ? <ActiveTumble key={active.id} spec={active} onDone={handleDone} /> : null}
    </group>
  );
});
