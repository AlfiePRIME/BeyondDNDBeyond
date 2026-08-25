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

// Target total heights (floor to the tallest point) for the loaded glTF
// chairs, following SeatAvatar's scale-to-known-height pattern. The two
// source models already lean this way on their own raw export scale (the
// DM throne measures ~1.83x the player chair's raw height before either is
// normalized) — these targets preserve that natural distinction rather
// than inventing one, landing close to the old procedural chairs' own
// ~1.46:1 throne-to-chair ratio, and keep the player chair near the old
// procedural chair's ~1.0 total height for scene continuity.
const PLAYER_CHAIR_HEIGHT = 1.0;
const DM_CHAIR_HEIGHT = 1.5;

// Each loaded chair's seat-pad top height above the floor, in scene units —
// measured directly off each glTF's real geometry at its actual rendered
// (post-scale) size, not guessed: for the DM throne (13 separate nodes),
// one sub-mesh ("Cube_low", a squarish, moderately-thick slab resting atop
// the throne's central pedestal column) sits at world Y 0.4357-0.5693,
// exactly where a seat cushion set into a grand throne frame should be —
// its own footprint is a modest fraction of the throne's full width/depth,
// which fits a cushion inset within a wider frame/armrests, not a full-
// width plank. The player chair is a single fused mesh with no isolable
// seat sub-mesh, so instead every vertex's world Y was binned into a
// histogram (see the throwaway probe script this was measured with): the
// densest wide, near-full-footprint horizontal band (spanning ~88-97% of
// the chair's own width/depth, unlike the narrower band at ~12% height
// that's almost certainly a leg stretcher) lands at world Y ≈ 0.515 — that
// full-footprint span is what distinguishes an actual seat plank from a
// stretcher bar or armrest, both of which are narrower. Both figures
// checked against a standing avatar in the actual rendered scene (a
// temporary bright marker at this exact height, not just the placeholder
// mannequin's fuzzy silhouette) — neither floats above the cushion nor
// sinks into it, the exact bug class this file was flagged to re-check now
// that the two chairs have independently measured, no-longer-identical
// heights.
export const SEAT_TOP_Y: Record<"dm" | "player", number> = {
  dm: 0.57,
  player: 0.52,
};

// The procedural fallback chairs (below) must put their OWN seat pad at
// this same per-role height — GameTableScene positions the avatar using
// SEAT_TOP_Y regardless of whether the real model or this fallback ends up
// rendering, so the fallback's geometry has to agree with it too, or a
// load failure would reintroduce the floating/sinking bug on the safety net
// itself. Cushion half-thickness is subtracted back out because SEAT_Y below
// is the cushion mesh's own (center) position, not its top surface.
const PLAYER_CUSHION_THICKNESS = 0.06;
const DM_CUSHION_THICKNESS = 0.07;
const PLAYER_SEAT_Y = SEAT_TOP_Y.player - PLAYER_CUSHION_THICKNESS / 2;
const DM_SEAT_Y = SEAT_TOP_Y.dm - DM_CUSHION_THICKNESS / 2;

/** Four thin cylindrical legs from the floor up to the underside of the
 * seat pad, at the seat pad's corners inset slightly so they read as legs
 * rather than poking past the pad's edge. */
function ChairLegs({
  halfFootprint,
  wood,
  seatY,
}: {
  halfFootprint: number;
  wood: string;
  seatY: number;
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
          <cylinderGeometry args={[0.03, 0.035, legHeight, 8]} />
          <meshStandardMaterial color={wood} roughness={0.8} />
        </mesh>
      ))}
    </>
  );
}

// A modest seat pad, backrest, and four legs — a plain chair, sized and
// toned to read as ordinary furniture next to the DM's throne. Kept around
// as the load-failure/loading-state fallback for the real player-chair.glb
// model (see Chair below) — every upper-body offset is expressed relative
// to PLAYER_SEAT_Y so the whole shape re-anchors correctly if that constant
// ever moves, rather than drifting out of proportion with the seat pad.
function ProceduralPlayerChair() {
  return (
    <group>
      <ChairLegs halfFootprint={0.25} wood={PLAYER_WOOD} seatY={PLAYER_SEAT_Y} />
      <mesh position={[0, PLAYER_SEAT_Y, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.5, PLAYER_CUSHION_THICKNESS, 0.5]} />
        <meshStandardMaterial color={CUSHION} roughness={0.7} />
      </mesh>
      {/* Back edge is +Z — local -Z is the seat's facing direction (toward
          the table center), so the backrest sits behind the sitter. */}
      <mesh position={[0, PLAYER_SEAT_Y + 0.305, 0.22]} castShadow>
        <boxGeometry args={[0.5, 0.55, 0.06]} />
        <meshStandardMaterial color={PLAYER_WOOD} roughness={0.75} />
      </mesh>
      {/* Glowing trim along the backrest's top edge — the old floor ring's
          accent glow, relocated onto the chair itself. */}
      <mesh position={[0, PLAYER_SEAT_Y + 0.57, 0.22]}>
        <boxGeometry args={[0.46, 0.03, 0.03]} />
        <meshStandardMaterial color={TEAL} emissive={TEAL} emissiveIntensity={1.7} />
      </mesh>
    </group>
  );
}

