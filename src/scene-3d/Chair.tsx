"use client";

import { Component, Suspense, useMemo, type ReactNode } from "react";
import { Clone, useGLTF } from "@react-three/drei";
import { Box3, Vector3 } from "three";
import type { Object3D } from "three";

// Palette mirrored from the app's design tokens (src/ui-components/tokens.css)
// and GameTableScene's own wood/cushion tones — scene-3d can't import CSS
// custom properties, and Chair renders standalone from GameTableScene's own
// module scope, so the constants are re-mirrored here rather than exported
// across files (the same hex-mirroring reasoning MapSurface.tsx already
// uses for PURPLE/TEAL).
const PURPLE = "#9b00ff"; // --purple
const TEAL = "#1ec8c8"; // --teal

// Matches GameTableScene's WOOD_TOP — the player chair's frame is the same
// naturalistic tabletop wood, not a new tone.
const PLAYER_WOOD = "#5a4028";
// A richer, darker walnut than the player frame — the "richer/darker wood
// tone" the throne needs to read apart from a plain chair at a glance, even
// before the purple trim or size difference registers.
const DM_WOOD = "#33210f";
// Matches GameTableScene's CUSHION — same dark cushion tone the old
// dais disc used, now on the chair's seat pad instead.
const CUSHION = "#2a2140";

const PLAYER_CHAIR_URL = "/table/player-chair.glb";
const DM_CHAIR_URL = "/table/dm-chair.glb";

// Which way each source file's own seat/front actually faces, empirically
// checked (not assumed) by temporarily rendering each raw glTF standalone
// with an AxesHelper fixed to its own local origin plus a Box3Helper, from
// four axis-aligned cameras (+Z/-Z/+X/-X) framing the whole model — the
// same throwaway-probe approach this file's other measurement comments
// document. For BOTH files, the +Z-facing elevation showed the seat cushion
// and armrests face-on (the open, sit-in-me side) and the -Z-facing
// elevation showed the plain, closed exterior of the backrest — i.e. both
// models were authored treating local +Z as their own "forward," not -Z.
// seating.ts's rotationY assumes an occupant's local -Z is forward (its own
// doc comment; SeatAvatar's avatars already honor that and aren't reported
// backwards), so each model needs a baked-in 180° yaw here to align its own
// +Z-front with the shared -Z-forward convention. The two files were
// authored independently (see this file's header note) and were checked
// independently for exactly that reason — they happening to agree on +Z is
// a coincidence the probe confirmed, not an assumption that let one stand
// in for the other.
const PLAYER_CHAIR_FORWARD_CORRECTION = Math.PI;
const DM_CHAIR_FORWARD_CORRECTION = Math.PI;

// Target total heights (floor to the tallest point) for the loaded glTF
// chairs, following SeatAvatar's scale-to-known-height pattern.
//
// The previous pass here (git history) re-derived both numbers from first
// principles — real-dining-chair anchors, AVATAR_HEIGHT comparisons, Box3
// sanity-checks against the raw glTFs — and concluded PLAYER_CHAIR_HEIGHT
// (1.0) was already correct while DM_CHAIR_HEIGHT needed raising to 2.0.
// That reasoning wasn't wrong about what was rendering; the project owner
// then looked at real screenshots of the live app with both fixes in place
// and judged BOTH chairs still far too small, and gave explicit multipliers
// to apply on top of those already-fixed numbers rather than asking for
// another from-scratch derivation: player chairs 2.5x their current size,
// the DM throne 1.75x its current size. Applied here exactly as given —
// including the fact that it deliberately shrinks the throne-to-player size
// RATIO from 2.0x down to 1.4x (3.5/2.5), noticeably less dramatic than
// before. That's not a side effect to correct for; the owner was looking at
// the real rendered result with both numbers already in front of them and
// asked for this specific pair anyway.
const PLAYER_CHAIR_HEIGHT = 2.5;
const DM_CHAIR_HEIGHT = 3.5;

