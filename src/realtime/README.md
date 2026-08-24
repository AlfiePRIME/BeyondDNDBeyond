# realtime

Wraps Supabase Realtime channels and presence behind a small typed event-bus. Every
live-synced feature (map state, tokens, initiative, dice rolls, the lobby, handout reveals)
publishes/subscribes through this rather than talking to Realtime directly. Module boundary
formalized in Prompt 2; populated starting in Prompt 16.
