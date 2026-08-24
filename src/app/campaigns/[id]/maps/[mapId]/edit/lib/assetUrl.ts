import { getMapAssetSignedUrl, type MapAsset, type SupabaseClient } from "@/data-access";

/** A campaign asset with its model resolved to a loadable URL (or null for
 * "couldn't resolve" — scene-3d renders its placeholder prop for that). */
export interface PaletteAsset extends MapAsset {
  url: string | null;
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
 */
export async function resolvePaletteAssets(
  supabase: SupabaseClient,
  assets: MapAsset[]
): Promise<PaletteAsset[]> {
  return Promise.all(
    assets.map(async (asset) => {
      if (asset.source_type === "preset") return { ...asset, url: asset.model_ref };
      try {
        return {
          ...asset,
          url: await getMapAssetSignedUrl(supabase, asset.model_ref, SIGNED_URL_TTL_SECONDS),
        };
      } catch {
        return { ...asset, url: null };
      }
    })
  );
}
