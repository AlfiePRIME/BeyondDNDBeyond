// Public entry point for the realtime module. Wraps Supabase Realtime
// channels/presence behind a typed event-bus — one shared core
// (joinChannel in channel.ts) with a thin topic-scoped wrapper per
// feature scope, rather than each feature opening its own raw channel.
export const MODULE_NAME = "realtime" as const;

export type {
  PresenceChannel,
  ChannelIdentity,
  PresenceMember,
  ConnectionState,
} from "./channel";
export { joinCampaignChannel } from "./campaignChannel";
export { joinCampaignRoomChannel } from "./campaignRoomChannel";
export { joinLobbyChannel } from "./lobbyChannel";
