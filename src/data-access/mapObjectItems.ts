import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Map Editor Batch A4: a single item sitting inside a container — a chest
 * (a MapObject) or a still-concealed pit (a concealed_pits row). Exactly
 * one of map_object_id/concealed_pit_id is ever set (0060's own CHECK
 * constraint enforces this at the DB level), the same shape
 * interaction_events (Batch A6) already established for the same "either
 * kind of source" problem.
 *
 * Deliberately lightweight — name/description/icon/tag — NOT a full
 * character-sheet InventoryItem (see characters.ts): this is flavor loot,
 * not a weapon/armor stat block. curse_blessing stays null until a later
 * prompt (A9) populates it.
 */
export interface MapObjectItem {
  id: string;
  campaign_id: string;
  map_object_id: string | null;
  concealed_pit_id: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  /** Independent of map_objects.tag (Batch A6) — a separate freeform label
   * on this table, copied into interaction_events.tag when the item is
   * taken (createInteractionEvent's own `tag` param). */
  tag: string | null;
  /** Unpopulated as of Batch A4 — a later prompt (A9) defines the real
   * shape (kind/resolution/effect/telegraphed) and starts writing here. */
  curse_blessing: Record<string, unknown> | null;
  created_at: string;
}

/** Which container a call addresses — exactly one of the two, matching the
 * table's own CHECK constraint. */
export type ContainerRef =
  | { mapObjectId: string; concealedPitId?: undefined }
  | { concealedPitId: string; mapObjectId?: undefined };

/** Every item on one container, oldest first — the map editor's authoring
 * panel's own list, and the Game Room's "open this chest" read (player-
 * readable for a chest on the live map; concealed-pit items stay DM-only,
 * see 0060's own RLS comment — the Game Room instead surfaces those
 * through the DM-authoritative reveal broadcast, never this direct read). */
export async function listContainerItems(
  supabase: SupabaseClient,
  container: ContainerRef
): Promise<MapObjectItem[]> {
  const base = supabase.from("map_object_items").select();
  const filtered = container.mapObjectId
    ? base.eq("map_object_id", container.mapObjectId)
    : base.eq("concealed_pit_id", container.concealedPitId);
  const { data, error } = await filtered.order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/** Every item across a whole batch of MapObjects at once — the Game Room's
 * own bulk "which of this map's objects are openable containers right now"
 * read (so a chest can be listed/opened without requiring the DM to have
 * configured a click-trigger action on it at all), player-readable for a
 * chest on the live map exactly like listContainerItems above. Returns []
 * without querying for an empty input, since `.in()` with no values is
 * otherwise a always-true/always-false footgun depending on the client. */
export async function listItemsForMapObjects(
  supabase: SupabaseClient,
  mapObjectIds: string[]
): Promise<MapObjectItem[]> {
  if (mapObjectIds.length === 0) return [];
  const { data, error } = await supabase
    .from("map_object_items")
    .select()
    .in("map_object_id", mapObjectIds)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/** DM-only, enforced by map_object_items' own INSERT RLS (0060) — joined
 * through whichever container is given, not the campaignId param (a
 * convenience denormalization only, never itself an authorization check). */
export async function addContainerItem(
  supabase: SupabaseClient,
  params: ContainerRef & {
    campaignId: string;
    name: string;
    description?: string | null;
    icon?: string | null;
    tag?: string | null;
  }
): Promise<MapObjectItem> {
  const { data, error } = await supabase
    .from("map_object_items")
    .insert({
      campaign_id: params.campaignId,
      map_object_id: params.mapObjectId ?? null,
      concealed_pit_id: params.concealedPitId ?? null,
      name: params.name,
      description: params.description ?? null,
      icon: params.icon ?? null,
      tag: params.tag ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** DM-only, enforced by map_object_items' own UPDATE RLS (0060). */
export async function updateContainerItem(
  supabase: SupabaseClient,
  itemId: string,
  patch: { name?: string; description?: string | null; icon?: string | null; tag?: string | null }
): Promise<MapObjectItem> {
  const { data, error } = await supabase
    .from("map_object_items")
    .update(patch)
    .eq("id", itemId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** DM-only, enforced by map_object_items' own DELETE RLS (0060) — the
 * editor's authoring "Remove" action, distinct from claimContainerItem
 * below (a player taking an item in the Game Room). */
export async function removeContainerItem(supabase: SupabaseClient, itemId: string): Promise<void> {
  const { error } = await supabase.from("map_object_items").delete().eq("id", itemId);
  if (error) throw error;
}

/**
 * Takes an item: the claim_map_object_item RPC (0060) atomically removes
 * the row (SELECT ... FOR UPDATE then DELETE, so two near-simultaneous
 * takers can't both succeed — "picked up once, globally") and returns the
 * item as it was just before deletion, so the caller can build the
 * InventoryItem entry and the interaction_events row from a single round
 * trip. The DM always may; a member only for a container on the currently
 * live map (the RPC's own permission check) — the caller still has to add
 * the item to the taking character's inventory and log the interaction
 * event itself (updateCharacter / createInteractionEvent), the same
 * "persist first, then the caller's own follow-up writes" sequencing
 * handleTrigger's click-trigger path already uses.
 */
export async function claimContainerItem(
  supabase: SupabaseClient,
  itemId: string
): Promise<MapObjectItem> {
  const { data, error } = await supabase.rpc("claim_map_object_item", { p_item_id: itemId });
  if (error) throw error;
  return data;
}
