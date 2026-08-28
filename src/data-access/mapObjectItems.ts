import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConditionKey } from "@/rules-engine";

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
 * not a weapon/armor stat block.
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
  /** Map Editor Batch A5: null (A4's original shape, and every pre-A5 row)
   * means not hidden — always visible once the container is opened, exactly
   * A4's behavior. A number is the passive-Perception DC a VIEWING
   * character's own passive Perception must meet or beat, computed
   * per-viewer in the Game Room (see vision.ts's isItemVisibleToCharacter),
   * NOT a stored per-viewer reveal flag — see this column's own migration
   * comment for why nothing needs to be persisted per (item, character)
   * pair. */
  hidden_dc: number | null;
  /** Map Editor Batch A9: the item's curse/blessing configuration, or null
   * for a plain (unenchanted) item — see CurseBlessing's own doc comment. */
  curse_blessing: CurseBlessing | null;
  created_at: string;
}

export type CurseBlessingKind = "cursed" | "blessed";
export type CurseBlessingResolution = "mechanical" | "narrative";

/**
 * Exactly one mechanical effect — reuses the app's REAL condition/HP/
 * resource systems (conditions.ts's applyCondition, characters.ts's
 * applyHpDelta, characterResources.ts's applyResourceDelta), never a
 * bespoke curse-only mechanic, per the project owner's explicit
 * instruction. `resourceName` (not a resourceId) because the DM configures
 * this before any specific taking character exists — a character_resources
 * row belonging to whoever eventually takes the item doesn't exist yet at
 * authoring time. It's matched by name, case-insensitively, against the
 * TAKING character's own resources at pickup time (see
 * apply_character_resource_delta) — the same "flavor loot, not a rigid
 * stat block" posture the rest of this table already has.
 */
export type CurseBlessingEffect =
  | { kind: "condition"; conditionKey: ConditionKey }
  | { kind: "hp_delta"; delta: number }
  | { kind: "resource_delta"; resourceName: string; delta: number };

/**
 * Map Editor Batch A9: the structured payload map_object_items.curse_blessing
 * (added, unpopulated, by A4's own migration 0060) actually holds once this
 * prompt populates it. `effect` is null for a narrative resolution (a
 * mechanical resolution always has exactly one). `telegraphed` is
 * independent of kind/resolution — the DM's own opt-in to show a plain
 * warning hint on the item BEFORE it's taken (see ContainerPanel), against
 * the default of a curse/blessing being discovered only once triggered,
 * matching concealed pits' own "DM-only-known until sprung" precedent.
 */
export interface CurseBlessing {
  kind: CurseBlessingKind;
  resolution: CurseBlessingResolution;
  effect: CurseBlessingEffect | null;
  telegraphed: boolean;
}

/** The map editor's own item-editing panel draft shape — every field a
 * plain string/boolean so it can back controlled form inputs directly,
 * converted to/from the real CurseBlessing payload only at save/load time
 * (draftToCurseBlessing/curseBlessingToDraft below). `effectKind` and the
 * per-effect fields are all kept, populated or not, regardless of which one
 * is currently selected — switching the dropdown back and forth never loses
 * whatever the DM already typed into the others. */
export interface CurseBlessingDraft {
  enabled: boolean;
  kind: CurseBlessingKind;
  resolution: CurseBlessingResolution;
  effectKind: CurseBlessingEffect["kind"];
  conditionKey: ConditionKey;
  hpDelta: string;
  resourceName: string;
  resourceDelta: string;
  telegraphed: boolean;
}

export const DEFAULT_CURSE_BLESSING_DRAFT: CurseBlessingDraft = {
  enabled: false,
  kind: "cursed",
  resolution: "narrative",
  effectKind: "hp_delta",
  conditionKey: "poisoned",
  hpDelta: "-1",
  resourceName: "",
  resourceDelta: "-1",
  telegraphed: false,
};

/** Whether `draft` can be saved as-is — gates the editor's Add/Save button.
 * A disabled (not enabled) draft is always valid (it becomes a plain null
 * curse_blessing); a narrative or condition-effect draft is always valid
 * once a kind is picked (every dropdown always has a selected value); an
 * hp_delta/resource_delta draft needs its numeric field to actually parse,
 * and resource_delta additionally needs a non-blank resource name to match
 * against. */
export function isCurseBlessingDraftValid(draft: CurseBlessingDraft): boolean {
  if (!draft.enabled || draft.resolution !== "mechanical") return true;
  if (draft.effectKind === "hp_delta") {
    return draft.hpDelta.trim() !== "" && Number.isFinite(Number(draft.hpDelta));
  }
  if (draft.effectKind === "resource_delta") {
    return (
      draft.resourceName.trim() !== "" &&
      draft.resourceDelta.trim() !== "" &&
      Number.isFinite(Number(draft.resourceDelta))
    );
  }
  return true;
}

