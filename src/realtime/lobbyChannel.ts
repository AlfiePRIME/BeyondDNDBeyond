import type { SupabaseClient } from "@/data-access";
import { joinChannel, type ChannelIdentity, type PresenceChannel } from "./channel";

/**
 * Joins the app-wide Lobby channel — one fixed topic shared by every signed-in
 * user regardless of campaign, so its presence list IS "who's online right
 * now" across the whole app.
 */
export function joinLobbyChannel(supabase: SupabaseClient, identity: ChannelIdentity): PresenceChannel {
  return joinChannel(supabase, "lobby", identity);
}
