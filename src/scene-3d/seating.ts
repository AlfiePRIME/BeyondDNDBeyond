import { COMBINED_TABLE_TOP, TABLE_TOP, singleTableOffsetZ } from "./table";

/**
 * Structurally matches data-access's CampaignMember so callers can pass that
 * list straight through — scene-3d can't import the type itself (module
 * boundary), and seat order must come from the caller's already-ordered
 * member list (joined_at ascending, a DB-level ORDER BY shared by every
 * client), which is what keeps the arrangement identical across clients.
 */
export interface SeatMember {
  user_id: string;
  role: "dm" | "player";
  display_name: string | null;
  /**
   * Directly-loadable glTF URL for this member's avatar — resolution
   * (preset manifest lookup, signed Storage URL) happens in the app layer
   * because scene-3d can't fetch its own data. null/absent renders the
   * built-in placeholder.
   */
  avatar_url?: string | null;
  /**
   * Stored forward-direction correction (degrees) for this member's avatar
   * model — see docs/design/model-orientation-and-posing.md §8. Resolved in
   * the app layer alongside avatar_url, for the same reason. Absent/null
   * means 0 (no correction), same default as every avatar predating this
   * feature.
   */
  avatar_forward_offset_deg?: number | null;
}

export type CameraMode = "seat" | "orbit";

export interface Seat {
  member: SeatMember;
  /** Stool base on the floor. */
  position: [number, number, number];
  /** Yaw so an object with default -Z forward faces the table center. */
  rotationY: number;
  /** Seated eye point for this seat's first-person camera. */
  cameraPosition: [number, number, number];
}

const SEAT_MARGIN = 0.4;
// Eye point sits above and behind the stool — a strict seated eye height
// buries the view in the tabletop and hides everyone else's seat markers.
// Re-tuned up from 1.6/3.4 for the two-table combined footprint (table.ts's
// COMBINED_TABLE_TOP, this function's new default `table`): the ellipse's
// depth-axis half-extent nearly doubled (old single-table depth 2.1 → the
// combined 4.2), so every seat sits noticeably further from center than
// before. A taller, further-back eye point keeps the WHOLE combined surface
// comfortably inside the seated camera's 50° FOV from any seat, the same
// way the old values kept the smaller single table comfortably framed.
const CAMERA_SETBACK = 2.1;
const CAMERA_EYE_HEIGHT = 4.3;
// Seat 0 (the campaign creator, first in joined_at order) sits on the near
// (+z) side, matching the direction Prompt 19's fixed camera looked from.
const FIRST_SEAT_ANGLE = Math.PI / 2;

/**
 * Reorders members so the DM lands at the array index whose angle
 * (`FIRST_SEAT_ANGLE + (index/n) * 2π`, computeSeatLayout's existing
 * per-index formula) works out closest to `FIRST_SEAT_ANGLE + π` — the
 * far/-Z side of the table, opposite the near/+Z seat-0 slot. That's the
 * edge where a map's row 0 renders (see mapFit.ts/MapSurface.tsx), so the
 * DM ends up sitting behind the top of the map, looking down its length at
 * the players — a real GM-screen posture. Runs before computeSeatLayout's
 * per-index math; that math itself (ellipse position, camera, rotation)
 * stays completely untouched — this function only controls which member
 * ends up at which index.
 *
 * There's always exactly one DM (a DB-level unique constraint enforces
 * this per campaign), but the early return keeps this safe if a caller
 * (e.g. a test) ever passes a memberless-DM list.
 */
function placeDmAtNorthSlot(members: readonly SeatMember[]): readonly SeatMember[] {
  const n = members.length;
  const dmIndex = members.findIndex((member) => member.role === "dm");
  if (dmIndex === -1) return members;

  // At odd n there's no index exactly opposite FIRST_SEAT_ANGLE; this picks
  // the closest one, off by at most π/n — expected, not a bug to chase.
  const targetIndex = Math.round(n / 2) % n;

  const dm = members[dmIndex];
  const others = members.filter((_, index) => index !== dmIndex);

  const reordered: SeatMember[] = [];
  let otherCursor = 0;
  for (let index = 0; index < n; index++) {
    if (index === targetIndex) {
      reordered.push(dm);
    } else {
      reordered.push(others[otherCursor]);
      otherCursor++;
    }
  }
  return reordered;
}

