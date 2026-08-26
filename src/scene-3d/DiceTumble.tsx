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
import { buildDieGeometry, dieKindForSides, type DieKind } from "./diceGeometry";
import { useDiceTumble } from "./useDiceTumble";
import {
  DICE_START_RADIUS_BASE,
  DICE_START_RADIUS_JITTER,
  scriptedDiceAnimator,
  type DiceAnimator,
  type DiceTumbleDieSpec,
} from "./diceAnimator";
import { PlacedObject, PLACED_OBJECT_SIZE } from "./PlacedObject";

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
   * precedent in GameRoom.tsx) so verify-*.mjs's Playwright checks have
   * something to read — a WebGL scene has no DOM of its own to inspect, and
   * pixel-diffing a canvas can't distinguish "which roll" or "dropped vs.
   * still queued". Index 0 is always the currently-animating roll; the rest
   * are waiting their turn. */
  onQueueChange?: (rollIds: readonly string[]) => void;
  /** Where this tray sits in the scene — one per connected member, computed
   * by seating.ts's computeMemberTrayPosition/resolveMemberTrayLayout (see
   * GameRoom.tsx's memberTrayPositions). No default: every real caller now
   * supplies its own member-specific spot, unlike the old single
   * fixed-corner shared tray this replaced. */
  trayPosition: readonly [number, number, number];
  /** Lateral (x/z) spread scale for this tray's own dice-tumble physics —
   * multiplies the scripted animator's own horizontal travel distances
   * (diceAnimator.ts's DICE_START_RADIUS_BASE/JITTER), so a smaller
   * personal tray's dice never visually tumble outside its own smaller
   * disc/model footprint. Vertical bounce (position.y) and rotation are
   * left completely untouched — only the tray's own FOOTPRINT needs to
   * shrink, not how high or how fast a die spins. Defaults to
   * PERSONAL_TRAY_SCALE, since every real caller now mounts a personal
   * (not full-size) tray; pass 1 to reproduce the original full-size play
   * area exactly (trayRadiusForScale(1)'s own value). */
  scale?: number;
  /** A member's own chosen custom tray model (diceTrayPreference.ts's
   * "custom" source), already resolved to a loadable URL the same way
   * AssetPalette.tsx's map-object props are (resolvePaletteAssets) — null/
   * undefined (the "default" preference, or a resolution failure) renders
   * the built-in procedural felt disc (DiceTray) exactly as before this
   * feature existed. */
  modelUrl?: string | null;
  /** The custom model's own stored forward-direction correction (degrees,
   * model_orientation) — meaningless for a tray (nothing about a tray
   * "faces" anywhere) but threaded through anyway so PlacedObject renders
   * it identically to how the SAME asset would look placed on a map,
   * rather than silently dropping a correction the uploader dialed in. */
  modelForwardOffsetDeg?: number;
}

const DIE_SIZE = 0.13;
const FALLBACK_COLOR = "#8f86ad"; // Same placeholder tone as SeatAvatar/PlacedObject.
const DIE_COLOR = "#c9482f";
const TRAY_COLOR = "#2a2140"; // Matches GameTableScene's seat-cushion tone.

/**
 * A tray's real physical footprint radius at a given dice-motion `scale`
 * (DiceTumbleProps.scale) — a die's own farthest travel from the tray's
 * center is `DICE_START_RADIUS_BASE + DICE_START_RADIUS_JITTER` (the
 * scripted animator's own worst-case starting radius) times `scale`, plus
 * the die's own physical half-extent (DIE_SIZE) so the drawn disc/model
 * comfortably contains the die's rendered geometry too, not just its
 * center point. Exported so any caller needing a tray's real collision
 * radius (GameRoom.tsx's chair-drag obstacle list, seating.ts's
 * resolveMemberTrayLayout) derives it from this SAME formula instead of a
 * hand-copied literal that could silently drift from it — the
 * PLAYER_CHAIR_FRONTAGE/TRAY_RADIUS "single source of truth" precedent.
 */
export function trayRadiusForScale(scale: number): number {
  return (DICE_START_RADIUS_BASE + DICE_START_RADIUS_JITTER) * scale + DIE_SIZE;
}

/**
 * Every connected member's own personal tray uses this same dice-motion
 * scale and resulting radius — smaller than the original single shared
 * tray's full-size play area (trayRadiusForScale(1) === 0.55, the exact
 * pre-existing value), since N of these now render simultaneously, often
 * across a wider multi-table arrangement, and each one only ever needs to
 * hold ONE roller's own dice at a time. 0.35 keeps a die's own rendered
 * size (DIE_SIZE 0.13) a meaningfully large fraction of the tray's own
 * footprint (still reads as "a dice tray", not a coin), while giving
 * seating.ts's HEAD_SQUARE_MEMBER_TRAY_FRACTION/APPENDED_TABLE_MEMBER_TRAY_FRACTION
 * enough spare room to keep a realistic party's simultaneous personal trays
 * clear of each other — see that file's own doc comments and
 * scripts/db/verify-per-member-dice-trays.mjs for the numeric verification
 * this specific value was chosen against.
 */
export const PERSONAL_TRAY_SCALE = 0.35;
export const PERSONAL_TRAY_RADIUS = trayRadiusForScale(PERSONAL_TRAY_SCALE);

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

