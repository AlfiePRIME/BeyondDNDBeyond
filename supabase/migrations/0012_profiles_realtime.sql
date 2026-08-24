-- Prompt 21: let Realtime emit postgres_changes events for profiles, so an
-- avatar change made anywhere (the /account page, another device) reaches
-- every open Game Room without that tab doing anything. The self-hosted
-- stack ships the supabase_realtime publication empty — a table must be
-- added explicitly before change events fire for it. Row visibility is
-- still filtered per-subscriber by the profiles RLS select policy
-- (readable by any authenticated user, see 0001).

alter publication supabase_realtime add table public.profiles;