/**
 * Half-extents of the seating ellipse for a given table footprint — the
 * same √2-through-the-corners fit computeSeatLayout uses internally,
 * exported so any other system that needs to know exactly how far out a
 * seat/chair can land (the directional light's shadow-camera frustum in
 * GameTableScene.tsx) stays derived from the one real fit formula instead
 * of a hand-copied guess that could silently drift from it.
 */
export function seatEllipseSemiAxes(
  table: { width: number; depth: number } = COMBINED_TABLE_TOP
): { semiX: number; semiZ: number } {
  // √2 × the half-dimensions is the ellipse through the rectangle's corners
  // — a plain half-dimension ellipse dips inside the tabletop near the
  // corners, clipping seats through it.
  return {
    semiX: (table.width / 2) * Math.SQRT2 + SEAT_MARGIN,
    semiZ: (table.depth / 2) * Math.SQRT2 + SEAT_MARGIN,
  };
}

/**
 * The position/rotation/camera math for a single seat at a given angle
 * around a given table's ellipse — factored out of computeSeatLayout so a
 * DIFFERENT angle-generation scheme (appendedTableAngles below, for
 * appended tables' own end-cap-only arcs) can reuse the exact same
 * placement formula instead of a hand-copied duplicate. Pure function of
 * (table, angle) alone — computeSeatLayout supplies angles via its own
 * full-circle, equal-spacing formula; appendedTableAngles supplies them via
 * two restricted arcs instead. Neither knows or cares which the other does.
 */
function seatAtAngle(
  table: { width: number; depth: number },
  angle: number
): Pick<Seat, "position" | "rotationY" | "cameraPosition"> {
  const { semiX, semiZ } = seatEllipseSemiAxes(table);
  const x = semiX * Math.cos(angle);
  const z = semiZ * Math.sin(angle);
  return {
    position: [x, 0, z],
    rotationY: Math.atan2(x, z),
    cameraPosition: [
      (semiX + CAMERA_SETBACK) * Math.cos(angle),
      CAMERA_EYE_HEIGHT,
      (semiZ + CAMERA_SETBACK) * Math.sin(angle),
    ],
  };
}

export function computeSeatLayout(
  members: readonly SeatMember[],
  table: { width: number; depth: number } = COMBINED_TABLE_TOP
): Seat[] {
  const ordered = placeDmAtNorthSlot(members);

  return ordered.map((member, index) => {
    const angle = FIRST_SEAT_ANGLE + (index / members.length) * Math.PI * 2;
    return { member, ...seatAtAngle(table, angle) };
  });
}

