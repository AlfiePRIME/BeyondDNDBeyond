// The six standard polyhedral dice, built entirely from procedural
// geometry — three.js's own built-in Platonic-solid primitives for five of
// them, plus a from-scratch-derived pentagonal trapezohedron (below) for
// the d10, which three.js has no primitive for. No external 3D asset: this
// keeps the scene-3d module's only dependency its existing `three`/
// `@react-three/drei` packages, with nothing to license-check.
//
// DIE_FACE_NORMALS works around a different problem: a plain colored
// polyhedron has no printed pips, so there's no ground truth for "which
// face is the 6". Each entry below was computed once (see
// diceGeometry.test.ts) by grouping a shape's triangles into physical
// faces via shared normals, pairing antipodal faces (dot product ≈ -1,
// true for all five centrally-symmetric solids here), and numbering them
// by the SRD convention that opposite faces sum to sides+1 — the d4 has no
// antipodal pairs, so its 4 faces are just numbered in a fixed,
// arbitrary-but-deterministic order. The numbering is geometrically real
// (every face is a genuine modeled face) but not validated against any
// printed number — diceAnimator.ts's settle pose still points a real face
// upward, it just can't promise that face LOOKS like a "17" on an unlabeled
// solid color. The billboarded result badge (DiceTumble.tsx) is what
// actually carries the number unambiguously, the same "always-legible
// readout" job MapSurface's HP bar and condition chips already do for
// other game state a raw mesh can't express on its own.
import { BoxGeometry, DodecahedronGeometry, IcosahedronGeometry, OctahedronGeometry, PolyhedronGeometry, TetrahedronGeometry, type BufferGeometry } from "three";

export type DieKind = "d4" | "d6" | "d8" | "d10" | "d12" | "d20";

export const DIE_KINDS: readonly DieKind[] = ["d4", "d6", "d8", "d10", "d12", "d20"];

const SIDES_BY_KIND: Record<DieKind, number> = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20 };

/** Maps a rolled term's side count to a DieKind with real geometry. Returns
 * null for anything the free-form notation box can produce that isn't one
 * of the six standard shapes (d100, d3, d2, ...) — DieMesh falls back to a
 * plain placeholder primitive for those rather than failing to render; see
 * its doc comment. */
export function dieKindForSides(sides: number): DieKind | null {
  for (const kind of DIE_KINDS) {
    if (SIDES_BY_KIND[kind] === sides) return kind;
  }
  return null;
}

// A pentagonal trapezohedron — the true D10 dice shape (10 congruent kite
// faces, not triangles) — derived as the dual of a uniform pentagonal
// antiprism: reciprocate each of the antiprism's 12 faces through its
// plane (point = normal / distance-from-origin) to get the trapezohedron's
// 12 vertices, then each of the antiprism's 10 ORIGINAL vertices becomes
// one kite face of the dual. Verified numerically (see
// diceGeometry.test.ts) to be planar to within floating-point error and to
// wind consistently outward. three.js has no built-in primitive for this
// solid, unlike the other five standard dice below.
const D10_VERTICES: readonly (readonly [number, number, number])[] = [
  [0.70356, 0.16609, 0.51116],
  [0.86964, -0.16609, 0],
  [0.70356, 0.16609, -0.51116],
  [0, 1.5732, 0],
  [-0.26873, 0.16609, 0.82708],
  [0.26873, -0.16609, 0.82708],
  [-0.86964, 0.16609, 0],
  [-0.70356, -0.16609, 0.51116],
  [-0.26873, 0.16609, -0.82708],
  [-0.70356, -0.16609, -0.51116],
  [0.26873, -0.16609, -0.82708],
  [0, -1.5732, 0],
];

const D10_INDICES: readonly number[] = [
  0, 1, 2, 0, 2, 3, 4, 5, 0, 4, 0, 3, 6, 7, 4, 6, 4, 3, 8, 9, 6, 8, 6, 3, 2, 10, 8, 2, 8, 3, 11, 1, 0,
  11, 0, 5, 11, 5, 4, 11, 4, 7, 11, 7, 6, 11, 6, 9, 11, 9, 8, 11, 8, 10, 11, 10, 2, 11, 2, 1,
];

function buildD10Geometry(radius: number): BufferGeometry {
  // PolyhedronGeometry is the base class Tetrahedron/Octahedron/Dodecahedron
  // /IcosahedronGeometry all extend — it accepts an arbitrary vertex/index
  // array, which is exactly the from-scratch trapezohedron above.
  const flatVertices = D10_VERTICES.flat();
  return new PolyhedronGeometry(flatVertices, [...D10_INDICES], radius, 0);
}

