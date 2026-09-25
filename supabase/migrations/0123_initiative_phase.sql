-- Guided initiative phase.
--
-- Combat used to start straight into round 1 with every combatant's
-- initiative empty and nothing telling anyone to roll. Now a new encounter
-- opens in an 'initiative' phase: everyone rolls (the Game Room shows a
-- party-vs-enemies roster with a 15-second countdown, after which the DM's
-- client rolls for anyone still waiting), then the DM's client calls
-- begin_combat_round to start round 1 at the top of the order.
--
-- start_combat itself is untouched: the new columns' defaults put every
-- freshly started encounter into the initiative phase with a deadline
-- 15 seconds out. Encounters already running are marked 'active'.
--
-- combat_combatants.initiative_roll is the natural d20 behind the stored
-- total, so every client can show the die landing on the face actually
-- rolled (the total alone can't be split back into die + modifier for
-- another player's character, whose sheet RLS hides).

alter table public.combat_encounters
  add column if not exists phase text not null default 'initiative'
    check (phase in ('initiative', 'active')),
  add column if not exists initiative_deadline timestamptz default (now() + interval '15 seconds');

update public.combat_encounters set phase = 'active', initiative_deadline = null;

alter table public.combat_combatants
  add column if not exists initiative_roll integer check (initiative_roll between 1 and 20);

create or replace function public.begin_combat_round(p_encounter_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
begin
  select campaign_id into v_campaign_id
  from public.combat_encounters
  where id = p_encounter_id and ended_at is null;
  if v_campaign_id is null then
    raise exception 'Encounter not found or already ended';
  end if;
  if not public.is_campaign_dm(v_campaign_id) then
    raise exception 'Only the DM can begin the round';
  end if;

  update public.combat_encounters
  set phase = 'active',
      round_number = 1,
      current_turn_index = 0,
      initiative_deadline = null
  where id = p_encounter_id and phase = 'initiative';
end;
$$;

grant execute on function public.begin_combat_round(uuid) to authenticated;