// Each loaded chair's seat-pad top height above the floor, in scene units —
// RE-measured directly off each glTF's real geometry at the NEW target
// heights above, not linearly projected from the old numbers on faith: the
// same throwaway probe script this file has used for every previous height
// change (ChairModel's exact scale/offset math replayed standalone, then
// real vertex data read back out) was re-run against both live models at
// PLAYER_CHAIR_HEIGHT=2.5/DM_CHAIR_HEIGHT=3.5.
//
// DM throne: the same isolable "Cube_low" seat-cushion sub-mesh identified
// before (13 total nodes, this one a squarish slab on the pedestal column)
// now spans real vertex world Y 1.017-1.328 (was 0.581-0.759 at the old
// 2.0 — re-measured precisely by per-vertex extraction, not the coarser
// Box3Helper-screenshot read the very first pass used, which is why these
// don't match that pass's rounder-looking 0.61-0.797). Its own dense
// top-surface vertex cluster (the actual sit-on face, distinct from the
// slab's thinner underside cluster near the bottom of that range) tops out
// at 1.328, used below rounded to 1.33.
//
// Player chair: still a single fused mesh with no isolable seat sub-mesh,
// so every vertex's world Y was re-binned into a histogram exactly as
// before. The same wide, near-full-footprint band — ~97% of the chair's
// own width, ~88% of its depth, the same footprint-span signature as the
// old measurement, confirming this is the same seat plank and not some
// other part of the model — now lands at world Y ≈ 1.292-1.298, used below
// rounded to 1.30.
//
// Both new numbers land almost exactly on a straight-line scaling of the
// old ones (0.76 -> 1.33 is *1.75, DM_CHAIR_HEIGHT's own 2.0->3.5 ratio;
// 0.52 -> 1.30 is *2.5, PLAYER_CHAIR_HEIGHT's own 1.0->2.5 ratio). That
// makes sense in hindsight — ChairModel's scale is a fixed raw model size
// divided into a target height, so scale is itself exactly proportional to
// the target height, and every offset built from that scale (the floor-pin
// and the rotated-recenter) is proportional to it too, making the whole
// transform linear in target height for a fixed raw glTF — but it's a
// conclusion this fresh probe CONFIRMED for both real models, not a
// shortcut that assumed it and skipped re-measuring: a non-uniform export
// (pre-baked scale/rotation sitting on some mesh node, or a bounding box
// whose min/max don't move together under the model's own transforms)
// could have broken that linearity, and re-running the probe against the
// live geometry was the only way to know it didn't.
export const SEAT_TOP_Y: Record<"dm" | "player", number> = {
  dm: 1.33,
  player: 1.3,
};

// The procedural fallback chairs (below) must put their OWN seat pad at
// this same per-role height — GameTableScene positions the avatar using
// SEAT_TOP_Y regardless of whether the real model or this fallback ends up
// rendering, so the fallback's geometry has to agree with it too, or a
// load failure would reintroduce the floating/sinking bug on the safety net
// itself. Cushion half-thickness is subtracted back out because SEAT_Y below
// is the cushion mesh's own (center) position, not its top surface.
//
// Both fallbacks' own hand-tuned literals (ProceduralPlayerChair's and
// ProceduralDmChair's, below) were originally tuned to look right at each
// chair's ORIGINAL target height, not whatever *_CHAIR_HEIGHT is now: 1.0
// for the player chair (its height had never moved before the owner's
// 2.5x call above), 1.5 for the DM throne (the old procedural-only
// throne's own tuning basis, predating the real dm-chair.glb model — see
// git history). *_PROCEDURAL_SCALE is exactly that original-tuning-basis
// ratio: multiplying every one of a fallback's own dimensions by it keeps
// the whole shape proportionate to whatever the real model's current
// target height is, rather than just growing/shrinking its legs (via
// *_SEAT_Y, which is already the correct absolute height on its own) while
// leaving its cushion/backrest/armrests at their old, now-mismatched
// absolute size. DM_PROCEDURAL_SCALE already existed from the earlier
// throne-only-scale fix and needed no changes beyond DM_CHAIR_HEIGHT's new
// value flowing through it automatically; PLAYER_PROCEDURAL_SCALE is new
// here, following the exact same pattern, since the player chair's height
// had never changed before now.
const PLAYER_PROCEDURAL_SCALE = PLAYER_CHAIR_HEIGHT / 1.0;
const DM_PROCEDURAL_SCALE = DM_CHAIR_HEIGHT / 1.5;
const PLAYER_CUSHION_THICKNESS = 0.06 * PLAYER_PROCEDURAL_SCALE;
const DM_CUSHION_THICKNESS = 0.07 * DM_PROCEDURAL_SCALE;
const PLAYER_SEAT_Y = SEAT_TOP_Y.player - PLAYER_CUSHION_THICKNESS / 2;
const DM_SEAT_Y = SEAT_TOP_Y.dm - DM_CUSHION_THICKNESS / 2;