// A visibly bigger, taller "throne": wider seat and armrests, a much taller
// backrest topped with a purple-emissive finial, darker wood, purple trim
// along the backrest's edges instead of teal. Kept around as the
// load-failure/loading-state fallback for the real dm-chair.glb model (see
// Chair below); like the player chair above, every upper-body offset is
// expressed relative to DM_SEAT_Y.
function ProceduralDmChair() {
  const half = 0.31; // 0.62 footprint / 2
  return (
    <group>
      <ChairLegs halfFootprint={half} wood={DM_WOOD} seatY={DM_SEAT_Y} />
      <mesh position={[0, DM_SEAT_Y, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.62, DM_CUSHION_THICKNESS, 0.62]} />
        <meshStandardMaterial color={CUSHION} roughness={0.65} />
      </mesh>

      {/* Armrests flank the seat, resting just above the pad. */}
      <mesh position={[half + 0.03, DM_SEAT_Y + 0.09, 0]} castShadow>
        <boxGeometry args={[0.06, 0.18, 0.5]} />
        <meshStandardMaterial color={DM_WOOD} roughness={0.75} />
      </mesh>
      <mesh position={[-(half + 0.03), DM_SEAT_Y + 0.09, 0]} castShadow>
        <boxGeometry args={[0.06, 0.18, 0.5]} />
        <meshStandardMaterial color={DM_WOOD} roughness={0.75} />
      </mesh>

      {/* Tall backrest — reaches ~1.4 total height vs. the player chair's
          ~1.0, the throne's main size signal. */}
      <mesh position={[0, DM_SEAT_Y + 0.455, 0.34]} castShadow>
        <boxGeometry args={[0.62, 1.05, 0.08]} />
        <meshStandardMaterial color={DM_WOOD} roughness={0.7} />
      </mesh>

      {/* Purple trim along the backrest's vertical edges and top. */}
      <mesh position={[0.28, DM_SEAT_Y + 0.48, 0.34]}>
        <boxGeometry args={[0.03, 1.0, 0.03]} />
        <meshStandardMaterial color={PURPLE} emissive={PURPLE} emissiveIntensity={1.7} />
      </mesh>
      <mesh position={[-0.28, DM_SEAT_Y + 0.48, 0.34]}>
        <boxGeometry args={[0.03, 1.0, 0.03]} />
        <meshStandardMaterial color={PURPLE} emissive={PURPLE} emissiveIntensity={1.7} />
      </mesh>
      <mesh position={[0, DM_SEAT_Y + 0.98, 0.34]}>
        <boxGeometry args={[0.58, 0.03, 0.03]} />
        <meshStandardMaterial color={PURPLE} emissive={PURPLE} emissiveIntensity={1.7} />
      </mesh>

      {/* Finial ornament at the top of the backrest. */}
      <mesh position={[0, DM_SEAT_Y + 1.04, 0.34]} castShadow>
        <coneGeometry args={[0.06, 0.16, 12]} />
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
 * the export placed its own origin. Clone (not the cached scene directly)
 * since every seat mounts its own instance and useGLTF caches per URL.
 */
function ChairModel({ url, targetHeight }: { url: string; targetHeight: number }) {
  const { scene } = useGLTF(url);
  const { scale, offset } = useMemo(() => {
    const box = new Box3().setFromObject(scene as Object3D);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const scale = size.y > 1e-3 ? targetHeight / size.y : 1;
    const offset: [number, number, number] = [-center.x * scale, -box.min.y * scale, -center.z * scale];
    return { scale, offset };
  }, [scene, targetHeight]);

  return <Clone object={scene} scale={scale} position={offset} castShadow receiveShadow />;
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
 * chair (`ProceduralDmChair`/`ProceduralPlayerChair`, both preserved
 * unchanged in shape, just re-anchored to the same measured seat heights)
 * rather than an empty or broken seat.
 * `SeatAvatar` renders on top of this unchanged — this component owns only
 * the furniture beneath the avatar.
 */
export function Chair({ role }: { role: "dm" | "player" }) {
  if (role === "dm") {
    return (
      <ChairErrorBoundary fallback={<ProceduralDmChair />}>
        <Suspense fallback={<ProceduralDmChair />}>
          <ChairModel url={DM_CHAIR_URL} targetHeight={DM_CHAIR_HEIGHT} />
        </Suspense>
      </ChairErrorBoundary>
    );
  }
  return (
    <ChairErrorBoundary fallback={<ProceduralPlayerChair />}>
      <Suspense fallback={<ProceduralPlayerChair />}>
        <ChairModel url={PLAYER_CHAIR_URL} targetHeight={PLAYER_CHAIR_HEIGHT} />
      </Suspense>
    </ChairErrorBoundary>
  );
}

useGLTF.preload(PLAYER_CHAIR_URL);
useGLTF.preload(DM_CHAIR_URL);