// Real chair frontage (side-to-side width a chair actually occupies once
// rendered), re-measured the same way table.ts's own TABLE_TOP comment
// documents: a Box3 over each raw glTF's loaded scene
// (public/table/player-chair.glb, public/table/dm-chair.glb — a plain
// GLB-chunk walk + per-vertex world-matrix transform, not GLTFLoader, since
// this was measured from a throwaway Node script outside the browser;
// cross-checked against table.glb's own already-documented raw bounding box
// to confirm the measurement approach itself is correct), then scaled by
// the exact same targetHeight/rawHeight factor Chair.tsx's ChairModel
// applies at render time:
//   player: raw Box3 size (x,y,z) ≈ (0.5897, 1.2630, 0.6626); Chair.tsx's
//     PLAYER_CHAIR_HEIGHT (1.0) / raw y (1.2630) = 0.7918 scale →
//     frontage = 0.5897 × 0.7918 ≈ 0.4669
//   dm: raw Box3 size (x,y,z) ≈ (1.4269, 2.2063, 0.9312); Chair.tsx's
//     DM_CHAIR_HEIGHT (2.0) / raw y (2.2063) = 0.9065 scale →
//     frontage = 1.4269 × 0.9065 ≈ 1.2935
// Local X (not Z) is the right axis to measure: both chair models were
// authored with local +Z as their own front-facing direction (confirmed by
// Chair.tsx's own axis-aligned-camera probe comment), making X the
// side-to-side ("frontage") axis, not the front-to-back depth axis. The
// 180° *_FORWARD_CORRECTION yaw Chair.tsx applies doesn't change this
// number: a pure rotation about Y by exactly π maps local x to -x, which
// preserves the overall x-extent (max−min) exactly, so the raw model's
// local-X footprint IS the rendered chair's world-frame tangential width
// regardless of that correction (or of TableSeat's own further per-seat
// rotation, which this circular-footprint model deliberately doesn't need
// to track — see HEAD_SQUARE_SEAT_CAPACITY's own comment).
// Exported (not just module-private) so tests can check real non-collision
// against the exact same numbers this file's own capacity derivation uses,
// instead of a hand-copied duplicate that could silently drift from them —
// the same "single source of truth" reasoning seatEllipseSemiAxes was
// already exported for.
export const PLAYER_CHAIR_FRONTAGE = 0.4669;
export const DM_CHAIR_FRONTAGE = 1.2935;

/**
 * How many seats fit around one "table unit" before the next one's chair
 * would visually collide with its neighbor — derived, not guessed, by
 * actually finding (below, at module load — not a hand-copied literal that
 * could silently drift from the formula it claims to summarize) the largest
 * n for which every pair of ADJACENT seats (computeSeatLayout's own
 * equal-angle-spacing formula, walked around the ring) clears half of each
 * seat's own chair frontage summed together — the standard minimum
 * non-overlapping center-to-center spacing for two differently-sized
 * objects centered on their own anchor points, modeling each chair as a
 * frontage-diameter circle (a deliberately simple proxy for the real,
 * individually-rotated rectangular footprint that sidesteps needing to
 * track each seat's own rotationY, since a circle looks the same from every
 * angle). Only ADJACENT pairs need checking: seats sit in strictly
 * increasing angular order around a convex ellipse, so any non-adjacent
 * pair is always farther apart than its nearer neighbor.
 */
function maxSeatCapacity(
  table: { width: number; depth: number },
  frontageAt: (seatIndex: number, seatCount: number) => number
): number {
  const { semiX, semiZ } = seatEllipseSemiAxes(table);
  const positionAt = (index: number, n: number): [number, number] => {
    const angle = FIRST_SEAT_ANGLE + (index / n) * Math.PI * 2;
    return [semiX * Math.cos(angle), semiZ * Math.sin(angle)];
  };

  let best = 1; // a solo seat never has a neighbor to collide with
  for (let n = 2; n <= 200; n++) {
    let everyAdjacentPairFits = true;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const required = frontageAt(i, n) / 2 + frontageAt(j, n) / 2;
      const [ix, iz] = positionAt(i, n);
      const [jx, jz] = positionAt(j, n);
      if (Math.hypot(ix - jx, iz - jz) < required) {
        everyAdjacentPairFits = false;
        break;
      }
    }
    if (!everyAdjacentPairFits) break;
    best = n;
  }
  return best;
}

// placeDmAtNorthSlot's own north-slot formula, replayed here so the head
// square's capacity search knows exactly which one of its n seats is the
// wider DM throne rather than assuming every seat is a plain player chair.
function dmSeatIndex(n: number): number {
  return Math.round(n / 2) % n;
}

