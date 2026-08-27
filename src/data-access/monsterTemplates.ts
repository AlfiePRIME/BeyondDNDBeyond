import type { SupabaseClient } from "@supabase/supabase-js";
import type { MonsterAttack } from "./monsterStatBlocks";
import type { TokenAllegiance } from "./mapTokens";

/**
 * Weather & Enemies C5: the enemy template library — a single, GLOBAL,
 * shared list every campaign reads from (migration 0073), the first
 * non-campaign-scoped content table in this codebase. Deliberately the
 * SAME attacks shape monster_stat_blocks (0038) already uses
 * (MonsterAttack), so a template's stats copy into a campaign's own
 * monster_stat_blocks row with no reshaping. Read-only from the app's
 * perspective today: writes are gated server-side to an app admin
 * (public.is_app_admin(), AI Backend & Admin D1) — there is no
 * create/update/delete here because no in-app admin UI exists yet to call
 * them; content is seeded directly by the migration.
 */
export interface MonsterTemplate {
  id: string;
  name: string;
  /** Matches TOKEN_ALLEGIANCES (map_tokens.allegiance) — a real per-
   * template value (goblins/daemons/demons/witches/zombies default
   * 'hostile'; traders/guards/high guards default 'neutral'), copied onto
   * a campaign's monster_stat_blocks row when a DM adds this template
   * (createMonsterStatBlockFromTemplate) so a quick-added token gets a
   * sensible default allegiance instead of every NPC placement's
   * historical hardcoded 'hostile' (placeNpcToken). */
  default_allegiance: TokenAllegiance;
  max_hp: number;
  armor_class: number;
  passive_perception: number;
  attacks: MonsterAttack[];
  description: string;
  /** Weather & Enemies C6 (migration 0074): a LIVE pointer into
   * asset_library — the model MapSurface.tsx renders for any token backed
   * by a monster_stat_block that links back to this template
   * (monster_stat_blocks.template_id). Deliberately NOT copied at
   * quick-add time the way stats are (createMonsterStatBlockFromTemplate):
   * if an admin changes this later, every campaign already using this
   * template picks up the new appearance automatically. Nullable — a
   * template with no model set (shouldn't happen for any of C5's 8 seeded
   * rows, but possible for a future admin-authored one) simply renders no
   * distinct model, falling back to the flat allegiance disc like any
   * other unlinked NPC. */
  default_asset_id: string | null;
  created_at: string;
}

/** Every global template, alphabetical — open to any authenticated user
 * per 0073's SELECT policy (not DM-gated at the RLS layer, even though the
 * only current caller, MonsterPanel, is a DM-only page). */
export async function listMonsterTemplates(supabase: SupabaseClient): Promise<MonsterTemplate[]> {
  const { data, error } = await supabase
    .from("monster_templates")
    .select()
    .order("name", { ascending: true });

  if (error) throw error;
  return (data ?? []) as MonsterTemplate[];
}
