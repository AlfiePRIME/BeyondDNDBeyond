import { describe, expect, it } from "vitest";
import { computeSeatLayout, seatEllipseSemiAxes, type SeatMember } from "@/scene-3d";
import { COMBINED_TABLE_TOP, TABLE_TOP, singleTableOffsetZ } from "./table";
import {
  computeCampaignSeatLayout,
  HEAD_SQUARE_SEAT_CAPACITY,
  SINGLE_TABLE_SEAT_CAPACITY,
  PLAYER_CHAIR_FRONTAGE,
  DM_CHAIR_FRONTAGE,
} from "./seating";

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

// Dynamic table capacity: the head square (COMBINED_TABLE_TOP) is always
// present; once a party outgrows it, plain single tables (TABLE_TOP) get
// appended one at a time beside it (computeCampaignSeatLayout). The five
// example party sizes the acceptance criteria names explicitly.
const REQUIRED_PARTY_SIZES = [1, 2, 4, 6, 10];

/** The minimum non-overlapping center-to-center distance for two chairs —
 * half of each one's own real, measured frontage, summed. Mirrors
 * maxSeatCapacity's own internal check (seating.ts), against the exact same
 * exported frontage constants that drove HEAD_SQUARE_SEAT_CAPACITY/
 * SINGLE_TABLE_SEAT_CAPACITY's own derivation — so this test can never
 * silently drift from the numbers the production capacity figures actually
 * came from. */
function requiredSpacing(aIsDm: boolean, bIsDm: boolean): number {
  const frontage = (isDm: boolean) => (isDm ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE);
  return frontage(aIsDm) / 2 + frontage(bIsDm) / 2;
}

/** Every ADJACENT pair of seats around a single table's own ring (seats
 * already sorted by angle, which computeSeatLayout's per-index formula
 * guarantees) must clear requiredSpacing — the same "don't visually
 * collide" check the capacity numbers themselves were derived from,
 * replayed here against a table's actual seat OUTPUT rather than the
 * abstract per-n formula. */
function expectNoAdjacentCollisions(seats: { member: { role: string }; position: readonly [number, number, number] }[]) {
  const n = seats.length;
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = seats[i];
    const b = seats[j];
    const dist = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
    const required = requiredSpacing(a.member.role === "dm", b.member.role === "dm");
    expect(dist).toBeGreaterThanOrEqual(required - 1e-9);
  }
}