/** Four thin cylindrical legs from the floor up to the underside of the
 * seat pad, at the seat pad's corners inset slightly so they read as legs
 * rather than poking past the pad's edge. `radius` defaults to the
 * original, un-scaled base proportions; both ProceduralPlayerChair and
 * ProceduralDmChair now pass their own *_PROCEDURAL_SCALE-d pair instead
 * (the player's scaled 1:1 with its own shape, the DM's additionally
 * thickened relative to its footprint so its legs read as sturdy enough
 * for a much wider seat instead of comparatively spindly) so their legs
 * grow and shrink along with the rest of their own shape rather than
 * staying fixed while everything around them rescales. */
function ChairLegs({
  halfFootprint,
  wood,
  seatY,
  radius = [0.03, 0.035],
}: {
  halfFootprint: number;
  wood: string;
  seatY: number;
  radius?: [number, number];
}) {
  const inset = halfFootprint - 0.06;
  const legHeight = seatY - 0.03;
  const corners: readonly [number, number][] = [
    [inset, inset],
    [-inset, inset],
    [inset, -inset],
    [-inset, -inset],
  ];
  return (
    <>
      {corners.map(([x, z]) => (
        <mesh key={`${x},${z}`} position={[x, legHeight / 2, z]} castShadow>
          <cylinderGeometry args={[radius[0], radius[1], legHeight, 8]} />
          <meshStandardMaterial color={wood} roughness={0.8} />
        </mesh>
      ))}
    </>
  );
}

// A modest seat pad, backrest, and four legs — a plain chair, sized and
// toned to read as ordinary furniture next to the DM's throne. Kept around
// as the load-failure/loading-state fallback for the real player-chair.glb
// model (see Chair below). Every offset here is `PLAYER_SEAT_Y + (own
// hand-tuned delta * PLAYER_PROCEDURAL_SCALE)` — the seat anchor itself is
// never scaled (it's already the correct absolute height from
// SEAT_TOP_Y), only each part's own size/position *relative to that
// anchor* grows or shrinks with PLAYER_PROCEDURAL_SCALE, so the whole shape
// stays proportionate to whatever PLAYER_CHAIR_HEIGHT currently is instead
// of drifting out of proportion with the seat pad (the same pattern
// ProceduralDmChair below established for the throne).
function ProceduralPlayerChair() {
  return (
    <group>
      <ChairLegs
        halfFootprint={0.25 * PLAYER_PROCEDURAL_SCALE}
        wood={PLAYER_WOOD}
        seatY={PLAYER_SEAT_Y}
        radius={[0.03 * PLAYER_PROCEDURAL_SCALE, 0.035 * PLAYER_PROCEDURAL_SCALE]}
      />
      <mesh position={[0, PLAYER_SEAT_Y, 0]} castShadow receiveShadow>
        <boxGeometry
          args={[0.5 * PLAYER_PROCEDURAL_SCALE, PLAYER_CUSHION_THICKNESS, 0.5 * PLAYER_PROCEDURAL_SCALE]}
        />
        <meshStandardMaterial color={CUSHION} roughness={0.7} />
      </mesh>
      {/* Back edge is +Z — local -Z is the seat's facing direction (toward
          the table center), so the backrest sits behind the sitter. */}
      <mesh
        position={[0, PLAYER_SEAT_Y + 0.305 * PLAYER_PROCEDURAL_SCALE, 0.22 * PLAYER_PROCEDURAL_SCALE]}
        castShadow
      >
        <boxGeometry
          args={[0.5 * PLAYER_PROCEDURAL_SCALE, 0.55 * PLAYER_PROCEDURAL_SCALE, 0.06 * PLAYER_PROCEDURAL_SCALE]}
        />
        <meshStandardMaterial color={PLAYER_WOOD} roughness={0.75} />
      </mesh>
      {/* Glowing trim along the backrest's top edge — the old floor ring's
          accent glow, relocated onto the chair itself. */}
      <mesh position={[0, PLAYER_SEAT_Y + 0.57 * PLAYER_PROCEDURAL_SCALE, 0.22 * PLAYER_PROCEDURAL_SCALE]}>
        <boxGeometry
          args={[0.46 * PLAYER_PROCEDURAL_SCALE, 0.03 * PLAYER_PROCEDURAL_SCALE, 0.03 * PLAYER_PROCEDURAL_SCALE]}
        />
        <meshStandardMaterial color={TEAL} emissive={TEAL} emissiveIntensity={1.7} />
      </mesh>
    </group>
  );
}

