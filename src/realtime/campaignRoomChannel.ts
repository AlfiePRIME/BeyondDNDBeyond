import type { SupabaseClient } from "@/data-access";
import { joinChannel, type ChannelIdentity, type PresenceChannel } from "./channel";

/**
 * Joins the Game-Room-scoped channel for one campaign — a SEPARATE topic
 * from joinCampaignChannel on purpose: the campaign detail page's roster
 * (CampaignRoster) tracks presence on the campaign topic, so "present
 * there" means "somewhere in this campaign's pages", not "at the table".
 * Session lifecycle logic (last-leaver auto-end, abandoned-session
 * reclaim probes, the session-ended broadcast) needs presence that means
 * exactly "connected to the Game Room", which is this topic.
 */
export function joinCampaignRoomChannel(
  supabase: SupabaseClient,
  campaignId: string,
  identity: ChannelIdentity
): PresenceChannel {
  return joinChannel(supabase, `campaign:${campaignId}:room`, identity);
}
