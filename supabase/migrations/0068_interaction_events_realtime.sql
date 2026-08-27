-- Chat & Summary B5: interaction_events (0059) was created with no real UI
-- consumer yet, so it was never added to the supabase_realtime publication —
-- a table's own RLS policies are necessary but not sufficient for
-- postgres_changes delivery; without this, subscribeToInteractionEvents'
-- channel simply never receives anything, silently, no error. Same
-- publication as roll_log (0030) / chat_messages (0067) / every other
-- postgres_changes-backed live feed in this app; per-subscriber visibility
-- still rides interaction_events' own DM-only SELECT policy (0059) exactly
-- as before this migration.
alter publication supabase_realtime add table public.interaction_events;
