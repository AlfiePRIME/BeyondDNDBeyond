"use client";

import { useMemo } from "react";
import { OrbitControls, PerspectiveCamera, RoundedBox } from "@react-three/drei";
import { LEG, TABLE_TOP, TABLE_SURFACE_Y } from "./table";
import { computeSeatLayout, type CameraMode, type Seat, type SeatMember } from "./seating";
import { SeatAvatar } from "./SeatAvatar";

// Room ambiance pulls from the app's design tokens (see
// src/ui-components/tokens.css) — scene-3d can't import CSS custom
// properties, so the hex values are mirrored here.
const ROOM_BG = "#0d0520"; // --surface2
const PURPLE = "#9b00ff"; // --purple
const TEAL = "#1ec8c8"; // --teal

// The tabletop stays naturalistic dark walnut (not neon) so future maps and
// tokens rendered on top of it stay legible — the palette accents live in
// the room lighting instead.
const WOOD_TOP = "#5a4028";
const WOOD_LEG = "#42301c";

const CUSHION = "#2a2140";
const LOOK_TARGET = [0, TABLE_SURFACE_Y, 0] as const;
const FALLBACK_CAMERA_POSITION: readonly [number, number, number] = [0, 10.5, 7.5];

function TableLeg({ x, z }: { x: number; z: number }) {
  return (
    <mesh position={[x, LEG.height / 2, z]} castShadow>
      <cylinderGeometry args={[LEG.radius, LEG.radius * 1.35, LEG.height, 12]} />
      <meshStandardMaterial color={WOOD_LEG} roughness={0.8} />
    </mesh>
  );
}

// The Prompt 19 stool is gone — an avatar standing on a low dais with the
// role-colored ring around its feet reads cleaner than a model clipping
// through a stool.
function TableSeat({ seat }: { seat: Seat }) {
  const accent = seat.member.role === "dm" ? PURPLE : TEAL;
  return (
    <group position={seat.position} rotation={[0, seat.rotationY, 0]}>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <cylinderGeometry args={[0.5, 0.56, 0.04, 24]} />
        <meshStandardMaterial color={CUSHION} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.045, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.5, 0.028, 10, 40]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.7} />
      </mesh>
      <group position={[0, 0.04, 0]}>
        <SeatAvatar url={seat.member.avatar_url ?? null} />
      </group>
    </group>
  );
}

export interface GameTableSceneProps {
  /** Ordered campaign member list — seat index is position in this list. */
  members?: readonly SeatMember[];
  currentUserId?: string | null;
  cameraMode?: CameraMode;
}

export function GameTableScene({
  members = [],
  currentUserId = null,
  cameraMode = "seat",
}: GameTableSceneProps) {
  const legX = TABLE_TOP.width / 2 - 0.45;
  const legZ = TABLE_TOP.depth / 2 - 0.45;

  const seats = useMemo(() => computeSeatLayout(members), [members]);
  const mySeat = seats.find((seat) => seat.member.user_id === currentUserId);
  const cameraPosition = mySeat ? mySeat.cameraPosition : FALLBACK_CAMERA_POSITION;

  return (
    <>
      {/* Keyed by mode so leaving orbit remounts the camera at the seat
          position/orientation instead of wherever orbiting dragged it. */}
      <PerspectiveCamera
        key={cameraMode}
        makeDefault
        position={cameraPosition as [number, number, number]}
        fov={mySeat ? 50 : 42}
        onUpdate={(camera) => camera.lookAt(...LOOK_TARGET)}
      />
      {cameraMode === "orbit" && (
        <OrbitControls
          target={[...LOOK_TARGET]}
          minDistance={1.5}
          maxDistance={22}
          maxPolarAngle={Math.PI / 2 - 0.05}
        />
      )}

      <color attach="background" args={[ROOM_BG]} />
      <fog attach="fog" args={[ROOM_BG, 16, 34]} />

      <ambientLight color="#b9a6ff" intensity={0.55} />
      <directionalLight
        color="#ffe9c9"
        intensity={3.4}
        position={[5, 10, 3]}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
      />
      <pointLight color={PURPLE} intensity={300} position={[-9, 4, -6]} distance={40} />
      <pointLight color={TEAL} intensity={200} position={[9, 3.5, 6]} distance={40} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[24, 48]} />
        <meshStandardMaterial color="#1a1338" roughness={0.95} />
      </mesh>

      <RoundedBox
        args={[TABLE_TOP.width, TABLE_TOP.thickness, TABLE_TOP.depth]}
        radius={0.06}
        position={[0, LEG.height + TABLE_TOP.thickness / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={WOOD_TOP} roughness={0.72} />
      </RoundedBox>

      <TableLeg x={-legX} z={-legZ} />
      <TableLeg x={legX} z={-legZ} />
      <TableLeg x={-legX} z={legZ} />
      <TableLeg x={legX} z={legZ} />

      {seats.map((seat) => (
        <TableSeat key={seat.member.user_id} seat={seat} />
      ))}
    </>
  );
}
