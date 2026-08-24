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

export function computeSeatLayout(
  members: readonly SeatMember[],
  table: { width: number; depth: number } = TABLE_TOP
): Seat[] {
  // √2 × the half-dimensions is the ellipse through the rectangle's corners
  // — a plain half-dimension ellipse dips inside the tabletop near the
  // corners, clipping seats through it.
  const semiX = (table.width / 2) * Math.SQRT2 + SEAT_MARGIN;
  const semiZ = (table.depth / 2) * Math.SQRT2 + SEAT_MARGIN;

  return members.map((member, index) => {
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
