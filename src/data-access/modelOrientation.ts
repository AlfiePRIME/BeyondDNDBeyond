import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * General per-model forward-direction metadata — see
 * docs/design/model-orientation-and-posing.md §8. Keyed by the model's own
 * resolved, STABLE path (asset_library.model_ref as-is; a preset avatar's
 * AVATAR_PRESETS-resolved file path; a custom avatar's avatar_ref as-is) —
 * never the ephemeral signed URL minted at render time, which embeds a
 * fresh expiring token per call and would never match a previous row. See
 * 0043_model_orientation.sql for the full reasoning.
 */
export interface ModelOrientation {
  model_url: string;
  forward_offset_deg: number;
  updated_at: string;
}

/** Every model with no stored row renders with this — exactly today's
 * no-correction behavior, so no existing preset or upload regresses. */
export const DEFAULT_FORWARD_OFFSET_DEG = 0;

/**
 * The stored forward-direction correction for one resolved model path, or
 * the default (0) if none has ever been set — every asset that predates
 * this feature.
 */
export async function getForwardOffsetDeg(
  supabase: SupabaseClient,
  modelUrl: string
): Promise<number> {
  const { data, error } = await supabase
    .from("model_orientation")
    .select("forward_offset_deg")
    .eq("model_url", modelUrl)
    .maybeSingle();

  if (error) throw error;
  return data?.forward_offset_deg ?? DEFAULT_FORWARD_OFFSET_DEG;
}

/**
 * Batched read for N model paths at once, keyed by model_url — resolving a
 * whole campaign's palette (resolvePaletteAssets) or a room's roster needs
 * one round trip here, not one per asset/avatar. Missing keys are simply
 * absent from the returned map; callers default a lookup miss to 0 the same
 * way getForwardOffsetDeg does.
 */
export async function getForwardOffsetsForUrls(
  supabase: SupabaseClient,
  modelUrls: readonly string[]
): Promise<Map<string, number>> {
  const uniqueUrls = Array.from(new Set(modelUrls));
  if (uniqueUrls.length === 0) return new Map();

  const { data, error } = await supabase
    .from("model_orientation")
    .select("model_url, forward_offset_deg")
    .in("model_url", uniqueUrls);

  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.model_url, row.forward_offset_deg]));
}

/**
 * Saves the forward-direction correction for one resolved model path — an
 * upsert, not an insert. This matters most for uploadAvatarFile's fixed
 * per-user path (`{user_id}/avatar.glb`, replaced via upsert:true on every
 * re-upload, per profiles.ts): a plain insert on a second upload would
 * either fail outright (primary-key violation) or, if that were somehow
 * ignored, leave the FIRST upload's orientation row in place to be read
 * back against the new model — "my new avatar renders sideways because of
 * my old avatar's leftover rotation setting" (see the design doc's §8
 * gotcha and 0043_model_orientation.sql). Map-asset uploads don't have this
 * exposure (a fresh UUID path every time), but upserting is exactly as
 * correct there too, so one function covers both callers.
 */
export async function setForwardOffsetDeg(
  supabase: SupabaseClient,
  modelUrl: string,
  forwardOffsetDeg: number
): Promise<void> {
  const { error } = await supabase.from("model_orientation").upsert({
    model_url: modelUrl,
    forward_offset_deg: forwardOffsetDeg,
    updated_at: new Date().toISOString(),
  });

  if (error) throw error;
}
