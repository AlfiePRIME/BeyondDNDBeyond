// Map Editor Batch A7: wall-mounted torches. Pure geometry, no React/three
// imports needed (the mapFit.ts/gridOverlay.ts precedent) — used both by the
// map editor (MapEditor.tsx/MapEditorScene.tsx) and the live Game Room
// (GameRoom.tsx) so a mounted object resolves identically in both places.
//
// Only the placeable wall-object FAMILY (wall.glb/wall-corner.glb/
// wall-diagonal.glb/wall-door.glb — real MapObjects with their own x/y/
// rotation transform) can host a mount; the separate procedural
// elevation-edge wall rendering has no addressable per-face identity at all
// and is untouched by this feature.

/**
 * The two mountable faces of any wall-family object, as degrees ADDED TO
 * the host wall's own `rotation` — not an absolute world angle. Every
 * wall-family preset (straight run, corner, diagonal, doorway) shares the
 * SAME local +Z thickness axis as its "front"/"back" (buildWall's own
 * 2×1.4×0.3 box in generate-map-presets.mjs, and the matching WALL_THICKNESS
 * layers generate-wall-variants-presets.mjs builds corner/diagonal/door
 * from) — 0 is that local +Z face, 180 its opposite. A corner or diagonal
 * piece technically exposes more than two physical surfaces, but per this
 * feature's own acceptance criteria ("interior/exterior relative to the
 * wall's own orientation") every wall-family host is treated uniformly: the
 * DM picks a SIDE, not a specific physical facet.
 */
export const WALL_MOUNT_FACES = [0, 180] as const;

export type WallMountFaceDeg = (typeof WALL_MOUNT_FACES)[number];

/**
 * Cell-fraction distance a mounted object sits OUTWARD from its host wall's
 * own center, along the chosen face's normal. Deliberately ONE constant
 * across the whole wall family rather than each preset's own true
 * half-thickness (which genuinely differs: wall.glb's WALL_THICKNESS 0.3
 * scales to a real 0.15 world units at its 0.5 fit-scale, while
 * wall-corner.glb/wall-diagonal.glb/wall-door.glb's own WALL_THICKNESS 0.19
 * renders at scale 1 — see PlacedObject.tsx's WALL_FIT_TARGET_BY_URL doc
 * comment for the real measured numbers behind both) — a torch's own
 * visible footprint (~0.13 radius, generate-map-presets.mjs's buildTorch)
 * already dominates whatever few-hundredths-of-a-unit difference the exact
 * per-preset thickness would make, so one shared constant reads as "mounted
 * on the face, not centered" for every wall-family host without a
 * per-model lookup table of its own.
 */
export const WALL_MOUNT_OFFSET = 0.22;

/** A host wall's transform, in the exact shape MapObject already stores it
 * (plain grid x/y/elevation/rotation) — kept independent of data-access's
 * own MapObject type so this stays a pure, data-access-free scene-3d module
 * (the mapFit.ts/gridOverlay.ts precedent), matching the same primitive
 * shape MapSurfaceObject itself already exposes. */
export interface WallMountHost {
  x: number;
  y: number;
  elevation: number;
  rotation: number;
}

/**
 * The world-Y rotation (degrees) and cell-fraction (x, z) offset for an
 * object mounted to a host wall currently at `host.rotation`, on the face
 * `faceDeg` describes (added to the host's own rotation). Uses the exact
 * "rotate local +Z by degrees around Y" convention every other Y-rotated
 * placed prop in this app already follows (MapSurface.tsx's
 * WATER_FLOW_Y_ROTATION doc comment: local +Z at rotation 0 points toward
 * +worldZ, this app's own "south").
 *
 * Deliberately re-derived fresh from the host's CURRENT rotation on every
 * call rather than ever being cached on the mounted object's own row — so
 * re-rotating the host wall (or, via mapObjects.ts's updateMapObject
 * cascade trigger, moving it to a new cell) keeps a mounted object's
 * rendered facing/offset correct automatically, with no separate rotation
 * cascade of its own.
 */
export function resolveWallMountOffset(
  host: Pick<WallMountHost, "rotation">,
  faceDeg: number
): { rotationDeg: number; offsetX: number; offsetZ: number } {
  const rotationDeg = host.rotation + faceDeg;
  const rad = (rotationDeg * Math.PI) / 180;
  return {
    rotationDeg,
    offsetX: WALL_MOUNT_OFFSET * Math.sin(rad),
    offsetZ: WALL_MOUNT_OFFSET * Math.cos(rad),
  };
}
