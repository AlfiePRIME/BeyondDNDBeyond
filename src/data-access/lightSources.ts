import type { SupabaseClient } from "@supabase/supabase-js";

export const LIGHT_SOURCE_BRIGHTNESSES = ["bright", "dim"] as const;

export type LightSourceBrightness = (typeof LIGHT_SOURCE_BRIGHTNESSES)[number];

/**
 * A DM-authored light source on a map (Prompt 55, migration 0036): a radius
 * and brightness anchored to exactly one of a fixed cell (x/y), a placed
 * object (object_id — the light moves with the prop), or a token (token_id
 * — a carried torch moves with its carrier). The three-way XOR is a CHECK
 * constraint, the map_tokens character_id/npc_name pattern. RLS mirrors
 * map_cells/map_objects exactly: members read the live map's lights,
 * DM-only writes. Nothing renders illumination from these yet — the
 * perception/vision engine is Prompt 56.
 */
export interface LightSource {
  id: string;
  map_id: string;
  radius_feet: number;
  brightness: LightSourceBrightness;
  x: number | null;
  y: number | null;
  object_id: string | null;
  token_id: string | null;
  created_at: string;
}

/** Exactly one anchor — the type makes the XOR unrepresentable app-side,
 * mirroring the DB CHECK. */
export type LightSourceAnchor =
  | { kind: "cell"; x: number; y: number }
  | { kind: "object"; objectId: string }
  | { kind: "token"; tokenId: string };

export async function listLightSources(
  supabase: SupabaseClient,
  mapId: string
): Promise<LightSource[]> {
  const { data, error } = await supabase
    .from("light_sources")
    .select()
    .eq("map_id", mapId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/** DM-only via the light_sources INSERT policy (0036). */
export async function createLightSource(
  supabase: SupabaseClient,
  params: {
    mapId: string;
    radiusFeet: number;
    brightness: LightSourceBrightness;
    anchor: LightSourceAnchor;
  }
): Promise<LightSource> {
  const { anchor } = params;
  const { data, error } = await supabase
    .from("light_sources")
    .insert({
      map_id: params.mapId,
      radius_feet: params.radiusFeet,
      brightness: params.brightness,
      x: anchor.kind === "cell" ? anchor.x : null,
      y: anchor.kind === "cell" ? anchor.y : null,
      object_id: anchor.kind === "object" ? anchor.objectId : null,
      token_id: anchor.kind === "token" ? anchor.tokenId : null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Adjusts a light's radius/brightness in place; re-anchoring is a delete
 * plus create (a "moved" light is a different light, and partial anchor
 * patches could trip the XOR CHECK mid-edit). */
export async function updateLightSource(
  supabase: SupabaseClient,
  lightSourceId: string,
  patch: { radiusFeet?: number; brightness?: LightSourceBrightness }
): Promise<LightSource> {
  const { data, error } = await supabase
    .from("light_sources")
    .update({
      ...(patch.radiusFeet !== undefined ? { radius_feet: patch.radiusFeet } : {}),
      ...(patch.brightness !== undefined ? { brightness: patch.brightness } : {}),
    })
    .eq("id", lightSourceId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteLightSource(
  supabase: SupabaseClient,
  lightSourceId: string
): Promise<void> {
  const { error } = await supabase.from("light_sources").delete().eq("id", lightSourceId);

  if (error) throw error;
}
