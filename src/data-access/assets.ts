import type { SupabaseClient } from "@supabase/supabase-js";

/** Disambiguates model_ref: a public /assets/presets/ path ('preset'), or a
 * storage object path in the map-assets bucket ('custom'). */
export type AssetSourceType = "preset" | "custom";

export interface MapAsset {
  id: string;
  name: string;
  source_type: AssetSourceType;
  model_ref: string;
  campaign_id: string | null;
  created_at: string;
}

/**
 * Every asset available to a campaign: the global built-in presets plus that
 * campaign's own custom uploads. RLS already hides other campaigns' custom
 * assets, but the campaign_id filter is still applied explicitly so a
 * multi-campaign member sees only this campaign's palette.
 */
export async function listAssetsForCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<MapAsset[]> {
  const { data, error } = await supabase
    .from("asset_library")
    .select()
    .or(`source_type.eq.preset,campaign_id.eq.${campaignId}`)
    // 'preset' sorts after 'custom' alphabetically, so descending puts the
    // built-ins first; uploads then appear in the order they were added.
    .order("source_type", { ascending: false })
    .order("created_at", { ascending: true })
    .order("name", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Uploads a custom map asset to the map-assets bucket and returns the object
 * path to store as model_ref. Unlike avatars' one-fixed-path-per-user
 * scheme, a campaign accumulates many assets, so each upload gets a fresh
 * unique object name — two uploads with the same source filename can't
 * silently overwrite each other.
 */
export async function uploadMapAssetFile(
  supabase: SupabaseClient,
  campaignId: string,
  file: File
): Promise<string> {
  const path = `${campaignId}/${crypto.randomUUID()}.glb`;
  const { error } = await supabase.storage
    .from("map-assets")
    .upload(path, file, { contentType: "model/gltf-binary" });

  if (error) throw error;
  return path;
}

/** DM-only, enforced by asset_library's INSERT RLS policy (0015). */
export async function createCustomAsset(
  supabase: SupabaseClient,
  params: { campaignId: string; name: string; modelRef: string }
): Promise<MapAsset> {
  const { data, error } = await supabase
    .from("asset_library")
    .insert({
      name: params.name.trim(),
      source_type: "custom",
      model_ref: params.modelRef,
      campaign_id: params.campaignId,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Signed download URL for a custom map asset object — same private-bucket
 * signed-URL model (and expiry caveat) as getAvatarSignedUrl; the bucket's
 * RLS limits reads to the owning campaign's members.
 */
export async function getMapAssetSignedUrl(
  supabase: SupabaseClient,
  path: string,
  expiresInSeconds: number
): Promise<string> {
  const { data, error } = await supabase.storage
    .from("map-assets")
    .createSignedUrl(path, expiresInSeconds);

  if (error) throw error;
  return data.signedUrl;
}
