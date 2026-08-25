import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  DIE_FACE_NORMALS,
  DIE_KINDS,
  buildDieGeometry,
  dieKindForSides,
  faceNormalForResult,
  type DieKind,
} from "./diceGeometry";

const SIDES: Record<DieKind, number> = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20 };

describe("dieKindForSides", () => {
  it("maps every standard side count to its kind", () => {
    for (const kind of DIE_KINDS) {
      expect(dieKindForSides(SIDES[kind])).toBe(kind);
    }
  });

  it("returns null for a free-form roll's non-standard side count", () => {
    expect(dieKindForSides(100)).toBeNull();
    expect(dieKindForSides(3)).toBeNull();
    expect(dieKindForSides(2)).toBeNull();
  });
});

describe("buildDieGeometry", () => {
  it("builds a non-degenerate, roughly origin-centered shape for every kind", () => {
    for (const kind of DIE_KINDS) {
      const geometry = buildDieGeometry(kind, 0.15);
      expect(geometry.attributes.position.count).toBeGreaterThan(0);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      const center = box.getCenter(new Vector3());
      expect(center.length()).toBeLessThan(0.01);
    }
  });
});

describe("DIE_FACE_NORMALS", () => {
  it("has exactly `sides` unit-length entries per die kind", () => {
    for (const kind of DIE_KINDS) {
      const faces = DIE_FACE_NORMALS[kind];
      expect(faces.length).toBe(SIDES[kind]);
      for (const normal of faces) {
        const length = new Vector3(...normal).length();
        expect(length).toBeCloseTo(1, 2);
      }
    }
  });

  it("pairs opposite faces summing to sides+1 as antipodal normals (the five centrally-symmetric solids)", () => {
    for (const kind of DIE_KINDS) {
      if (kind === "d4") continue; // No antipodal pairs on a tetrahedron.
      const sides = SIDES[kind];
      for (let result = 1; result <= sides; result++) {
        const a = new Vector3(...faceNormalForResult(kind, result));
        const b = new Vector3(...faceNormalForResult(kind, sides + 1 - result));
        expect(a.dot(b)).toBeCloseTo(-1, 2);
      }
    }
  });
});

describe("faceNormalForResult", () => {
  it("clamps an out-of-range result to a valid face rather than throwing", () => {
    expect(() => faceNormalForResult("d20", 0)).not.toThrow();
    expect(() => faceNormalForResult("d20", 999)).not.toThrow();
    expect(faceNormalForResult("d20", 0)).toEqual(faceNormalForResult("d20", 1));
    expect(faceNormalForResult("d20", 999)).toEqual(faceNormalForResult("d20", 20));
  });
});