/**
 * How many seats fit around the fixed head square (COMBINED_TABLE_TOP's own
 * ellipse) before the next one would visually collide with a neighbor —
 * exactly one of these n seats (placeDmAtNorthSlot's own north-slot index)
 * is the much wider DM throne (DM_CHAIR_FRONTAGE); the rest are player
 * chairs (PLAYER_CHAIR_FRONTAGE). See maxSeatCapacity's own doc comment for
 * the fitting method.
 *
 * This number comes out much larger than a typical real-world game table
 * seats (23 players before the head square alone is full) — a real,
 * verified consequence of this scene's EXISTING geometry, not a mistake
 * introduced here: COMBINED_TABLE_TOP's footprint was independently scaled
 * to match TABLE_SURFACE_Y (table.ts's own comment — "kept unchanged on
 * purpose" for camera/fog framing, deliberately taller, and by that same
 * scale factor wider, than a real table), while the chairs were separately
 * tuned to REAL dining-chair proportions (Chair.tsx's own comment on
 * PLAYER_CHAIR_HEIGHT). Those two independently-correct facts together mean
 * this specific table, at its current size, can genuinely seat far more
 * real-proportioned chairs than a realistically-sized table could — not a
 * bug, just what the real numbers say once actually measured, which is
 * exactly what was asked for instead of a guessed round number.
 */
export const HEAD_SQUARE_SEAT_CAPACITY = maxSeatCapacity(COMBINED_TABLE_TOP, (index, n) =>
  index === dmSeatIndex(n) ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE
);

/**
 * An appended single table's own two seats never wrap all the way around
 * its ellipse the way the head square's (or a genuinely standalone table's)
 * do — table.ts's own TABLE_TOP_JOIN_DEPTH comment has the reasoning: the
 * table-doubling work already established that tables in this row join
 * along their WIDTH edges ("that join runs along the WIDTH axis... the two
 * tables stack along DEPTH instead" — table.ts's own COMBINED_TABLE_TOP
 * comment). That means every table's own two WIDTH (long) edges — the
 * angle-π/2 and angle-3π/2 ends of its ellipse, at the ellipse's Z-extremes
 * — are exactly the edges touching whatever's next to it in the row (the
 * head square on one side, and — for every table but the last in a longer
 * row — another appended table on the other). Only the two DEPTH (short)
 * end-caps — the ellipse's X-extremes, at angle 0 and π — are ever free.
 * Placing seats around the FULL ellipse (as computeSeatLayout does for the
 * head square, which has no neighbor to worry about) put chairs on those
 * occupied long edges too, which is what let an appended table's own
 * chairs collide with the head square's real deployed layout once
 * TABLE_TOP_JOIN_DEPTH tightened the row spacing.
 *
 * APPENDED_TABLE_ENDCAP_HALF_WIDTH_DEG is the half-width of each of the two
 * usable end-cap arcs (one centered on angle 0, one on angle π), a plain,
 * symmetric "quarter circle per end" (2×45°) rather than an
 * opaquely-optimized number — checked, not just assumed, against
 * SINGLE_TABLE_SEAT_CAPACITY's own exhaustive search below to confirm it
 * actually clears every real collision case at a real capacity (an
 * exhaustive sweep of the half-width itself found the true optimum at 43°,
 * a single seat's difference in the resulting capacity — not worth the
 * extra opacity of a non-round number for one seat).
 */
const APPENDED_TABLE_ENDCAP_HALF_WIDTH_DEG = 45;

/**
 * The angles (radians) for `n` seats split across an appended table's two
 * free end-cap arcs — as evenly as possible between the two ends (the
 * larger half, if n is odd, goes to the first/"left" end), each end's own
 * share spread evenly across its own
 * [-APPENDED_TABLE_ENDCAP_HALF_WIDTH_DEG, +HALF_WIDTH] arc, centered on
 * angle 0 (first end) or angle π (second end). A single seat on one end
 * sits at that end's exact center (0 or π) rather than an arbitrary edge of
 * its own arc.
 */
