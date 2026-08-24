-- Prompt 7: DM role transfer. The current campaign_members UPDATE policy
-- only lets a member update their OWN row (see 0004) — but transferring the
-- DM role means the current DM must change a DIFFERENT member's row too
-- (promote them to dm). Same shape as 0005's join-by-code: a
-- SECURITY DEFINER RPC that authorizes and performs the whole operation
-- atomically, rather than widening the UPDATE policy in a way that would
-- let any member edit any other member's row.
create or replace function public.transfer_dm(p_campaign_id uuid, p_new_dm_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_is_dm boolean;
  v_target_is_member boolean;
begin
  select exists (
    select 1 from public.campaign_members
    where campaign_id = p_campaign_id and user_id = auth.uid() and role = 'dm'
  ) into v_caller_is_dm;

  if not v_caller_is_dm then
    raise exception 'Only the current DM can transfer the DM role';
  end if;

  if p_new_dm_user_id = auth.uid() then
    return; -- already the DM — nothing to do
  end if;

  select exists (
    select 1 from public.campaign_members
    where campaign_id = p_campaign_id and user_id = p_new_dm_user_id
  ) into v_target_is_member;

  if not v_target_is_member then
    raise exception 'The target user is not a member of this campaign';
  end if;

  -- Demote the current DM first, then promote the target. Doing it in the
  -- opposite order would momentarily create two 'dm' rows for the same
  -- campaign within this statement and violate the one_dm_per_campaign
  -- unique partial index from 0003 — going 1 dm -> 0 dm -> 1 dm never
  -- has two at once, so this ordering is what keeps it atomic-safe.
  update public.campaign_members
  set role = 'player'
  where campaign_id = p_campaign_id and user_id = auth.uid();

  update public.campaign_members
  set role = 'dm'
  where campaign_id = p_campaign_id and user_id = p_new_dm_user_id;
end;
$$;

grant execute on function public.transfer_dm(uuid, uuid) to authenticated;
