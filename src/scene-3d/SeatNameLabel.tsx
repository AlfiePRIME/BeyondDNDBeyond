"use client";

import { Html } from "@react-three/drei";
import { SEAT_TOP_Y } from "./Chair";
import { AVATAR_HEIGHT } from "./SeatAvatar";
import styles from "./SeatNameLabel.module.css";

export type NameLabelSize = "small" | "medium" | "large";

// Preset font sizes for profiles.name_label_size (0100) — a small, closed
// set rather than an unbounded numeric input a user could set to something
// absurd (0, or 10000px) that breaks the seated table's own readability for
// every OTHER connected client looking at that member's seat; see 0100's
// own migration doc comment for the fuller reasoning. Chosen to read clearly
// distinct from one another at this label's real on-screen size (a
// non-perspective-transformed Html overlay, so these are genuine CSS pixel
// values, not scaled by 3D distance) without either extreme looking broken:
// "small" still comfortably legible, "large" still well short of dominating
// the view the way ChatBubble's own 14px chat text never needs to guard
// against (a chat message is transient; a name label is permanent chrome
// sitting above every seat at once).
export const NAME_LABEL_FONT_SIZE_PX: Record<NameLabelSize, number> = {
  small: 13,
  medium: 16,
  large: 21,
};

// tokens.css's own `--text` value, re-mirrored here the way DmBookProp.tsx's
// PURPLE/ChatBubble's design-token references already are (scene-3d can't
// import CSS custom properties). This is deliberately NOT default_pawn_
// color's own #1ec8c8 teal default — see 0100_name_label.sql's own doc
// comment for why: that default exists to reproduce a color that was
// ALREADY rendering somewhere before that migration; no name label has ever
// rendered before this feature, so the only real goal for a never-
// customized label is legibility against GameTableScene's own dark
// DAY_NIGHT_PRESETS room backgrounds — exactly what `--text` already solves
// everywhere else in this app.
export const DEFAULT_NAME_LABEL_COLOR = "#ede0ff";

// How far above the seat's own head-top (SEAT_TOP_Y[role] + AVATAR_HEIGHT,
// the exact anchor ChatBubble.tsx computes) this label floats — deliberately
// SMALLER than ChatBubble's own HEAD_CLEARANCE (0.3): this label is ALWAYS
// visible (unlike a transient chat message), so it needs to sit close and
// distinct from where a chat bubble ALSO floats above the same seat, rather
// than competing for the same vertical slot when both are showing at once.
// 0.12 leaves a clear, deliberate gap below ChatBubble's own 0.3 anchor
// (roughly the same head-height margin ChatBubble itself adds beyond the
// bare head-top) without the two ever visually overlapping.
const NAME_LABEL_CLEARANCE = 0.12;

export interface SeatNameLabelProps {
  /** Purely a data-testid disambiguator (`seat-name-label-${userId}`) —
   * the ChatBubble.tsx userId prop precedent exactly: a real Playwright
   * check has no other way to find a specific member's own label among
   * several simultaneously-rendered ones. Never read for anything else. */
  userId: string;
  /** campaign_members' own display_name (SeatMember.display_name) — plain
   * text only, rendered as-is with no markup interpretation (see this
   * component's own doc comment for why free-form HTML/CSS is explicitly
   * out of scope). Callers should skip rendering this component entirely
   * for a null/empty display name rather than passing a placeholder string
   * — see TableSeat's own call site. */
  displayName: string;
  /** This member's own resolved name_label_color (profiles.name_label_color,
   * 0100) — already defaulted by the caller (TableSeat) if the member never
   * customized it; this component applies no fallback of its own beyond
   * accepting whatever hex string it's given. */
  color: string;
  /** This member's own resolved name_label_size (profiles.name_label_size,
   * 0100) — same "already defaulted by the caller" contract as color. */
  size: NameLabelSize;
  /** Which per-role head-top height (Chair.tsx's SEAT_TOP_Y) to float above
   * — the DM's throne and a player's chair measure very slightly
   * differently (SEAT_TOP_Y.dm vs .player), the exact ChatBubble.tsx
   * isDm-keyed lookup this component reuses. */
  role: "dm" | "player";
}

/**
 * A floating, ALWAYS-VISIBLE name label above a seated member's own chair —
 * "can we please add username above the characters in their chairs so
 * people know who is who" (the project owner's own explicit ask). Rendered
 * for EVERY seated member, DM's throne included: knowing who the DM is is
 * exactly as much "who is who" as knowing which player is which.
 *
 * <Html transform={false}>, the ChatBubble.tsx/DmBookProp.tsx precedent for
 * rendering arbitrary text as a DOM overlay anchored to a 3D world position
 * — not a canvas-texture sprite, because a display name plus two
 * independently live-changing style choices (color, size) is not the small,
 * cacheable, fixed-string case DmBookProp's own labelTexture cache is built
 * for (that file's own doc comment on why chat text needs the same Html
 * treatment applies identically here).
 *
 * Rendered as a DIRECT CHILD of GameTableScene's TableSeat, inside that
 * seat's own already-positioned/rotated group — deliberately NOT a
 * separately-positioned Canvas sibling the way ChatBubble is mounted. A
 * local `position={[0, y, 0]}` sitting exactly on the Y axis is completely
 * unaffected by TableSeat's own `rotation={[0, seat.rotationY, 0]}` (a
 * rotation about Y leaves every point already ON that axis fixed), so this
 * label automatically rides along with TableSeat's own imperative
 * per-frame position updates (the chair-drag-feel smoothing in that
 * component's own useFrame) with zero separate position-tracking logic of
 * its own to keep in sync — exactly why this component takes no `position`
 * prop of its own at all, unlike ChatBubble.
 *
 * Deliberately plain text with no markup interpretation, no free-form
 * HTML/CSS: the project owner's own FIRST, looser message floated "apply
 * effects to their names or even css/html", but their own very next message
 * explicitly narrowed that down to just size and color. Rendering one
 * user's arbitrary attacker-controlled markup into every OTHER connected
 * campaign member's page would be a genuine stored-XSS vector — this
 * component only ever accepts a plain string (React's default text-node
 * escaping) plus two DB-CHECK-validated style values, never raw HTML.
 */
export function SeatNameLabel({ userId, displayName, color, size, role }: SeatNameLabelProps) {
  const anchorY = SEAT_TOP_Y[role] + AVATAR_HEIGHT + NAME_LABEL_CLEARANCE;
  return (
    <Html
      position={[0, anchorY, 0]}
      center
      transform={false}
      zIndexRange={[430, 0]}
      // A passive readout, not a control — never intercepts clicks/drags
      // meant for the chair/table beneath it, the ChatBubble.tsx precedent
      // exactly (as opposed to DmBookProp's own interactive book content).
      pointerEvents="none"
    >
      <div
        className={styles.label}
        data-testid={`seat-name-label-${userId}`}
        style={{ color, fontSize: NAME_LABEL_FONT_SIZE_PX[size] }}
      >
        {displayName}
      </div>
    </Html>
  );
}
