-- Temporary hit points, hit dice, and inspiration.
--
-- characters gains:
--   temp_hp         — temporary HP. Damage comes off it first; it doesn't
--                     stack (setting it replaces the old value) and a long
--                     rest clears it.
--   hit_dice_spent  — hit dice used since they were last recovered; a
--                     character has `level` hit dice, so remaining is
--                     level - hit_dice_spent (no separate column to drift
--                     out of sync on a level change).
--   inspiration     — the DM awards it; its owner spends it for advantage
--                     on their next d20 roll (via 0101's pending_roll_mode,
--                     which the roll route already consumes).
--
-- apply_hp_delta / resolve_attack_damage / resolve_npc_attack_damage (0120
-- bodies) absorb damage with temp HP first. The concentration DC still uses
-- the FULL damage taken — damage soaked by temporary HP is still damage.
--
-- long_rest now follows the SRD: no benefit at 0 HP (or dead); otherwise
-- full HP, temp HP cleared, death saves/stability and any pending
-- concentration check reset, and half the character's hit dice (min 1)
-- recovered. spend_hit_die heals by a server-rolled amount the client got
-- from the roll route and marks one hit die used.

alter table public.characters
  add column if not exists temp_hp integer not null default 0 check (temp_hp >= 0),
  add column if not exists hit_dice_spent integer not null default 0 check (hit_dice_spent >= 0),
  add column if not exists inspiration boolean not null default false;

create or replace function public.enforce_dm_managed_character_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.xp is distinct from old.xp
     and not public.is_campaign_dm(old.campaign_id) then
    raise exception 'Only the campaign''s DM can change a character''s XP';
  end if;
  if new.inspiration and not old.inspiration
     and not public.is_campaign_dm(old.campaign_id) then
    raise exception 'Only the campaign''s DM can award inspiration';
  end if;
  -- Spending inspiration (true -> false in the same update) is the one way
  -- a player may give themselves advantage on their next roll.
  if new.pending_roll_mode is distinct from old.pending_roll_mode
     and new.pending_roll_mode <> 'normal'
     and not public.is_campaign_dm(old.campaign_id)
     and not (new.pending_roll_mode = 'advantage' and old.inspiration and not new.inspiration) then
    raise exception 'Only the campaign''s DM can grant advantage or disadvantage';
  end if;
  return new;
end;
$$;

create or replace function public.apply_hp_delta(p_character_id uuid, p_delta integer)
returns public.characters
language plpgsql
set search_path = public
as $$
declare
  v_current public.characters;
  v_row public.characters;
  v_new_hp integer;
  v_absorbed integer;
  v_hp_delta integer;
  v_successes integer;
  v_failures integer;
  v_stable boolean;
  v_dead boolean;
  v_concentrating text;
  v_pending_dc integer;
begin
  select * into v_current
  from public.characters
  where id = p_character_id
  for update;

  if not found then
    raise exception 'Character not found, or you may not change its HP';
  end if;

  -- Temporary HP soaks damage first (0122); only the rest reaches real HP.
  v_absorbed := case when p_delta < 0 then least(v_current.temp_hp, -p_delta) else 0 end;
  v_hp_delta := p_delta + v_absorbed;

  v_new_hp := least(v_current.max_hp, greatest(0, v_current.current_hp + v_hp_delta));
  v_successes := v_current.death_save_successes;
  v_failures := v_current.death_save_failures;
  v_stable := v_current.is_stable;
  v_dead := v_current.is_dead;
  v_concentrating := v_current.concentrating_on;
  v_pending_dc := v_current.pending_concentration_dc;

  if v_hp_delta < 0 and v_current.current_hp = 0 and not v_current.is_dead then
    if -v_hp_delta >= v_current.max_hp then
      -- Instant death: don't bother incrementing failures.
      v_dead := true;
    else
      if v_stable then
        v_stable := false;
        v_successes := 0;
        v_failures := 0;
      end if;
      v_failures := least(3, v_failures + 1);
      v_dead := v_failures >= 3;
    end if;
  elsif v_hp_delta < 0 and v_current.current_hp > 0 and not v_current.is_dead
    and (-v_hp_delta) - v_current.current_hp >= v_current.max_hp then
    -- Massive damage: dropped to 0 with at least max HP left over.
    v_dead := true;
  elsif v_hp_delta > 0 and v_current.current_hp = 0 and v_new_hp > 0 then
    v_successes := 0;
    v_failures := 0;
    v_stable := false;
  end if;

  if p_delta < 0 then
    if v_new_hp = 0 then
      v_concentrating := null;
      v_pending_dc := null;
    elsif v_concentrating is not null then
      v_pending_dc := greatest(10, (-p_delta) / 2);
    end if;
  end if;

  update public.characters
  set current_hp = v_new_hp,
      temp_hp = temp_hp - v_absorbed,
      death_save_successes = v_successes,
      death_save_failures = v_failures,
      is_stable = v_stable,
      is_dead = v_dead,
      concentrating_on = v_concentrating,
      pending_concentration_dc = v_pending_dc,
      updated_at = now()
  where id = p_character_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.apply_hp_delta(uuid, integer) to authenticated;