describe("computeCampaignSeatLayout", () => {
  it.each(REQUIRED_PARTY_SIZES)(
    "keeps a party of %i entirely on the head square, identical to computeSeatLayout's own single-table output",
    (n) => {
      const members = makeMembers(n);
      const { appendedTables, seats } = computeCampaignSeatLayout(members);
      expect(appendedTables).toHaveLength(0);
      expect(seats.every((s) => s.tableIndex === -1)).toBe(true);
      // toMatchObject, not toEqual: `seats` carries an extra tableIndex tag
      // computeSeatLayout's own plain output doesn't have.
      expect(seats).toMatchObject(computeSeatLayout(members, COMBINED_TABLE_TOP));
    }
  );

  it.each(REQUIRED_PARTY_SIZES)("has no colliding adjacent chairs at a party of %i", (n) => {
    const { seats } = computeCampaignSeatLayout(makeMembers(n));
    expectNoAdjacentCollisions(seats);
  });

  it.each(REQUIRED_PARTY_SIZES)("seats exactly one DM at a party of %i, and no one else", (n) => {
    const { seats } = computeCampaignSeatLayout(makeMembers(n));
    expect(seats.filter((s) => s.member.role === "dm")).toHaveLength(1);
    expect(seats).toHaveLength(n);
  });

  it("stays on exactly one table (the head square) right up to HEAD_SQUARE_SEAT_CAPACITY", () => {
    const { appendedTables } = computeCampaignSeatLayout(makeMembers(HEAD_SQUARE_SEAT_CAPACITY));
    expect(appendedTables).toHaveLength(0);
  });

  it("appends exactly one single table the moment the party exceeds HEAD_SQUARE_SEAT_CAPACITY", () => {
    const { appendedTables, seats } = computeCampaignSeatLayout(makeMembers(HEAD_SQUARE_SEAT_CAPACITY + 1));
    expect(appendedTables).toHaveLength(1);
    expect(appendedTables[0]).toEqual({ index: 0, offsetZ: singleTableOffsetZ(0) });
    // Exactly one member (the overflow) lands at the new table; everyone
    // else stays on the head square.
    const overflowCount = seats.filter((s) => s.tableIndex === 0).length;
    expect(overflowCount).toBe(1);
    expectNoAdjacentCollisions(seats.filter((s) => s.tableIndex === -1));
    expectNoAdjacentCollisions(seats.filter((s) => s.tableIndex === 0));
  });

  it("fills the first appended table up to SINGLE_TABLE_SEAT_CAPACITY before a second one appears", () => {
    const atCapacity = computeCampaignSeatLayout(
      makeMembers(HEAD_SQUARE_SEAT_CAPACITY + SINGLE_TABLE_SEAT_CAPACITY)
    );
    expect(atCapacity.appendedTables).toHaveLength(1);

    const overflowing = computeCampaignSeatLayout(
      makeMembers(HEAD_SQUARE_SEAT_CAPACITY + SINGLE_TABLE_SEAT_CAPACITY + 1)
    );
    expect(overflowing.appendedTables).toHaveLength(2);
    expect(overflowing.appendedTables[1]).toEqual({ index: 1, offsetZ: singleTableOffsetZ(1) });
  });

  it("keeps appending single tables (never another two-table head square) for a very large party, each with no colliding chairs", () => {
    const n = HEAD_SQUARE_SEAT_CAPACITY + SINGLE_TABLE_SEAT_CAPACITY * 3 + 4;
    const { appendedTables, seats } = computeCampaignSeatLayout(makeMembers(n));
    expect(appendedTables).toHaveLength(4);
    appendedTables.forEach((table, i) => {
      expect(table).toEqual({ index: i, offsetZ: singleTableOffsetZ(i) });
    });
    for (let tableIndex = -1; tableIndex < appendedTables.length; tableIndex++) {
      const tableSeats = seats.filter((s) => s.tableIndex === tableIndex);
      expect(tableSeats.length).toBeGreaterThan(0);
      expectNoAdjacentCollisions(tableSeats);
    }
    // No appended table ever seats the DM — the DM is always on the head
    // square (tableIndex -1).
    expect(seats.find((s) => s.member.role === "dm")!.tableIndex).toBe(-1);
  });

  it("keeps the DM (and every member the head square can hold) pinned to the exact same head-square seats computeSeatLayout would produce, however many tables get appended beyond it", () => {
    for (const n of [
      HEAD_SQUARE_SEAT_CAPACITY,
      HEAD_SQUARE_SEAT_CAPACITY + 1,
      HEAD_SQUARE_SEAT_CAPACITY + SINGLE_TABLE_SEAT_CAPACITY + 3,
      HEAD_SQUARE_SEAT_CAPACITY + SINGLE_TABLE_SEAT_CAPACITY * 2 + 7,
    ]) {
      const members = makeMembers(n); // DM at user-0, players at user-1..user-(n-1)
      const { seats } = computeCampaignSeatLayout(members);
      const expectedHeadMembers = [members[0], ...members.slice(1, HEAD_SQUARE_SEAT_CAPACITY)];
      const expectedHeadSeats = computeSeatLayout(expectedHeadMembers, COMBINED_TABLE_TOP);
      for (const expected of expectedHeadSeats) {
        const actual = seats.find((s) => s.member.user_id === expected.member.user_id);
        expect(actual?.tableIndex).toBe(-1);
        expect(actual).toMatchObject(expected);
      }
      // In particular, the DM specifically:
      const dmSeat = seats.find((s) => s.member.role === "dm");
      const expectedDmSeat = expectedHeadSeats.find((s) => s.member.role === "dm");
      expect(dmSeat).toMatchObject(expectedDmSeat!);
    }
  });

  it("never moves an already-seated member to a different table as the party grows, from a solo DM up through several fully-populated appended tables", () => {
    const maxN = HEAD_SQUARE_SEAT_CAPACITY + SINGLE_TABLE_SEAT_CAPACITY * 2 + 5;
    let previous = computeCampaignSeatLayout(makeMembers(1));
    for (let n = 2; n <= maxN; n++) {
      const members = makeMembers(n);
      const current = computeCampaignSeatLayout(members);
      // Every member present at the smaller size (n - 1) must resolve to
      // the exact same table now that one more member has joined.
      for (let i = 0; i < n - 1; i++) {
        const userId = `user-${i}`;
        const previousSeat = previous.seats.find((s) => s.member.user_id === userId)!;
        const currentSeat = current.seats.find((s) => s.member.user_id === userId)!;
        expect(currentSeat.tableIndex).toBe(previousSeat.tableIndex);
      }
      previous = current;
    }
  });

  it("is deterministic for the same input", () => {
    const members = makeMembers(HEAD_SQUARE_SEAT_CAPACITY + SINGLE_TABLE_SEAT_CAPACITY + 3);
    expect(computeCampaignSeatLayout(members)).toEqual(computeCampaignSeatLayout(members));
  });

  it("is a no-op single-head-square layout for an empty member list", () => {
    const { appendedTables, seats } = computeCampaignSeatLayout([]);
    expect(appendedTables).toHaveLength(0);
    expect(seats).toHaveLength(0);
  });
});

