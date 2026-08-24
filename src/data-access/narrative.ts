import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The narrative content a DM builds a campaign's world out of (Prompt 32):
 * NPCs, a wiki-style lore section, quests, a session log, revealable
 * handouts, and DM-only notes. Every write here goes through the DM-only
 * RLS policies added in 0020 — there's no client-side role check to
 * duplicate, but a non-DM caller gets a Postgres RLS error rather than a
 * friendly message, same tradeoff as mapObjects.ts.
 */

export interface Npc {
  id: string;
  campaign_id: string;
  name: string;
  description: string | null;
  portrait_ref: string | null;
  relationship_notes: string | null;
  created_at: string;
}

export async function listNpcs(supabase: SupabaseClient, campaignId: string): Promise<Npc[]> {
  const { data, error } = await supabase
    .from("npcs")
    .select()
    .eq("campaign_id", campaignId)
    .order("name", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function createNpc(
  supabase: SupabaseClient,
  params: { campaignId: string; name: string; description?: string; portraitRef?: string; relationshipNotes?: string }
): Promise<Npc> {
  const { data, error } = await supabase
    .from("npcs")
    .insert({
      campaign_id: params.campaignId,
      name: params.name.trim(),
      description: params.description ?? null,
      portrait_ref: params.portraitRef ?? null,
      relationship_notes: params.relationshipNotes ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export type UpdateNpcPatch = Partial<Pick<Npc, "name" | "description" | "portrait_ref" | "relationship_notes">>;

export async function updateNpc(supabase: SupabaseClient, npcId: string, patch: UpdateNpcPatch): Promise<Npc> {
  const { data, error } = await supabase.from("npcs").update(patch).eq("id", npcId).select().single();

  if (error) throw error;
  return data;
}

export async function deleteNpc(supabase: SupabaseClient, npcId: string): Promise<void> {
  const { error } = await supabase.from("npcs").delete().eq("id", npcId);
  if (error) throw error;
}

const PORTRAIT_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Uploads an NPC portrait to the npc-portraits bucket (0021) and returns the
 * object path to store as portrait_ref. Same fresh-unique-path-per-upload
 * scheme as uploadMapAssetFile — a campaign accumulates many portraits, and
 * two uploads with the same source filename must not overwrite each other.
 * The bucket only admits the three image MIME types below; anything else is
 * rejected here before a doomed network round-trip.
 */
export async function uploadNpcPortraitFile(
  supabase: SupabaseClient,
  campaignId: string,
  file: File
): Promise<string> {
  const extension = PORTRAIT_EXTENSIONS[file.type];
  if (!extension) throw new Error(`Unsupported portrait type: ${file.type || "unknown"}`);

  const path = `${campaignId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from("npc-portraits")
    .upload(path, file, { contentType: file.type });

  if (error) throw error;
  return path;
}

/**
 * Signed download URL for an NPC portrait — same private-bucket signed-URL
 * model (and no-auto-refresh expiry caveat) as getMapAssetSignedUrl; the
 * bucket's RLS limits reads to the owning campaign's members.
 */
export async function getNpcPortraitSignedUrl(
  supabase: SupabaseClient,
  path: string,
  expiresInSeconds: number
): Promise<string> {
  const { data, error } = await supabase.storage
    .from("npc-portraits")
    .createSignedUrl(path, expiresInSeconds);

  if (error) throw error;
  return data.signedUrl;
}

export interface LorePage {
  id: string;
  campaign_id: string;
  title: string;
  body: string | null;
  created_at: string;
}

export async function listLorePages(supabase: SupabaseClient, campaignId: string): Promise<LorePage[]> {
  const { data, error } = await supabase
    .from("lore_pages")
    .select()
    .eq("campaign_id", campaignId)
    .order("title", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function createLorePage(
  supabase: SupabaseClient,
  params: { campaignId: string; title: string; body?: string }
): Promise<LorePage> {
  const { data, error } = await supabase
    .from("lore_pages")
    .insert({ campaign_id: params.campaignId, title: params.title.trim(), body: params.body ?? null })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateLorePage(
  supabase: SupabaseClient,
  pageId: string,
  patch: Partial<Pick<LorePage, "title" | "body">>
): Promise<LorePage> {
  const { data, error } = await supabase.from("lore_pages").update(patch).eq("id", pageId).select().single();

  if (error) throw error;
  return data;
}

export async function deleteLorePage(supabase: SupabaseClient, pageId: string): Promise<void> {
  const { error } = await supabase.from("lore_pages").delete().eq("id", pageId);
  if (error) throw error;
}

export interface LorePageLink {
  from_page_id: string;
  to_page_id: string;
}

/** Links in either direction touching this page — a simple wiki doesn't
 * distinguish "pages this links to" from "pages that link here" in its UI. */
export async function listLorePageLinks(supabase: SupabaseClient, pageId: string): Promise<LorePageLink[]> {
  const { data, error } = await supabase
    .from("lore_page_links")
    .select()
    .or(`from_page_id.eq.${pageId},to_page_id.eq.${pageId}`);

  if (error) throw error;
  return data ?? [];
}

/**
 * Every link in the campaign in one query — for an index screen showing each
 * page's links without a per-page listLorePageLinks round-trip. Filtering on
 * the from page's campaign_id alone is sufficient: links between pages of
 * different campaigns can't exist in practice (writes require DM rights over
 * both pages), so from-side membership implies to-side membership.
 */
export async function listLorePageLinksForCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<LorePageLink[]> {
  const { data, error } = await supabase
    .from("lore_page_links")
    .select("from_page_id, to_page_id, from_page:lore_pages!from_page_id!inner(campaign_id)")
    .eq("from_page.campaign_id", campaignId);

  if (error) throw error;
  return (data ?? []).map((row) => ({ from_page_id: row.from_page_id, to_page_id: row.to_page_id }));
}

/** Enforced by lore_page_links' INSERT RLS policy (0020): the caller must be
 * the DM of both pages' campaign (in practice, always the same campaign). */
export async function linkLorePages(supabase: SupabaseClient, fromPageId: string, toPageId: string): Promise<void> {
  const { error } = await supabase
    .from("lore_page_links")
    .insert({ from_page_id: fromPageId, to_page_id: toPageId });

  if (error) throw error;
}

export async function unlinkLorePages(supabase: SupabaseClient, fromPageId: string, toPageId: string): Promise<void> {
  const { error } = await supabase
    .from("lore_page_links")
    .delete()
    .eq("from_page_id", fromPageId)
    .eq("to_page_id", toPageId);

  if (error) throw error;
}

export const QUEST_STATUSES = ["active", "completed", "abandoned"] as const;

export type QuestStatus = (typeof QUEST_STATUSES)[number];

export interface Quest {
  id: string;
  campaign_id: string;
  title: string;
  description: string | null;
  status: QuestStatus;
  created_at: string;
}

export async function listQuests(supabase: SupabaseClient, campaignId: string): Promise<Quest[]> {
  const { data, error } = await supabase
    .from("quests")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function createQuest(
  supabase: SupabaseClient,
  params: { campaignId: string; title: string; description?: string }
): Promise<Quest> {
  const { data, error } = await supabase
    .from("quests")
    .insert({ campaign_id: params.campaignId, title: params.title.trim(), description: params.description ?? null })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateQuest(
  supabase: SupabaseClient,
  questId: string,
  patch: Partial<Pick<Quest, "title" | "description">>
): Promise<Quest> {
  const { data, error } = await supabase.from("quests").update(patch).eq("id", questId).select().single();

  if (error) throw error;
  return data;
}

export async function setQuestStatus(supabase: SupabaseClient, questId: string, status: QuestStatus): Promise<Quest> {
  const { data, error } = await supabase.from("quests").update({ status }).eq("id", questId).select().single();

  if (error) throw error;
  return data;
}

export async function deleteQuest(supabase: SupabaseClient, questId: string): Promise<void> {
  const { error } = await supabase.from("quests").delete().eq("id", questId);
  if (error) throw error;
}

export interface SessionLogEntry {
  id: string;
  campaign_id: string;
  label: string | null;
  recap: string | null;
  created_at: string;
}

export async function listSessionLogEntries(supabase: SupabaseClient, campaignId: string): Promise<SessionLogEntry[]> {
  const { data, error } = await supabase
    .from("session_log")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function createSessionLogEntry(
  supabase: SupabaseClient,
  params: { campaignId: string; label?: string; recap?: string }
): Promise<SessionLogEntry> {
  const { data, error } = await supabase
    .from("session_log")
    .insert({ campaign_id: params.campaignId, label: params.label ?? null, recap: params.recap ?? null })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateSessionLogEntry(
  supabase: SupabaseClient,
  entryId: string,
  patch: Partial<Pick<SessionLogEntry, "label" | "recap">>
): Promise<SessionLogEntry> {
  const { data, error } = await supabase.from("session_log").update(patch).eq("id", entryId).select().single();

  if (error) throw error;
  return data;
}

export async function deleteSessionLogEntry(supabase: SupabaseClient, entryId: string): Promise<void> {
  const { error } = await supabase.from("session_log").delete().eq("id", entryId);
  if (error) throw error;
}

export interface Handout {
  id: string;
  campaign_id: string;
  title: string;
  reference: string | null;
  revealed: boolean;
  created_at: string;
}

/** DM-only read (0020 RLS) — this always returns every handout, revealed or
 * not, because the caller is the DM; a player-facing list should call this
 * through a DM-authenticated context only, or rely on RLS to filter for a
 * player's own client (which naturally sees only revealed rows). */
export async function listHandouts(supabase: SupabaseClient, campaignId: string): Promise<Handout[]> {
  const { data, error } = await supabase
    .from("handouts")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function createHandout(
  supabase: SupabaseClient,
  params: { campaignId: string; title: string; reference?: string }
): Promise<Handout> {
  const { data, error } = await supabase
    .from("handouts")
    .insert({ campaign_id: params.campaignId, title: params.title.trim(), reference: params.reference ?? null })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function setHandoutRevealed(
  supabase: SupabaseClient,
  handoutId: string,
  revealed: boolean
): Promise<Handout> {
  const { data, error } = await supabase
    .from("handouts")
    .update({ revealed })
    .eq("id", handoutId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteHandout(supabase: SupabaseClient, handoutId: string): Promise<void> {
  const { error } = await supabase.from("handouts").delete().eq("id", handoutId);
  if (error) throw error;
}

export interface DmNote {
  id: string;
  campaign_id: string;
  body: string | null;
  created_at: string;
}

/** DM-only, enforced by dm_notes' SELECT RLS policy (0020) — a non-DM caller
 * gets zero rows back, not an error (Postgres RLS filters silently). */
export async function listDmNotes(supabase: SupabaseClient, campaignId: string): Promise<DmNote[]> {
  const { data, error } = await supabase
    .from("dm_notes")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function createDmNote(supabase: SupabaseClient, params: { campaignId: string; body?: string }): Promise<DmNote> {
  const { data, error } = await supabase
    .from("dm_notes")
    .insert({ campaign_id: params.campaignId, body: params.body ?? null })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateDmNote(supabase: SupabaseClient, noteId: string, body: string): Promise<DmNote> {
  const { data, error } = await supabase.from("dm_notes").update({ body }).eq("id", noteId).select().single();

  if (error) throw error;
  return data;
}

export async function deleteDmNote(supabase: SupabaseClient, noteId: string): Promise<void> {
  const { error } = await supabase.from("dm_notes").delete().eq("id", noteId);
  if (error) throw error;
}
