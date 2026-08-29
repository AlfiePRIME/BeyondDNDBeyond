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
import { BufferGeometry, CanvasTexture, DoubleSide, Quaternion, SRGBColorSpace, Vector3 } from "three";
import { SOUND_KEYS, playSound } from "@/audio";
import {
  DEFAULT_FACE_LABELS,
  DIE_FACE_NORMALS,
  DIE_SIZE,
  buildDieGeometry,
  dieKindForSides,
  facePlaneDistance,
  labelForResult,
  type DieKind,
} from "./diceGeometry";
import { useDiceTumble } from "./useDiceTumble";
import {
  DICE_START_RADIUS_BASE,
  DICE_START_RADIUS_JITTER,
  disposeDicePhysicsRoll,
  physicsDiceAnimator,
  pickDiceAnimator,
  preloadDicePhysics,
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
  dice: readonly { sides: number; result: number; labelSet?: readonly string[] }[];
}

export interface DiceTumbleHandle {
  /** Queues `spec` to tumble — plays immediately if nothing is currently
   * animating, otherwise waits its turn (see DiceTumble's doc comment). */
  play(spec: DiceTumbleSpec): void;
}

/** DiceTumbleProps.onDieSettled's own payload shape — see that prop's doc
 * comment. `dieIndex` is the die's own position within the settled roll's
 * `spec.dice` array (a percentile pair's tens die is index 0, ones die
 * index 1). `usedPhysics` reflects the WHOLE ROLL's own animator choice
 * (pickDiceAnimator, decided once per roll — docs/design/dice-numbers-and-
 * physics.md §9) — true when this die's tumble was really
 * physics-simulated, false when it fell back to scriptedDiceAnimator (a
 * too-large roll, or the WASM engine not yet ready). Purely an
 * observability field for scripts/db/verify-dice-physics.mjs and
 * scripts/perf/dice-physics-benchmark.mjs to confirm real physics actually
 * ran, not just that the (always-correct-either-way) result was right —
 * the same "mirror it into a hidden DOM node for Playwright" precedent
 * every other field on this interface already follows. */
export interface DiceFaceSettledInfo {
  rollId: string;
  dieIndex: number;
  sides: number;
  result: number;
  label: string;
  usedPhysics: boolean;
  /** This die's own settled `<group>` local Y — i.e. the SAME tray-local
   * coordinate space diceAnimator.ts's physics floor sits in (that floor's
   * own real position is exactly local Y=0, see buildTrayBoundary), not a
   * world-space Y. `ResultBadge`'s own floating badge always renders at
   * this exact value plus a fixed +0.22 offset (its own hard-coded
   * `<Billboard position={[0, 0.22, 0]}>`), so this one number is also the
   * complete story for the badge's own render height — no separate field
   * needed for it. Purely an observability field for
   * scripts/db/verify-dice-tunneling-fix.mjs to confirm a real settled die
   * (and by construction its ResultBadge) never renders below the tray's
   * own floor — the same "mirror it into a hidden DOM node for Playwright"
   * precedent usedPhysics above already follows. */
  positionY: number;
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
  /** Fired once per die, the instant it settles — `dieIndex` is that die's
   * own position within the active roll's `spec.dice` array, `label` is the
   * exact printed value BOTH its own face decal and the floating
   * ResultBadge show (both are computed by the same labelForResult call, so
   * they can never disagree — see Die's own doc comment). Same
   * observability-hook shape as onQueueChange above: not read by DiceTumble
   * itself, purely so verify-*.mjs's Playwright checks (mirrored by
   * GameRoom into a hidden DOM node) can confirm a real roll's die-face and
   * badge stay in agreement without needing to OCR a WebGL canvas. */
  onDieSettled?: (info: DiceFaceSettledInfo) => void;
}

const FALLBACK_COLOR = "#8f86ad"; // Same placeholder tone as SeatAvatar/PlacedObject.
const DIE_COLOR = "#c9482f";