describe("HEAD_SQUARE_SEAT_CAPACITY / SINGLE_TABLE_SEAT_CAPACITY", () => {
  it("are derived from the real measured chair frontage, not guessed round numbers", () => {
    // Regression guard on the derivation itself: if table.ts's geometry or
    // seating.ts's SEAT_MARGIN/ellipse fit ever changes, these numbers
    // should move with them rather than silently staying stale — this
    // pins today's real, derived values so any such drift is visible in a
    // diff rather than discovered later.
    expect(HEAD_SQUARE_SEAT_CAPACITY).toBe(24);
    // 8, not anywhere near HEAD_SQUARE_SEAT_CAPACITY's own 24 — an
    // appended table only has its two short end-caps free (its long edges
    // are exactly where it joins its neighbor(s) in the row —
    // APPENDED_TABLE_ENDCAP_HALF_WIDTH_DEG's own doc comment), so it was
    // never going to seat anywhere near as many people as the head
    // square's own full, unobstructed perimeter.
    expect(SINGLE_TABLE_SEAT_CAPACITY).toBe(8);
  });

  it("HEAD_SQUARE_SEAT_CAPACITY dramatically exceeds a realistic real-world game table's seating (a documented, verified consequence of this scene's own existing geometry, not a bug)", () => {
    expect(HEAD_SQUARE_SEAT_CAPACITY).toBeGreaterThan(10);
  });

  it("SINGLE_TABLE_SEAT_CAPACITY is a small, plausible number of seats for one table's two free end-caps", () => {
    expect(SINGLE_TABLE_SEAT_CAPACITY).toBeGreaterThan(0);
    expect(SINGLE_TABLE_SEAT_CAPACITY).toBeLessThan(HEAD_SQUARE_SEAT_CAPACITY);
  });
});

describe("computeCampaignSeatLayout — appended tables never collide with a neighboring table's chairs", () => {
  // The bug a real deployed look caught: an appended table's seats
  // originally swept its own FULL ellipse (computeSeatLayout's own
  // full-circle formula), which could land chairs on the table's long
  // edges — exactly where it joins the head square (or another appended
  // table) — close enough to collide with THAT table's own chairs. Fixed
  // by restricting appended-table seats to the two free end-cap arcs
  // (appendedTableAngles); these tests check the cross-table case
  // directly, not just within-one-table's-own-seats collisions (which the
  // "has no colliding adjacent chairs" tests above already cover, but
  // exclusively per-table — never against a NEIGHBORING table's seats).
  function requiredSpacing(aIsDm: boolean, bIsDm: boolean): number {
    const frontage = (isDm: boolean) => (isDm ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE);
    return frontage(aIsDm) / 2 + frontage(bIsDm) / 2;
  }

  function expectNoCrossTableCollisions(seatsA: ReturnType<typeof computeCampaignSeatLayout>["seats"], seatsB: typeof seatsA) {
    for (const a of seatsA) {
      for (const b of seatsB) {
        const dist = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
        const required = requiredSpacing(a.member.role === "dm", b.member.role === "dm");
        expect(dist).toBeGreaterThanOrEqual(required - 1e-9);
      }
    }
  }

  it("a single appended table's chairs never collide with the head square's, at every size from 1 seat up to the appended table's own full capacity", () => {
    for (let overflowCount = 1; overflowCount <= SINGLE_TABLE_SEAT_CAPACITY; overflowCount++) {
      const n = HEAD_SQUARE_SEAT_CAPACITY + overflowCount;
      const { seats } = computeCampaignSeatLayout(makeMembers(n));
      const headOnly = seats.filter((s) => s.tableIndex === -1);
      const table0Only = seats.filter((s) => s.tableIndex === 0);
      expect(table0Only).toHaveLength(overflowCount);
      expectNoCrossTableCollisions(headOnly, table0Only);
    }
  });

  it("an 'interior' appended table (occupied neighbors on BOTH sides, in a longer row) still never collides with either neighbor, at full capacity each", () => {
    // Three fully-populated tables in the row: the head square, then two
    // appended tables each at SINGLE_TABLE_SEAT_CAPACITY — table 0 is the
    // interior one here, sandwiched between the head square and table 1.
    const n = HEAD_SQUARE_SEAT_CAPACITY + SINGLE_TABLE_SEAT_CAPACITY * 2;
    const { seats, appendedTables } = computeCampaignSeatLayout(makeMembers(n));
    expect(appendedTables).toHaveLength(2);
    const headOnly = seats.filter((s) => s.tableIndex === -1);
    const table0Only = seats.filter((s) => s.tableIndex === 0);
    const table1Only = seats.filter((s) => s.tableIndex === 1);
    expect(table0Only).toHaveLength(SINGLE_TABLE_SEAT_CAPACITY);
    expect(table1Only).toHaveLength(SINGLE_TABLE_SEAT_CAPACITY);
    expectNoCrossTableCollisions(headOnly, table0Only);
    expectNoCrossTableCollisions(table0Only, table1Only);
    // Not adjacent, but checked anyway — cheap, and confirms the row
    // doesn't fold back on itself at three tables.
    expectNoCrossTableCollisions(headOnly, table1Only);
  });
});
