"use client";

import { PerspectiveCamera, RoundedBox } from "@react-three/drei";

const TABLE_TOP = { width: 7, thickness: 0.35, depth: 4.4 } as const;
const LEG = { radius: 0.14, height: 1.05 } as const;
const TABLE_SURFACE_Y = LEG.height + TABLE_TOP.thickness;

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

function TableLeg({ x, z }: { x: number; z: number }) {
  return (
    <mesh position={[x, LEG.height / 2, z]} castShadow>
      <cylinderGeometry args={[LEG.radius, LEG.radius * 1.35, LEG.height, 12]} />
      <meshStandardMaterial color={WOOD_LEG} roughness={0.8} />
    </mesh>
  );
}

export function GameTableScene() {
  const legX = TABLE_TOP.width / 2 - 0.45;
  const legZ = TABLE_TOP.depth / 2 - 0.45;

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, 10.5, 7.5]}
        fov={42}
        onUpdate={(camera) => camera.lookAt(0, TABLE_SURFACE_Y, 0)}
      />

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
    </>
  );
}
