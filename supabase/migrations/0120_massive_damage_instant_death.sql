-- Massive damage (SRD "Instant Death"): when damage reduces a creature to
-- 0 hit points and damage remains, it dies outright if the remainder
-- equals or exceeds its hit point maximum.
--
-- 0031/0032/0038 only applied that check when the character was ALREADY at
-- 0 HP. A character at 5/12 HP taking 17 damage (12 left over) must die
-- instantly too, not start rolling death saves. This redefines the three
-- character-damage RPCs with that extra branch; everything else in each
-- body is carried over verbatim from its latest definition (apply_hp_delta
-- and resolve_attack_damage from 0032, resolve_npc_attack_damage from
-- 0038). Signatures and return shapes are unchanged, so CREATE OR REPLACE
-- suffices and every caller (including 0071's weather damage, which goes
-- through apply_hp_delta) picks the rule up.

create or replace function public.apply_hp_delta(p_character_id uuid, p_delta integer)
returns public.characters
language plpgsql
set search_path = public
as $$
declare
  v_current public.characters;
  v_row public.characters;
  v_new_hp integer;
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

  v_new_hp := least(v_current.max_hp, greatest(0, v_current.current_hp + p_delta));
  v_successes := v_current.death_save_successes;
  v_failures := v_current.death_save_failures;
  v_stable := v_current.is_stable;
  v_dead := v_current.is_dead;
  v_concentrating := v_current.concentrating_on;
  v_pending_dc := v_current.pending_concentration_dc;

  if p_delta < 0 and v_current.current_hp = 0 and not v_current.is_dead then
    if -p_delta >= v_current.max_hp then
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
  elsif p_delta < 0 and v_current.current_hp > 0 and not v_current.is_dead
    and (-p_delta) - v_current.current_hp >= v_current.max_hp then
    -- Massive damage: dropped to 0 with at least max HP left over.
    v_dead := true;
  elsif p_delta > 0 and v_current.current_hp = 0 and v_new_hp > 0 then
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

  v_new_hp := least(v_target.max_hp, greatest(0, v_target.current_hp - p_damage));
  v_successes := v_target.death_save_successes;
  v_failures := v_target.death_save_failures;
  v_stable := v_target.is_stable;
  v_dead := v_target.is_dead;
  v_concentrating := v_target.concentrating_on;
  v_pending_dc := v_target.pending_concentration_dc;

  if p_damage > 0 and v_target.current_hp = 0 and not v_target.is_dead then
    if p_damage >= v_target.max_hp then
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
  elsif p_damage > 0 and v_target.current_hp > 0 and not v_target.is_dead
    and p_damage - v_target.current_hp >= v_target.max_hp then
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

  v_new_hp := least(v_target.max_hp, greatest(0, v_target.current_hp - p_damage));
  v_successes := v_target.death_save_successes;
  v_failures := v_target.death_save_failures;
  v_stable := v_target.is_stable;
  v_dead := v_target.is_dead;
  v_concentrating := v_target.concentrating_on;
  v_pending_dc := v_target.pending_concentration_dc;

  if p_damage > 0 and v_target.current_hp = 0 and not v_target.is_dead then
    if p_damage >= v_target.max_hp then
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
  elsif p_damage > 0 and v_target.current_hp > 0 and not v_target.is_dead
    and p_damage - v_target.current_hp >= v_target.max_hp then
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
