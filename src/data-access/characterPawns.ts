import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Pawn Customization P2: a character's per-character map-token appearance —
 * see 0080_character_pawns.sql's own header comment for the full reasoning
 * on why this is a separate, campaign-member-readable table rather than a
 * column on the privacy-locked `characters` table. This is the SECOND,
 * character-scoped link in a live-pointer chain mirroring C6/C7's own
 * (monster_stat_block.template_id -> monster_templates.default_asset_id,
 * overridable per-campaign): here, map_tokens.character_id -> characters.id
 * -> character_pawns.pawn_model_ref, always re-resolved fresh by
 * GameRoom.tsx's token-render-props derivation, never a one-time copy.
 *
 * Always exactly one row per character (auto-created by 0080's trigger the
 * moment the character exists) — pawn_model_ref null means "no custom
 * model", the overwhelmingly common case, which MapSurface's token-model
 * resolution reads as "render the flat disc, colored via the owner's own
 * profiles.default_pawn_color (0079) instead".
 */
export interface CharacterPawn {
  character_id: string;
  campaign_id: string;
  owner_id: string;
  /** A storage object path in the character-pawns bucket ({character_id}/
   * pawn.glb), or null for "no custom model set". */
  pawn_model_ref: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Every character's pawn appearance for one campaign — the same
 * "campaign-wide, one round trip, id-keyed lookup" shape
 * listMonsterTemplateOverridesForCampaign already established for C7,
 * fetched for EVERY campaign member (0080's SELECT policy is any campaign
 * member, not owner-or-DM) since GameRoom's token-render resolution runs
 * per-viewer and needs this for every OTHER player's token too, not just
 * the caller's own.
 */
export async function listCharacterPawnsForCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<CharacterPawn[]> {
  const { data, error } = await supabase
    .from("character_pawns")
    .select()
    .eq("campaign_id", campaignId);

  if (error) throw error;
  return (data ?? []) as CharacterPawn[];
}

/** One character's own pawn row — used by the character sheet's upload UI,
 * always readable by its owner or the campaign DM (both are trivially
 * campaign members, so 0080's member-readable SELECT policy already covers
 * this call without any special-casing). Null only if the character itself
 * doesn't exist (RLS on `characters` would already have 404'd the page
 * before this is ever called) or, in principle, if the row somehow never
 * existed — every character created after 0080 always has one via its
 * trigger. */
export async function getCharacterPawn(
  supabase: SupabaseClient,
  characterId: string
): Promise<CharacterPawn | null> {
  const { data, error } = await supabase
    .from("character_pawns")
    .select()
    .eq("character_id", characterId)
    .maybeSingle();

  if (error) throw error;
  return (data as CharacterPawn | null) ?? null;
}

/**
 * Sets (or replaces) a character's custom pawn model — a plain UPDATE
 * through 0080's owner-or-DM policy (can_access_character), the exact same
 * write authorization as `characters` itself. Pass null to remove the
 * custom model (falls back to the disc, colored by the owner's account
 * color) — there is no separate "clear" function; a character's
 * character_pawns row always exists, so this is never an insert/delete.
 */
export async function setCharacterPawnModel(
  supabase: SupabaseClient,
  characterId: string,
  pawnModelRef: string | null
): Promise<CharacterPawn> {
  const { data, error } = await supabase
    .from("character_pawns")
    .update({ pawn_model_ref: pawnModelRef, updated_at: new Date().toISOString() })
    .eq("character_id", characterId)
    .select()
    .single();

  if (error) throw error;
  return data as CharacterPawn;
}

/**
 * Uploads a custom pawn model to the character-pawns bucket and returns the
 * object path to store as pawn_model_ref. One fixed path per character
 * ({character_id}/pawn.glb), replaced in place on re-upload — the
 * uploadAvatarFile precedent exactly, avoiding orphaned objects.
 */
export async function uploadCharacterPawnModelFile(
  supabase: SupabaseClient,
  characterId: string,
  file: File
): Promise<string> {
  const path = `${characterId}/pawn.glb`;
  // Re-wrapped as a Blob with the type we actually want — see
  // uploadAvatarFile's identical comment: many OSes don't register .glb, so
  // the browser reports the raw File's own `.type` as
  // "application/octet-stream", which the bucket's MIME allowlist rejects.
  const glbBlob = new Blob([file], { type: "model/gltf-binary" });
  const { error } = await supabase.storage
    .from("character-pawns")
    .upload(path, glbBlob, { contentType: "model/gltf-binary", upsert: true });

  if (error) throw error;
  return path;
}

/**
 * Signed download URL for a custom pawn model object. The character-pawns
 * bucket is private, so reads go through a signed URL minted under the
 * caller's own session — the bucket's RLS lets any campaign member who can
 * see the character's token read it (0080's can_view_character_pawn).
 * Known limitation, the getAvatarSignedUrl/getMapAssetSignedUrl precedent:
 * the URL expires after `expiresInSeconds` with no refresh.
 */
export async function getCharacterPawnSignedUrl(
  supabase: SupabaseClient,
  path: string,
  expiresInSeconds: number
): Promise<string> {
  const { data, error } = await supabase.storage
    .from("character-pawns")
    .createSignedUrl(path, expiresInSeconds);

  if (error) throw error;
  return data.signedUrl;
}
