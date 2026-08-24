-- Prompt 22: session state. One boolean on campaigns — this scope needs
-- "is a session running right now", not a history of past sessions, so no
-- separate sessions table.

alter table public.campaigns
  add column if not exists session_active boolean not null default false;

-- Starting a session is NOT transfer_dm: any member (not just the current
-- DM) may press Start and thereby claim the DM role for themselves, so this
-- is its own SECURITY DEFINER RPC with member-level authorization rather
-- than transfer_dm doing double duty with two different auth rules. The
-- demote-then-promote ordering is 0006's — 1 dm -> 0 dm -> 1 dm never has
-- two 'dm' rows at once, so one_dm_per_campaign (0003) is never violated.
--
-- The SELECT ... FOR UPDATE row lock is what resolves two near-simultaneous
-- Start presses on the same campaign: the second caller blocks on the lock,
-- and once the winner commits it re-reads the row (READ COMMITTED
-- EvalPlanQual), sees session_active = true, and raises.
--
-- p_reclaim_abandoned exists because Postgres has no visibility into
-- Realtime's in-memory presence: only a client can know that a
-- session_active campaign actually has nobody left in its room (a crashed
-- last member leaves the flag stranded). A client that has verified the
-- room is empty passes true to start anyway — end_session can't serve that
-- path, since it's DM-gated and the reclaiming member usually isn't the DM.
create or replace function public.start_session(
  p_campaign_id uuid,
  p_reclaim_abandoned boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active boolean;
begin
  select session_active into v_active
  from public.campaigns
  where id = p_campaign_id
  for update;

  if v_active is null then
    raise exception 'Campaign not found';
  end if;

  if not exists (
    select 1 from public.campaign_members
    where campaign_id = p_campaign_id and user_id = auth.uid()
  ) then
    raise exception 'Only a member of this campaign can start its session';
  end if;

  if v_active and not p_reclaim_abandoned then
    raise exception 'This campaign already has a session in progress';
  end if;

  if not exists (
    select 1 from public.campaign_members
    where campaign_id = p_campaign_id and user_id = auth.uid() and role = 'dm'
  ) then
    update public.campaign_members
    set role = 'player'
    where campaign_id = p_campaign_id and role = 'dm';

    update public.campaign_members
    set role = 'dm'
    where campaign_id = p_campaign_id and user_id = auth.uid();
  end if;

  update public.campaigns
  set session_active = true
  where id = p_campaign_id;
end;
$$;

grant execute on function public.start_session(uuid, boolean) to authenticated;

-- Idempotent on purpose: the last-leaver courtesy cleanup and an explicit
-- End Session click can race, and the loser of that race should no-op, not
-- error.
create or replace function public.end_session(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_campaign_dm(p_campaign_id) then
    raise exception 'Only the current DM can end the session';
  end if;

  update public.campaigns
  set session_active = false
  where id = p_campaign_id;
end;
$$;

grant execute on function public.end_session(uuid) to authenticated;
