import {
  getAvatarSignedUrl,
  type AvatarSource,
  type CampaignMember,
  type SupabaseClient,
} from "@/data-access";
import { AVATAR_PRESETS } from "@/app/account/avatar-presets";

/** A campaign member with their avatar resolved to a loadable URL (or null
 * for "no usable avatar" — scene-3d renders its placeholder for that). */
export interface RoomMember extends CampaignMember {
  avatar_url: string | null;
}

// Known limitation (deliberate, per Prompt 21): no refresh before expiry —
// a Game Room tab left open past this window shows the placeholder for
// custom avatars until reload.
const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

/**
 * Resolves a profile's avatar selection to a URL scene-3d can load
 * directly. Runs in the app layer on both server (initial page load) and
 * client (live profile-change updates) — scene-3d itself can't touch
 * Supabase. Unknown preset ids and failed signing degrade to null rather
 * than throwing, so one bad avatar can't take down the room.
 */
export async function resolveAvatarUrl(
  supabase: SupabaseClient,
  source: AvatarSource | null,
  ref: string | null
): Promise<string | null> {
  if (source === "preset" && ref) {
    return AVATAR_PRESETS.find((preset) => preset.id === ref)?.file ?? null;
  }
  if (source === "custom" && ref) {
    try {
      return await getAvatarSignedUrl(supabase, ref, SIGNED_URL_TTL_SECONDS);
    } catch {
      return null;
    }
  }
  return null;
}
