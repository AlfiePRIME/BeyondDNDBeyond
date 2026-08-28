import {
  getCharacterPawnSignedUrl,
  listCharacterPawnsForCampaign,
  type SupabaseClient,
} from "@/data-access";

/**
 * One character's pawn appearance, resolved to a loadable URL — the
 * resolvePaletteAssets/resolveAvatarUrl shape exactly, applied to Pawn
 * Customization P2's own character_pawns table (0080). `ownerId` rides
 * along so GameRoom's token-render-props derivation can look up that
 * owner's own account color (0079) for the disc-fallback case, without a
 * second privacy-locked round trip through `characters` itself — see
 * 0080_character_pawns.sql's own header comment for why owner_id lives
 * here at all.
 */
export interface ResolvedCharacterPawn {
  characterId: string;
  ownerId: string;
  /** null for "no custom model set" (renders the disc) OR "signing this
   * character's stored path failed" — same fail-soft posture as
   * resolveAvatarUrl/resolvePaletteAssets: one bad pawn can't take down the
   * room. */
  modelUrl: string | null;
}

// Same known limitation (deliberate) as the room's avatar/asset signed-url
// resolution: no refresh before expiry — a Game Room tab left open past
// this window shows the disc fallback for a custom pawn model until reload.
const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

/**
 * Resolves every character's pawn appearance for a campaign in one batch —
 * called for EVERY campaign member (0080's SELECT policy is any campaign
 * member, not owner-or-DM), server-side at page load and again whenever
 * GameRoom's own refreshCombat re-reads campaign-wide state, so a model
 * upload/removal reaches every other open room on nothing more than a
 * reload/re-render — the exact same "live pointer, always re-resolved
 * fresh, never a one-time copy" proof C6/C7 already established for NPC
 * template models.
 */
export async function resolveCampaignPawnAppearance(
  supabase: SupabaseClient,
  campaignId: string
): Promise<ResolvedCharacterPawn[]> {
  const pawns = await listCharacterPawnsForCampaign(supabase, campaignId);

  return Promise.all(
    pawns.map(async (pawn) => {
      if (!pawn.pawn_model_ref) {
        return { characterId: pawn.character_id, ownerId: pawn.owner_id, modelUrl: null };
      }
      try {
        const modelUrl = await getCharacterPawnSignedUrl(supabase, pawn.pawn_model_ref, SIGNED_URL_TTL_SECONDS);
        return { characterId: pawn.character_id, ownerId: pawn.owner_id, modelUrl };
      } catch {
        return { characterId: pawn.character_id, ownerId: pawn.owner_id, modelUrl: null };
      }
    })
  );
}
