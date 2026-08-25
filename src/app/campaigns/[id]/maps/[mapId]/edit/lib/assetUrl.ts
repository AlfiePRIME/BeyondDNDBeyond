import {
  getForwardOffsetsForUrls,
  getMapAssetSignedUrl,
  type MapAsset,
  type SupabaseClient,
} from "@/data-access";

/** A campaign asset with its model resolved to a loadable URL (or null for
 * "couldn't resolve" — scene-3d renders its placeholder prop for that). */
export interface PaletteAsset extends MapAsset {
  url: string | null;
  /** Stored forward-direction correction (model_orientation, keyed by
   * model_ref — see docs/design/model-orientation-and-posing.md §8),
   * applied as an extra Y rotation when PlacedObject renders this asset. 0
   * (no correction) for every asset with no stored row, which is every
   * asset that predates this feature — nothing regresses. */
  forwardOffsetDeg: number;
}

// Same known limitation (deliberate) as the room's avatar-url resolution:
// no refresh before expiry — an editor tab left open past this window shows
// placeholder props for custom assets until reload.
const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

/**
 * Resolves every palette asset to a URL scene-3d can load directly: presets
 * are public paths already, customs need a signed URL for the private
 * map-assets bucket. Failed signing degrades to null rather than throwing,
 * so one bad asset can't take down the editor.
 *
 * Also resolves each asset's stored forward-direction offset in one batched
 * lookup, keyed by model_ref (the stable path both preset and custom rows
 * already store) rather than the final `url` below — a custom asset's url
 * is a freshly-signed, per-call string that would never match a previous
 * model_orientation row. Same "one bad thing can't take down the editor"
 * posture as the per-asset signing: a failed lookup degrades to "no
 * offsets" (everything renders with today's uncorrected default) instead of
 * throwing.
 */
export async function resolvePaletteAssets(
  supabase: SupabaseClient,
  assets: MapAsset[]
): Promise<PaletteAsset[]> {
  const forwardOffsetByModelRef = await getForwardOffsetsForUrls(
    supabase,
    assets.map((asset) => asset.model_ref)
  ).catch(() => new Map<string, number>());

  return Promise.all(
    assets.map(async (asset) => {
      const forwardOffsetDeg = forwardOffsetByModelRef.get(asset.model_ref) ?? 0;
      if (asset.source_type === "preset") return { ...asset, url: asset.model_ref, forwardOffsetDeg };
      try {
        return {
          ...asset,
          url: await getMapAssetSignedUrl(supabase, asset.model_ref, SIGNED_URL_TTL_SECONDS),
          forwardOffsetDeg,
        };
      } catch {
        return { ...asset, url: null, forwardOffsetDeg };
      }
    })
  );
}
