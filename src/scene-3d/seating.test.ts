import { describe, expect, it } from "vitest";
import { computeSeatLayout, seatEllipseSemiAxes, type SeatMember } from "@/scene-3d";
import { COMBINED_TABLE_TOP, TABLE_TOP, TABLE_SURFACE_Y, singleTableOffsetZ } from "./table";
import {
  computeCampaignSeatLayout,
  HEAD_SQUARE_SEAT_CAPACITY,
  SINGLE_TABLE_SEAT_CAPACITY,
  PLAYER_CHAIR_FRONTAGE,
  DM_CHAIR_FRONTAGE,
  applySeatOffset,
  getEffectiveSeat,
  computeMemberTrayPosition,
  HEAD_SQUARE_MEMBER_TRAY_FRACTION,
  APPENDED_TABLE_MEMBER_TRAY_FRACTION,
  resolveMemberTrayLayout,
  CHAIR_DRAG_CLAMP_RADIUS,
  nearestTableCenter,
  clampToTableArrangement,
  rotationYTowardNearestTable,
  resolveChairDrop,
  type SeatOffset,
  type ChairObstacle,
  type MemberTraySeed,
} from "./seating";
import { PERSONAL_TRAY_RADIUS } from "./DiceTumble";

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

  it("puts the camera in front of the seat, closer to center than the stool (not behind it)", () => {
    // Updated expectation: the project owner reported the seated camera
    // looking from BEHIND the chair (an over-the-shoulder view back past
    // the seated avatar) when it should look from IN FRONT of it, toward
    // the table — seatAtAngle's own cameraPosition formula now SUBTRACTS
    // CAMERA_FORWARD_INSET from the seat's own radial distance instead of
    // adding a setback, so camDist < seatDist is now the correct,
    // intentional relationship (see CAMERA_FORWARD_INSET's own doc comment
    // in seating.ts for the full reasoning and the real-screenshot check
    // behind these numbers).
    for (const seat of computeSeatLayout(makeMembers(3))) {
      const seatDist = Math.hypot(seat.position[0], seat.position[2]);
      const camDist = Math.hypot(seat.cameraPosition[0], seat.cameraPosition[2]);
      expect(camDist).toBeLessThan(seatDist);
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

  // Regression guard for a party shaped exactly like
  // verify-per-member-dice-trays.mjs's own overflow scenario: a DM, 3
  // already-connected players, HEAD_SQUARE_SEAT_CAPACITY - 1 (23) filler
  // players padding out the rest of the head square, and 2 more players who
  // are guaranteed to overflow onto an appended table. A prior investigation
  // into a reported "23-filler-member crash" traced the actual failure to
  // that verify script's own Playwright wait logic (a waitForSelector call
  // missing `state: "attached"` against a permanently `hidden` debug mirror
  // div, plus a second, too-weak wait condition on the overflow-tray read
  // further down) — computeCampaignSeatLayout itself never threw, produced
  // no NaN/undefined, and correctly bucketed every member, at this exact
  // party size or its neighbors. These three sizes (one below, at, and one
  // above the real reported scenario) pin that finding down permanently.
  describe("a party shaped like verify-per-member-dice-trays.mjs's own 23-filler overflow scenario", () => {
    function makeOverflowScenarioMembers(fillerCount: number): SeatMember[] {
      const named = (id: string): SeatMember => ({ user_id: id, role: "player", display_name: id });
      return [
        { user_id: "dm", role: "dm", display_name: "dm" },
        named("alice"),
        named("bob"),
        named("carol"),
        ...Array.from({ length: fillerCount }, (_, i) => named(`filler-${i}`)),
        named("dave"),
        named("erin"),
      ];
    }

    it.each([22, 23, 24])("computes a fully sane layout with %i filler members (no NaN/undefined, no overlap, dave/erin on the same appended table)", (fillerCount) => {
      const members = makeOverflowScenarioMembers(fillerCount);
      const { appendedTables, seats } = computeCampaignSeatLayout(members);

      expect(seats).toHaveLength(members.length);
      for (const seat of seats) {
        expect(Number.isFinite(seat.position[0])).toBe(true);
        expect(Number.isFinite(seat.position[1])).toBe(true);
        expect(Number.isFinite(seat.position[2])).toBe(true);
        expect(Number.isFinite(seat.rotationY)).toBe(true);
        expect(Number.isFinite(seat.cameraPosition[0])).toBe(true);
        expect(Number.isFinite(seat.cameraPosition[1])).toBe(true);
        expect(Number.isFinite(seat.cameraPosition[2])).toBe(true);
      }
      expect(seats.filter((s) => s.member.role === "dm")).toHaveLength(1);

      for (let tableIndex = -1; tableIndex < appendedTables.length; tableIndex++) {
        expectNoAdjacentCollisions(seats.filter((s) => s.tableIndex === tableIndex));
      }

      // dave/erin (the last 2 joiners) are exactly the two players who
      // overflow past the head square, given HEAD_SQUARE_SEAT_CAPACITY (24)
      // minus the DM's own seat (23) already fully consumed by
      // alice/bob/carol plus this many fillers.
      const dave = seats.find((s) => s.member.user_id === "dave")!;
      const erin = seats.find((s) => s.member.user_id === "erin")!;
      expect(dave.tableIndex).toBe(0);
      expect(erin.tableIndex).toBe(0);
    });
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

/** Finds a seat by member.user_id, throwing (not returning undefined) on a
 * miss — every test below expects the id it looks up to actually be
 * present, and a thrown error at the lookup site is a much clearer failure
 * than a later "Cannot read properties of undefined". */
function findSeatByUserId(seats: ReturnType<typeof computeCampaignSeatLayout>["seats"], userId: string) {
  const seat = seats.find((s) => s.member.user_id === userId);
  if (!seat) throw new Error(`no seat found for ${userId}`);
  return seat;
}

/**
 * Builds a real, anchor-carrying SeatOffset the way a genuine chair drag
 * actually persists one now (GameRoom.tsx's handleChairDragEnd /
 * GameTableScene.tsx's live-drag construction — both stamp in baseX/baseZ/
 * baseRotationY from the seat's own default at capture time, the "DM chair
 * floats off the table after a new member joins" bug fix) — anchored
 * against whichever seat the caller passes, so applySeatOffset's own
 * "anchor still matches" fast path applies `delta` completely unmodified,
 * exactly the pre-fix behavior, for every test below that isn't
 * specifically about a STALE anchor.
 */
function offsetFor(
  seat: { position: readonly [number, number, number]; rotationY: number },
  delta: { dx: number; dz: number; dRotationY: number }
): SeatOffset {
  return { ...delta, baseX: seat.position[0], baseZ: seat.position[2], baseRotationY: seat.rotationY };
}

describe("applySeatOffset", () => {
  it("returns the seat completely unchanged when there is no override (null or undefined)", () => {
    const { seats } = computeCampaignSeatLayout(makeMembers(4));
    const seat = seats[0];
    expect(applySeatOffset(seat, null)).toEqual(seat);
    expect(applySeatOffset(seat, undefined)).toEqual(seat);
  });

  it("applies the offset's dx/dz to both position and cameraPosition, and dRotationY to rotationY, when the stored anchor still matches the seat's current default", () => {
    const { seats } = computeCampaignSeatLayout(makeMembers(4));
    const seat = seats[0];
    const offset = offsetFor(seat, { dx: 0.4, dz: -0.2, dRotationY: 0.15 });
    const effective = applySeatOffset(seat, offset);

    expect(effective.position).toEqual([seat.position[0] + offset.dx, seat.position[1], seat.position[2] + offset.dz]);
    expect(effective.rotationY).toBeCloseTo(seat.rotationY + offset.dRotationY);
    expect(effective.cameraPosition).toEqual([
      seat.cameraPosition[0] + offset.dx,
      seat.cameraPosition[1],
      seat.cameraPosition[2] + offset.dz,
    ]);
  });

  it("preserves every other field on the seat (member identity, tableIndex) untouched", () => {
    const { seats } = computeCampaignSeatLayout(makeMembers(HEAD_SQUARE_SEAT_CAPACITY + 1));
    const seat = seats.find((s) => s.tableIndex === 0)!;
    const offset = offsetFor(seat, { dx: 0.4, dz: -0.2, dRotationY: 0.15 });
    const effective = applySeatOffset(seat, offset);
    expect(effective.member).toBe(seat.member);
    expect(effective.tableIndex).toBe(seat.tableIndex);
  });

  // Bug report: "I have added another user to test the game and the DM
  // chair is now not in the right place" (a screenshot showed a seated
  // chair thrown off the table's own seating ellipse entirely — "elevated
  // above and behind the table... not touching it at all" — right after a
  // new member joined a smaller party). Root-caused to this exact function
  // blindly re-adding a persisted WORLD-FRAME (dx, dz) delta to whatever
  // computeCampaignSeatLayout's default happens to be NOW, with no check
  // that it's still the same default the delta was ever calibrated
  // against. A seat's own default reshapes (rotates around its table's
  // ellipse, sometimes by tens of degrees — placeDmAtNorthSlot/
  // dmSeatIndex's own doc comments) every time the roster's composition
  // changes for ANYONE sharing that seat's table bucket, not only when a
  // table is literally appended — so a stale delta calibrated against a
  // now-rotated-away default can point in a direction with no remaining
  // relationship to the seat, throwing it meaningfully off the ellipse. The
  // two tests below are this fix's own direct regression coverage.
  it("ignores a legacy offset with no anchor at all (a pre-fix database row) — treated as no override rather than blindly re-applied", () => {
    const { seats } = computeCampaignSeatLayout(makeMembers(4));
    const seat = seats[0];
    const legacyOffset = { dx: 0.4, dz: -0.2, dRotationY: 0.15 } as SeatOffset; // 0044's original shape, pre-anchor
    expect(applySeatOffset(seat, legacyOffset)).toEqual(seat);
  });

  it("recomputes (rotates) the offset instead of blindly re-applying it once the seat's own default has moved since it was captured", () => {
    // user-2 — not the very first joiner (FIRST_SEAT_ANGLE's own doc
    // comment: the first joiner's own seat index, and therefore angle,
    // never moves for any party size) — at a party size that grows enough
    // to meaningfully rotate this seat's own default around the head
    // square's ellipse.
    const before = computeCampaignSeatLayout(makeMembers(3));
    const after = computeCampaignSeatLayout(makeMembers(6));
    const seatBefore = findSeatByUserId(before.seats, "user-2");
    const seatAfter = findSeatByUserId(after.seats, "user-2");
    expect(seatAfter.position).not.toEqual(seatBefore.position); // the default genuinely moved

    const rawDelta = { dx: 1.1, dz: -0.6, dRotationY: 0 };
    const offset = offsetFor(seatBefore, rawDelta);
    const effective = applySeatOffset(seatAfter, offset);
    const appliedDx = effective.position[0] - seatAfter.position[0];
    const appliedDz = effective.position[2] - seatAfter.position[2];

    // Magnitude preserved — a pure rotation of the original delta.
    expect(Math.hypot(appliedDx, appliedDz)).toBeCloseTo(Math.hypot(rawDelta.dx, rawDelta.dz));

    // Re-derived independently from first principles (plain trig, not
    // seating.ts's own private rotation helper): rotate the original delta
    // by exactly how much this seat's own rotationY changed between the
    // two party sizes — "the same relationship to my own seat", the
    // property this fix is meant to preserve, rather than a raw world-frame
    // vector blindly re-added to a since-rotated base.
    const angleDelta = seatAfter.rotationY - seatBefore.rotationY;
    expect(Math.abs(angleDelta)).toBeGreaterThan(0.2); // a real, meaningful rotation — not a no-op case
    const expectedDx = rawDelta.dx * Math.cos(angleDelta) + rawDelta.dz * Math.sin(angleDelta);
    const expectedDz = rawDelta.dz * Math.cos(angleDelta) - rawDelta.dx * Math.sin(angleDelta);
    expect(appliedDx).toBeCloseTo(expectedDx);
    expect(appliedDz).toBeCloseTo(expectedDz);

    // And genuinely NOT the old (buggy) behavior — the raw delta blindly
    // re-added to the new default, unrotated.
    expect(Math.abs(appliedDx - rawDelta.dx)).toBeGreaterThan(0.1);
  });

  it("applies the offset completely unmodified (byte-for-byte the pre-fix behavior) when the seat's own default hasn't moved at all since it was captured", () => {
    const { seats } = computeCampaignSeatLayout(makeMembers(5));
    const seat = seats[2];
    const rawDelta = { dx: 0.4, dz: -0.2, dRotationY: 0.15 };
    const offset = offsetFor(seat, rawDelta);
    const effective = applySeatOffset(seat, offset);
    expect(effective.position).toEqual([seat.position[0] + rawDelta.dx, seat.position[1], seat.position[2] + rawDelta.dz]);
  });
});

describe("getEffectiveSeat", () => {
  it("equals computeCampaignSeatLayout's own default when no override is stored for that member", () => {
    const layout = computeCampaignSeatLayout(makeMembers(5));
    const userId = layout.seats[2].member.user_id;
    expect(getEffectiveSeat(layout, userId, new Map())).toEqual(layout.seats[2]);
  });

  it("applies a stored override on top of that member's default seat", () => {
    const layout = computeCampaignSeatLayout(makeMembers(5));
    const userId = layout.seats[2].member.user_id;
    const offset = offsetFor(layout.seats[2], { dx: 0.4, dz: -0.2, dRotationY: 0.15 });
    const offsets = new Map([[userId, offset]]);
    expect(getEffectiveSeat(layout, userId, offsets)).toEqual(applySeatOffset(layout.seats[2], offset));
  });

  it("returns null for a user_id not present in the layout at all", () => {
    const layout = computeCampaignSeatLayout(makeMembers(4));
    expect(getEffectiveSeat(layout, "not-a-member", new Map())).toBeNull();
  });
});

describe("effective position tracks a reshaped default instead of going stale", () => {
  it("stays correct (via the rotation-aware recompute) as the head square's own ring re-spaces its seats (party growing, table capacity untouched)", () => {
    // user-2 (a player, not the DM, and deliberately not the very first
    // joiner — placeDmAtNorthSlot's own construction pins the first
    // joiner's seat index, and therefore angle, at 0 for every party size,
    // by design, per FIRST_SEAT_ANGLE's own doc comment, so it wouldn't
    // demonstrate a reshaped default here) is seated at the head square at
    // both party sizes — well under HEAD_SQUARE_SEAT_CAPACITY either time —
    // but computeSeatLayout spaces a table's seats evenly by CURRENT
    // occupant count, so this member's own default angle (and therefore
    // position) is NOT the same before and after growth: the default
    // itself moved.
    const before = computeCampaignSeatLayout(makeMembers(3));
    const after = computeCampaignSeatLayout(makeMembers(6));
    const seatBefore = findSeatByUserId(before.seats, "user-2");
    const seatAfter = findSeatByUserId(after.seats, "user-2");

    expect(seatAfter.tableIndex).toBe(seatBefore.tableIndex); // still the head square (-1)
    expect(seatAfter.position).not.toEqual(seatBefore.position); // the default genuinely moved

    const rawDelta = { dx: 0.4, dz: -0.2, dRotationY: 0.15 };
    const offset = offsetFor(seatBefore, rawDelta);
    const effectiveBefore = applySeatOffset(seatBefore, offset);
    const effectiveAfter = applySeatOffset(seatAfter, offset);

    // Not stale — the effective position after growth is still derived
    // from the NEW default, not the OLD effective position left sitting
    // wherever it used to be — but ALSO not the pre-fix bug's own naive
    // translation: the delta is rotated to match how much this seat's own
    // orientation changed, so it keeps the SAME magnitude and the SAME
    // relationship to the seat (e.g. "scooted back a bit") rather than
    // pointing in a world-frame direction that stopped meaning anything the
    // moment the seat swung to a different point on the ellipse.
    expect(effectiveAfter.position).not.toEqual(effectiveBefore.position);
    const appliedDx = effectiveAfter.position[0] - seatAfter.position[0];
    const appliedDz = effectiveAfter.position[2] - seatAfter.position[2];
    expect(Math.hypot(appliedDx, appliedDz)).toBeCloseTo(Math.hypot(rawDelta.dx, rawDelta.dz));
  });

  it("stays correct (via the rotation-aware recompute) as a table gets appended and its own ring grows (party crossing HEAD_SQUARE_SEAT_CAPACITY)", () => {
    // The first three overflow members (index HEAD_SQUARE_SEAT_CAPACITY,
    // +1, +2 in the joined_at order) all land at appended table 0 once the
    // party is this large. At exactly one overflow member, that lone
    // member sits alone at that table's angle-0 end-cap; growing to three
    // overflow members splits the two end-caps 2/1 (appendedTableAngles'
    // own ceil(n/2) split), moving the FIRST overflow member's own angle
    // off of plain 0 — a real default reshape driven by a table actually
    // being appended/growing, not just an existing ring re-spacing.
    const firstOverflowUserId = makeMembers(HEAD_SQUARE_SEAT_CAPACITY + 1)[HEAD_SQUARE_SEAT_CAPACITY].user_id;
    const before = computeCampaignSeatLayout(makeMembers(HEAD_SQUARE_SEAT_CAPACITY + 1));
    const after = computeCampaignSeatLayout(makeMembers(HEAD_SQUARE_SEAT_CAPACITY + 3));

    const seatBefore = findSeatByUserId(before.seats, firstOverflowUserId);
    const seatAfter = findSeatByUserId(after.seats, firstOverflowUserId);

    expect(seatBefore.tableIndex).toBe(0);
    expect(seatAfter.tableIndex).toBe(0); // same appended table both times — append-only bucketing
    expect(seatAfter.position).not.toEqual(seatBefore.position); // this table's own ring reshaped

    const rawDelta = { dx: 0.4, dz: -0.2, dRotationY: 0.15 };
    const offset = offsetFor(seatBefore, rawDelta);
    const effectiveBefore = applySeatOffset(seatBefore, offset);
    const effectiveAfter = applySeatOffset(seatAfter, offset);

    expect(effectiveAfter.position).not.toEqual(effectiveBefore.position);
    const appliedDx = effectiveAfter.position[0] - seatAfter.position[0];
    const appliedDz = effectiveAfter.position[2] - seatAfter.position[2];
    expect(Math.hypot(appliedDx, appliedDz)).toBeCloseTo(Math.hypot(rawDelta.dx, rawDelta.dz));
  });

  it("keeps a promoted-to-DM member's leftover player-era offset from ever landing on the DM's throne — transfer_dm updates only role, never seat_offset, so this is the same 'stale anchor' guard covering that path for free", () => {
    // Simulates a DM-transfer: user-1 was a plain player (their own seat's
    // default anchored the offset below), then became the DM — a
    // completely different index/angle/chair (placeDmAtNorthSlot always
    // pulls the DM out to its own north-ish slot), all done by
    // transfer_dm's own plain `update ... set role = ...`
    // (0006_dm_transfer.sql) with no seat_offset column involved at all.
    const asPlayer = computeCampaignSeatLayout(makeMembers(5)); // user-1 is a player here
    const seatAsPlayer = findSeatByUserId(asPlayer.seats, "user-1");
    const offset = offsetFor(seatAsPlayer, { dx: 2.5, dz: 1.8, dRotationY: 0 }); // a real, sizeable drag

    const membersAfterTransfer = makeMembers(5).map((m) =>
      m.user_id === "user-1" ? { ...m, role: "dm" as const } : m.user_id === "user-0" ? { ...m, role: "player" as const } : m
    );
    const afterTransfer = computeCampaignSeatLayout(membersAfterTransfer);
    const seatAsDm = findSeatByUserId(afterTransfer.seats, "user-1");
    expect(seatAsDm.member.role).toBe("dm");
    expect(seatAsDm.position).not.toEqual(seatAsPlayer.position); // a genuinely different chair/seat now

    const effective = applySeatOffset(seatAsDm, offset);
    // Rotated to the new (DM) default, not blindly re-added — the same
    // magnitude-preserving guarantee as the party-growth cases above, which
    // keeps this on/near the DM's own real seating ellipse instead of
    // thrown off by a delta calibrated against a completely different
    // former chair.
    const appliedDx = effective.position[0] - seatAsDm.position[0];
    const appliedDz = effective.position[2] - seatAsDm.position[2];
    expect(Math.hypot(appliedDx, appliedDz)).toBeCloseTo(Math.hypot(offset.dx, offset.dz));
  });
});

// Prompt 8a: the per-member dice-tray-position data layer (no rendering —
// Prompt 8b's concern). computeMemberTrayPosition is a pure function of
// (layout, userId, offsets), so every case below re-derives its own
// expected value from first principles (the outward-from-center formula,
// not the function's own internals) rather than asserting against a
// hand-copied literal that could silently drift from the real formula.
describe("computeMemberTrayPosition", () => {
  /** Replicates the fraction-of-the-way-from-center formula independently
   * of seating.ts's own internals, so these assertions actually check the
   * formula rather than just calling it twice. */
  function expectedTrayPosition(
    seatPosition: readonly [number, number, number],
    center: readonly [number, number] = [0, 0],
    fraction: number = HEAD_SQUARE_MEMBER_TRAY_FRACTION
  ): [number, number, number] {
    return [
      center[0] + (seatPosition[0] - center[0]) * fraction,
      TABLE_SURFACE_Y + 0.01,
      center[1] + (seatPosition[2] - center[1]) * fraction,
    ];
  }

  it("returns null for a user_id not present in the layout at all", () => {
    const layout = computeCampaignSeatLayout(makeMembers(4));
    expect(computeMemberTrayPosition(layout, "not-a-member", new Map())).toBeNull();
  });

  it("sits at HEAD_SQUARE_MEMBER_TRAY_FRACTION of the way from the world origin toward a head-square member's own default seat", () => {
    const layout = computeCampaignSeatLayout(makeMembers(4));
    const userId = layout.seats[1].member.user_id;
    const seat = findSeatByUserId(layout.seats, userId);
    expect(seat.tableIndex).toBe(-1); // the head square

    const position = computeMemberTrayPosition(layout, userId, new Map());
    expect(position).not.toBeNull();
    const [x, y, z] = position!;
    expect(y).toBeCloseTo(TABLE_SURFACE_Y + 0.01);
    expect(Math.hypot(x, z)).toBeCloseTo(
      Math.hypot(seat.position[0], seat.position[2]) * HEAD_SQUARE_MEMBER_TRAY_FRACTION
    );
    expect(position).toEqual(expectedTrayPosition(seat.position));
  });

  it("stays within the physical head-square tabletop for every seat angle — never past the real table edge", () => {
    // The per-axis bound this file's own doc comment on
    // HEAD_SQUARE_MEMBER_TRAY_FRACTION relies on: |x| ≤ fraction × semiX and
    // |z| ≤ fraction × semiZ for EVERY angle (|cosθ|, |sinθ| ≤ 1), checked
    // here against a large sweep of party sizes rather than trusted by
    // algebra alone.
    for (let n = 2; n <= 16; n++) {
      const layout = computeCampaignSeatLayout(makeMembers(n));
      for (const seat of layout.seats.filter((s) => s.tableIndex === -1)) {
        const position = computeMemberTrayPosition(layout, seat.member.user_id, new Map())!;
        expect(Math.abs(position[0])).toBeLessThan(COMBINED_TABLE.width / 2 - PERSONAL_TRAY_RADIUS);
        expect(Math.abs(position[2])).toBeLessThan(COMBINED_TABLE.depth / 2 - PERSONAL_TRAY_RADIUS);
      }
    }
  });

  it("matches the DM's own private tray for the DM's seat specifically (the exact case GameRoom.tsx's dmPrivateTrayPosition already covers)", () => {
    const layout = computeCampaignSeatLayout(makeMembers(5));
    const dmSeat = layout.seats.find((s) => s.member.role === "dm")!;
    const position = computeMemberTrayPosition(layout, dmSeat.member.user_id, new Map());
    expect(position).toEqual(expectedTrayPosition(dmSeat.position));
  });

  it("tracks a stored seat offset: writing an offset moves the derived tray position accordingly", () => {
    const layout = computeCampaignSeatLayout(makeMembers(5));
    const userId = layout.seats[2].member.user_id;
    const offset = offsetFor(layout.seats[2], { dx: 0.4, dz: -0.2, dRotationY: 0.15 });

    const withoutOffset = computeMemberTrayPosition(layout, userId, new Map());
    const withOffset = computeMemberTrayPosition(layout, userId, new Map([[userId, offset]]));

    expect(withoutOffset).not.toBeNull();
    expect(withOffset).not.toBeNull();
    // A real move, not a no-op.
    expect(withOffset).not.toEqual(withoutOffset);

    // And it moves to EXACTLY where the offset-applied effective seat
    // predicts, not just "somewhere different".
    const effectiveSeat = getEffectiveSeat(layout, userId, new Map([[userId, offset]]));
    expect(withOffset).toEqual(expectedTrayPosition(effectiveSeat!.position));
  });

  it("clearing a stored offset (back to null) moves the tray back to the un-offset default", () => {
    const layout = computeCampaignSeatLayout(makeMembers(5));
    const userId = layout.seats[2].member.user_id;
    const offset = offsetFor(layout.seats[2], { dx: 0.4, dz: -0.2, dRotationY: 0.15 });

    const withOffset = computeMemberTrayPosition(layout, userId, new Map([[userId, offset]]));
    const cleared = computeMemberTrayPosition(layout, userId, new Map());

    expect(cleared).not.toEqual(withOffset);
    expect(cleared).toEqual(computeMemberTrayPosition(layout, userId, new Map()));
  });

  it("offsets from the APPENDED table's own center, not the world origin, for a member seated there, using that table's own (smaller) fraction", () => {
    const n = HEAD_SQUARE_SEAT_CAPACITY + 2;
    const layout = computeCampaignSeatLayout(makeMembers(n));
    const overflowSeat = layout.seats.find((s) => s.tableIndex === 0)!;
    expect(overflowSeat.tableIndex).toBe(0);

    const tableCenter: [number, number] = [0, singleTableOffsetZ(0)];
    const position = computeMemberTrayPosition(layout, overflowSeat.member.user_id, new Map());
    expect(position).toEqual(
      expectedTrayPosition(overflowSeat.position, tableCenter, APPENDED_TABLE_MEMBER_TRAY_FRACTION)
    );

    // Sanity: this is NOT the same as offsetting from the world origin —
    // proves the appended-table branch is actually exercised, not
    // accidentally falling back to the head-square formula.
    expect(position).not.toEqual(
      expectedTrayPosition(overflowSeat.position, [0, 0], APPENDED_TABLE_MEMBER_TRAY_FRACTION)
    );
  });

  it("stays within the physical appended-table tabletop for every end-cap seat angle", () => {
    const n = HEAD_SQUARE_SEAT_CAPACITY + SINGLE_TABLE_SEAT_CAPACITY;
    const layout = computeCampaignSeatLayout(makeMembers(n));
    const overflowSeats = layout.seats.filter((s) => s.tableIndex === 0);
    expect(overflowSeats.length).toBe(SINGLE_TABLE_SEAT_CAPACITY);
    const tableCenterZ = singleTableOffsetZ(0);
    for (const seat of overflowSeats) {
      const [x, , z] = computeMemberTrayPosition(layout, seat.member.user_id, new Map())!;
      expect(Math.abs(x)).toBeLessThan(TABLE.width / 2 - PERSONAL_TRAY_RADIUS);
      expect(Math.abs(z - tableCenterZ)).toBeLessThan(TABLE.depth / 2 - PERSONAL_TRAY_RADIUS);
    }
  });

  it("an appended-table member's tray also tracks a stored seat offset", () => {
    const n = HEAD_SQUARE_SEAT_CAPACITY + 2;
    const layout = computeCampaignSeatLayout(makeMembers(n));
    const overflowSeat = layout.seats.find((s) => s.tableIndex === 0)!;
    const userId = overflowSeat.member.user_id;
    const tableCenter: [number, number] = [0, singleTableOffsetZ(0)];
    const offset = offsetFor(overflowSeat, { dx: 0.4, dz: -0.2, dRotationY: 0.15 });

    const withoutOffset = computeMemberTrayPosition(layout, userId, new Map());
    const withOffset = computeMemberTrayPosition(layout, userId, new Map([[userId, offset]]));
    expect(withOffset).not.toEqual(withoutOffset);

    const effectiveSeat = getEffectiveSeat(layout, userId, new Map([[userId, offset]]));
    expect(withOffset).toEqual(
      expectedTrayPosition(effectiveSeat!.position, tableCenter, APPENDED_TABLE_MEMBER_TRAY_FRACTION)
    );
  });

  it("stays correct (via getEffectiveSeat's own rotation-aware recompute) as the underlying default reshapes from party growth — never stale, and never the pre-fix bug's naive translation either", () => {
    const userId = "user-2";
    const before = computeCampaignSeatLayout(makeMembers(3));
    const after = computeCampaignSeatLayout(makeMembers(6));
    const seatBefore = findSeatByUserId(before.seats, userId);

    const offsets = new Map([[userId, offsetFor(seatBefore, { dx: 0.4, dz: -0.2, dRotationY: 0.15 })]]);
    const positionBefore = computeMemberTrayPosition(before, userId, offsets);
    const positionAfter = computeMemberTrayPosition(after, userId, offsets);

    expect(positionBefore).not.toEqual(positionAfter);
    expect(positionAfter).toEqual(
      expectedTrayPosition(getEffectiveSeat(after, userId, offsets)!.position)
    );
  });
});

/** Every seated member's own real chair, as a ChairObstacle —
 * resolveMemberTrayLayout's own "avoid every real chair" obstacle list,
 * built the same way GameRoom.tsx's handleChairDragEnd already builds one
 * for resolveChairDrop. */
function chairObstaclesFor(seats: ReturnType<typeof computeCampaignSeatLayout>["seats"]): ChairObstacle[] {
  return seats.map((seat) => ({
    x: seat.position[0],
    z: seat.position[2],
    radius: (seat.member.role === "dm" ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE) / 2,
  }));
}

function minPairwiseDistance(points: readonly [number, number][]): number {
  let min = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      min = Math.min(min, Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]));
    }
  }
  return min;
}

describe("resolveMemberTrayLayout", () => {
  it("returns each seed's own ideal position unchanged when there's only one connected member (nothing to conflict with)", () => {
    const layout = computeCampaignSeatLayout(makeMembers(4));
    const seat = layout.seats[0];
    const ideal = computeMemberTrayPosition(layout, seat.member.user_id, new Map())!;
    const seeds: MemberTraySeed[] = [{ userId: seat.member.user_id, position: ideal }];
    const resolved = resolveMemberTrayLayout(seeds, PERSONAL_TRAY_RADIUS, chairObstaclesFor(layout.seats));
    expect(resolved.get(seat.member.user_id)).toEqual(ideal);
  });

  it("keeps every connected member's tray clear of every other one, for realistic party sizes at the head square", () => {
    for (let n = 2; n <= 15; n++) {
      const layout = computeCampaignSeatLayout(makeMembers(n));
      const seeds: MemberTraySeed[] = layout.seats.map((seat) => ({
        userId: seat.member.user_id,
        position: computeMemberTrayPosition(layout, seat.member.user_id, new Map())!,
      }));
      const resolved = resolveMemberTrayLayout(seeds, PERSONAL_TRAY_RADIUS, chairObstaclesFor(layout.seats));
      const points: [number, number][] = [...resolved.values()].map(([x, , z]) => [x, z]);
      const minDist = minPairwiseDistance(points);
      expect(minDist, `n=${n} minimum tray-tray distance`).toBeGreaterThanOrEqual(PERSONAL_TRAY_RADIUS * 2 - 1e-6);
    }
  });

  it("keeps every connected member's tray clear of every seated chair, including its own neighbors", () => {
    const layout = computeCampaignSeatLayout(makeMembers(8));
    const seeds: MemberTraySeed[] = layout.seats.map((seat) => ({
      userId: seat.member.user_id,
      position: computeMemberTrayPosition(layout, seat.member.user_id, new Map())!,
    }));
    const chairObstacles = chairObstaclesFor(layout.seats);
    const resolved = resolveMemberTrayLayout(seeds, PERSONAL_TRAY_RADIUS, chairObstacles);
    for (const seat of layout.seats) {
      const [tx, , tz] = resolved.get(seat.member.user_id)!;
      for (const other of layout.seats) {
        if (other.member.user_id === seat.member.user_id) continue; // a member's own chair sits behind their own tray by construction
        const otherRadius = (other.member.role === "dm" ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE) / 2;
        const dist = Math.hypot(tx - other.position[0], tz - other.position[2]);
        expect(dist).toBeGreaterThanOrEqual(PERSONAL_TRAY_RADIUS + otherRadius - 1e-6);
      }
    }
  });

  it("still resolves a modest overflow party spanning the head square and one appended table with no overlap", () => {
    // A party just past the head square's own capacity, spread across the
    // head square plus a FEW seats on the first appended table — the
    // realistic overflow shape this feature is meant to support cleanly
    // (see PERSONAL_TRAY_RADIUS/HEAD_SQUARE_MEMBER_TRAY_FRACTION/
    // APPENDED_TABLE_MEMBER_TRAY_FRACTION's own doc comments for the much
    // more extreme densities where a perfect guarantee stops holding).
    const n = HEAD_SQUARE_SEAT_CAPACITY + 3;
    const layout = computeCampaignSeatLayout(makeMembers(n));
    expect(layout.appendedTables.length).toBe(1);
    const seeds: MemberTraySeed[] = layout.seats.map((seat) => ({
      userId: seat.member.user_id,
      position: computeMemberTrayPosition(layout, seat.member.user_id, new Map())!,
    }));
    const resolved = resolveMemberTrayLayout(seeds, PERSONAL_TRAY_RADIUS, chairObstaclesFor(layout.seats));
    const points: [number, number][] = [...resolved.values()].map(([x, , z]) => [x, z]);
    expect(minPairwiseDistance(points)).toBeGreaterThanOrEqual(PERSONAL_TRAY_RADIUS * 2 - 1e-6);
  });

  it("is deterministic: the same seeds/obstacles always resolve to the exact same layout", () => {
    const layout = computeCampaignSeatLayout(makeMembers(10));
    const seeds: MemberTraySeed[] = layout.seats.map((seat) => ({
      userId: seat.member.user_id,
      position: computeMemberTrayPosition(layout, seat.member.user_id, new Map())!,
    }));
    const obstacles = chairObstaclesFor(layout.seats);
    const first = resolveMemberTrayLayout(seeds, PERSONAL_TRAY_RADIUS, obstacles);
    const second = resolveMemberTrayLayout(seeds, PERSONAL_TRAY_RADIUS, obstacles);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });
});

describe("nearestTableCenter", () => {
  it("returns the head square's own center (world origin) when there are no appended tables at all", () => {
    expect(nearestTableCenter(2, 3, [])).toEqual({ x: 0, z: 0 });
    expect(nearestTableCenter(-100, 100, [])).toEqual({ x: 0, z: 0 });
  });

  it("picks the head square when a point sits closer to it than to any appended table", () => {
    const appended = [{ index: 0, offsetZ: singleTableOffsetZ(0) }];
    expect(nearestTableCenter(0, 0.1, appended)).toEqual({ x: 0, z: 0 });
  });

  it("picks an appended table's own center once a point sits closer to it than to the head square", () => {
    const appended = [{ index: 0, offsetZ: singleTableOffsetZ(0) }];
    expect(nearestTableCenter(0, singleTableOffsetZ(0) + 0.1, appended)).toEqual({
      x: 0,
      z: singleTableOffsetZ(0),
    });
  });

  it("picks whichever of several appended tables is genuinely nearest", () => {
    const appended = [
      { index: 0, offsetZ: singleTableOffsetZ(0) },
      { index: 1, offsetZ: singleTableOffsetZ(1) },
      { index: 2, offsetZ: singleTableOffsetZ(2) },
    ];
    const midpoint = (singleTableOffsetZ(1) + singleTableOffsetZ(2)) / 2;
    expect(nearestTableCenter(0, midpoint - 0.01, appended)).toEqual({ x: 0, z: singleTableOffsetZ(1) });
    expect(nearestTableCenter(0, midpoint + 0.01, appended)).toEqual({ x: 0, z: singleTableOffsetZ(2) });
  });
});

describe("clampToTableArrangement", () => {
  it("leaves a point already within CHAIR_DRAG_CLAMP_RADIUS of its nearest table untouched", () => {
    expect(clampToTableArrangement(1, 1, [])).toEqual({ x: 1, z: 1 });
  });

  it("scales a too-far point back to exactly CHAIR_DRAG_CLAMP_RADIUS from its nearest table's center", () => {
    const clamped = clampToTableArrangement(100, 0, []);
    expect(Math.hypot(clamped.x, clamped.z)).toBeCloseTo(CHAIR_DRAG_CLAMP_RADIUS);
    // Direction is preserved — still due +X from the head square's center.
    expect(clamped.x).toBeCloseTo(CHAIR_DRAG_CLAMP_RADIUS);
    expect(clamped.z).toBeCloseTo(0);
  });

  it("clamps relative to an appended table's own center once that's the nearest one, not world origin", () => {
    const appended = [{ index: 0, offsetZ: singleTableOffsetZ(0) }];
    const farZ = singleTableOffsetZ(0) + 100;
    const clamped = clampToTableArrangement(0, farZ, appended);
    expect(clamped.z).toBeCloseTo(singleTableOffsetZ(0) + CHAIR_DRAG_CLAMP_RADIUS);
    const distanceFromNearestTable = Math.hypot(clamped.x - 0, clamped.z - singleTableOffsetZ(0));
    expect(distanceFromNearestTable).toBeCloseTo(CHAIR_DRAG_CLAMP_RADIUS);
  });
});

describe("rotationYTowardNearestTable", () => {
  it("matches seatAtAngle's own atan2(x, z) convention around the head square when there's no appended table", () => {
    expect(rotationYTowardNearestTable(0, 5, [])).toBeCloseTo(Math.atan2(0, 5));
    expect(rotationYTowardNearestTable(5, 0, [])).toBeCloseTo(Math.atan2(5, 0));
    expect(rotationYTowardNearestTable(3, -4, [])).toBeCloseTo(Math.atan2(3, -4));
  });

  it("faces the nearest appended table's own center once dragged out along the row", () => {
    const appended = [{ index: 0, offsetZ: singleTableOffsetZ(0) }];
    const z = singleTableOffsetZ(0) + 2;
    expect(rotationYTowardNearestTable(1, z, appended)).toBeCloseTo(Math.atan2(1, z - singleTableOffsetZ(0)));
  });
});

describe("resolveChairDrop", () => {
  it("returns the candidate position and its nearest-table-facing rotation unchanged when nothing is violated", () => {
    const resolved = resolveChairDrop({ x: 1, z: 1, chairRadius: 0.2, obstacles: [], appendedTables: [] });
    expect(resolved.x).toBeCloseTo(1);
    expect(resolved.z).toBeCloseTo(1);
    expect(resolved.rotationY).toBeCloseTo(Math.atan2(1, 1));
  });

  it("clamps a too-far drop to CHAIR_DRAG_CLAMP_RADIUS even with no obstacles at all", () => {
    const resolved = resolveChairDrop({ x: 1000, z: 0, chairRadius: 0.2, obstacles: [], appendedTables: [] });
    expect(Math.hypot(resolved.x, resolved.z)).toBeCloseTo(CHAIR_DRAG_CLAMP_RADIUS);
  });

  it("nudges a drop away from a single overlapping obstacle to just clear it, preserving direction", () => {
    const chairRadius = 0.25;
    const obstacle: ChairObstacle = { x: 2, z: 0, radius: 0.3 };
    // Dropped almost exactly on top of the obstacle, offset a hair along +X
    // so the push direction is unambiguous.
    const resolved = resolveChairDrop({
      x: 2.01,
      z: 0,
      chairRadius,
      obstacles: [obstacle],
      appendedTables: [],
    });
    const distance = Math.hypot(resolved.x - obstacle.x, resolved.z - obstacle.z);
    expect(distance).toBeGreaterThanOrEqual(chairRadius + obstacle.radius);
    expect(resolved.x).toBeGreaterThan(2); // pushed further along +X, not flipped to the other side
    expect(resolved.z).toBeCloseTo(0);
  });

  it("never leaves the final position overlapping ANY obstacle in a cluttered multi-obstacle drop", () => {
    const chairRadius = 0.25;
    const obstacles: ChairObstacle[] = [
      { x: 0.3, z: 0, radius: 0.25 },
      { x: 0, z: 0.3, radius: 0.25 },
      { x: 0.2, z: 0.2, radius: 0.2 },
    ];
    const resolved = resolveChairDrop({ x: 0.1, z: 0.1, chairRadius, obstacles, appendedTables: [] });
    for (const obstacle of obstacles) {
      const distance = Math.hypot(resolved.x - obstacle.x, resolved.z - obstacle.z);
      expect(distance).toBeGreaterThanOrEqual(chairRadius + obstacle.radius - 1e-6);
    }
  });

  it("re-clamps after nudging, so a push near the clamp boundary never ends up outside it", () => {
    const chairRadius = 0.25;
    // An obstacle placed just inside the clamp radius, positioned so the
    // only clear direction to push is further outward, past the boundary
    // without the post-nudge re-clamp.
    const obstacle: ChairObstacle = { x: CHAIR_DRAG_CLAMP_RADIUS - 0.1, z: 0, radius: 0.3 };
    const resolved = resolveChairDrop({
      x: CHAIR_DRAG_CLAMP_RADIUS - 0.09,
      z: 0,
      chairRadius,
      obstacles: [obstacle],
      appendedTables: [],
    });
    expect(Math.hypot(resolved.x, resolved.z)).toBeLessThanOrEqual(CHAIR_DRAG_CLAMP_RADIUS + 1e-6);
  });

  it("recomputes rotationY from wherever the point actually finally lands, toward the nearest table", () => {
    const appended = [{ index: 0, offsetZ: singleTableOffsetZ(0) }];
    const obstacle: ChairObstacle = { x: 0, z: singleTableOffsetZ(0), radius: 0.3 };
    const resolved = resolveChairDrop({
      x: 0.05,
      z: singleTableOffsetZ(0),
      chairRadius: 0.25,
      obstacles: [obstacle],
      appendedTables: appended,
    });
    expect(resolved.rotationY).toBeCloseTo(
      rotationYTowardNearestTable(resolved.x, resolved.z, appended)
    );
  });
});