function appendedTableAngles(n: number): number[] {
  const halfWidth = (APPENDED_TABLE_ENDCAP_HALF_WIDTH_DEG * Math.PI) / 180;
  const leftCount = Math.ceil(n / 2);
  const rightCount = n - leftCount;
  const angles: number[] = [];
  for (let i = 0; i < leftCount; i++) {
    angles.push(leftCount === 1 ? 0 : -halfWidth + (i / (leftCount - 1)) * (2 * halfWidth));
  }
  for (let i = 0; i < rightCount; i++) {
    angles.push(Math.PI + (rightCount === 1 ? 0 : -halfWidth + (i / (rightCount - 1)) * (2 * halfWidth)));
  }
  return angles;
}

/**
 * computeSeatLayout's counterpart for an appended single table: same
 * seatAtAngle placement math, but angles come from appendedTableAngles's
 * two-end-cap split instead of a full-circle sweep (this table's own doc
 * comment above has the reasoning), and the whole result is translated by
 * `offsetZ` (table.ts's singleTableOffsetZ) into this table's actual
 * world-space row position. No DM reordering: an appended table never
 * seats the DM (computeCampaignSeatLayout always keeps it on the head
 * square), so members are placed in their given (join) order as-is.
 */
function computeAppendedTableSeatLayout(members: readonly SeatMember[], offsetZ: number): Seat[] {
  const angles = appendedTableAngles(members.length);
  return members.map((member, index) => {
    const seat = seatAtAngle(TABLE_TOP, angles[index]);
    return {
      member,
      position: [seat.position[0], seat.position[1], seat.position[2] + offsetZ],
      rotationY: seat.rotationY,
      cameraPosition: [seat.cameraPosition[0], seat.cameraPosition[1], seat.cameraPosition[2] + offsetZ],
    };
  });
}

/**
 * How many seats fit at one appended single table before either its own
 * chairs collide with each other OR with a neighboring table's — checked
 * against THREE real cases, not just the single-table-in-isolation case
 * maxSeatCapacity covers:
 *  1. Within this table's own two end-cap arcs (adjacent seats on the same
 *     arc, and the two arcs against each other).
 *  2. Against a full head square (HEAD_SQUARE_SEAT_CAPACITY seats, the DM
 *     included) at table.ts's singleTableOffsetZ(0) — the case for the
 *     FIRST appended table, which always has exactly this as its neighbor
 *     (an appended table only ever exists once the head square is
 *     completely full — computeCampaignSeatLayout's own bucketing).
 *  3. Against ANOTHER appended table at the very next row slot
 *     (singleTableOffsetZ(1)), holding just as many seats — the worst case
 *     for an "interior" table in a row of 3+ appended tables, which has an
 *     occupied neighbor on BOTH sides, not just one.
 * Whichever of these three fails first caps the capacity — checked at every
 * candidate n, not assumed safe just because ONE of the three happens to
 * clear.
 */
function maxAppendedTableCapacity(): number {
  const buildSeats = (n: number, offsetZ: number) =>
    appendedTableAngles(n).map((angle) => {
      const { position } = seatAtAngle(TABLE_TOP, angle);
      return { x: position[0], z: position[2] + offsetZ, frontage: PLAYER_CHAIR_FRONTAGE };
    });
  const headSeats = () =>
    Array.from({ length: HEAD_SQUARE_SEAT_CAPACITY }, (_, i) => {
      const { position } = seatAtAngle(
        COMBINED_TABLE_TOP,
        FIRST_SEAT_ANGLE + (i / HEAD_SQUARE_SEAT_CAPACITY) * Math.PI * 2
      );
      return {
        x: position[0],
        z: position[2],
        frontage: i === dmSeatIndex(HEAD_SQUARE_SEAT_CAPACITY) ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE,
      };
    });
  const worstPairRatio = (as: { x: number; z: number; frontage: number }[], bs: typeof as) => {
    let worst = Infinity;
    for (const a of as) {
      for (const b of bs) {
        const dist = Math.hypot(a.x - b.x, a.z - b.z);
        worst = Math.min(worst, dist / (a.frontage / 2 + b.frontage / 2));
      }
    }
    return worst;
  };

  const worstWithinPairRatio = (seats: { x: number; z: number; frontage: number }[]) => {
    let worst = Infinity;
    for (let i = 0; i < seats.length; i++) {
      for (let j = i + 1; j < seats.length; j++) {
        const a = seats[i];
        const b = seats[j];
        const dist = Math.hypot(a.x - b.x, a.z - b.z);
        worst = Math.min(worst, dist / (a.frontage / 2 + b.frontage / 2));
      }
    }
    return worst;
  };

  let best = 0;
  for (let n = 1; n <= 100; n++) {
    const table0 = buildSeats(n, singleTableOffsetZ(0));
    const table1 = buildSeats(n, singleTableOffsetZ(1));
    const withinOk = n < 2 || worstWithinPairRatio(table0) >= 1;
    const crossHeadOk = worstPairRatio(headSeats(), table0) >= 1;
    const crossNextOk = worstPairRatio(table0, table1) >= 1;
    if (withinOk && crossHeadOk && crossNextOk) best = n;
    else break;
  }
  return best;
}