// The default procedural tray's own palette (DiceTray, below) — deliberately
// mirrors the SAME wood-tone / purple-teal vocabulary GameTableScene's own
// WOOD_TOP and Chair.tsx's PURPLE/TEAL trim already establish for every
// other piece of furniture at this table, rather than inventing a new look
// for the one remaining always-procedural prop (Chair.tsx/GameTableScene's
// table both moved to real glTF models specifically because procedural
// furniture reads as flat/generic without real detail — see this file's own
// module doc comment on the pattern this pass borrows from them: real wood
// material tones plus a canvas-drawn decorative motif, not just flat color).
const TRAY_FELT = "#2a2140"; // Unchanged from the pre-existing TRAY_COLOR — matches GameTableScene's seat-cushion tone; still the felt playing surface's own base tone.
const TRAY_WOOD = "#5a4028"; // Matches GameTableScene's WOOD_TOP / Chair's PLAYER_WOOD.
const TRAY_ACCENT_TEAL = "#1ec8c8"; // --teal
const TRAY_ACCENT_PURPLE = "#9b00ff"; // --purple

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

// A hair of outward offset for each face's printed-number decal, so its
// quad never coplanar-z-fights with the base mesh's own triangle it sits
// directly on top of — docs/design/dice-numbers-and-physics.md §4's
// DECAL_EPSILON. Computed once per kind (every face of a fair die is
// equidistant from center — diceGeometry.ts's facePlaneDistance), not
// per-face, and cached the same way geometryCache caches buildDieGeometry.
const DECAL_EPSILON = 0.002;
const facePlaneDistanceCache = new Map<DieKind, number>();

function facePlaneDistanceFor(kind: DieKind): number {
  let distance = facePlaneDistanceCache.get(kind);
  if (distance === undefined) {
    distance = facePlaneDistance(kind, DIE_SIZE);
    facePlaneDistanceCache.set(kind, distance);
  }
  return distance;
}

// Each decal quad's own on-screen size, tuned by eye per kind against that
// kind's own real measured face size (diceGeometry.ts's facePlaneDistance
// correlates with it, but face SHAPE matters too — d20's 20 small
// triangular faces need a noticeably smaller decal than d6's 6 large square
// ones, and d10's kite faces are narrow in one direction, or the numeral
// would spill past the face's own edges onto a neighboring face). Verified
// against real screenshots (scripts/db/screenshots/dice-numbering/), not
// just eyeballed in isolation.
const DECAL_SIZE: Record<DieKind, number> = {
  d4: 0.1,
  d6: 0.09,
  d8: 0.075,
  d10: 0.035,
  d12: 0.075,
  d20: 0.055,
};

const faceDecalTextureCache = new Map<string, CanvasTexture>();

