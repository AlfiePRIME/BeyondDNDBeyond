# realtime

Wraps Supabase Realtime channels and presence behind a small typed event-bus. Every
live-synced feature (map state, tokens, initiative, dice rolls, the lobby, handout reveals)
publishes/subscribes through this rather than talking to Realtime directly.

One shared core, `joinChannel(supabase, topic, identity)` in `channel.ts`, does all the real
work; the public API is a thin topic-scoped wrapper per feature scope so topic naming stays in
one place:

- `joinCampaignChannel(supabase, campaignId, identity)` — the one channel for a campaign
  (topic `campaign:<id>`, so concurrent campaigns never cross-talk).
- `joinLobbyChannel(supabase, identity)` — the app-wide Lobby (fixed topic `lobby`); its
  presence list is "who's online right now" across the whole app.

Both return a `PresenceChannel`:

- `publish(event, payload)` / `subscribe(event, handler)` — typed broadcast pub/sub; any
  number of named events share the one channel, each `subscribe` call returns an unsubscribe
  function.
- `onPresenceChange(handler)` / `getPresentMembers()` — who else is currently connected,
  called immediately with the current snapshot and again on every join/leave.
- `getConnectionState()` / `onConnectionStateChange(handler)` — `"connecting" | "connected" |
  "reconnecting"`, called immediately with the current state and again on every change. Backed by
  realtime-js/Phoenix's own socket reconnect-with-backoff and automatic channel rejoin; this module
  just observes those transitions rather than reimplementing them.
- `onReconnect(handler)` — fires after recovering from an unexpected drop, never after the initial
  join. Presence resyncs itself automatically and needs no handler; this is for feature modules
  (map, tokens, combat, HP, ...) with their own authoritative state to refetch after reconnecting.
- `leave()` — untracks presence and releases the channel; call on unmount.

Callers supply their own `SupabaseClient` (from `@/data-access/supabase-browser` or
`@/data-access/supabase-server`) — this module never imports `@supabase/supabase-js` itself,
per the module boundary in `eslint.config.mjs`.
