/** Broadcast on the lobby channel when someone starts hosting — members of
 * that campaign get an invitation to join (never an automatic redirect). */
export const SESSION_STARTED_EVENT = "session-started";

export interface SessionStartedPayload {
  campaignId: string;
  campaignName: string;
  /** Display name of whoever is hosting (the campaign's DM for the session). */
  hostName?: string | null;
}