/**
 * How many seats fit at one appended single table — see
 * maxAppendedTableCapacity's own doc comment for the three real collision
 * cases this checks (within its own two arcs, against a full head square,
 * and against a same-sized neighbor on its OTHER side too, the worst case
 * for a 3+-table row's interior tables). Far smaller than
 * HEAD_SQUARE_SEAT_CAPACITY — expected, not a bug: an appended table only
 * has its two short end-caps free to seat anyone at all (its long edges are
 * exactly where it joins its neighbors), so it was never going to seat
 * anywhere near as many people as the head square's own full, unobstructed
 * perimeter.
 */
export const SINGLE_TABLE_SEAT_CAPACITY = maxAppendedTableCapacity();

/** One plain single table appended beside the fixed head square. */
export interface AppendedTable {
  /** 0-based: 0 is the first table appended beside the head square. */
  index: number;
  /** World-space Z offset of this table's own center — table.ts's
   * singleTableOffsetZ, the same formula GameTableScene positions the
   * physical table mesh with. Every seat at this table (in the sibling
   * `seats` array) has already been offset by this same amount. */
  offsetZ: number;
}

/** A Seat plus which physical table it landed on — a superset of Seat, so
 * anywhere that renders a plain Seat (GameTableScene's TableSeat) still
 * accepts these unchanged. `tableIndex` is -1 for the fixed head square, or
 * an AppendedTable's own 0-based `index` — exposed as real data rather than
 * left for a caller to reverse-engineer from raw position (the two
 * ellipses' Z ranges can overlap for a nearly-full head square, since
 * TABLE_TOP shares COMBINED_TABLE_TOP's own width and only differs in
 * depth, so inferring table membership from position alone is unreliable;
 * this field is the authoritative answer). */
export interface CampaignSeat extends Seat {
  tableIndex: number;
}

export interface CampaignSeatLayout {
  /** The fixed head square is always present (even for an empty/solo
   * party) and always at offsetZ 0 — it isn't included in this list, only
   * plain appended single tables, in the order they were added. */
  appendedTables: readonly AppendedTable[];
  /** Every seat across every table, head square first, already offset into
   * final world-space position — a flat list a renderer can map over
   * exactly the way computeSeatLayout's own output already was. */
  seats: CampaignSeat[];
}

