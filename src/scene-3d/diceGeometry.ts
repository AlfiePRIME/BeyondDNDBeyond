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

/** Every die's rendered size (the "radius"-ish argument fed to
 * buildDieGeometry) — the one shared constant DiceTumble.tsx's visual mesh
 * AND diceAnimator.ts's physics collider both build from
 * (docs/design/dice-numbers-and-physics.md §8: the collider is built
 * directly from buildDieGeometry's own vertices, at this same size, so the
 * two can never silently drift into physically different-sized shapes). */
export const DIE_SIZE = 0.13;

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

// Shared by faceNormalForResult and labelForResult below — both need to
// agree on EXACTLY which face index a given result maps to, so a die's own
// printed number (labelForResult) and whichever face physically ends up
// pointing up (faceNormalForResult) can never disagree about which face
// won. Clamped defensively — a malformed/out-of-range result (shouldn't
// happen; the server is the only roller) just reads face 1 rather than
// throwing mid-animation.
function faceIndexForResult(faceCount: number, result: number): number {
  return Math.min(Math.max(Math.round(result) - 1, 0), faceCount - 1);
}

/** The local-space normal that should point "up" (world +Y) for `kind` to
 * settle on `result`. See faceIndexForResult's own doc comment for the
 * clamping behavior. */
export function faceNormalForResult(kind: DieKind, result: number): readonly [number, number, number] {
  const faces = DIE_FACE_NORMALS[kind];
  return faces[faceIndexForResult(faces.length, result)];
}

/**
 * One printed label per face, index-aligned with DIE_FACE_NORMALS[kind] —
 * DEFAULT_FACE_LABELS[kind][i] is the number printed on the exact face
 * `faceNormalForResult(kind, i + 1)` points up for. Every standard die is
 * simply "1" through "sides" in face order, including the d10, which prints
 * "10" on its tenth face rather than the "0" some physical d10s use:
 * `rollDie(10, random)` in rules-engine/dice.ts always returns an integer in
 * [1, 10], so a face reading "0" could never correspond to any real result
 * this app produces — printing one anyway would be actively confusing, not
 * a neutral nod to physical-dice convention (docs/design/dice-numbers-and-
 * physics.md §4). Numerals, not pips, on every face including the d6 — one
 * shared "draw this string" renderer (DiceTumble.tsx's faceDecalTexture) for
 * all six kinds is simpler than a second, pip-layout algorithm, and reads
 * faster at this app's actual render scale (same section, in full).
 */
function sequentialLabels(sides: number): readonly string[] {
  return Array.from({ length: sides }, (_, index) => String(index + 1));
}

export const DEFAULT_FACE_LABELS: Record<DieKind, readonly string[]> = {
  d4: sequentialLabels(SIDES_BY_KIND.d4),
  d6: sequentialLabels(SIDES_BY_KIND.d6),
  d8: sequentialLabels(SIDES_BY_KIND.d8),
  d10: sequentialLabels(SIDES_BY_KIND.d10),
  d12: sequentialLabels(SIDES_BY_KIND.d12),
  d20: sequentialLabels(SIDES_BY_KIND.d20),
};

/**
 * The printed label the face `faceNormalForResult(kind, result)` points up
 * for — routed through the exact same faceIndexForResult as
 * faceNormalForResult itself, so a die's own newly-decaled face and
 * whichever readout displays `result` (DiceTumble.tsx's ResultBadge) can
 * never disagree about which face won, by construction rather than by
 * convention. `labelSet` overrides the standard 1..sides numbering
 * (DEFAULT_FACE_LABELS) — today's one real use is a percentile pair's own
 * tens/ones face labels (src/app/campaigns/[id]/roll/tumble.ts's
 * buildDiceTumbleSpec), where the synthetic 1-10 `result` fed in here is
 * NOT the value actually printed on the face.
 */
export function labelForResult(kind: DieKind, result: number, labelSet?: readonly string[]): string {
  const labels = labelSet ?? DEFAULT_FACE_LABELS[kind];
  return labels[faceIndexForResult(labels.length, result)];
}

/**
 * The perpendicular distance from a die's local origin out to any one of
 * its own flat faces — by construction the same for every face of all six
 * kinds here (this module's own doc comment on the isohedral/centrally-
 * symmetric construction every DIE_FACE_NORMALS entry already relies on),
 * so one scalar per kind is enough
 * (docs/design/dice-numbers-and-physics.md §4's FACE_PLANE_DISTANCE).
 * Measured directly off `buildDieGeometry`'s own real vertex data — the
 * largest dot product any vertex has against face 0's own normal is exactly
 * the vertices that lie ON that face's plane, for any convex solid — rather
 * than a hand-derived analytic inradius formula per shape (five different
 * Platonic-solid formulas plus the d10's own from-scratch trapezohedron is
 * real surface area for a transcription mistake). Same "verify numerically,
 * don't just trust the formula" approach this file's own D10 vertices used.
 */
export function facePlaneDistance(kind: DieKind, size: number): number {
  const geometry = buildDieGeometry(kind, size);
  const [nx, ny, nz] = DIE_FACE_NORMALS[kind][0];
  const position = geometry.attributes.position;
  let maxDot = 0;
  for (let i = 0; i < position.count; i++) {
    const dot = position.getX(i) * nx + position.getY(i) * ny + position.getZ(i) * nz;
    if (dot > maxDot) maxDot = dot;
  }
  return maxDot;
}

/**
 * Where face `index`'s own printed-number decal (DiceTumble.tsx's DieMesh)
 * sits, before the small outward DECAL_EPSILON nudge that avoids z-fighting
 * with the base mesh — exactly `DIE_FACE_NORMALS[kind][index] *
 * facePlaneDistance(kind, size)`, the spike's own faceCenter formula (§4).
 */
export function faceCenter(kind: DieKind, index: number, size: number): readonly [number, number, number] {
  const distance = facePlaneDistance(kind, size);
  const [nx, ny, nz] = DIE_FACE_NORMALS[kind][index];
  return [nx * distance, ny * distance, nz * distance];
}
