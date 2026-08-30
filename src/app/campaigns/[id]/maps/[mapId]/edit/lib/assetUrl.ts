import {
  getForwardOffsetsForUrls,
  getMapAssetSignedUrl,
  getStandableSurfaceHeightsForUrls,
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
  /** "Objects so tokens can stand on top of them": this asset's own
   * auto-measured real stand-on height (model_orientation.
   * standable_surface_height, keyed by model_ref same as forwardOffsetDeg
   * above), or null when nobody has measured it yet — every asset before
   * this feature, and any asset no DM has ever marked standable. Consumed
   * by GameRoom.tsx to resolve MapSurfaceToken/MapSurfaceObject's own
   * standSurfaceHeight for whichever cell this asset's object occupies. */
  standSurfaceHeight: number | null;
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
 * Also resolves each asset's stored forward-direction offset AND its
 * "objects so tokens can stand on top of them" measured stand-on height
 * (see PaletteAsset.standSurfaceHeight's own doc comment) — TWO independent
 * batched lookups (getForwardOffsetsForUrls, getStandableSurfaceHeightsForUrls),
 * each keyed by model_ref (the stable path both preset and custom rows
 * already store) rather than the final `url` below, since a custom asset's
 * url is a freshly-signed, per-call string that would never match a
 * previous model_orientation row. Deliberately NOT one combined query
 * against both columns — see getStandableSurfaceHeightsForUrls' own doc
 * comment for why: the standable column is newer, so a live database still
 * waiting on that one migration must never also degrade the completely
 * unrelated, already-working forward-offset lookup. Same "one bad thing
 * can't take down the editor" posture as the per-asset signing: EITHER
 * lookup failing independently degrades to "no rows" for that one thing —
 * everything renders with today's uncorrected offset default, or an
 * unmeasured (null) standable height — never both, and never a thrown error.
 */
export async function resolvePaletteAssets(
  supabase: SupabaseClient,
  assets: MapAsset[]
): Promise<PaletteAsset[]> {
  const modelRefs = assets.map((asset) => asset.model_ref);
  const [forwardOffsetByModelRef, standSurfaceHeightByModelRef] = await Promise.all([
    getForwardOffsetsForUrls(supabase, modelRefs).catch(() => new Map<string, number>()),
    getStandableSurfaceHeightsForUrls(supabase, modelRefs).catch(() => new Map<string, number>()),
  ]);

  return Promise.all(
    assets.map(async (asset) => {
      const forwardOffsetDeg = forwardOffsetByModelRef.get(asset.model_ref) ?? 0;
      const standSurfaceHeight = standSurfaceHeightByModelRef.get(asset.model_ref) ?? null;
      if (asset.source_type === "preset") {
        return { ...asset, url: asset.model_ref, forwardOffsetDeg, standSurfaceHeight };
      }
      try {
        return {
          ...asset,
          url: await getMapAssetSignedUrl(supabase, asset.model_ref, SIGNED_URL_TTL_SECONDS),
          forwardOffsetDeg,
          standSurfaceHeight,
        };
      } catch {
        return { ...asset, url: null, forwardOffsetDeg, standSurfaceHeight };
      }
    })
  );
}