/**
 * Generalizes computeSeatLayout to a party that may outgrow the fixed head
 * square: keeps the head square's own ellipse/seats completely untouched
 * (computeSeatLayout(headMembers, COMBINED_TABLE_TOP), DM included, at
 * world origin) for as long as the party fits inside
 * HEAD_SQUARE_SEAT_CAPACITY, then appends plain single tables one at a
 * time — each with computeAppendedTableSeatLayout(tableMembers, offsetZ)'s
 * own end-cap-only arcs (never a full ellipse sweep — that table's own doc
 * comment has the reasoning), offset into world space along the row
 * (table.ts's singleTableOffsetZ) — for every SINGLE_TABLE_SEAT_CAPACITY
 * more members beyond that. An appended table never seats the DM: the DM
 * is always pulled out of the input list first and reinserted into the
 * head bucket, where placeDmAtNorthSlot (inside the head square's own
 * computeSeatLayout call) keeps it pinned to the north slot regardless of
 * overall party size — exactly the project owner's confirmed requirement
 * that the DM never moves off the head square as more tables get appended
 * elsewhere.
 *
 * Member→table assignment is a stable, append-only bucketing over the
 * caller's already-joined_at-ordered list, DM aside: the remaining players
 * fill the head bucket up to HEAD_SQUARE_SEAT_CAPACITY - 1 (one head slot
 * reserved for the DM), then each appended table up to
 * SINGLE_TABLE_SEAT_CAPACITY apiece, in that same join order. Because join
 * order only ever grows by appending, and every bucket boundary is a fixed
 * threshold over that same order, a member already inside a bucket stays in
 * that exact bucket as more members join later — nobody already seated is
 * ever bumped to a different table by a new arrival; only members joining
 * beyond the current total capacity land at a (possibly brand new) table of
 * their own.
 *
 * (A member's angle WITHIN their own table's ring can still shift slightly
 * as that specific table's own occupancy grows — computeSeatLayout always
 * spaces its own bucket's seats evenly by count, exactly like it always
 * has for a single-table campaign — but that's the same pre-existing,
 * previously-accepted behavior every campaign already had before this
 * function existed; nobody moves to a meaningfully different seat, let
 * alone a different table, just because someone else joined.)
 */
export function computeCampaignSeatLayout(members: readonly SeatMember[]): CampaignSeatLayout {
  const dmIndex = members.findIndex((member) => member.role === "dm");
  const dm = dmIndex === -1 ? null : members[dmIndex];
  const players = members.filter((_, index) => index !== dmIndex);

  const headPlayerCapacity = HEAD_SQUARE_SEAT_CAPACITY - (dm ? 1 : 0);
  const headPlayers = players.slice(0, headPlayerCapacity);
  const overflowPlayers = players.slice(headPlayerCapacity);

  // computeSeatLayout's own placeDmAtNorthSlot finds the DM by role and
  // reorders around it, so where the DM lands in this input array doesn't
  // matter — appending it keeps headPlayers in their existing join order.
  const headMembers = dm ? [...headPlayers, dm] : headPlayers;
  const seats: CampaignSeat[] = computeSeatLayout(headMembers, COMBINED_TABLE_TOP).map((seat) => ({
    ...seat,
    tableIndex: -1,
  }));

  const appendedTables: AppendedTable[] = [];
  let cursor = 0;
  let tableIndex = 0;
  while (cursor < overflowPlayers.length) {
    const tableMembers = overflowPlayers.slice(cursor, cursor + SINGLE_TABLE_SEAT_CAPACITY);
    cursor += SINGLE_TABLE_SEAT_CAPACITY;
    const offsetZ = singleTableOffsetZ(tableIndex);
    appendedTables.push({ index: tableIndex, offsetZ });
    // computeAppendedTableSeatLayout (not computeSeatLayout): an appended
    // table's own two long edges are exactly where it joins its
    // neighbor(s), so its seats only ever use the two short end-caps — see
    // APPENDED_TABLE_ENDCAP_HALF_WIDTH_DEG's own doc comment. It already
    // applies offsetZ internally.
    for (const seat of computeAppendedTableSeatLayout(tableMembers, offsetZ)) {
      seats.push({ ...seat, tableIndex });
    }
    tableIndex++;
  }

  return { appendedTables, seats };
}

