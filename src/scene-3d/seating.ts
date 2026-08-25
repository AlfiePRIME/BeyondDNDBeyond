import { TABLE_TOP } from "./table";

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
const CAMERA_SETBACK = 1.6;
const CAMERA_EYE_HEIGHT = 3.4;
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

export function computeSeatLayout(
  members: readonly SeatMember[],
  table: { width: number; depth: number } = TABLE_TOP
): Seat[] {
  // √2 × the half-dimensions is the ellipse through the rectangle's corners
  // — a plain half-dimension ellipse dips inside the tabletop near the
  // corners, clipping seats through it.
  const semiX = (table.width / 2) * Math.SQRT2 + SEAT_MARGIN;
  const semiZ = (table.depth / 2) * Math.SQRT2 + SEAT_MARGIN;

  const ordered = placeDmAtNorthSlot(members);

  return ordered.map((member, index) => {
    const angle = FIRST_SEAT_ANGLE + (index / members.length) * Math.PI * 2;
    const x = semiX * Math.cos(angle);
    const z = semiZ * Math.sin(angle);
    return {
      member,
      position: [x, 0, z],
      rotationY: Math.atan2(x, z),
      cameraPosition: [
        (semiX + CAMERA_SETBACK) * Math.cos(angle),
        CAMERA_EYE_HEIGHT,
        (semiZ + CAMERA_SETBACK) * Math.sin(angle),
      ],
    };
  });
}