// A visibly bigger, taller "throne": wider seat and armrests, a much taller
// backrest topped with a purple-emissive finial, darker wood, purple trim
// along the backrest's edges instead of teal. Kept around as the
// load-failure/loading-state fallback for the real dm-chair.glb model (see
// Chair below). Every offset here is `DM_SEAT_Y + (own hand-tuned delta *
// DM_PROCEDURAL_SCALE)` — the seat anchor itself is never scaled (it's
// already the correct absolute height from SEAT_TOP_Y), only each part's
// own size/position *relative to that anchor* grows or shrinks with
// DM_PROCEDURAL_SCALE, so the whole shape stays proportionate to whatever
// DM_CHAIR_HEIGHT currently is instead of drifting out of proportion with
// the seat pad.
function ProceduralDmChair() {
  const half = 0.31 * DM_PROCEDURAL_SCALE; // 0.62 footprint / 2, scaled
  return (
    <group>
      <ChairLegs
        halfFootprint={half}
        wood={DM_WOOD}
        seatY={DM_SEAT_Y}
        radius={[0.03 * DM_PROCEDURAL_SCALE, 0.035 * DM_PROCEDURAL_SCALE]}
      />
      <mesh position={[0, DM_SEAT_Y, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.62 * DM_PROCEDURAL_SCALE, DM_CUSHION_THICKNESS, 0.62 * DM_PROCEDURAL_SCALE]} />
        <meshStandardMaterial color={CUSHION} roughness={0.65} />
      </mesh>

      {/* Armrests flank the seat, resting just above the pad. */}
      <mesh position={[half + 0.03 * DM_PROCEDURAL_SCALE, DM_SEAT_Y + 0.09 * DM_PROCEDURAL_SCALE, 0]} castShadow>
        <boxGeometry args={[0.06 * DM_PROCEDURAL_SCALE, 0.18 * DM_PROCEDURAL_SCALE, 0.5 * DM_PROCEDURAL_SCALE]} />
        <meshStandardMaterial color={DM_WOOD} roughness={0.75} />
      </mesh>
      <mesh position={[-(half + 0.03 * DM_PROCEDURAL_SCALE), DM_SEAT_Y + 0.09 * DM_PROCEDURAL_SCALE, 0]} castShadow>
        <boxGeometry args={[0.06 * DM_PROCEDURAL_SCALE, 0.18 * DM_PROCEDURAL_SCALE, 0.5 * DM_PROCEDURAL_SCALE]} />
        <meshStandardMaterial color={DM_WOOD} roughness={0.75} />
      </mesh>

      {/* Tall backrest — reaches ~1.4x the player chair's own total height
          at this file's original tuning basis, the throne's main size
          signal; DM_PROCEDURAL_SCALE keeps that same relative reach at
          whatever DM_CHAIR_HEIGHT is now. */}
      <mesh position={[0, DM_SEAT_Y + 0.455 * DM_PROCEDURAL_SCALE, 0.34 * DM_PROCEDURAL_SCALE]} castShadow>
        <boxGeometry args={[0.62 * DM_PROCEDURAL_SCALE, 1.05 * DM_PROCEDURAL_SCALE, 0.08 * DM_PROCEDURAL_SCALE]} />
        <meshStandardMaterial color={DM_WOOD} roughness={0.7} />
      </mesh>

      {/* Purple trim along the backrest's vertical edges and top. */}
      <mesh position={[0.28 * DM_PROCEDURAL_SCALE, DM_SEAT_Y + 0.48 * DM_PROCEDURAL_SCALE, 0.34 * DM_PROCEDURAL_SCALE]}>
        <boxGeometry args={[0.03 * DM_PROCEDURAL_SCALE, 1.0 * DM_PROCEDURAL_SCALE, 0.03 * DM_PROCEDURAL_SCALE]} />
        <meshStandardMaterial color={PURPLE} emissive={PURPLE} emissiveIntensity={1.7} />
      </mesh>
      <mesh
        position={[-0.28 * DM_PROCEDURAL_SCALE, DM_SEAT_Y + 0.48 * DM_PROCEDURAL_SCALE, 0.34 * DM_PROCEDURAL_SCALE]}
      >
        <boxGeometry args={[0.03 * DM_PROCEDURAL_SCALE, 1.0 * DM_PROCEDURAL_SCALE, 0.03 * DM_PROCEDURAL_SCALE]} />
        <meshStandardMaterial color={PURPLE} emissive={PURPLE} emissiveIntensity={1.7} />
      </mesh>
      <mesh position={[0, DM_SEAT_Y + 0.98 * DM_PROCEDURAL_SCALE, 0.34 * DM_PROCEDURAL_SCALE]}>
        <boxGeometry args={[0.58 * DM_PROCEDURAL_SCALE, 0.03 * DM_PROCEDURAL_SCALE, 0.03 * DM_PROCEDURAL_SCALE]} />
        <meshStandardMaterial color={PURPLE} emissive={PURPLE} emissiveIntensity={1.7} />
      </mesh>

      {/* Finial ornament at the top of the backrest. */}
      <mesh position={[0, DM_SEAT_Y + 1.04 * DM_PROCEDURAL_SCALE, 0.34 * DM_PROCEDURAL_SCALE]} castShadow>
        <coneGeometry args={[0.06 * DM_PROCEDURAL_SCALE, 0.16 * DM_PROCEDURAL_SCALE, 12]} />
        <meshStandardMaterial color={PURPLE} emissive={PURPLE} emissiveIntensity={1.9} />
      </mesh>
    </group>
  );
}

