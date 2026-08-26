import { describe, expect, it } from "vitest";
import { computeSeatLayout, seatEllipseSemiAxes, type SeatMember } from "@/scene-3d";
import { COMBINED_TABLE_TOP, TABLE_TOP } from "./table";

// Imports the real constants rather than hardcoded copies so these tests can
// never silently drift from table.ts's actual dimensions. TABLE is the
// single physical table's own footprint (still useful below to prove seats
// land OUTSIDE any one table, not just the combined pair); COMBINED_TABLE is
// the full two-table footprint computeSeatLayout now fits its ellipse
// around by default.
const TABLE = TABLE_TOP;
const COMBINED_TABLE = COMBINED_TABLE_TOP;

// Mirrors seating.ts's own private FIRST_SEAT_ANGLE — not exported, so the
// DM-placement tests below re-derive the "closest to opposite" seat index
// from first principles instead of importing/duplicating the source's
// shortcut formula.
const FIRST_SEAT_ANGLE = Math.PI / 2;

function makeMembers(count: number): SeatMember[] {
  return Array.from({ length: count }, (_, i) => ({
    user_id: `user-${i}`,
    role: i === 0 ? ("dm" as const) : ("player" as const),
    display_name: `Member ${i}`,
  }));
}

/** Builds a member list of size `n` with the DM at `dmPosition` and every
 * other slot a player, in ascending id order — used to prove DM placement
 * doesn't depend on where the DM happens to sit in the input array. */
function makeMembersWithDmAt(n: number, dmPosition: number): SeatMember[] {
  return Array.from({ length: n }, (_, i) => ({
    user_id: `user-${i}`,
    role: i === dmPosition ? ("dm" as const) : ("player" as const),
    display_name: `Member ${i}`,
  }));
}

/** The angular distance (shortest way around the circle) between two
 * angles in radians. */
function angularDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % (Math.PI * 2);
  return Math.min(raw, Math.PI * 2 - raw);
}

describe("computeSeatLayout DM placement", () => {
  it("always seats the DM at the same seat index for a given party size, regardless of the DM's position in the input array, within π/n of the true far side", () => {
    // At odd n, two seat indices can be exactly tied for closest to the far
    // side (e.g. n=3's indices 1 and 2 are both π/3 off) — seating.ts's
    // Math.round(n/2) % n resolves that tie deterministically one way, but
    // which way isn't this test's concern. What matters is (a) EVERY input
    // position for a given n lands the DM on the exact same seat index —
    // proving the reordering doesn't depend on where the DM starts — and
    // (b) that shared index is genuinely close to the far side (within
    // π/n), not some unrelated seat.
    for (const n of [2, 3, 5, 6, 7, 8]) {
      const candidatePositions = new Set([0, Math.floor(n / 2), n - 1]);
      let referenceIndex: number | null = null;
      for (const dmPosition of candidatePositions) {
        const members = makeMembersWithDmAt(n, dmPosition);
        const seats = computeSeatLayout(members);
        const dmSeatIndex = seats.findIndex((seat) => seat.member.role === "dm");
        expect(seats[dmSeatIndex].member.user_id).toBe(members[dmPosition].user_id);

        if (referenceIndex === null) {
          referenceIndex = dmSeatIndex;
        } else {
          expect(dmSeatIndex).toBe(referenceIndex);
        }

        const angle = FIRST_SEAT_ANGLE + (dmSeatIndex / n) * Math.PI * 2;
        const target = FIRST_SEAT_ANGLE + Math.PI;
        expect(angularDistance(angle, target)).toBeLessThanOrEqual(Math.PI / n + 1e-9);
      }
    }
  });

  it("seats the DM exactly opposite the sole player at n=2", () => {
    const seats = computeSeatLayout(makeMembersWithDmAt(2, 0));
    const dmSeat = seats.find((seat) => seat.member.role === "dm");
    const playerSeat = seats.find((seat) => seat.member.role === "player");
    expect(dmSeat).toBeDefined();
    expect(playerSeat).toBeDefined();
    // At n=2 the two seats' angles differ by exactly π, so each position
    // component negates exactly — true regardless of the ellipse's
    // (possibly unequal) x/z scale factors, since cos/sin both flip sign
    // under a π shift.
    expect(dmSeat!.position[0]).toBeCloseTo(-playerSeat!.position[0], 5);
    expect(dmSeat!.position[2]).toBeCloseTo(-playerSeat!.position[2], 5);
  });

  it("fills the remaining seats with players in their original relative order", () => {
    const n = 6;
    const dmPosition = 2;
    const members = makeMembersWithDmAt(n, dmPosition);
    const seats = computeSeatLayout(members);

    const seatedPlayerIds = seats.filter((s) => s.member.role === "player").map((s) => s.member.user_id);
    const expectedOrder = members.filter((m) => m.role === "player").map((m) => m.user_id);
    expect(seatedPlayerIds).toEqual(expectedOrder);
  });

  it("is a no-op for a solo DM", () => {
    const members = makeMembersWithDmAt(1, 0);
    const seats = computeSeatLayout(members);
    expect(seats).toHaveLength(1);
    expect(seats[0].member).toBe(members[0]);
  });
});

describe("computeSeatLayout", () => {
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

  // Prompt: doubling the table along its long edge. computeSeatLayout's
  // default `table` param is now COMBINED_TABLE_TOP (the two-table
  // footprint), not a single table's — these two tests are the direct
  // acceptance check that the ellipse actually fits the FULL combined
  // surface by default, not just a single table's worth of it.
  it("keeps seats outside the COMBINED two-table footprint by default (no explicit table arg)", () => {
    for (const count of [1, 2, 3, 5, 8]) {
      for (const seat of computeSeatLayout(makeMembers(count))) {
        const [x, , z] = seat.position;
        const insideCombinedTable =
          Math.abs(x) < COMBINED_TABLE.width / 2 && Math.abs(z) < COMBINED_TABLE.depth / 2;
        expect(insideCombinedTable).toBe(false);
      }
    }
  });

  it("spreads seats across the full combined perimeter, not clustered as if only one table existed", () => {
    // A seat computed against the default (combined) footprint must sit
    // meaningfully further from center, on the now-much-longer depth axis,
    // than the SAME seat computed against a single table's footprint would
    // — proving the ellipse genuinely grew with the second table rather
    // than silently still fitting just the first one.
    const { semiZ: combinedSemiZ } = seatEllipseSemiAxes(COMBINED_TABLE);
    const { semiZ: singleSemiZ } = seatEllipseSemiAxes(TABLE);
    expect(combinedSemiZ).toBeGreaterThan(singleSemiZ * 1.5);

    // n=2's two seats sit exactly on the depth axis (FIRST_SEAT_ANGLE is
    // π/2, and computeSeatLayout's DM placement puts the other seat exactly
    // opposite it at n=2) — the axis combined depth actually stretched
    // along — so their distance from center should match combinedSemiZ
    // exactly, not the single table's much shorter one.
    const seats = computeSeatLayout(makeMembers(2));
    for (const seat of seats) {
      const dist = Math.hypot(seat.position[0], seat.position[2]);
      expect(dist).toBeCloseTo(combinedSemiZ, 5);
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
