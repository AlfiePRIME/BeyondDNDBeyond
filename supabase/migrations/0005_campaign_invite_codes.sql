-- Prompt 6: campaign invite codes. Permanent, multi-use for the life of the
-- campaign — generated once at creation and never rotated by this prompt.

alter table public.campaigns
  add column invite_code text unique not null
  default upper(substr(md5(gen_random_uuid()::text), 1, 8));

-- Joining by invite code is a chicken-and-egg RLS case, same shape as the
-- bootstrap problem in 0004: a user isn't a campaign_members row yet, so
-- campaigns' own SELECT policy (is_campaign_member) would hide the very
-- row they're trying to look up by code. Rather than widen campaigns' SELECT
-- policy (which would let anyone browse every campaign's name/invite_code,
-- not just look one up by a code they already know), this is a
-- SECURITY DEFINER RPC: it looks up the campaign internally (bypassing RLS)
-- and, only if the code matches, inserts the caller as a player. Nothing
-- about other campaigns is ever exposed.
-- The RETURNS TABLE column names below are deliberately NOT "campaign_id" /
-- "campaign_name" — PL/pgSQL implicitly declares RETURNS TABLE columns as
-- in-scope variables for the whole function body, which collides with the
-- real campaign_members.campaign_id column referenced in the INSERT below
-- ("column reference is ambiguous"). Prefixing with result_ avoids it.
create or replace function public.join_campaign_by_invite_code(p_invite_code text)
returns table (result_campaign_id uuid, result_campaign_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_campaign_name text;
begin
  select id, name into v_campaign_id, v_campaign_name
  from public.campaigns
  where invite_code = upper(trim(p_invite_code));

  if v_campaign_id is null then
    raise exception 'Invalid invite code';
  end if;

  insert into public.campaign_members (campaign_id, user_id, role)
  values (v_campaign_id, auth.uid(), 'player')
  on conflict (campaign_id, user_id) do nothing;

  return query select v_campaign_id, v_campaign_name;
end;
$$;

grant execute on function public.join_campaign_by_invite_code(text) to authenticated;