/**
 * A member's own persisted override for where their chair actually sits —
 * always an OFFSET from computeCampaignSeatLayout's own computed default
 * for that seat, never an absolute world coordinate. See
 * supabase/migrations/0044_seat_offsets.sql for the full reasoning: the
 * default reshapes as party size changes (a table getting appended, or a
 * table's own per-seat angles shifting as its bucket fills/empties), so an
 * absolute stored position would silently go stale — a chair left floating
 * over empty space, or now overlapping a newly-appended table — the moment
 * that happens. An offset stays sensibly attached to wherever the default
 * now sits instead.
 *
 * Deliberately floor-plane only (dx/dz, no dy): every seat's `position` is
 * already fixed to y=0 ("Stool base on the floor" — Seat's own doc
 * comment), and this data layer has no reason to invent a vertical degree
 * of freedom a chair drag was never going to produce.
 *
 * Structurally matches data-access/seatOffsets.ts's own SeatOffset — the
 * same module-boundary convention as SeatMember above (scene-3d can't
 * import data-access's type directly, so this is scene-3d's independent,
 * structurally-identical definition of the same shape).
 */
export interface SeatOffset {
  /** Added to position[0]/cameraPosition[0]. */
  dx: number;
  /** Added to position[2]/cameraPosition[2]. */
  dz: number;
  /** Added to rotationY, radians — same unit computeSeatLayout already
   * uses (Math.atan2 output). */
  dRotationY: number;
}

/**
 * The one place a stored SeatOffset ever actually gets combined with a
 * computed default — every later consumer of a seat's position (the chair
 * drag gesture, the personal dice tray, camera-mode) should route through
 * this (or getEffectiveSeat below) instead of reading a Seat/CampaignSeat
 * straight off computeSeatLayout/computeCampaignSeatLayout, so "where is
 * this member actually sitting right now" has exactly one answer everywhere
 * — never a computed value in some call sites and an overridden one in
 * others.
 *
 * `offset` null/undefined (no override ever stored, or explicitly cleared
 * back to the default) returns `seat` completely unchanged — the identity
 * case. Generic over S (Seat or the CampaignSeat superset) so this works
 * unmodified for either computeSeatLayout's or computeCampaignSeatLayout's
 * own output, preserving whatever extra fields (e.g. CampaignSeat's
 * tableIndex) the input seat already carried.
 *
 * Translates position AND cameraPosition by the identical (dx, dz) — a
 * rigid translation that keeps the seated camera's setback/height relative
 * to the chair exactly as tuned (CAMERA_SETBACK/CAMERA_EYE_HEIGHT above),
 * rather than re-deriving a camera offset from the new position and getting
 * a different (wrong) relationship to it.
 */
export function applySeatOffset<S extends Seat>(seat: S, offset: SeatOffset | null | undefined): S {
  if (!offset) return seat;
  return {
    ...seat,
    position: [seat.position[0] + offset.dx, seat.position[1], seat.position[2] + offset.dz],
    rotationY: seat.rotationY + offset.dRotationY,
    cameraPosition: [
      seat.cameraPosition[0] + offset.dx,
      seat.cameraPosition[1],
      seat.cameraPosition[2] + offset.dz,
    ],
  } as S;
}

/**
 * Finds `userId`'s own seat in `layout` and applies their stored offset (if
 * any) — the convenience form of applySeatOffset for the common "where is
 * THIS member actually sitting" query (the private dice tray's own seat,
 * the local player's camera seat, one dragged chair), so a caller doesn't
 * need to re-derive the `seats.find(...)` lookup that GameRoom.tsx's own
 * dmSeat memo (and others like it) already does today. Returns null if
 * `userId` isn't seated at all (not a member of this campaign's roster) —
 * the same "absent, not a wrong answer" shape as a missed Map lookup.
 *
 * `offsets` accepts a plain Map (data-access's getSeatOffsetsForCampaign's
 * own return shape) so a caller holding that result can pass it straight
 * through without re-keying it into a different structure first.
 */
export function getEffectiveSeat(
  layout: CampaignSeatLayout,
  userId: string,
  offsets: ReadonlyMap<string, SeatOffset>
): CampaignSeat | null {
  const seat = layout.seats.find((candidate) => candidate.member.user_id === userId);
  if (!seat) return null;
  return applySeatOffset(seat, offsets.get(userId));
}