/**
 * Loads and normalizes an arbitrary chair glTF — same scale-to-known-height
 * plus recenter-to-origin math as SeatAvatar's AvatarModel: real bounding
 * box via Box3, uniform scale to `targetHeight`, recentered on x/z with the
 * model's lowest point pinned to the local origin's y=0 regardless of where
 * the export placed its own origin, PLUS a baked-in yaw (`forwardCorrection`
 * — one of the two *_FORWARD_CORRECTION constants above) that spins the
 * model to face the shared -Z-forward convention before TableSeat's own
 * per-seat rotation is applied on top.
 *
 * The recenter offset is computed from the ROTATED center, not the raw one
 * — three.js composes an Object3D's transform as
 * `position + rotation·(scale·localPoint)`, i.e. the fixed `position` is
 * added in world space *after* `rotation`, so centering with the raw
 * (pre-rotation) center would spin the model in place around its own
 * off-center origin and then shift the now-off-center result sideways by a
 * stale offset. Rotating the scaled center first and centering on THAT
 * keeps the model's own vertical axis — wherever it ends up pointing after
 * the yaw — passing through local (0, *, 0), exactly like the unrotated
 * SeatAvatar/table case. Y is untouched by this: a yaw around Y can't
 * change any point's Y coordinate, so the floor-pinning term (`-box.min.y
 * * scale`) is exactly the same with or without `forwardCorrection`, and so
 * is every SEAT_TOP_Y measurement below (all taken after this offset).
 * Clone (not the cached scene directly) since every seat mounts its own
 * instance and useGLTF caches per URL.
 */
