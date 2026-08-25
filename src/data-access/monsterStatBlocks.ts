import type { SupabaseClient } from "@supabase/supabase-js";

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
