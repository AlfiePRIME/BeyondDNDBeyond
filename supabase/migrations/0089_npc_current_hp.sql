-- Click-to-attack follow-up: closes a real gap the roll route has had since
-- Prompt 61 — a PC's attack roll landing on an NPC target has NEVER
-- automatically reduced its HP (unlike PC-attacks-PC via resolve_attack_
-- damage, or NPC-attacks-PC via resolve_npc_attack_damage); the DM has had
-- to separately call apply_npc_hp_delta by hand every time. This also blocks
-- the new "attack whether in combat or not" flow: today an NPC's only HP
-- counter (combat_combatants.npc_current_hp) doesn't exist until the token
-- has been seeded into a live encounter, so a casual pre-combat swing has
-- nowhere to record damage at all.
--
-- Fix: map_tokens gains its own current_hp, the token's own persistent HP
-- counter — the characters.current_hp parity NPCs have never had (a PC's
-- HP already lives directly on its own row, independent of whether combat
-- is active; an NPC's HP has only ever existed as a combat-scoped
-- snapshot). Null means "at full health, derive the ceiling from its
-- linked stat block" — the same sparse-until-touched convention
-- npc_current_hp itself already uses, extended one level earlier.
alter table public.map_tokens
  add column if not exists current_hp integer
    check (current_hp is null or current_hp >= 0);