/** Builds one shape's geometry at a given radius/size — a fresh
 * BufferGeometry each call, since callers (DiceTumble.tsx) cache the result
 * themselves once per kind. */
export function buildDieGeometry(kind: DieKind, size: number): BufferGeometry {
  switch (kind) {
    case "d4":
      return new TetrahedronGeometry(size);
    case "d6":
      return new BoxGeometry(size * 1.2, size * 1.2, size * 1.2);
    case "d8":
      return new OctahedronGeometry(size);
    case "d10":
      return buildD10Geometry(size);
    case "d12":
      return new DodecahedronGeometry(size);
    case "d20":
      return new IcosahedronGeometry(size);
  }
}

/**
 * Face-number → local-space unit normal, one array per die kind, index 0 =
 * face "1". Computed directly from each shape's real generated geometry —
 * three.js's own Platonic-solid primitives for five of them, the derived
 * D10 vertices/indices above for the sixth (see this module's doc comment)
 * — in the geometry's own centered local space, matching what
 * buildDieGeometry produces (three's primitives are already centered on
 * their own origin).
 */
export const DIE_FACE_NORMALS: Record<DieKind, readonly (readonly [number, number, number])[]> = {
  d4: [
    [-0.57735, 0.57735, 0.57735],
    [0.57735, 0.57735, -0.57735],
    [0.57735, -0.57735, 0.57735],
    [-0.57735, -0.57735, -0.57735],
  ],
  d6: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, -1, 0],
    [-1, 0, 0],
  ],
  d8: [
    [0.57735, 0.57735, 0.57735],
    [0.57735, -0.57735, 0.57735],
    [0.57735, -0.57735, -0.57735],
    [0.57735, 0.57735, -0.57735],
    [-0.57735, -0.57735, 0.57735],
    [-0.57735, 0.57735, 0.57735],
    [-0.57735, 0.57735, -0.57735],
    [-0.57735, -0.57735, -0.57735],
  ],
  d10: [
    [0.89443, 0.4472, 0],
    [0.2764, 0.44721, 0.85065],
    [-0.72361, 0.44721, 0.52573],
    [-0.72361, 0.44721, -0.52573],
    [0.2764, 0.44721, -0.85065],
    [-0.2764, -0.44721, 0.85065],
    [0.72361, -0.44721, 0.52573],
    [0.72361, -0.44721, -0.52573],
    [-0.2764, -0.44721, -0.85065],
    [-0.89443, -0.44721, 0],
  ],
  d12: [
    [0, 0.85065, 0.52573],
    [0.85065, 0.52573, 0],
    [0.52573, 0, -0.85065],
    [-0.52573, 0, -0.85065],
    [0, 0.85065, -0.52573],
    [-0.85065, 0.52573, 0],
    [0.85065, -0.52573, 0],
    [0, -0.85065, 0.52573],
    [0.52573, 0, 0.85065],
    [-0.52573, 0, 0.85065],
    [-0.85065, -0.52573, 0],
    [0, -0.85065, -0.52573],
  ],
  d20: [
    [-0.57735, 0.57735, 0.57735],
    [0, 0.93417, 0.35682],
    [0, 0.93417, -0.35682],
    [-0.57735, 0.57735, -0.57735],
    [-0.93417, 0.35682, 0],
    [0.57735, 0.57735, 0.57735],
    [-0.35682, 0, 0.93417],
    [-0.93417, -0.35682, 0],
    [-0.35682, 0, -0.93417],
    [0.57735, 0.57735, -0.57735],
    [-0.57735, -0.57735, 0.57735],
    [0.35682, 0, 0.93417],
    [0.93417, 0.35682, 0],
    [0.35682, 0, -0.93417],
    [-0.57735, -0.57735, -0.57735],
    [0.93417, -0.35682, 0],
    [0.57735, -0.57735, 0.57735],
    [0, -0.93417, 0.35682],
    [0, -0.93417, -0.35682],
    [0.57735, -0.57735, -0.57735],
  ],
};

/** The local-space normal that should point "up" (world +Y) for `kind` to
 * settle on `result`. Clamped defensively to a valid face index — a
 * malformed/out-of-range result (shouldn't happen; the server is the only
 * roller) just reads face 1 rather than throwing mid-animation. */
export function faceNormalForResult(kind: DieKind, result: number): readonly [number, number, number] {
  const faces = DIE_FACE_NORMALS[kind];
  const index = Math.min(Math.max(Math.round(result) - 1, 0), faces.length - 1);
  return faces[index];
}