// Same cached-canvas-texture technique as resultBadgeTexture below, but
// transparent-background (a decal sitting on the die's own color, not a
// floating badge with its own backdrop) and a bolder glyph, since this is
// the numeral itself, not a secondary readout. Two-character labels (d10's
// "10", a percentile pair's "90"/"00") get a smaller font so they still fit
// the same square canvas without shrinking the texture resolution itself —
// a canvas-rendered numeral stays exactly as crisp as its texture
// resolution regardless of glyph size (docs/design/dice-numbers-and-
// physics.md §4).
function faceDecalTexture(label: string): CanvasTexture {
  let texture = faceDecalTextureCache.get(label);
  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#fdf6e8";
      context.font = `bold ${label.length > 1 ? 56 : 78}px sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(label, canvas.width / 2, canvas.height / 2 + 4);
    }
    texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    faceDecalTextureCache.set(label, texture);
  }
  return texture;
}

// Aligns a decal quad's default +Z-facing plane with an outward face
// normal — the exact same Quaternion().setFromUnitVectors technique
// diceAnimator.ts already uses to compute its settle-target orientation
// (proven correct there by diceAnimator.test.ts's own settle-orientation
// assertion), applied here to a STATIC decal instead of an animated pose.
const DECAL_QUAD_NORMAL = new Vector3(0, 0, 1);

/**
 * One quad per face of `kind`, positioned/oriented directly off the
 * already-computed DIE_FACE_NORMALS — the spike's recommended per-face
 * canvas-texture-decal approach (docs/design/dice-numbers-and-physics.md
 * §4): reuses DIE_FACE_NORMALS completely unmodified, never touches
 * buildDieGeometry's own vertex/UV data, and needs no per-shape UV-atlas
 * authoring. `labelSet` overrides the standard 1..sides numbering
 * (DEFAULT_FACE_LABELS) — a percentile pair's own tens/ones faces are the
 * one real user of that today (§5).
 */
function buildFaceDecals(kind: DieKind, labelSet: readonly string[] | undefined) {
  const normals = DIE_FACE_NORMALS[kind];
  const labels = labelSet ?? DEFAULT_FACE_LABELS[kind];
  const distance = facePlaneDistanceFor(kind) + DECAL_EPSILON;
  const size = DECAL_SIZE[kind];
  return normals.map((normal, index) => {
    const quaternion = new Quaternion().setFromUnitVectors(DECAL_QUAD_NORMAL, new Vector3(...normal));
    const position: [number, number, number] = [normal[0] * distance, normal[1] * distance, normal[2] * distance];
    return (
      <mesh key={index} position={position} quaternion={quaternion}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial map={faceDecalTexture(labels[index] ?? "")} transparent depthWrite={false} />
      </mesh>
    );
  });
}

/** Renders the real modeled shape for one of the six standard dice (built
 * procedurally — see diceGeometry.ts), with a printed-number decal on every
 * face (buildFaceDecals above), or a plain placeholder icosahedron for
 * anything else. A free-form roll can produce an odd side count (d3, d2,
 * ...) with no matching shape, and rather than fail to render, it still
 * tumbles and still gets the billboarded result badge, just not a faithful
 * model or any face decals. (d100 is NOT such a case — tumble.ts's
 * buildDiceTumbleSpec resolves it into two ordinary d10s, sides === 10,
 * before this component ever sees it; see diceGeometry.ts's doc comments
 * and docs/design/dice-numbers-and-physics.md §5.) */
function DieMesh({ sides, labelSet }: { sides: number; labelSet?: readonly string[] }) {
  const kind = dieKindForSides(sides);
  // Hooks must run unconditionally regardless of `kind`, so the memos
  // themselves stay no-ops (null) rather than being skipped — the fallback
  // below branches on the VALUE, not on whether the hook ran.
  const geometry = useMemo(() => (kind ? geometryFor(kind) : null), [kind]);
  const decals = useMemo(() => (kind ? buildFaceDecals(kind, labelSet) : null), [kind, labelSet]);
  if (!kind || !geometry) return <FallbackDieMesh />;
  return (
    <>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial color={DIE_COLOR} roughness={0.45} />
      </mesh>
      {decals}
    </>
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
 * around the table regardless of the die's final orientation — legible
 * from any angle even now that the die's own face is ALSO printed (a face
 * decal only reads correctly from roughly "above", the same as a real
 * physical die). `label` is the exact printed value (Die's own
 * labelForResult call) — a percentile pair's own synthetic 1-10 `result`
 * would otherwise show the wrong text here (docs/design/dice-numbers-and-
 * physics.md §5): a face reading "40" needs a badge reading "40", not the
 * synthetic index "4" that drives its orientation. */
const ResultBadge = memo(function ResultBadge({ label }: { label: string }) {
  return (
    <Billboard position={[0, 0.22, 0]}>
      <mesh>
        <planeGeometry args={[0.22, 0.15]} />
        <meshBasicMaterial map={resultBadgeTexture(label)} transparent />
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

/** `kind`'s null (a free-form roll's non-standard side count, e.g. a lone
 * "d3") falls back to the raw numeric result, same text ResultBadge always
 * showed before this feature existed — there's no DEFAULT_FACE_LABELS entry
 * to look up for a shape that doesn't exist. Every standard kind (and every
 * percentile tens/ones d10, via spec.labelSet) routes through
 * diceGeometry.ts's labelForResult, the exact same face-index math
 * faceNormalForResult itself uses, so this label and the physically settled
 * face can never disagree. */
function labelFor(spec: DiceTumbleDieSpec): string {
  const kind = dieKindForSides(spec.sides);
  return kind ? labelForResult(kind, spec.result, spec.labelSet) : String(spec.result);
}

// SP8 — the minimum real time between two dice_impact sounds for ONE die.
// Chosen to exactly match generate-sound-effects.mjs's own real generated
// clip length for dice_impact (anoisesrc=d=0.12 / sine=f=180:d=0.12 — a
// genuine 0.12s file, confirmed via ffprobe at generation time): at this
// interval, a new impact sound can never start until the previous one has
// fully finished playing, so back-to-back impacts are always heard as
// distinct, non-overlapping thocks rather than a muddy layered pile-up —
// while still being short enough that a real chaotic bounce phase's own
// genuinely-distinct bounces (measured directly during this feature's own
// prototyping at roughly one every 150-400ms in the busiest opening moments
// of a real physics tumble, well above this floor) are never suppressed.
// This is a defensive backstop, not the primary anti-spam mechanism — a
// real Rapier collision-started event only fires once when a contact
// BEGINS, never again while that same contact persists (confirmed directly
// during this feature's own prototyping), so DicePose.impacted already
// rarely retriggers faster than this on its own; this interval exists for
// the genuine edge case of a die rapidly chattering against a corner/edge
// (many fast start/stop/start contact toggles in quick succession).
const MIN_DICE_IMPACT_INTERVAL_MS = 120;

// SP8 — a SECOND, PAGE-WIDE rate limit, independent of the per-die one
// above. Real measurement (scripts/perf/dice-physics-benchmark.mjs, the
// project's own established 10-tray x 8-die worst case — perf-budgets.json
// realtimeLoad.concurrentClients x diceAnimator.ts's own
// MAX_PHYSICS_DICE_PER_ROLL) found the per-die limit alone was NOT enough at
// that real concurrency. Isolating the cause (this feature's own design
// investigation): baseline (this feature entirely absent) measured ~30-33ms
// avg frame time across repeated runs; adding real collision detection alone
// (the EventQueue/drain machinery in diceAnimator.ts, the playSound() call
// temporarily disabled) measured ~31.6ms — confirming the PHYSICS-side cost
// is negligible, matching this feature's own earlier raw-Node prototyping.
// Re-enabling the actual per-impact playSound() call with ONLY the per-die
// 120ms cap in place pushed it to ~39ms, over perf-budgets.json's 33.3ms
// budget: with up to 80 simultaneous physics-tumbling dice across 10
// independent trays all genuinely bouncing at once, the per-die cap alone
// still allows a real aggregate burst of Web Audio graph construction +
// soundManager.ts's own debug-mirror notify/re-render (every playSound call)
// that the render loop can't absorb. This global floor caps the PAGE's
// total dice_impact rate regardless of how many trays/dice are
// simultaneously chaotic, while staying far above what any ORDINARY
// gameplay moment (one tray, or even a handful, rolling at once) could ever
// hit. Confirmed directly: repeated benchmark runs with this 40ms floor in
// place averaged ~30-33ms — statistically indistinguishable from the
// feature-absent baseline's own ~30-33ms run-to-run range on the same real
// (shared, noisy) hardware — without perceptibly thinning out a real
// single-tray tumble's own impact cadence (still far more permissive than
// the per-die 120ms cap for any one tray's own dice). NOTE: this sandbox's
// own background load visibly swings individual runs by several ms either
// way (confirmed by comparing repeated same-config runs) — the real,
// reproducible signal is "the physics/detection layer itself costs ~1-2ms;
// the audio side-effect needed this second, coarser page-wide throttle on
// top of the per-die one to stay inside budget at the project's own
// documented worst-case concurrency," not any single run's exact number.
const GLOBAL_MIN_DICE_IMPACT_INTERVAL_MS = 40;
let lastGlobalDiceImpactAt = -Infinity;

function Die({
  spec,
  animator,
  onSettled,
}: {
  spec: DiceTumbleDieSpec;
  animator: DiceAnimator;
  onSettled: (id: string, positionY: number) => void;
}) {
  // Per-die, per-mount rate-limit state — a fresh -Infinity every time this
  // component (re)mounts, matching every other piece of this die's own
  // animation state (useDiceTumble's own ref/elapsed-clock/phase), since a
  // fresh roll always remounts a brand-new Die via `key={die.id}` (below)
  // rather than reusing one across rolls.
  const lastImpactAtRef = useRef(-Infinity);
  const handleImpact = useCallback(() => {
    const now = performance.now();
    if (now - lastImpactAtRef.current < MIN_DICE_IMPACT_INTERVAL_MS) return;
    // The page-wide floor (GLOBAL_MIN_DICE_IMPACT_INTERVAL_MS above) — a
    // plain module-level variable (not React state/context), the same
    // "shared mutable state with no natural React tree to hang it off of"
    // shape soundManager.ts's own masterGain/loops already use, since this
    // needs to coordinate across every Die instance on the page, spanning
    // every connected member's own independent tray, not just siblings
    // under one ActiveTumble.
    if (now - lastGlobalDiceImpactAt < GLOBAL_MIN_DICE_IMPACT_INTERVAL_MS) return;
    lastImpactAtRef.current = now;
    lastGlobalDiceImpactAt = now;
    // No variantIndex — playSound's own default (soundManager.ts's
    // resolveSoundUrl) picks a real random variant from dice_impact's pool
    // every call, the same "genuinely vary across repeated triggers"
    // guarantee SP5's hit_normal pool established. This is a purely local,
    // client-side Web Audio call — never a network broadcast — so it can
    // only ever run on a client whose OWN DiceTumble instance actually
    // mounted this Die in the first place. That is exactly what keeps a
    // private roll's impact sounds off every other client with zero extra
    // gating needed here: GameRoom.tsx's handleRollLanded never even calls
    // play() on (and therefore never mounts ActiveTumble/Die for) any
    // client other than the roller's own for a private roll — see that
    // handler's own doc comment.
    void playSound(SOUND_KEYS.DICE_IMPACT);
  }, []);

  const { ref, rotationRef, phase } = useDiceTumble(spec, animator, handleImpact);
  const label = labelFor(spec);

  useEffect(() => {
    // ref.current.position is up to date the instant `phase` flips to
    // "settled": useDiceTumble's own useFrame callback writes the group's
    // position BEFORE checking pose.settled and flipping phase (see its own
    // doc comment), so this effect (which only runs after that state commit)
    // always reads the exact just-settled pose, never a stale one.
    if (phase === "settled") onSettled(spec.id, ref.current?.position.y ?? 0);
    // `ref` itself is the stable object useDiceTumble's own useRef returns
    // (never a new identity across renders), so including it here changes
    // nothing about when this effect actually re-runs — it just satisfies
    // exhaustive-deps for the `ref.current` read above.
  }, [phase, spec.id, onSettled, ref]);

  return (
    <group ref={ref}>
      {/* Rotation lives on this INNER group, wrapping only the die's own
          mesh — ResultBadge below is a SIBLING of this group, not a child
          of it, so it tracks the die's translation (the outer `ref` group
          above) without also inheriting its rotation. See rotationRef's
          own doc comment (useDiceTumble.ts) for the real bug this fixes: a
          badge nested inside the same rotating group used to visibly swing
          along with the settle-blend's own final corrective slerp. */}
      <group ref={rotationRef}>
        <DieMesh sides={spec.sides} labelSet={spec.labelSet} />
      </group>
      {phase === "settled" ? <ResultBadge label={label} /> : null}
    </group>
  );
}

/** Mounts one roll's dice, tracks when every one of them has individually
 * settled, and fires `onDone` after a short linger so the result stays
 * legible before the tray clears for the next queued roll. */
function ActiveTumble({
  spec,
  animator,
  usingPhysics,
  onDone,
  onDieSettled,
}: {
  spec: DiceTumbleSpec;
  animator: DiceAnimator;
  /** Whether `animator` is (a scaled wrapper around) physicsDiceAnimator for
   * this WHOLE roll — see DiceFaceSettledInfo.usedPhysics's own doc comment.
   * Passed down as a plain boolean rather than re-derived by reference-
   * checking `animator` here, since `animator` is usually scaledDiceAnimator's
   * own wrapper object, not physicsDiceAnimator itself. */
  usingPhysics: boolean;
  onDone: () => void;
  onDieSettled?: DiceTumbleProps["onDieSettled"];
}) {
  const dice = useMemo<DiceTumbleDieSpec[]>(
    () => spec.dice.map((die, index) => ({ ...die, id: `${spec.id}:${index}` })),
    [spec]
  );
  const settledIdsRef = useRef<Set<string>>(new Set());
  const [allSettled, setAllSettled] = useState(false);

  // A single stable callback (not one fresh inline arrow function created
  // per die, per render) — the registerDiceTumbleRef precedent in
  // GameRoom.tsx flags exactly this shape's own past failure mode: a fresh
  // callback identity on every render feeds Die's onSettled effect
  // dependency array, retriggering the effect (and this component's own
  // parent re-render, via onDieSettled bubbling up to GameRoom's own
  // debug-mirror state) every single render, an infinite loop. Looking
  // `dieIndex`/the die's own {sides, result, labelSet} up from `dice`
  // (stable for this ActiveTumble instance's whole lifetime — a fresh
  // roll always remounts via `key={spec.id}` in DiceTumble below, never
  // swaps `spec` under an already-mounted instance) keeps this callback's
  // own identity stable across re-renders too, same as `dice.length` alone
  // already did for the settled-count tracking below.
  const handleSettled = useCallback(
    (id: string, positionY: number) => {
      settledIdsRef.current.add(id);
      if (settledIdsRef.current.size >= dice.length) setAllSettled(true);
      if (onDieSettled) {
        const dieIndex = dice.findIndex((die) => die.id === id);
        const die = dice[dieIndex];
        if (die) {
          onDieSettled({
            rollId: spec.id,
            dieIndex,
            sides: die.sides,
            result: die.result,
            label: labelFor(die),
            usedPhysics: usingPhysics,
            positionY,
          });
        }
      }
    },
    [dice, spec.id, onDieSettled, usingPhysics]
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

// The raised rim's own fixed absolute dimensions (world units, NOT scaled by
// a personal tray's `scale`/`radius`) — the same reasoning DIE_SIZE itself
// is a flat, unscaled constant: a real die stays the same physical size
// regardless of which tray it lands in, so the rim built to visually contain
// one should size itself off THAT (roughly DIE_SIZE-scale), not off however
// large or small this particular tray's own landing footprint happens to be.
// Tuned by eye against real screenshots (scripts/db/verify-dice-tray-design.mjs's
// own before/after captures) to read as a real contained lip at both the
// personal-tray scale GameRoom.tsx actually renders (PERSONAL_TRAY_SCALE) and
// the full scale=1 size the /dev/dice-showcase page uses.
const TRAY_RIM_HEIGHT = 0.075;
// How far the rim's own TOP edge flares outward beyond the floor's own
// radius — see DiceTray's own doc comment for why this can never intrude
// on the floor's footprint (and can therefore never clip a tumbling die)
// regardless of its value: the rim is a frustum whose BASE sits exactly at
// `radius` (tangent to the floor's own edge), flaring outward only as it
// rises, so its inner wall at any height is always >= `radius`.
const TRAY_RIM_FLARE = 0.02;
const TRAY_RIM_CAP_WIDTH = 0.015;
const TRAY_ACCENT_BEAD_RADIUS = 0.006;

const feltFloorTextureCache = new Map<string, CanvasTexture>();

/**
 * A procedurally-drawn "casting circle" motif for the tray's own felt
 * floor — concentric rings, eight compass-style radiating ticks, and a
 * small faceted center emblem, all in the app's own purple/teal accent
 * colors (tokens.css's --purple/--teal) laid over the pre-existing felt
 * tone. Uses the exact same cached-canvas-texture technique this file's own
 * faceDecalTexture/resultBadgeTexture already establish (docs/design/
 * dice-numbers-and-physics.md §4) — one canvas drawn once (not per
 * instance, not per frame) and cached, so this "genuine decorative detail"
 * the project owner asked for costs nothing ongoing and needs no new
 * external asset or dependency. Deliberately restrained (thin, low-opacity
 * strokes on the existing dark felt) so it reads as tasteful tabletop-prop
 * detailing up close (the /dev/dice-showcase page's own tight camera) without
 * ever competing with a settled die's own brighter, warmer color for
 * attention — the same "never fight the game-state readout for legibility"
 * principle this file's own ResultBadge/faceDecalTexture already follow.
 */
function feltFloorTexture(): CanvasTexture {
  const cacheKey = "default";
  const cached = feltFloorTextureCache.get(cacheKey);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (context) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    context.fillStyle = TRAY_FELT;
    context.fillRect(0, 0, canvas.width, canvas.height);

    // Three concentric rings, alternating the two accent hues.
    const ringRadii = [0.92, 0.78, 0.64].map((fraction) => fraction * cx);
    ringRadii.forEach((ringRadius, index) => {
      context.beginPath();
      context.arc(cx, cy, ringRadius, 0, Math.PI * 2);
      context.strokeStyle = index % 2 === 0 ? TRAY_ACCENT_TEAL : TRAY_ACCENT_PURPLE;
      context.globalAlpha = 0.32;
      context.lineWidth = 3;
      context.stroke();
    });

    // Eight compass-style ticks between the outer two rings.
    context.globalAlpha = 0.4;
    context.strokeStyle = TRAY_ACCENT_PURPLE;
    context.lineWidth = 3;
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const inner = ringRadii[1];
      const outer = ringRadii[0];
      context.beginPath();
      context.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      context.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      context.stroke();
    }

    // A small faceted center emblem — a hexagonal outline evoking a die's
    // own polyhedral silhouette in general, rather than one specific shape
    // (any roll could land any of the six standard kinds here).
    context.globalAlpha = 0.55;
    context.strokeStyle = TRAY_ACCENT_TEAL;
    context.lineWidth = 3;
    context.beginPath();
    const emblemPoints = 6;
    const emblemRadius = 0.14 * cx;
    for (let i = 0; i <= emblemPoints; i++) {
      const angle = (i / emblemPoints) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * emblemRadius;
      const y = cy + Math.sin(angle) * emblemRadius;
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
    context.globalAlpha = 1;
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  feltFloorTextureCache.set(cacheKey, texture);
  return texture;
}

/**
 * The default procedural dice tray — DiceTumble's own built-in look for a
 * member who hasn't picked a custom uploaded model (diceTrayPreference.ts's
 * "default" source). Previously a single flat, unmarked disc; this pass adds
 * a real raised wooden rim (so it reads as a container dice can't roll out
 * of, not a marked patch of table) plus genuine decorative detail — the
 * procedurally-drawn felt motif above, a teal accent bead, and alternating
 * purple/teal cardinal studs — all pulled from this app's own established
 * wood-tone / purple-teal palette (GameTableScene's WOOD_TOP/PURPLE/TEAL,
 * Chair.tsx's identical trim treatment on its own backrests) rather than an
 * unstyled generic box.
 *
 * `radius` is `trayRadiusForScale(scale)` — the exact same value every
 * NON-visual consumer relies on (GameRoom.tsx's chair-drag obstacle radius,
 * seating.ts's tray-tray non-overlap math, both via the exported
 * PERSONAL_TRAY_RADIUS) — and the felt FLOOR below keeps that footprint
 * completely unchanged from before this pass: same circleGeometry radius,
 * same position, same role as the one surface every die's landing math
 * (diceAnimator.ts) already assumes it can reach out to. Only the texture
 * mapped onto it is new.
 *
 * The raised rim is a FRUSTUM (CylinderGeometry with radiusTop > radiusBottom,
 * openEnded) whose BASE radius is exactly `radius` — tangent to the floor's
 * own edge at y=0 — flaring outward only as it rises to `radius +
 * TRAY_RIM_FLARE` at its own top. That shape's inner wall at any height h is
 * `radius + (h / TRAY_RIM_HEIGHT) * TRAY_RIM_FLARE`, algebraically always ≥
 * `radius`, so it can never intrude into the floor's own footprint at ANY
 * height — meaning a die tumbling anywhere within `radius` (the one
 * guarantee trayRadiusForScale's own formula already makes, matching
 * diceAnimator.ts's real worst-case travel distance) can never clip through
 * this rim, no matter how high a bounce goes. Only the decorative cap/bead
 * right at the rim's own TOP outer edge extends a small, fixed distance
 * (TRAY_RIM_FLARE + TRAY_RIM_CAP_WIDTH) beyond `radius` — well above
 * table-surface height, where no neighboring object in this scene (another
 * member's own personal tray, a seated chair) actually occupies space — so
 * that purely decorative overhang is deliberately NOT fed back into
 * trayRadiusForScale/PERSONAL_TRAY_RADIUS the way the floor's own radius is;
 * doing so would ripple into every seating.ts non-overlap guarantee for a
 * few millimeters of glow-bead that nothing at table height ever actually
 * touches.
 */
function DiceTray({ radius }: { radius: number }) {
  const topRadius = radius + TRAY_RIM_FLARE;
  const capOuterRadius = topRadius + TRAY_RIM_CAP_WIDTH;
  const texture = useMemo(() => feltFloorTexture(), []);
  return (
    <group>
      {/* Felt playing surface — same footprint/position this tray has always
          used; every die's own landing math is entirely independent of this
          mesh, so nothing about where a die actually settles changes here. */}
      <mesh position={[0, -0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[radius, 48]} />
        <meshStandardMaterial map={texture} roughness={0.85} />
      </mesh>

      {/* Raised wooden rim — a hollow frustum, base tangent to the floor's
          own edge, flaring outward as it rises (see this component's own
          doc comment for why that shape can never clip a tumbling die). */}
      <mesh position={[0, TRAY_RIM_HEIGHT / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[topRadius, radius, TRAY_RIM_HEIGHT, 40, 1, true]} />
        <meshStandardMaterial color={TRAY_WOOD} roughness={0.7} side={DoubleSide} />
      </mesh>

      {/* The rim's own flat top cap — a real, visible lip looking down onto
          it from above, not just a paper-thin shell edge. */}
      <mesh position={[0, TRAY_RIM_HEIGHT, 0]} rotation={[-Math.PI / 2, 0, 0]} castShadow receiveShadow>
        <ringGeometry args={[topRadius - 0.006, capOuterRadius, 40]} />
        <meshStandardMaterial color={TRAY_WOOD} roughness={0.6} side={DoubleSide} />
      </mesh>

      {/* A thin teal accent bead along the cap's own outer edge — the same
          "glowing trim" treatment Chair.tsx's own backrest edge already
          uses (teal for player chairs there); this tray isn't role-specific,
          so it takes the teal accent by default. */}
      <mesh position={[0, TRAY_RIM_HEIGHT, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[capOuterRadius, TRAY_ACCENT_BEAD_RADIUS, 8, 40]} />
        <meshStandardMaterial color={TRAY_ACCENT_TEAL} emissive={TRAY_ACCENT_TEAL} emissiveIntensity={1.4} />
      </mesh>

      {/* Four small cardinal accent studs on the cap, alternating the app's
          two accent hues — the "corner detailing" a round tray's own
          compass points stand in for. */}
      {[0, 1, 2, 3].map((index) => {
        const angle = (index / 4) * Math.PI * 2;
        const studRadius = (topRadius + capOuterRadius) / 2;
        const color = index % 2 === 0 ? TRAY_ACCENT_PURPLE : TRAY_ACCENT_TEAL;
        return (
          <mesh
            key={index}
            position={[Math.cos(angle) * studRadius, TRAY_RIM_HEIGHT + 0.004, Math.sin(angle) * studRadius]}
          >
            <sphereGeometry args={[0.008, 10, 10]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.6} />
          </mesh>
        );
      })}
    </group>
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
  {
    onQueueChange,
    trayPosition,
    scale = PERSONAL_TRAY_SCALE,
    modelUrl = null,
    modelForwardOffsetDeg = 0,
    onDieSettled,
  },
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

  // Kicks off loading the WASM physics engine as soon as a tray mounts
  // (every connected member's own tray does this, harmlessly redundantly —
  // preloadDicePhysics is idempotent) rather than waiting for this member's
  // first actual roll, so real physics is already ready well before anyone
  // clicks a roll button in ordinary play. See diceAnimator.ts's own doc
  // comment on why a roll that starts before this resolves simply falls back
  // to scriptedDiceAnimator for that one roll instead of blocking.
  useEffect(() => {
    preloadDicePhysics();
  }, []);

  const active = queue[0] ?? null;
  const handleDone = useCallback(() => {
    // Safe to call unconditionally even for a roll that never used physics
    // (disposeDicePhysicsRoll is a no-op for a roll id with no physics world)
    // — see diceAnimator.ts's own doc comment on why explicit disposal here,
    // via ActiveTumble's existing onDone hook, is the one place a finished
    // roll's Rapier World gets freed.
    if (active) disposeDicePhysicsRoll(active.id);
    setQueue((current) => current.slice(1));
  }, [active]);

  // Chosen PER ROLL (not once for the whole tray) — docs/design/dice-numbers-
  // and-physics.md §9's own per-roll all-or-nothing fallback: a roll whose
  // die count exceeds MAX_PHYSICS_DICE_PER_ROLL (or that starts before the
  // physics engine has finished loading) uses scriptedDiceAnimator for its
  // ENTIRE tumble, never a partial mix. Physics always simulates at the
  // shared full-size tray's own physical scale — scaledDiceAnimator (below)
  // is what shrinks a smaller personal tray's dice-motion footprint
  // afterward, exactly the same "wrap the output, don't touch the step math"
  // seam it already used for the scripted animator, so this needs no
  // physics-specific scaling logic of its own.
  const rawAnimator = useMemo(() => pickDiceAnimator(active?.dice.length ?? 0), [active]);
  const usingPhysics = rawAnimator === physicsDiceAnimator;
  const animator = useMemo(() => scaledDiceAnimator(rawAnimator, scale), [rawAnimator, scale]);
  const radius = useMemo(() => trayRadiusForScale(scale), [scale]);

  return (
    <group position={trayPosition as [number, number, number]}>
      {modelUrl ? (
        <CustomTrayModel url={modelUrl} forwardOffsetDeg={modelForwardOffsetDeg} radius={radius} />
      ) : (
        <DiceTray radius={radius} />
      )}
      {active ? (
        <ActiveTumble
          key={active.id}
          spec={active}
          animator={animator}
          usingPhysics={usingPhysics}
          onDone={handleDone}
          onDieSettled={onDieSettled}
        />
      ) : null}
    </group>
  );
});