/** Converts a (valid — see isCurseBlessingDraftValid) draft into the real
 * persisted shape, or null when the DM has left curse/blessing off. */
export function draftToCurseBlessing(draft: CurseBlessingDraft): CurseBlessing | null {
  if (!draft.enabled) return null;
  const effect: CurseBlessingEffect | null =
    draft.resolution !== "mechanical"
      ? null
      : draft.effectKind === "condition"
        ? { kind: "condition", conditionKey: draft.conditionKey }
        : draft.effectKind === "hp_delta"
          ? { kind: "hp_delta", delta: Number(draft.hpDelta) }
          : { kind: "resource_delta", resourceName: draft.resourceName.trim(), delta: Number(draft.resourceDelta) };
  return { kind: draft.kind, resolution: draft.resolution, effect, telegraphed: draft.telegraphed };
}

/** The inverse of draftToCurseBlessing — populates the editor's form when
 * opening an existing item for editing (or DEFAULT_CURSE_BLESSING_DRAFT for
 * a plain item with none set). */
export function curseBlessingToDraft(curseBlessing: CurseBlessing | null): CurseBlessingDraft {
  if (!curseBlessing) return { ...DEFAULT_CURSE_BLESSING_DRAFT };
  return {
    enabled: true,
    kind: curseBlessing.kind,
    resolution: curseBlessing.resolution,
    effectKind: curseBlessing.effect?.kind ?? DEFAULT_CURSE_BLESSING_DRAFT.effectKind,
    conditionKey:
      curseBlessing.effect?.kind === "condition" ? curseBlessing.effect.conditionKey : DEFAULT_CURSE_BLESSING_DRAFT.conditionKey,
    hpDelta: curseBlessing.effect?.kind === "hp_delta" ? String(curseBlessing.effect.delta) : DEFAULT_CURSE_BLESSING_DRAFT.hpDelta,
    resourceName: curseBlessing.effect?.kind === "resource_delta" ? curseBlessing.effect.resourceName : "",
    resourceDelta:
      curseBlessing.effect?.kind === "resource_delta"
        ? String(curseBlessing.effect.delta)
        : DEFAULT_CURSE_BLESSING_DRAFT.resourceDelta,
    telegraphed: curseBlessing.telegraphed,
  };
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

/** A PostgREST `.in()` filter embeds every id directly in the request URL —
 * a map with enough objects (98 objects on one real campaign's town map)
 * produces a query string long enough to get 502'd by the reverse-proxy
 * chain in front of Supabase before it ever reaches Postgres. Chunking
 * keeps every single request's URL short regardless of how large a map
 * grows, at the cost of N/BATCH round trips instead of one — a trade this
 * table's read volume (one bulk read per map load/switch, not a hot path)
 * comfortably affords. */
const MAX_MAP_OBJECT_IDS_PER_QUERY = 40;

/** Every item across a whole batch of MapObjects at once — the Game Room's
 * own bulk "which of this map's objects are openable containers right now"
 * read (so a chest can be listed/opened without requiring the DM to have
 * configured a click-trigger action on it at all), player-readable for a
 * chest on the live map exactly like listContainerItems above. Returns []
 * without querying for an empty input, since `.in()` with no values is
 * otherwise a always-true/always-false footgun depending on the client.
 * Chunks mapObjectIds (see MAX_MAP_OBJECT_IDS_PER_QUERY) rather than one
 * `.in()` over the whole list — see that constant's own comment. */
export async function listItemsForMapObjects(
  supabase: SupabaseClient,
  mapObjectIds: string[]
): Promise<MapObjectItem[]> {
  if (mapObjectIds.length === 0) return [];
  const batches: string[][] = [];
  for (let i = 0; i < mapObjectIds.length; i += MAX_MAP_OBJECT_IDS_PER_QUERY) {
    batches.push(mapObjectIds.slice(i, i + MAX_MAP_OBJECT_IDS_PER_QUERY));
  }
  const results = await Promise.all(
    batches.map(async (batch) => {
      const { data, error } = await supabase.from("map_object_items").select().in("map_object_id", batch);
      if (error) throw error;
      return data ?? [];
    })
  );
  return results.flat().sort((a, b) => a.created_at.localeCompare(b.created_at));
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
    /** Map Editor Batch A5 — omitted/undefined and null both mean "not
     * hidden", matching every other optional field here. */
    hiddenDc?: number | null;
    /** Map Editor Batch A9. */
    curseBlessing?: CurseBlessing | null;
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
      hidden_dc: params.hiddenDc ?? null,
      curse_blessing: params.curseBlessing ?? null,
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
  patch: {
    name?: string;
    description?: string | null;
    icon?: string | null;
    tag?: string | null;
    /** Map Editor Batch A5 — null clears it back to not-hidden. */
    hidden_dc?: number | null;
    /** Map Editor Batch A9. */
    curse_blessing?: CurseBlessing | null;
  }
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
