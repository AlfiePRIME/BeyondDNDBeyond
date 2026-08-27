import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  DEFAULT_FACE_LABELS,
  DIE_FACE_NORMALS,
  DIE_KINDS,
  buildDieGeometry,
  dieKindForSides,
  faceCenter,
  faceNormalForResult,
  facePlaneDistance,
  labelForResult,
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

describe("DEFAULT_FACE_LABELS", () => {
  it("has exactly `sides` sequential labels, starting at \"1\", for every die kind", () => {
    for (const kind of DIE_KINDS) {
      const labels = DEFAULT_FACE_LABELS[kind];
      expect(labels.length).toBe(SIDES[kind]);
      expect(labels).toEqual(Array.from({ length: SIDES[kind] }, (_, i) => String(i + 1)));
    }
  });

  it("prints \"10\" on the d10's tenth face, never \"0\" (rollDie(10) is always in [1, 10])", () => {
    expect(DEFAULT_FACE_LABELS.d10[9]).toBe("10");
    expect(DEFAULT_FACE_LABELS.d10).not.toContain("0");
  });
});

describe("labelForResult", () => {
  it("agrees with faceNormalForResult about which face won, for every kind and every valid result", () => {
    // Both route through the identical face-index clamp — this asserts
    // that guarantee end to end, not just that it's true by inspection.
    for (const kind of DIE_KINDS) {
      for (let result = 1; result <= SIDES[kind]; result++) {
        const faceIndex = DIE_FACE_NORMALS[kind].findIndex(
          (normal) => normal === faceNormalForResult(kind, result)
        );
        expect(DEFAULT_FACE_LABELS[kind][faceIndex]).toBe(labelForResult(kind, result));
      }
    }
  });

  it("clamps an out-of-range result exactly like faceNormalForResult does", () => {
    expect(labelForResult("d20", 0)).toBe(labelForResult("d20", 1));
    expect(labelForResult("d20", 999)).toBe(labelForResult("d20", 20));
  });

  it("uses a custom labelSet (the percentile pair's own tens/ones labels) instead of DEFAULT_FACE_LABELS when given one", () => {
    const tensLabels = ["00", "10", "20", "30", "40", "50", "60", "70", "80", "90"];
    expect(labelForResult("d10", 6, tensLabels)).toBe("50");
    expect(labelForResult("d10", 6)).toBe("6"); // Unaffected default behavior.
  });
});

describe("facePlaneDistance / faceCenter", () => {
  it("is positive and identical regardless of which face's normal is checked (every face of a fair die is equidistant from center)", () => {
    for (const kind of DIE_KINDS) {
      const distance = facePlaneDistance(kind, 0.15);
      expect(distance).toBeGreaterThan(0);
      // Recompute independently via a DIFFERENT face's own normal (not the
      // face-0 normal facePlaneDistance itself measures against) — proves
      // the "one scalar per kind" assumption is actually true here, not
      // just assumed.
      const geometry = buildDieGeometry(kind, 0.15);
      const position = geometry.attributes.position;
      const otherIndex = Math.min(2, DIE_FACE_NORMALS[kind].length - 1);
      const otherNormal = new Vector3(...DIE_FACE_NORMALS[kind][otherIndex]);
      let maxDot = 0;
      for (let i = 0; i < position.count; i++) {
        const dot = new Vector3(position.getX(i), position.getY(i), position.getZ(i)).dot(otherNormal);
        if (dot > maxDot) maxDot = dot;
      }
      expect(maxDot).toBeCloseTo(distance, 4);
    }
  });

  it("every face's center lies exactly on that face's own plane, along its own normal", () => {
    for (const kind of DIE_KINDS) {
      const distance = facePlaneDistance(kind, 0.15);
      for (let index = 0; index < DIE_FACE_NORMALS[kind].length; index++) {
        const center = new Vector3(...faceCenter(kind, index, 0.15));
        const normal = new Vector3(...DIE_FACE_NORMALS[kind][index]);
        expect(center.length()).toBeCloseTo(distance, 4);
        expect(center.clone().normalize().dot(normal)).toBeCloseTo(1, 4);
      }
    }
  });
});
