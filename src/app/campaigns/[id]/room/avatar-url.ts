import {
  getAvatarSignedUrl,
  getForwardOffsetDeg,
  type AvatarSource,
  type CampaignMember,
  type NameLabelSize,
  type SupabaseClient,
} from "@/data-access";
import { AVATAR_PRESETS } from "@/app/account/avatar-presets";

/** A campaign member with their avatar resolved to a loadable URL (or null
 * for "no usable avatar" — scene-3d renders its placeholder for that). */
export interface RoomMember extends CampaignMember {
  avatar_url: string | null;
  /** Stored forward-direction correction for this member's avatar model
   * (model_orientation — see docs/design/model-orientation-and-posing.md
   * §8), applied as an extra Y rotation when SeatAvatar renders it. 0 (no
   * correction) for every avatar predating this feature. */
  avatar_forward_offset_deg: number;
  /** Pawn Customization P1: this member's account-wide default MAP TOKEN
   * color (profiles.default_pawn_color, 0079) — completely unrelated to
   * avatar_url/avatar_forward_offset_deg above, which are the seated table
   * avatar. GameRoom's own token-render-props derivation reads this,
   * id-keyed by user_id, to color a party-aligned PC token's pawn/plinth.
   * Falls back to DEFAULT_PAWN_COLOR (matching 0079's own column default)
   * only for the vanishingly unlikely case of a missing profile row —
   * every real profile always has a real, non-null value here. */
  default_pawn_color: string;
  /** Name Labels: this member's own account-wide floating name-label color
   * (profiles.name_label_color, 0100) — completely unrelated to
   * default_pawn_color above (that colors the MAP TOKEN) or avatar_url
   * (the seated avatar MODEL); this colors only the always-visible text
   * label GameTableScene's SeatNameLabel renders above THIS member's own
   * seat. Falls back to DEFAULT_NAME_LABEL_COLOR only for the vanishingly
   * unlikely case of a missing profile row — every real profile always has
   * a real, non-null value here (0100's own NOT NULL column). */
  name_label_color: string;
  /** Name Labels: this member's own account-wide name-label size preset
   * (profiles.name_label_size, 0100) — same fallback reasoning as
   * name_label_color immediately above. */
  name_label_size: NameLabelSize;
}

/** Mirrors 0079_default_pawn_color.sql's own column default exactly (the
 * same TEAL every token rendered before this feature existed) — used only
 * as page.tsx's fallback for a member whose profile row failed to load,
 * never a real per-row default (the DB itself already guarantees NOT NULL). */
export const DEFAULT_PAWN_COLOR = "#1ec8c8";

/** Mirrors 0100_name_label.sql's own name_label_color column default
 * exactly (tokens.css's `--text`) — same "page.tsx fallback only" scope as
 * DEFAULT_PAWN_COLOR immediately above. Independently re-declared here
 * (rather than imported) from scene-3d's own SeatNameLabel.DEFAULT_NAME_
 * LABEL_COLOR — the identical cross-module-boundary mirroring
 * DEFAULT_PAWN_COLOR/MapSurface.tsx's ALLEGIANCE_COLOR.party already
 * establish (this app layer file can't import from scene-3d's own default
 * for a page.tsx-only fallback constant, nor should it: the two defaults
 * exist for two different callers to reach for their own missing-row edge
 * case, not one shared import). */
export const DEFAULT_NAME_LABEL_COLOR = "#ede0ff";

/** Mirrors 0100_name_label.sql's own name_label_size column default
 * exactly. Same page.tsx-fallback-only scope as DEFAULT_NAME_LABEL_COLOR. */
export const DEFAULT_NAME_LABEL_SIZE: NameLabelSize = "medium";

/** resolveAvatarUrl's return shape — the URL scene-3d can load, paired with
 * its stored forward-direction correction (0 when none is set). */
export interface ResolvedAvatar {
  url: string | null;
  forwardOffsetDeg: number;
}

// Known limitation (deliberate, per Prompt 21): no refresh before expiry —
// a Game Room tab left open past this window shows the placeholder for
// custom avatars until reload.
const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

const NO_AVATAR: ResolvedAvatar = { url: null, forwardOffsetDeg: 0 };

/**
 * Resolves a profile's avatar selection to a URL scene-3d can load
 * directly, plus its stored forward-direction offset. Runs in the app layer
 * on both server (initial page load) and client (live profile-change
 * updates) — scene-3d itself can't touch Supabase. Unknown preset ids and
 * failed signing/lookups degrade to the no-avatar/no-offset defaults rather
 * than throwing, so one bad avatar can't take down the room.
 *
 * The offset is looked up by the SAME resolved path used as the URL for a
 * preset (AVATAR_PRESETS' file path) or the raw `ref` for a custom avatar —
 * never the freshly-signed URL below, which embeds a per-call expiring
 * token and would never match a stored model_orientation row. See
 * 0043_model_orientation.sql for why this specific stability matters for
 * uploadAvatarFile's fixed-per-user-path re-upload case.
 */
export async function resolveAvatarUrl(
  supabase: SupabaseClient,
  source: AvatarSource | null,
  ref: string | null
): Promise<ResolvedAvatar> {
  if (source === "preset" && ref) {
    const file = AVATAR_PRESETS.find((preset) => preset.id === ref)?.file;
    if (!file) return NO_AVATAR;
    const forwardOffsetDeg = await getForwardOffsetDeg(supabase, file).catch(() => 0);
    return { url: file, forwardOffsetDeg };
  }
  if (source === "custom" && ref) {
    try {
      const [url, forwardOffsetDeg] = await Promise.all([
        getAvatarSignedUrl(supabase, ref, SIGNED_URL_TTL_SECONDS),
        getForwardOffsetDeg(supabase, ref).catch(() => 0),
      ]);
      return { url, forwardOffsetDeg };
    } catch {
      return NO_AVATAR;
    }
  }
  return NO_AVATAR;
}
