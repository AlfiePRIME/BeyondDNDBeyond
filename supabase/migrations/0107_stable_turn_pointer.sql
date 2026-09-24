-- Keep "whose turn it is" pinned to the same combatant when the turn order
-- is reshuffled mid-combat.
--
-- current_turn_index is a position in the initiative-sorted combatant list
-- (initiative desc nulls last, created_at, id — see 0027). Anything that
-- re-sorts or shrinks that list silently moved the turn to someone else:
-- setting/rolling an initiative mid-combat, a late combatant joining, or a
-- token (and so its combatant, via on delete cascade) being removed.
--
-- The encounter now also remembers WHO is acting (current_combatant_id,
-- derived from the index whenever the index is written), and a trigger on
-- combat_combatants moves the index to follow that combatant after every
-- insert/delete/initiative change. If the acting combatant itself is
-- removed, the index stays put — the next combatant in order takes the
-- turn — wrapping to the top if it fell off the end.
--
-- Round 1, index 0 means combat hasn't really started (people are still
-- rolling initiative), so there the turn stays on whoever is top of the
-- order rather than following the first combatant that happened to be
-- seated.

alter table public.combat_encounters
  add column if not exists current_combatant_id uuid;

create or replace function public.combatant_at_turn(p_encounter_id uuid, p_index integer)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id
  from public.combat_combatants c
  where c.encounter_id = p_encounter_id
  order by c.initiative desc nulls last, c.created_at asc, c.id asc
  offset greatest(p_index, 0)
  limit 1;
$$;

-- Whenever the index is written, record who it points at.
create or replace function public.sync_current_combatant_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.current_combatant_id := public.combatant_at_turn(new.id, new.current_turn_index);
  return new;
end;
$$;

drop trigger if exists combat_encounters_sync_current_combatant on public.combat_encounters;
create trigger combat_encounters_sync_current_combatant
  before insert or update of current_turn_index on public.combat_encounters
  for each row execute function public.sync_current_combatant_id();

-- Whenever the list changes, move the index to follow the acting combatant.
create or replace function public.follow_current_combatant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_encounter_id uuid := coalesce(new.encounter_id, old.encounter_id);
  v_encounter public.combat_encounters%rowtype;
  v_position integer;
  v_count integer;
  v_index integer;
begin
  select * into v_encounter
  from public.combat_encounters
  where id = v_encounter_id and ended_at is null;
  if not found then
    return null;
  end if;

  if v_encounter.round_number = 1 and v_encounter.current_turn_index = 0 then
    v_index := 0;
  else
    select ordered.position into v_position
    from (
      select c.id, (row_number() over (
        order by c.initiative desc nulls last, c.created_at asc, c.id asc
      ) - 1)::integer as position
      from public.combat_combatants c
      where c.encounter_id = v_encounter_id
    ) ordered
    where ordered.id = v_encounter.current_combatant_id;

    if v_position is not null then
      v_index := v_position;
    else
      select count(*)::integer into v_count
      from public.combat_combatants
      where encounter_id = v_encounter_id;
      v_index := case when v_encounter.current_turn_index >= v_count then 0 else v_encounter.current_turn_index end;
    end if;
  end if;

  -- Always rewrite (even an unchanged index) so current_combatant_id is
  -- re-derived — e.g. after the acting combatant was deleted.
  update public.combat_encounters
  set current_turn_index = v_index
  where id = v_encounter_id;
  return null;
end;
$$;

drop trigger if exists combat_combatants_follow_current on public.combat_combatants;
create trigger combat_combatants_follow_current
  after insert or delete or update of initiative on public.combat_combatants
  for each row execute function public.follow_current_combatant();

-- Backfill every active encounter.
update public.combat_encounters
set current_turn_index = current_turn_index
where ended_at is null;
