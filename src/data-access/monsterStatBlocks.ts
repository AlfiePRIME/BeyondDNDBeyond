import type { SupabaseClient } from "@supabase/supabase-js";
import type { TokenAllegiance } from "./mapTokens";

// DM NPC/monster stat blocks (Prompt 61): the lightweight, campaign-scoped
// TEMPLATE a placed token links to (map_tokens.monster_stat_block_id) and
// a combatant snapshots (combat_combatants.monster_stat_block_id) — name,
// HP, AC, passive Perception, and a small named-attacks list, deliberately
// nothing like a full character sheet. Every write goes through 0038's
// DM-only RLS (the npcs/0020 posture: members read, the DM writes); a
// non-DM caller gets a Postgres RLS error rather than a friendly message,
// the narrative.ts trade-off.

/** One stored attack: the bonus and damage ARE the numbers rolled with —
 * a stat-block attack never derives anything from ability scores or
 * proficiency, by design (the roll route uses these directly in place of
 * rules-engine attackBonus/damage computation). */
export interface MonsterAttack {
  name: string;
  bonus: number;
  damageNotation: string;
}

/** monster_stat_blocks.attacks' only schema — the column is otherwise
 * schemaless jsonb, the characters.inventory/spells arrangement. */
export interface MonsterStatBlock {
  id: string;
  campaign_id: string;
  name: string;
  max_hp: number;
  armor_class: number;
  passive_perception: number;
  attacks: MonsterAttack[];
  /** Weather & Enemies C5 (migration 0073): the allegiance a token quick-
   * added from this block should default to. 'hostile' for every
   * pre-existing, hand-authored block (the column's own DB default,
   * matching placeNpcToken's long-standing hardcoded literal exactly) —
   * createMonsterStatBlock below never sets this column, by design, so
   * freeform blocks are completely unaffected. A block created via
   * createMonsterStatBlockFromTemplate carries its template's
   * default_allegiance instead (e.g. 'neutral' for a Trader/Guard/High
   * Guard), so THOSE quick-added tokens stop defaulting to the wrong,
   * misleading hostile-red disc. */
  default_allegiance: TokenAllegiance;
  /** Weather & Enemies C6 (migration 0074): set ONLY by
   * createMonsterStatBlockFromTemplate, to the source monster_templates
   * row's id — a LIVE pointer used PURELY for visual rendering (MapSurface
   * looks up this template's own default_asset_id, fresh, every time a
   * token backed by this stat block is drawn). Completely separate from,
   * and independent of, the plain-value stat copy (max_hp/armor_class/
   * attacks/etc.) that same function performs once at creation time: if an
   * admin later changes the template's default_asset_id, this block's
   * rendered appearance updates automatically, while every stat this block
   * already copied stays exactly as it was copied — editing this block
   * (updateMonsterStatBlock) never touches template_id, and there is no
   * write path anywhere that re-syncs stats from the template after
   * creation. null for every pre-existing, hand-authored (createMonsterStatBlock)
   * block — the freeform case — so it continues rendering exactly as
   * today, the flat allegiance-colored disc. */
  template_id: string | null;
  created_at: string;
}

export async function listMonsterStatBlocks(
  supabase: SupabaseClient,
  campaignId: string
): Promise<MonsterStatBlock[]> {
  const { data, error } = await supabase
    .from("monster_stat_blocks")
    .select()
    .eq("campaign_id", campaignId)
    .order("name", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw error;
  return (data ?? []) as MonsterStatBlock[];
}

export async function createMonsterStatBlock(
  supabase: SupabaseClient,
  params: {
    campaignId: string;
    name: string;
    maxHp: number;
    armorClass: number;
    passivePerception: number;
    attacks: MonsterAttack[];
  }
): Promise<MonsterStatBlock> {
  const { data, error } = await supabase
    .from("monster_stat_blocks")
    .insert({
      campaign_id: params.campaignId,
      name: params.name.trim(),
      max_hp: params.maxHp,
      armor_class: params.armorClass,
      passive_perception: params.passivePerception,
      attacks: params.attacks,
    })
    .select()
    .single();

  if (error) throw error;
  return data as MonsterStatBlock;
}

/** Weather & Enemies C5: MonsterPanel's "add from library" action — copies
 * a global monster_templates row's stats into a BRAND NEW, fully
 * independent campaign-scoped monster_stat_blocks row. A one-time value
 * copy, never a live link for the STATS: the template itself is never
 * mutated by this (0073's RLS wouldn't allow a non-admin to anyway), and
 * editing the resulting row afterward (updateMonsterStatBlock, the ordinary
 * MonsterPanel edit form) can never reach back into the template or any
 * other campaign's own copy. Takes plain fields rather than a
 * MonsterTemplate object so this module doesn't need to import
 * monsterTemplates.ts (the caller already has the template in hand from
 * listMonsterTemplates).
 *
 * Weather & Enemies C6 (migration 0074) adds template_id, stamped here with
 * the source template's own id — UNLIKE every field above, this one IS a
 * live pointer, but purely for visual rendering (see MonsterStatBlock.
 * template_id's own doc comment): MapSurface.tsx looks up this template's
 * current default_asset_id fresh every render, so a later admin change to
 * the template's model picture updates this block's on-table appearance
 * automatically, while every stat copied above stays frozen exactly as
 * copied. */
export async function createMonsterStatBlockFromTemplate(
  supabase: SupabaseClient,
  params: {
    campaignId: string;
    templateId: string;
    name: string;
    maxHp: number;
    armorClass: number;
    passivePerception: number;
    attacks: MonsterAttack[];
    defaultAllegiance: TokenAllegiance;
  }
): Promise<MonsterStatBlock> {
  const { data, error } = await supabase
    .from("monster_stat_blocks")
    .insert({
      campaign_id: params.campaignId,
      template_id: params.templateId,
      name: params.name.trim(),
      max_hp: params.maxHp,
      armor_class: params.armorClass,
      passive_perception: params.passivePerception,
      attacks: params.attacks,
      default_allegiance: params.defaultAllegiance,
    })
    .select()
    .single();

  if (error) throw error;
  return data as MonsterStatBlock;
}

export type UpdateMonsterStatBlockPatch = Partial<
  Pick<MonsterStatBlock, "name" | "max_hp" | "armor_class" | "passive_perception" | "attacks">
>;

export async function updateMonsterStatBlock(
  supabase: SupabaseClient,
  statBlockId: string,
  patch: UpdateMonsterStatBlockPatch
): Promise<MonsterStatBlock> {
  const { data, error } = await supabase
    .from("monster_stat_blocks")
    .update(patch)
    .eq("id", statBlockId)
    .select()
    .single();

  if (error) throw error;
  return data as MonsterStatBlock;
}

/** Deleting a template leaves placed tokens/combatants as ordinary bare
 * NPCs (the FK is ON DELETE SET NULL) rather than sweeping them away. */
export async function deleteMonsterStatBlock(
  supabase: SupabaseClient,
  statBlockId: string
): Promise<void> {
  const { error } = await supabase.from("monster_stat_blocks").delete().eq("id", statBlockId);
  if (error) throw error;
}