/** Wraps `animator` so its returned pose's horizontal (x/z) position is
 * multiplied by `scale` — the one seam a per-tray dice-motion scale needs
 * (useDiceTumble already accepts an injectable DiceAnimator for exactly
 * this kind of override, see its own doc comment), without touching
 * diceAnimator.ts's own pure step math at all. Vertical bounce (y) and
 * rotation pass through unchanged — only a tray's own FOOTPRINT needs to
 * shrink for a smaller personal tray, not how high or fast a die tumbles.
 * scale === 1 (the shared-tray-sized default) returns `animator` itself
 * unwrapped, so that exact case costs nothing extra and stays byte-for-byte
 * identical to the pre-existing behavior. */
function scaledDiceAnimator(animator: DiceAnimator, scale: number): DiceAnimator {
  if (scale === 1) return animator;
  return {
    step(spec, elapsedSeconds) {
      const pose = animator.step(spec, elapsedSeconds);
      return {
        ...pose,
        position: [pose.position[0] * scale, pose.position[1], pose.position[2] * scale],
      };
    },
  };
}

function Die({
  spec,
  animator,
  onSettled,
}: {
  spec: DiceTumbleDieSpec;
  animator: DiceAnimator;
  onSettled: (id: string) => void;
}) {
  const { ref, phase } = useDiceTumble(spec, animator);

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
function ActiveTumble({
  spec,
  animator,
  onDone,
}: {
  spec: DiceTumbleSpec;
  animator: DiceAnimator;
  onDone: () => void;
}) {
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
        <Die key={die.id} spec={die} animator={animator} onSettled={handleSettled} />
      ))}
    </>
  );
}

function DiceTray({ radius }: { radius: number }) {
  return (
    <mesh position={[0, -0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <circleGeometry args={[radius, 32]} />
      <meshStandardMaterial color={TRAY_COLOR} roughness={0.85} />
    </mesh>
  );
}

/** A member's own chosen custom tray model in place of the procedural
 * DiceTray disc — reuses PlacedObject (the exact same GLB-loading/
 * normalize/error-boundary/Suspense machinery a map prop already renders
 * through, per this feature's own "reuse the existing upload pipeline"
 * brief) wrapped in a uniform re-scale from PlacedObject's own fixed
 * PLACED_OBJECT_SIZE normalization down to this tray's real footprint
 * (`radius * 2`) — so a custom tray model always fits the exact same
 * play-area/collision footprint a procedural disc at this radius would,
 * regardless of the uploaded model's own real-world proportions. */
function CustomTrayModel({
  url,
  forwardOffsetDeg,
  radius,
}: {
  url: string;
  forwardOffsetDeg: number;
  radius: number;
}) {
  const scale = (radius * 2) / PLACED_OBJECT_SIZE;
  return (
    <group scale={scale}>
      <PlacedObject url={url} forwardOffsetDeg={forwardOffsetDeg} />
    </group>
  );
}

/**
 * Mounted once PER CONNECTED MEMBER as a sibling of GameTableScene inside
 * the Game Room's <Canvas> (GameRoom.tsx) — replacing the original single
 * shared tray plus the DM's separate private tray with one of these per
 * member, each at that member's own computed spot (`trayPosition`, see
 * seating.ts's computeMemberTrayPosition/GameRoom.tsx's
 * memberTrayPositions). Exposes an imperative `play(spec)` handle rather
 * than a `rolls` prop: GameRoom calls it once for its own roll (immediately,
 * no network round trip) and once from the DICE_ROLLED_EVENT broadcast
 * handler for every other public roll, keyed by the roll's own
 * roller_user_id so it always lands at the ROLLER's own tray, never a
 * shared one. A DM's PRIVATE roll reuses this exact same per-member
 * instance (the DM's own) — see GameRoom.tsx's handleRollLanded — the
 * visibility rule that keeps it off every other client is still purely "was
 * this ever broadcast at all", completely unchanged by this generalization.
 * This component owns turning that stream of `play()` calls into a
 * well-behaved single-file animation for exactly this one member's own
 * rolls; every other member's own instance keeps a completely independent
 * queue, so two different members' rolls always animate concurrently at
 * their own separate trays rather than competing for one shared spot.
 *
 * Overlapping rolls FROM THE SAME roller are handled with a plain FIFO
 * queue rather than trying to lay multiple simultaneous tumbles out in the
 * tray's small footprint: a new `play()` while one is still animating is
 * appended (deduped by spec.id against re-delivery, capped at MAX_QUEUE as
 * a defensive backstop against a pathological burst), and each queued roll
 * gets its own full, uninterrupted tumble-settle-linger cycle in turn.
 * `ActiveTumble` is keyed by `spec.id`, so advancing the queue is a full
 * remount — every die's ref/animation-clock/phase starts completely fresh,
 * with no chance of a new roll's dice inheriting or clobbering the previous
 * roll's Three.js state.
 */
export const DiceTumble = forwardRef<DiceTumbleHandle, DiceTumbleProps>(function DiceTumble(
  { onQueueChange, trayPosition, scale = PERSONAL_TRAY_SCALE, modelUrl = null, modelForwardOffsetDeg = 0 },
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

  const animator = useMemo(() => scaledDiceAnimator(scriptedDiceAnimator, scale), [scale]);
  const radius = useMemo(() => trayRadiusForScale(scale), [scale]);

  return (
    <group position={trayPosition as [number, number, number]}>
      {modelUrl ? (
        <CustomTrayModel url={modelUrl} forwardOffsetDeg={modelForwardOffsetDeg} radius={radius} />
      ) : (
        <DiceTray radius={radius} />
      )}
      {active ? <ActiveTumble key={active.id} spec={active} animator={animator} onDone={handleDone} /> : null}
    </group>
  );
});
