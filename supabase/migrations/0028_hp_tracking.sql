-- Prompt 46: in-combat damage/healing.
--
-- 0007 gave characters current_hp with no range constraint (only
-- max_hp >= 0). Close that defense-in-depth gap before adding the RPC —
-- clamping any out-of-range rows first so the constraint can land on
-- existing data.

update public.characters
set current_hp = least(max_hp, greatest(0, current_hp))
where current_hp < 0 or current_hp > max_hp;

alter table public.characters
  add constraint characters_current_hp_in_range
  check (current_hp >= 0 and current_hp <= max_hp);

-- One signed-delta function for both damage (negative) and healing
-- (positive): the clamp math is identical in both directions.
--
-- Deliberately SECURITY INVOKER (the default), unlike the combat RPCs in
-- 0027: those exist to express cross-row/multi-row rules a per-row policy
-- can't, but "owner or campaign DM may change any field" is exactly what
-- 0008's characters UPDATE policy already says, so this runs as the caller
-- and lets that policy do the authorizing. The RPC exists purely for
-- atomicity: the clamped value is computed from the CURRENT stored
-- current_hp inside one UPDATE, so two near-simultaneous deltas both land
-- instead of a client-side read-then-write losing one to the race.
create or replace function public.apply_hp_delta(p_character_id uuid, p_delta integer)
returns public.characters
language plpgsql
set search_path = public
as $$
declare
  v_row public.characters;
begin
  update public.characters
  set current_hp = least(max_hp, greatest(0, current_hp + p_delta)),
      updated_at = now()
  where id = p_character_id
  returning * into v_row;

  if not found then
    -- RLS filters the row out for anyone who isn't the owner or the DM, so
    -- "blocked" and "nonexistent" are indistinguishable here — same
    -- opacity as getCharacter's null.
    raise exception 'Character not found, or you may not change its HP';
  end if;

  return v_row;
end;
$$;

grant execute on function public.apply_hp_delta(uuid, integer) to authenticated;

-- Live sync for the character sheet page: the sheet isn't connected to the
-- Game Room's campaign channel at all, so mid-combat HP changes reach it
-- via postgres_changes on the characters table — the same mechanism (and
-- the same publication) 0012 set up for profiles. Row visibility is still
-- filtered per-subscriber by the characters SELECT policy (owner or DM).
alter publication supabase_realtime add table public.characters;
