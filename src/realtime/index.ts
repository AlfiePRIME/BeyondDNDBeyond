// Public entry point for the realtime module. Wraps Supabase Realtime
// channels/presence behind a typed event-bus — every live-synced feature
// joins its campaign's channel through joinCampaignChannel() below rather
// than opening its own raw Realtime channel.
export const MODULE_NAME = "realtime" as const;

export {
  joinCampaignChannel,
  type CampaignChannel,
  type CampaignChannelIdentity,
  type CampaignPresenceMember,
  type CampaignConnectionState,
} from "./campaignChannel";