-- start_combat's seed now prefers a token's own already-accumulated damage
-- (coalesce) over always restarting at the template's max_hp — a monster
-- hurt before the fight formally started (or in an earlier fight that
-- ended) keeps its wounds when it's seeded into a new encounter. Everything
-- else — the FOR UPDATE serialization, the DM check, the already-active/
-- no-live-map/no-tokens errors — is preserved verbatim from 0038.
create or replace function public.start_combat(p_campaign_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live_map uuid;
  v_encounter_id uuid;
begin
  select live_map into v_live_map
  from public.campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception 'Campaign not found';
  end if;

  if not public.is_campaign_dm(p_campaign_id) then
    raise exception 'Only the DM can start combat';
  end if;

  if exists (
    select 1 from public.combat_encounters
    where campaign_id = p_campaign_id and ended_at is null
  ) then
    raise exception 'Combat is already in progress for this campaign';
  end if;

  if v_live_map is null then
    raise exception 'Set a live map before starting combat';
  end if;

  if not exists (select 1 from public.map_tokens where map_id = v_live_map) then
    raise exception 'There are no tokens on the live map to fight';
  end if;

  insert into public.combat_encounters (campaign_id)
  values (p_campaign_id)
  returning id into v_encounter_id;

  insert into public.combat_combatants
    (encounter_id, token_id, character_id, npc_name, monster_stat_block_id, npc_current_hp)
  select v_encounter_id, t.id, t.character_id, t.npc_name, t.monster_stat_block_id,
    case when sb.id is null then null else coalesce(t.current_hp, sb.max_hp) end
  from public.map_tokens t
  left join public.monster_stat_blocks sb on sb.id = t.monster_stat_block_id
  where t.map_id = v_live_map;

  return v_encounter_id;
end;
$$;

grant execute on function public.start_combat(uuid) to authenticated;

-- add_combatant's seed gets the identical coalesce treatment — everything
-- else preserved verbatim from 0038.
create or replace function public.add_combatant(
  p_encounter_id uuid,
  p_token_id uuid,
  p_initiative integer
) returns public.combat_combatants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_ended timestamptz;
  v_token public.map_tokens;
  v_token_campaign uuid;
  v_stat_hp integer;
  v_row public.combat_combatants;
begin
  select campaign_id, ended_at into v_campaign_id, v_ended
  from public.combat_encounters
  where id = p_encounter_id
  for update;

  if not found then
    raise exception 'Encounter not found';
  end if;

  if not public.is_campaign_dm(v_campaign_id) then
    raise exception 'Only the DM can add a combatant';
  end if;

  if v_ended is not null then
    raise exception 'This encounter has already ended';
  end if;

  select t.* into v_token
  from public.map_tokens t
  where t.id = p_token_id;

  if not found then
    raise exception 'Token not found';
  end if;

  select m.campaign_id into v_token_campaign
  from public.campaign_maps m
  where m.id = v_token.map_id;

  if v_token_campaign is distinct from v_campaign_id then
    raise exception 'That token belongs to another campaign';
  end if;

  if exists (
    select 1 from public.combat_combatants c
    where c.encounter_id = p_encounter_id and c.token_id = p_token_id
  ) then
    raise exception 'That token is already in this encounter';
  end if;

  select coalesce(v_token.current_hp, sb.max_hp) into v_stat_hp
  from public.monster_stat_blocks sb
  where sb.id = v_token.monster_stat_block_id;

  insert into public.combat_combatants
    (encounter_id, token_id, character_id, npc_name, monster_stat_block_id, npc_current_hp, initiative)
  values
    (p_encounter_id, p_token_id, v_token.character_id, v_token.npc_name,
     v_token.monster_stat_block_id, v_stat_hp, p_initiative)
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.add_combatant(uuid, uuid, integer) to authenticated;

-- apply_npc_hp_delta (the DM's manual in-combat HP control) now writes the
-- same resulting value back to the token's own current_hp too, so the two
-- counters never drift apart — a DM manually healing/damaging a combatant
-- mid-fight and then the fight ending must leave the token's OWN HP correct
-- for whatever attacks it next (formal combat or a casual out-of-combat
-- swing). Everything else preserved verbatim from 0038.
create or replace function public.apply_npc_hp_delta(p_combatant_id uuid, p_delta integer)
returns public.combat_combatants
language plpgsql
set search_path = public
as $$
declare
  v_row public.combat_combatants;
begin
  update public.combat_combatants c
  set npc_current_hp = least(sb.max_hp, greatest(0, c.npc_current_hp + p_delta))
  from public.monster_stat_blocks sb
  where c.id = p_combatant_id
    and sb.id = c.monster_stat_block_id
    and c.npc_current_hp is not null
  returning c.* into v_row;

  if not found then
    raise exception 'Combatant not found, has no tracked HP, or you may not change it';
  end if;

  if v_row.token_id is not null then
    update public.map_tokens set current_hp = v_row.npc_current_hp where id = v_row.token_id;
  end if;

  return v_row;
end;
$$;

grant execute on function public.apply_npc_hp_delta(uuid, integer) to authenticated;

-- The new automatic-application RPC: the PC-attacks-NPC counterpart of
-- resolve_attack_damage/resolve_npc_attack_damage — a NEW, PARALLEL
-- function, never a modification of either (the same accepted duplication
-- precedent apply_hp_delta/resolve_attack_damage themselves established: a
-- different authorization model and a different target shape each get
-- their own RPC). Authorization is attacker-based, identical to
-- resolve_attack_damage: the caller owns the attacking character, or is
-- that character's campaign DM. The target is a map_tokens row (an NPC has
-- no character row to lock/update) rather than a characters row — clamped
-- against its linked stat block's max_hp, with no death-save/instant-death/
-- concentration bookkeeping at all (0038's own established rule: a monster
-- at 0 is just at 0, the DM narrates from there; none of that machinery
-- exists for monsters). Writes current_hp unconditionally (whether or not
-- combat is active) and ALSO keeps an active encounter's own
-- combat_combatants.npc_current_hp in sync when this token happens to be
-- seated in one right now, so the DM's live combat panel HP bar is never
-- stale — the two counters stay reconciled from both directions
-- (apply_npc_hp_delta above writes token -> combatant; this writes
-- combatant -> token).
create or replace function public.resolve_pc_attack_on_npc_damage(
  p_attacker_character_id uuid,
  p_target_token_id uuid,
  p_damage integer,
  p_critical boolean,
  p_breakdown jsonb,
  p_total integer
) returns table (
  out_target_token_id uuid,
  out_target_current_hp integer,
  out_roll_id uuid,
  out_roll_created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_token public.map_tokens;
  v_token_campaign uuid;
  v_max_hp integer;
  v_new_hp integer;
  v_combatant_id uuid;
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

  select t.* into v_token
  from public.map_tokens t
  where t.id = p_target_token_id
    and t.character_id is null
  for update;

  if not found then
    raise exception 'Target not found, or has no HP to track';
  end if;

  select m.campaign_id into v_token_campaign
  from public.campaign_maps m
  where m.id = v_token.map_id;

  if v_token_campaign is distinct from v_campaign_id then
    raise exception 'Target belongs to another campaign';
  end if;

  select sb.max_hp into v_max_hp
  from public.monster_stat_blocks sb
  where sb.id = v_token.monster_stat_block_id;

  if v_max_hp is null then
    raise exception 'This NPC has no stat block, so it has no HP to track';
  end if;

  v_new_hp := least(v_max_hp, greatest(0, coalesce(v_token.current_hp, v_max_hp) - p_damage));

  update public.map_tokens set current_hp = v_new_hp where id = v_token.id;

  select c.id into v_combatant_id
  from public.combat_combatants c
  join public.combat_encounters e on e.id = c.encounter_id
  where c.token_id = v_token.id
    and e.ended_at is null;

  if v_combatant_id is not null then
    update public.combat_combatants set npc_current_hp = v_new_hp where id = v_combatant_id;
  end if;

  insert into public.roll_log (campaign_id, roller_user_id, character_id, kind, breakdown, total)
  values (v_campaign_id, auth.uid(), p_attacker_character_id, 'attack', p_breakdown, p_total)
  returning id, created_at into v_roll_id, v_roll_created_at;

  return query select v_token.id, v_new_hp, v_roll_id, v_roll_created_at;
end;
$$;

grant execute on function public.resolve_pc_attack_on_npc_damage(uuid, uuid, integer, boolean, jsonb, integer) to authenticated;