function ChairModel({
  url,
  targetHeight,
  forwardCorrection,
}: {
  url: string;
  targetHeight: number;
  forwardCorrection: number;
}) {
  const { scene } = useGLTF(url);
  const { scale, offset } = useMemo(() => {
    const box = new Box3().setFromObject(scene as Object3D);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const scale = size.y > 1e-3 ? targetHeight / size.y : 1;
    const rotatedCenterXZ = new Vector3(center.x * scale, 0, center.z * scale).applyAxisAngle(
      new Vector3(0, 1, 0),
      forwardCorrection
    );
    const offset: [number, number, number] = [-rotatedCenterXZ.x, -box.min.y * scale, -rotatedCenterXZ.z];
    return { scale, offset };
  }, [scene, targetHeight, forwardCorrection]);

  return (
    <Clone
      object={scene}
      scale={scale}
      position={offset}
      rotation={[0, forwardCorrection, 0]}
      castShadow
      receiveShadow
    />
  );
}

interface ChairErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

/** Falls back to the procedural chair on a load/parse failure — an
 * occupied (or empty) seat should never end up rendering nothing just
 * because a model 404s or fails to parse. Chair URLs are fixed built-in
 * assets rather than per-member data, so unlike SeatAvatar's boundary this
 * one never needs to reset on a prop change. */
class ChairErrorBoundary extends Component<ChairErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Per-seat chair furniture — replaces the old cushion-disc + glowing-ring
 * "dais" (see GameTableScene's `TableSeat`) with an actual modeled chair.
 * Loads the real dm-chair.glb/player-chair.glb models (SeatAvatar's
 * load/scale/recenter/Clone pattern), Suspense- and error-boundary-wrapped
 * so a slow or failed load falls back to the original fully-procedural
 * chair (`ProceduralDmChair`/`ProceduralPlayerChair`, both re-anchored to
 * the same measured seat heights and uniformly rescaled — by
 * DM_PROCEDURAL_SCALE and PLAYER_PROCEDURAL_SCALE respectively — so each
 * stays proportionate to its own *_CHAIR_HEIGHT) rather than an empty or
 * broken seat.
 * `SeatAvatar` renders on top of this unchanged — this component owns only
 * the furniture beneath the avatar.
 */
export function Chair({ role }: { role: "dm" | "player" }) {
  if (role === "dm") {
    return (
      <ChairErrorBoundary fallback={<ProceduralDmChair />}>
        <Suspense fallback={<ProceduralDmChair />}>
          <ChairModel
            url={DM_CHAIR_URL}
            targetHeight={DM_CHAIR_HEIGHT}
            forwardCorrection={DM_CHAIR_FORWARD_CORRECTION}
          />
        </Suspense>
      </ChairErrorBoundary>
    );
  }
  return (
    <ChairErrorBoundary fallback={<ProceduralPlayerChair />}>
      <Suspense fallback={<ProceduralPlayerChair />}>
        <ChairModel
          url={PLAYER_CHAIR_URL}
          targetHeight={PLAYER_CHAIR_HEIGHT}
          forwardCorrection={PLAYER_CHAIR_FORWARD_CORRECTION}
        />
      </Suspense>
    </ChairErrorBoundary>
  );
}

useGLTF.preload(PLAYER_CHAIR_URL);
useGLTF.preload(DM_CHAIR_URL);
