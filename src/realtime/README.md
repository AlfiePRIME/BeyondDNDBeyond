# realtime

Wraps Supabase Realtime channels and presence behind a small typed event-bus. Every
live-synced feature (map state, tokens, initiative, dice rolls, the lobby, handout reveals)
publishes/subscribes through this rather than talking to Realtime directly.

`joinCampaignChannel(supabase, campaignId, identity)` joins the one channel for a campaign
(topic `campaign:<id>`, so concurrent campaigns never cross-talk) and returns:

- `publish(event, payload)` / `subscribe(event, handler)` — typed broadcast pub/sub; any
  number of named events share the one channel, each `subscribe` call returns an unsubscribe
  function.
- `onPresenceChange(handler)` / `getPresentMembers()` — who else is currently connected,
  called immediately with the current snapshot and again on every join/leave.
- `leave()` — untracks presence and releases the channel; call on unmount.

Callers supply their own `SupabaseClient` (from `@/data-access/supabase-browser` or
`@/data-access/supabase-server`) — this module never imports `@supabase/supabase-js` itself,
per the module boundary in `eslint.config.mjs`.
