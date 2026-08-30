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
  /** "Objects so tokens can stand on top of them": this model's own
   * auto-measured real top-surface height (see
   * 0105_standable_surface_height.sql and src/scene-3d/standableSurface.ts),
   * in the SAME cell-relative units crossingSurface.ts's SURFACE_HEIGHT_BY_URL
   * constants use — null until some client has actually measured it (never
   * DM-entered), which is every model before this feature existed. */
  standable_surface_height: number | null;
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

/**
 * "Objects so tokens can stand on top of them": batched read for N model
 * paths' own auto-measured standable_surface_height, keyed by model_url —
 * the SAME shape/contract as getForwardOffsetsForUrls just above, but
 * DELIBERATELY A SEPARATE QUERY rather than one combined
 * "select every column resolvePaletteAssets needs" read: this column is
 * newer than forward_offset_deg (0105_standable_surface_height.sql, added
 * long after 0043_model_orientation.sql shipped), so a live database that
 * hasn't run that migration YET (per the project owner's own "hold every
 * migration in this batch" instruction, real windows of exactly this exist)
 * would otherwise fail resolvePaletteAssets' whole orientation read with an
 * unrecognized-column error and — since a single combined query fails or
 * succeeds as one unit — silently zero out the COMPLETELY UNRELATED,
 * already-shipped forward_offset_deg correction for every asset too, a real
 * regression risk for a feature this one had nothing to do with. Two
 * independent queries (and, in resolvePaletteAssets, two independently
 * `.catch()`-guarded calls) means a standable-height read failing can never
 * take the orientation-offset read down with it.
 *
 * A url missing from the result (no stored row, or the stored row's
 * standable_surface_height is still null/"not yet measured") both mean the
 * same thing to a caller — nothing to add — so both are simply absent from
 * the returned map, the same "missing means unknown, apply your own
 * default" contract getForwardOffsetsForUrls already uses.
 */
export async function getStandableSurfaceHeightsForUrls(
  supabase: SupabaseClient,
  modelUrls: readonly string[]
): Promise<Map<string, number>> {
  const uniqueUrls = Array.from(new Set(modelUrls));
  if (uniqueUrls.length === 0) return new Map();

  const { data, error } = await supabase
    .from("model_orientation")
    .select("model_url, standable_surface_height")
    .in("model_url", uniqueUrls);

  if (error) throw error;
  return new Map(
    (data ?? [])
      .filter((row): row is { model_url: string; standable_surface_height: number } => row.standable_surface_height !== null)
      .map((row) => [row.model_url, row.standable_surface_height])
  );
}

/**
 * Persists a freshly-measured standable surface height for one resolved
 * model path — an upsert, like setForwardOffsetDeg, and for the same
 * reason: the first DM to mark ANY asset standable might not be the first
 * to have already uploaded it (a preset, or an upload from before this
 * feature existed, both already have a model_orientation row for their
 * forward_offset_deg alone) — this must update that existing row's new
 * column, never fail or silently create a duplicate. Deliberately omits
 * forward_offset_deg from the payload so an upsert on an existing row never
 * clobbers that column back to its own default (Postgres upsert only
 * overwrites the columns actually present in the payload).
 *
 * Called by any connected client the first time it measures a given
 * asset's real geometry (src/scene-3d/standableSurface.ts) — never
 * DM-gated, riding model_orientation's own deliberately-open write policy
 * (0043_model_orientation.sql's own doc comment: "writes... ride alongside
 * the existing insert/update rather than needing new RLS logic of its
 * own" — here, there's no upload happening at all, just an idempotent,
 * content-derived measurement any authenticated client can reproduce
 * identically).
 */
export async function setStandableSurfaceHeight(
  supabase: SupabaseClient,
  modelUrl: string,
  standSurfaceHeight: number
): Promise<void> {
  const { error } = await supabase.from("model_orientation").upsert({
    model_url: modelUrl,
    standable_surface_height: standSurfaceHeight,
    updated_at: new Date().toISOString(),
  });

  if (error) throw error;
}
