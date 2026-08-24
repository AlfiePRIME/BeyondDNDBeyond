-- Prompt 12: short/long rest. Both are single UPDATE statements the JS
-- Supabase client can't express directly (setting a column to another
-- column's value on the same row, e.g. current_uses = max_uses), so they're
-- plain SQL functions rather than round-tripping every resource row through
-- the client. No SECURITY DEFINER needed, unlike transfer_dm/join_campaign_by_
-- invite_code: those crossed a visibility boundary RLS would otherwise block;
-- this doesn't — running as the caller, RLS on character_resources/characters
-- (owner or campaign DM) still applies to every row touched, so a caller
-- without access simply updates zero rows rather than erroring.
create or replace function public.short_rest(p_character_id uuid)
returns void
language sql
set search_path = public
as $$
  update public.character_resources
  set current_uses = max_uses
  where character_id = p_character_id
    and recharge = 'short_rest';
$$;

create or replace function public.long_rest(p_character_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  -- Every resource resets on a long rest regardless of recharge_type
  -- (short_rest resources reset too — a long rest is a superset of a short
  -- rest), which also covers spell slots since they're stored as ordinary
  -- character_resources rows with recharge = 'long_rest'.
  update public.character_resources
  set current_uses = max_uses
  where character_id = p_character_id;

  update public.characters
  set current_hp = max_hp, updated_at = now()
  where id = p_character_id;
end;
$$;

grant execute on function public.short_rest(uuid) to authenticated;
grant execute on function public.long_rest(uuid) to authenticated;