create or replace function public.resolve_attack_damage(
  p_attacker_character_id uuid,
  p_target_character_id uuid,
  p_damage integer,
  p_critical boolean,
  p_breakdown jsonb,
  p_total integer
) returns table (
  out_target_id uuid,
  out_target_current_hp integer,
  out_roll_id uuid,
  out_roll_created_at timestamptz,
  out_instant_death boolean,
  out_failure_added integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_target public.characters;
  v_new_hp integer;
  v_absorbed integer;
  v_hp_damage integer;
  v_successes integer;
  v_failures integer;
  v_stable boolean;
  v_dead boolean;
  v_concentrating text;
  v_pending_dc integer;
  v_instant_death boolean := false;
  v_failure_added integer := 0;
  v_roll_id uuid;
  v_roll_created_at timestamptz;
begin
  if p_damage is null or p_damage < 0 then
    raise exception 'Damage must be zero or more';
  end if;

  select ch.campaign_id into v_campaign_id
  from public.characters ch
  where ch.id = p_attacker_character_id
    and (ch.owner_id = auth.uid() or public.is_campaign_dm(ch.campaign_id));

  if v_campaign_id is null then
    raise exception 'Attacker not found, or you may not resolve its attacks';
  end if;

  select ch.* into v_target
  from public.characters ch
  where ch.id = p_target_character_id
    and ch.campaign_id = v_campaign_id
  for update;

  if not found then
    raise exception 'Target not found in this campaign';
  end if;

  -- Temporary HP soaks damage first (0122); only the rest reaches real HP.
  v_absorbed := least(v_target.temp_hp, greatest(p_damage, 0));
  v_hp_damage := p_damage - v_absorbed;

  v_new_hp := least(v_target.max_hp, greatest(0, v_target.current_hp - v_hp_damage));
  v_successes := v_target.death_save_successes;
  v_failures := v_target.death_save_failures;
  v_stable := v_target.is_stable;
  v_dead := v_target.is_dead;
  v_concentrating := v_target.concentrating_on;
  v_pending_dc := v_target.pending_concentration_dc;

  if v_hp_damage > 0 and v_target.current_hp = 0 and not v_target.is_dead then
    if v_hp_damage >= v_target.max_hp then
      v_instant_death := true;
      v_dead := true;
    else
      if v_stable then
        v_stable := false;
        v_successes := 0;
        v_failures := 0;
      end if;
      v_failure_added := case when coalesce(p_critical, false) then 2 else 1 end;
      v_failures := least(3, v_failures + v_failure_added);
      v_dead := v_failures >= 3;
    end if;
  elsif v_hp_damage > 0 and v_target.current_hp > 0 and not v_target.is_dead
    and v_hp_damage - v_target.current_hp >= v_target.max_hp then
    -- Massive damage: dropped to 0 with at least max HP left over.
    v_instant_death := true;
    v_dead := true;
  end if;

  if p_damage > 0 then
    if v_new_hp = 0 then
      v_concentrating := null;
      v_pending_dc := null;
    elsif v_concentrating is not null then
      v_pending_dc := greatest(10, p_damage / 2);
    end if;
  end if;

  update public.characters
  set current_hp = v_new_hp,
      temp_hp = temp_hp - v_absorbed,
      death_save_successes = v_successes,
      death_save_failures = v_failures,
      is_stable = v_stable,
      is_dead = v_dead,
      concentrating_on = v_concentrating,
      pending_concentration_dc = v_pending_dc,
      updated_at = now()
  where id = v_target.id;

  insert into public.roll_log (campaign_id, roller_user_id, character_id, kind, breakdown, total)
  values (v_campaign_id, auth.uid(), p_attacker_character_id, 'attack', p_breakdown, p_total)
  returning id, created_at into v_roll_id, v_roll_created_at;

  return query select v_target.id, v_new_hp, v_roll_id, v_roll_created_at, v_instant_death, v_failure_added;
end;
$$;

grant execute on function public.resolve_attack_damage(uuid, uuid, integer, boolean, jsonb, integer) to authenticated;

create or replace function public.resolve_npc_attack_damage(
  p_attacker_combatant_id uuid,
  p_target_character_id uuid,
  p_damage integer,
  p_critical boolean,
  p_breakdown jsonb,
  p_total integer
) returns table (
  out_target_id uuid,
  out_target_current_hp integer,
  out_roll_id uuid,
  out_roll_created_at timestamptz,
  out_instant_death boolean,
  out_failure_added integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_target public.characters;
  v_new_hp integer;
  v_absorbed integer;
  v_hp_damage integer;
  v_successes integer;
  v_failures integer;
  v_stable boolean;
  v_dead boolean;
  v_concentrating text;
  v_pending_dc integer;
  v_instant_death boolean := false;
  v_failure_added integer := 0;
  v_roll_id uuid;
  v_roll_created_at timestamptz;
begin
  if p_damage is null or p_damage < 0 then
    raise exception 'Damage must be zero or more';
  end if;

  select e.campaign_id into v_campaign_id
  from public.combat_combatants c
  join public.combat_encounters e on e.id = c.encounter_id
  where c.id = p_attacker_combatant_id
    and c.character_id is null
    and public.is_campaign_dm(e.campaign_id);

  if v_campaign_id is null then
    raise exception 'Attacker not found, or you may not resolve its attacks';
  end if;

  select ch.* into v_target
  from public.characters ch
  where ch.id = p_target_character_id
    and ch.campaign_id = v_campaign_id
  for update;

  if not found then
    raise exception 'Target not found in this campaign';
  end if;

  -- Temporary HP soaks damage first (0122); only the rest reaches real HP.
  v_absorbed := least(v_target.temp_hp, greatest(p_damage, 0));
  v_hp_damage := p_damage - v_absorbed;

  v_new_hp := least(v_target.max_hp, greatest(0, v_target.current_hp - v_hp_damage));
  v_successes := v_target.death_save_successes;
  v_failures := v_target.death_save_failures;
  v_stable := v_target.is_stable;
  v_dead := v_target.is_dead;
  v_concentrating := v_target.concentrating_on;
  v_pending_dc := v_target.pending_concentration_dc;

  if v_hp_damage > 0 and v_target.current_hp = 0 and not v_target.is_dead then
    if v_hp_damage >= v_target.max_hp then
      v_instant_death := true;
      v_dead := true;
    else
      if v_stable then
        v_stable := false;
        v_successes := 0;
        v_failures := 0;
      end if;
      v_failure_added := case when coalesce(p_critical, false) then 2 else 1 end;
      v_failures := least(3, v_failures + v_failure_added);
      v_dead := v_failures >= 3;
    end if;
  elsif v_hp_damage > 0 and v_target.current_hp > 0 and not v_target.is_dead
    and v_hp_damage - v_target.current_hp >= v_target.max_hp then
    -- Massive damage: dropped to 0 with at least max HP left over.
    v_instant_death := true;
    v_dead := true;
  end if;

  if p_damage > 0 then
    if v_new_hp = 0 then
      v_concentrating := null;
      v_pending_dc := null;
    elsif v_concentrating is not null then
      v_pending_dc := greatest(10, p_damage / 2);
    end if;
  end if;

  update public.characters
  set current_hp = v_new_hp,
      temp_hp = temp_hp - v_absorbed,
      death_save_successes = v_successes,
      death_save_failures = v_failures,
      is_stable = v_stable,
      is_dead = v_dead,
      concentrating_on = v_concentrating,
      pending_concentration_dc = v_pending_dc,
      updated_at = now()
  where id = v_target.id;

  insert into public.roll_log (campaign_id, roller_user_id, character_id, kind, breakdown, total)
  values (v_campaign_id, auth.uid(), null, 'attack', p_breakdown, p_total)
  returning id, created_at into v_roll_id, v_roll_created_at;

  return query select v_target.id, v_new_hp, v_roll_id, v_roll_created_at, v_instant_death, v_failure_added;
end;
$$;

grant execute on function public.resolve_npc_attack_damage(uuid, uuid, integer, boolean, jsonb, integer) to authenticated;

create or replace function public.long_rest(p_character_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_character public.characters;
begin
  select * into v_character
  from public.characters
  where id = p_character_id
  for update;

  if not found then
    raise exception 'Character not found, or you may not rest it';
  end if;
  if v_character.is_dead then
    raise exception 'A dead character can''t take a long rest';
  end if;
  if v_character.current_hp = 0 then
    raise exception 'A character needs at least 1 hit point to benefit from a long rest';
  end if;

  -- Every resource resets (a long rest is a superset of a short rest).
  update public.character_resources
  set current_uses = max_uses
  where character_id = p_character_id;

  update public.characters
  set current_hp = max_hp,
      temp_hp = 0,
      death_save_successes = 0,
      death_save_failures = 0,
      is_stable = false,
      pending_concentration_dc = null,
      hit_dice_spent = greatest(0, hit_dice_spent - greatest(1, level / 2)),
      updated_at = now()
  where id = p_character_id;
end;
$$;

grant execute on function public.long_rest(uuid) to authenticated;

create or replace function public.spend_hit_die(p_character_id uuid, p_healing integer)
returns public.characters
language plpgsql
set search_path = public
as $$
declare
  v_character public.characters;
begin
  select * into v_character
  from public.characters
  where id = p_character_id
  for update;

  if not found then
    raise exception 'Character not found, or you may not change it';
  end if;
  if v_character.is_dead then
    raise exception 'A dead character can''t spend hit dice';
  end if;
  if v_character.hit_dice_spent >= v_character.level then
    raise exception 'No hit dice left — they come back on a long rest';
  end if;

  update public.characters
  set hit_dice_spent = hit_dice_spent + 1
  where id = p_character_id;

  return public.apply_hp_delta(p_character_id, greatest(p_healing, 0));
end;
$$;

grant execute on function public.spend_hit_die(uuid, integer) to authenticated;
