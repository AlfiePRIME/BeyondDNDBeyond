import { describe, expect, it } from "vitest";
import { computeSeatLayout, type SeatMember } from "@/scene-3d";

const TABLE = { width: 7, depth: 4.4 };

function makeMembers(count: number): SeatMember[] {
  return Array.from({ length: count }, (_, i) => ({
    user_id: `user-${i}`,
    role: i === 0 ? ("dm" as const) : ("player" as const),
    display_name: `Member ${i}`,
  }));
}

describe("computeSeatLayout", () => {
  it("assigns one seat per member, preserving the input order", () => {
    const members = makeMembers(4);
    const seats = computeSeatLayout(members);
    expect(seats).toHaveLength(4);
    seats.forEach((seat, i) => expect(seat.member).toBe(members[i]));
  });

  it("is deterministic for the same input", () => {
    const members = makeMembers(5);
    expect(computeSeatLayout(members)).toEqual(computeSeatLayout(members));
  });

  it("places every seat at a distinct position", () => {
    const seats = computeSeatLayout(makeMembers(6));
    const keys = new Set(seats.map((s) => s.position.map((v) => v.toFixed(4)).join(",")));
    expect(keys.size).toBe(6);
  });

  it("keeps seats outside the tabletop footprint", () => {
    for (const count of [1, 2, 3, 5, 8]) {
      for (const seat of computeSeatLayout(makeMembers(count), TABLE)) {
        const [x, , z] = seat.position;
        const insideTable = Math.abs(x) < TABLE.width / 2 && Math.abs(z) < TABLE.depth / 2;
        expect(insideTable).toBe(false);
      }
    }
  });

  it("orients each seat to face the table center", () => {
    for (const seat of computeSeatLayout(makeMembers(7))) {
      const [x, , z] = seat.position;
      // Default forward (-Z) rotated by rotationY around Y.
      const forward = [-Math.sin(seat.rotationY), -Math.cos(seat.rotationY)];
      const len = Math.hypot(x, z);
      const toCenter = [-x / len, -z / len];
      const dot = forward[0] * toCenter[0] + forward[1] * toCenter[1];
      expect(dot).toBeCloseTo(1, 5);
    }
  });

  it("puts the camera behind the seat, further from center than the stool", () => {
    for (const seat of computeSeatLayout(makeMembers(3))) {
      const seatDist = Math.hypot(seat.position[0], seat.position[2]);
      const camDist = Math.hypot(seat.cameraPosition[0], seat.cameraPosition[2]);
      expect(camDist).toBeGreaterThan(seatDist);
      expect(seat.cameraPosition[1]).toBeGreaterThan(0);
    }
  });
});
