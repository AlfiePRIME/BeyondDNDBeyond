import {
  getAvatarSignedUrl,
  getForwardOffsetDeg,
  type AvatarSource,
  type CampaignMember,
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
}

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
