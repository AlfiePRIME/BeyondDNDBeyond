import { getHandoutSignedUrl, type Handout, type SupabaseClient } from "@/data-access";

/** A handout with its file resolved to a loadable signed URL (or null for
 * "no file / couldn't sign" — the panel shows just the title for that). */
export interface RoomHandout extends Handout {
  url: string | null;
}

// Same known limitation (deliberate) as avatar-url: no refresh before
// expiry — a Game Room tab left open past this window shows broken handout
// files until reload.
const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

/**
 * Resolves a handouts row to a RoomHandout. Runs on both server (initial
 * Game Room load) and client (broadcast-driven updates) — each receiver
 * signs with its OWN client, so the bucket's row-join RLS (0022) decides
 * per viewer; a signed URL never rides a broadcast. Failed signing degrades
 * to null rather than throwing, same as resolveAvatarUrl.
 */
export async function resolveHandout(
  supabase: SupabaseClient,
  handout: Handout
): Promise<RoomHandout> {
  if (!handout.reference) return { ...handout, url: null };
  try {
    return {
      ...handout,
      url: await getHandoutSignedUrl(supabase, handout.reference, SIGNED_URL_TTL_SECONDS),
    };
  } catch {
    return { ...handout, url: null };
  }
}

/** Extension-based image sniff on the stored object path — the bucket only
 * admits three image types plus PDF, so "not an image" means PDF. */
export function isImageHandout(handout: Handout): boolean {
  return handout.reference !== null && /\.(png|jpg|webp)$/i.test(handout.reference);
}
