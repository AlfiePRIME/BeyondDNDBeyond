import type { SupabaseClient } from "@supabase/supabase-js";

/** Disambiguates a stored dice-tray preference: the built-in procedural
 * tray (DiceTumble.tsx's own DiceTray mesh — every member's only option
 * today), or a custom uploaded model referenced by `assetId`. The
 * avatar_source/asset_library precedent (profiles.ts's AvatarSource,
 * assets.ts's AssetSourceType), not seat_offset's plain jsonb shape: unlike
 * a seat offset, "which model" here is a real foreign key into
 * asset_library, not a same-shaped numeric triple.
 */
export type DiceTrayModelSource = "default" | "custom";

/**
 * One member's own persisted dice-tray-model choice for one campaign — see
 * 0045_dice_tray_preference.sql for why this lives on campaign_members
 * (the same per-(campaign_id, user_id) grain seat_offset already
 * established) rather than a global, cross-campaign profile setting: a
 * custom tray model is a row in THAT campaign's own asset_library (0014),
 * so the preference pointing at it only makes sense scoped to that same
 * campaign.
 *
 * `assetId` is `asset_library.id` when `source` is "custom", and always
 * null when `source` is "default" — the same paired-nullability invariant
 * the migration's CHECK constraint enforces at the database level, mirrored
 * here as a TypeScript-level shape so a caller can't construct an
 * inconsistent value in the first place.
 */
export interface DiceTrayModelPreference {
  source: DiceTrayModelSource;
  assetId: string | null;
}

/** Every existing member, and any member who has never chosen a tray model,
 * renders with this — exactly today's only tray (DiceTumble.tsx's
 * procedural DiceTray), so nothing regresses. */
export const DEFAULT_DICE_TRAY_PREFERENCE: DiceTrayModelPreference = {
  source: "default",
  assetId: null,
};

/**
 * The caller's own stored dice-tray preference for one campaign, or the
 * default (procedural tray) if they've never chosen one — the same
 * "row absent/null means default" shape getSeatOffset and
 * getForwardOffsetDeg already use.
 */
export async function getDiceTrayPreference(
  supabase: SupabaseClient,
  campaignId: string,
  userId: string
): Promise<DiceTrayModelPreference> {
  const { data, error } = await supabase
    .from("campaign_members")
    .select("dice_tray_source, dice_tray_asset_id")
    .eq("campaign_id", campaignId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.dice_tray_source) return DEFAULT_DICE_TRAY_PREFERENCE;
  return {
    source: data.dice_tray_source as DiceTrayModelSource,
    assetId: data.dice_tray_asset_id ?? null,
  };
}

/**
 * Batched read for a whole campaign's roster at once, keyed by user_id —
 * the getSeatOffsetsForCampaign shape: rendering a room full of personal
 * trays (Prompt 8b) needs one round trip, not one per member. A member with
 * no stored preference (or one explicitly reset to "default") is simply
 * absent from the returned map; callers treat a lookup miss the same as
 * DEFAULT_DICE_TRAY_PREFERENCE, via Map.get's own undefined-on-miss.
 */
export async function getDiceTrayPreferencesForCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<Map<string, DiceTrayModelPreference>> {
  const { data, error } = await supabase
    .from("campaign_members")
    .select("user_id, dice_tray_source, dice_tray_asset_id")
    .eq("campaign_id", campaignId)
    .not("dice_tray_source", "is", null);

  if (error) throw error;
  return new Map(
    (data ?? []).map((row) => [
      row.user_id as string,
      {
        source: row.dice_tray_source as DiceTrayModelSource,
        assetId: (row.dice_tray_asset_id as string | null) ?? null,
      },
    ])
  );
}

/**
 * Saves (or, passing null, clears back to the default procedural tray) the
 * caller's own dice-tray preference for one campaign. A plain UPDATE on
 * their already-existing campaign_members row, the exact setSeatOffset
 * shape and reasoning: that row is always created at join time, well before
 * any tray preference could ever be set, so there's never a missing row to
 * insert here.
 *
 * Goes through campaign_members' existing "a member can update their own
 * membership row" RLS policy (0004) — see 0045_dice_tray_preference.sql for
 * why no new policy is needed. Zero rows affected means either
 * campaignId/userId doesn't name a real membership row, or RLS blocked a
 * write to someone else's row; either way that's a real error, not a
 * silent no-op, so this throws rather than returning normally — the
 * setSeatOffset/renameCampaign/setHouseRules convention.
 *
 * Validates the paired source/assetId invariant client-side too (not just
 * relying on the migration's CHECK constraint) so a caller gets an
 * immediate, specific error instead of an opaque Postgres constraint
 * violation.
 *
 * A "default" preference (explicit or via `null`) is always written as
 * NULL/NULL, not the literal string 'default' — the same "row absent means
 * default" representation getSeatOffset's null column already uses, so
 * there's exactly one on-disk shape for "no override" rather than two
 * (NULL vs. an explicit 'default' row) that would otherwise both read back
 * identically anyway.
 */
export async function setDiceTrayPreference(
  supabase: SupabaseClient,
  campaignId: string,
  userId: string,
  preference: DiceTrayModelPreference | null
): Promise<void> {
  const resolved = preference ?? DEFAULT_DICE_TRAY_PREFERENCE;
  if (resolved.source === "custom" && !resolved.assetId) {
    throw new Error("A custom dice tray preference must include an assetId.");
  }
  if (resolved.source === "default" && resolved.assetId) {
    throw new Error("The default dice tray preference must not include an assetId.");
  }
  const isDefault = resolved.source === "default";

  const { error, count } = await supabase
    .from("campaign_members")
    .update(
      {
        dice_tray_source: isDefault ? null : resolved.source,
        dice_tray_asset_id: isDefault ? null : resolved.assetId,
      },
      { count: "exact" }
    )
    .eq("campaign_id", campaignId)
    .eq("user_id", userId);

  if (error) throw error;
  if (count === 0) {
    throw new Error(
      "Could not save this dice tray preference — you may not be a member of this campaign."
    );
  }
}
