-- Phase 3 (Game Room ambiance/tools plan): the DM's private dice rolls. A
-- private roll animates identically to a public one but must be visible
-- ONLY to the campaign's DM — a hidden Perception check or a monster's
-- attack roll behind the screen. roll_log's existing SELECT policy (0030)
-- makes every row member-readable with no visibility concept at all; this
-- adds one, and updates both existing policies around it.

alter table public.roll_log
  add column if not exists visibility text not null default 'public'
    check (visibility in ('public', 'private'));

-- Replace the SELECT policy: a 'public' row stays readable by every
-- campaign member exactly as before; a 'private' row is readable ONLY by
-- that campaign's DM (public.is_campaign_dm, 0008) — never by any player,
-- regardless of whose roll it is. Because roll_log's live sync is a
-- postgres_changes subscription (subscribeToRollLog), not a broadcast, this
-- alone keeps a private roll out of a player's persistent roll-log feed —
-- no client-side filtering needed for that surface.
drop policy "members read their campaign's rolls" on public.roll_log;

create policy "members read their campaign's public rolls, DM reads all"
  on public.roll_log for select
  to authenticated
  using (
    public.is_campaign_member(campaign_id)
    and (visibility = 'public' or public.is_campaign_dm(campaign_id))
  );

-- Replace the INSERT policy: same self-logging rule as before, plus a
-- WITH CHECK that only the DM may ever set visibility = 'private' — a
-- non-DM's direct attempt to insert a private row (bypassing the UI, which
-- never offers the option to a player) is rejected by RLS itself.
drop policy "members log their own rolls" on public.roll_log;

create policy "members log their own rolls"
  on public.roll_log for insert
  to authenticated
  with check (
    public.is_campaign_member(campaign_id)
    and roller_user_id = auth.uid()
    and (visibility = 'public' or public.is_campaign_dm(campaign_id))
  );
