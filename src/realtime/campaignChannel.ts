import type { SupabaseClient } from "@/data-access";
import { joinChannel, type ChannelIdentity, type PresenceChannel } from "./channel";

/**
 * Joins the single Realtime channel for one campaign — scoped by campaignId
 * so concurrent campaigns never cross-talk. Every campaign-scoped live-synced
 * feature (map state, tokens, initiative, dice rolls, the activity log, ...)
 * should call this rather than opening its own raw supabase.channel(...).
 */
export function joinCampaignChannel(
  supabase: SupabaseClient,
  campaignId: string,
  identity: ChannelIdentity
): PresenceChannel {
  return joinChannel(supabase, `campaign:${campaignId}`, identity);
}
