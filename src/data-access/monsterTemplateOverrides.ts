import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Weather & Enemies C7: a DM's per-campaign override of a monster_template's
 * (0073) default 3D appearance (default_asset_id, C6/0074) — see
 * 0075_monster_template_overrides.sql's own header comment for the full
 * reasoning. This is the SECOND, campaign-scoped link in C6's live-pointer
 * chain: MapSurface's token-model resolution (GameRoom.tsx) now checks THIS
 * table first, falling back to the template's own default_asset_id only
 * when the current campaign has no row here — completely independent of,
 * and never touching, another campaign's own rendering of the same
 * template.
 *
 * At most one row per (campaign_id, monster_template_id) — 0075's unique
 * constraint — so setting a NEW override for a template that already has
 * one replaces it (see setMonsterTemplateOverride's upsert) rather than
 * accumulating history no UI ever needs.
 */
export interface MonsterTemplateOverride {
  id: string;
  campaign_id: string;
  monster_template_id: string;
  /** Always a 'custom' asset_library row already scoped to this same
   * campaign_id — enforced at the RLS layer (0075's INSERT/UPDATE checks),
   * not just trusted here. */
  custom_asset_id: string;
  created_at: string;
}

/**
 * Every override currently set for one campaign — read alongside
 * monster_templates/asset_library, the same way GameRoom.tsx already reads
 * those two for C6's token-model resolution; this is the third id-keyed
 * lookup that resolution now needs (campaign override first, the
 * template's own default_asset_id as the fallback).
 */
export async function listMonsterTemplateOverridesForCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<MonsterTemplateOverride[]> {
  const { data, error } = await supabase
    .from("campaign_monster_template_overrides")
    .select()
    .eq("campaign_id", campaignId);

  if (error) throw error;
  return (data ?? []) as MonsterTemplateOverride[];
}

/**
 * Sets (or replaces) this campaign's override for one template — an upsert
 * on the (campaign_id, monster_template_id) unique pair (0075), so
 * uploading a second replacement model for a template that already has one
 * swaps the link rather than erroring on the existing row. DM-only,
 * enforced by 0075's INSERT/UPDATE RLS (which also re-checks that
 * customAssetId actually names a 'custom' asset already belonging to this
 * same campaignId, not just any asset_library row).
 */
export async function setMonsterTemplateOverride(
  supabase: SupabaseClient,
  params: { campaignId: string; templateId: string; customAssetId: string }
): Promise<MonsterTemplateOverride> {
  const { data, error } = await supabase
    .from("campaign_monster_template_overrides")
    .upsert(
      {
        campaign_id: params.campaignId,
        monster_template_id: params.templateId,
        custom_asset_id: params.customAssetId,
      },
      { onConflict: "campaign_id,monster_template_id" }
    )
    .select()
    .single();

  if (error) throw error;
  return data as MonsterTemplateOverride;
}

/**
 * Removes this campaign's override for one template. MapSurface's
 * token-model resolution falls straight back to the template's own
 * default_asset_id (C6) on the very next render — no other write needed,
 * and the underlying custom asset itself is left untouched in
 * asset_library (it may still be placed elsewhere on a map as an ordinary
 * prop).
 */
export async function deleteMonsterTemplateOverride(
  supabase: SupabaseClient,
  params: { campaignId: string; templateId: string }
): Promise<void> {
  const { error } = await supabase
    .from("campaign_monster_template_overrides")
    .delete()
    .eq("campaign_id", params.campaignId)
    .eq("monster_template_id", params.templateId);

  if (error) throw error;
}
