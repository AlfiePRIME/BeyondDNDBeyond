"use client";

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

// Seat pad height above the floor (the seat's own local origin) — a real
// chair-seat height, not the old low dais's near-floor disc.
const SEAT_Y = 0.42;

/** The seat pad's top surface height — where an avatar standing on the
 * chair should place its feet. Both chairs' pads are close enough in
 * thickness (0.06 vs 0.07) to share one constant without a visible seam;
 * exported so GameTableScene's avatar mount offset derives from the same
 * number the pads themselves are positioned from, rather than a second,
 * separately-hardcoded guess that could drift out of sync. */
export const SEAT_TOP_Y = SEAT_Y + 0.03;

/** Four thin cylindrical legs from the floor up to the underside of the
 * seat pad, at the seat pad's corners inset slightly so they read as legs
 * rather than poking past the pad's edge. */
function ChairLegs({ halfFootprint, wood }: { halfFootprint: number; wood: string }) {
  const inset = halfFootprint - 0.06;
  const legHeight = SEAT_Y - 0.03;
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
// toned to read as ordinary furniture next to the DM's throne.
function PlayerChair() {
  return (
    <group>
      <ChairLegs halfFootprint={0.25} wood={PLAYER_WOOD} />
      <mesh position={[0, SEAT_Y, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.5, 0.06, 0.5]} />
        <meshStandardMaterial color={CUSHION} roughness={0.7} />
      </mesh>
      {/* Back edge is +Z — local -Z is the seat's facing direction (toward
          the table center), so the backrest sits behind the sitter. */}
      <mesh position={[0, 0.725, 0.22]} castShadow>
        <boxGeometry args={[0.5, 0.55, 0.06]} />
        <meshStandardMaterial color={PLAYER_WOOD} roughness={0.75} />
      </mesh>
      {/* Glowing trim along the backrest's top edge — the old floor ring's
          accent glow, relocated onto the chair itself. */}
      <mesh position={[0, 0.99, 0.22]}>
        <boxGeometry args={[0.46, 0.03, 0.03]} />
        <meshStandardMaterial color={TEAL} emissive={TEAL} emissiveIntensity={1.7} />
      </mesh>
    </group>
  );
}

// A visibly bigger, taller "throne": wider seat and armrests, a much taller
// backrest topped with a purple-emissive finial, darker wood, purple trim
// along the backrest's edges instead of teal.
function DmChair() {
  const half = 0.31; // 0.62 footprint / 2
  return (
    <group>
      <ChairLegs halfFootprint={half} wood={DM_WOOD} />
      <mesh position={[0, SEAT_Y, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.62, 0.07, 0.62]} />
        <meshStandardMaterial color={CUSHION} roughness={0.65} />
      </mesh>

      {/* Armrests flank the seat, resting just above the pad. */}
      <mesh position={[half + 0.03, 0.51, 0]} castShadow>
        <boxGeometry args={[0.06, 0.18, 0.5]} />
        <meshStandardMaterial color={DM_WOOD} roughness={0.75} />
      </mesh>
      <mesh position={[-(half + 0.03), 0.51, 0]} castShadow>
        <boxGeometry args={[0.06, 0.18, 0.5]} />
        <meshStandardMaterial color={DM_WOOD} roughness={0.75} />
      </mesh>

      {/* Tall backrest — reaches ~1.4 total height vs. the player chair's
          ~1.0, the throne's main size signal. */}
      <mesh position={[0, 0.875, 0.34]} castShadow>
        <boxGeometry args={[0.62, 1.05, 0.08]} />
        <meshStandardMaterial color={DM_WOOD} roughness={0.7} />
      </mesh>

      {/* Purple trim along the backrest's vertical edges and top. */}
      <mesh position={[0.28, 0.9, 0.34]}>
        <boxGeometry args={[0.03, 1.0, 0.03]} />
        <meshStandardMaterial color={PURPLE} emissive={PURPLE} emissiveIntensity={1.7} />
      </mesh>
      <mesh position={[-0.28, 0.9, 0.34]}>
        <boxGeometry args={[0.03, 1.0, 0.03]} />
        <meshStandardMaterial color={PURPLE} emissive={PURPLE} emissiveIntensity={1.7} />
      </mesh>
      <mesh position={[0, 1.4, 0.34]}>
        <boxGeometry args={[0.58, 0.03, 0.03]} />
        <meshStandardMaterial color={PURPLE} emissive={PURPLE} emissiveIntensity={1.7} />
      </mesh>

      {/* Finial ornament at the top of the backrest. */}
      <mesh position={[0, 1.46, 0.34]} castShadow>
        <coneGeometry args={[0.06, 0.16, 12]} />
        <meshStandardMaterial color={PURPLE} emissive={PURPLE} emissiveIntensity={1.9} />
      </mesh>
    </group>
  );
}

/**
 * Per-seat chair furniture — replaces the old cushion-disc + glowing-ring
 * "dais" (see GameTableScene's `TableSeat`) with an actual modeled chair,
 * built entirely from three.js JSX primitives (no external asset, the
 * diceGeometry.ts precedent for procedural-over-imported geometry, though
 * a chair is simple enough to need no separate geometry-builder module).
 * `SeatAvatar` renders on top of this unchanged — this component owns only
 * the furniture beneath the avatar.
 */
export function Chair({ role }: { role: "dm" | "player" }) {
  return role === "dm" ? <DmChair /> : <PlayerChair />;
}
