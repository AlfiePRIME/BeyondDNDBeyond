-- Prompt 61: DM NPC/monster tools — lightweight stat blocks.
--
-- monster_stat_blocks is the campaign-scoped, DM-authored, reusable
-- TEMPLATE (name, HP, AC, passive Perception, a small set of named
-- attacks); a placed token LINKS to it (map_tokens.monster_stat_block_id)
-- and a combatant SNAPSHOTS the link plus its own instance HP
-- (combat_combatants.monster_stat_block_id / npc_current_hp). Existing
-- bare npc_name-only tokens are untouched — the new column is nullable
-- alongside the 0019 character_id/npc_name XOR, whose shape does not
-- change: a stat-blocked token is still an NPC token (npc_name populated
-- from the stat block's name at creation), so every existing display path
-- that reads npc_name keeps working unmodified.

create table if not exists public.monster_stat_blocks (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  name text not null,
  max_hp integer not null check (max_hp > 0),
  armor_class integer not null check (armor_class > 0),
  passive_perception integer not null default 10,
  -- A small structured list of named attacks: {name, bonus,
  -- damageNotation}[] — the characters.inventory/spells "small jsonb list,
  -- no child table" convention; the app layer (data-access) defines its
  -- only schema.
  attacks jsonb not null default '[]',
  created_at timestamptz not null default now()
);

alter table public.monster_stat_blocks enable row level security;

-- The npcs (0020) posture exactly: DM-authored content the whole table can
-- read (players need a monster's AC for the auto-fill, and its passive
-- Perception is table-stated data like a PC's), DM-only writes.
create policy "campaign members can read stat blocks"
  on public.monster_stat_blocks for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

create policy "the DM can create stat blocks"
  on public.monster_stat_blocks for insert
  to authenticated
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can update stat blocks"
  on public.monster_stat_blocks for update
  to authenticated
  using (public.is_campaign_dm(campaign_id))
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can delete stat blocks"
  on public.monster_stat_blocks for delete
  to authenticated
  using (public.is_campaign_dm(campaign_id));

-- The token → template link. Nullable; on delete SET NULL so deleting a
-- template leaves its placed tokens as ordinary bare NPC tokens rather
-- than sweeping them off the map.
alter table public.map_tokens
  add column if not exists monster_stat_block_id uuid
    references public.monster_stat_blocks (id) on delete set null;

-- The combatant-side snapshot (taken when the combatant is added, exactly
-- like character_id/npc_name at start_combat time) plus the INSTANCE HP:
-- npc_current_hp is non-null only for a stat-blocked NPC combatant,
-- initialized from the template's max_hp; null for PCs (whose HP lives on
-- characters) and for bare unstatted NPCs (which have no HP anywhere, as
-- before). The upper clamp joins to the template's max_hp at write time
-- (apply_npc_hp_delta below) rather than snapshotting max_hp separately —
-- one source of truth for the ceiling.
alter table public.combat_combatants
  add column if not exists monster_stat_block_id uuid
    references public.monster_stat_blocks (id) on delete set null,
  add column if not exists npc_current_hp integer
    check (npc_current_hp is null or npc_current_hp >= 0);

-- start_combat, second shape (create or replace): everything from 0027 —
-- the FOR UPDATE serialization, the DM check, the already-active/no-live-
-- map/no-tokens errors, seed-everyone-at-once — is preserved verbatim.
-- New: the seeding INSERT also snapshots each token's
-- monster_stat_block_id and initializes npc_current_hp from the linked
-- template's max_hp (null for PCs and bare NPCs), via a LEFT JOIN.
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

  -- "Every combatant present" = every token on the live map at this
  -- instant, party AND hostile/neutral alike — with the stat-block link
  -- snapshotted and instance HP seeded from the template where one exists.
  insert into public.combat_combatants
    (encounter_id, token_id, character_id, npc_name, monster_stat_block_id, npc_current_hp)
  select v_encounter_id, t.id, t.character_id, t.npc_name, t.monster_stat_block_id, sb.max_hp
  from public.map_tokens t
  left join public.monster_stat_blocks sb on sb.id = t.monster_stat_block_id
  where t.map_id = v_live_map;

  return v_encounter_id;
end;
$$;

grant execute on function public.start_combat(uuid) to authenticated;

-- Adds ONE combatant to an ALREADY-ACTIVE encounter — the capability
-- start_combat (seed-everyone-once) never had, for the quick-add flow. An
-- RPC rather than a policy'd INSERT because the write has cross-row
-- concerns a per-row predicate can't express: the encounter must be
-- active, the token must belong to the encounter's campaign, the
-- duplicate-add must be rejected cleanly, and character_id/npc_name/
-- monster_stat_block_id/npc_current_hp must be snapshotted from the token
-- (and its template) exactly the way start_combat's seed does. SECURITY
-- DEFINER, DM-only (is_campaign_dm) — adding combatants is table
-- management like starting/ending the fight, never a player call. The
-- encounter row is locked FOR UPDATE so two near-simultaneous adds of the
-- same token serialize and the loser hits the duplicate check. No list
-- splicing anywhere: the canonical turn order (initiative desc nulls
-- last, created_at, id) sorts the fresh row into place at read time.
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

  -- The 0019/0027 cross-campaign guard: a token from some other campaign's
  -- map can never be stitched into this encounter.
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

  select sb.max_hp into v_stat_hp
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

-- NPC HP: apply_hp_delta's 0028 single-UPDATE clamp shape applied to
-- npc_current_hp, with the upper bound joined from the linked template's
-- max_hp. Deliberately SECURITY INVOKER for 0028's exact reason: the
-- combat_combatants UPDATE policy (can_write_combatant) already says who
-- may write this row, and an NPC combatant (character_id null) fails the
-- ownership branch by construction, so this is DM-only without any new
-- rule. No death-save/concentration bookkeeping — those state machines
-- live on characters and deliberately do not exist for monsters (a
-- monster at 0 is just at 0; the DM narrates from there).
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
    -- RLS filters the row out for anyone who isn't the DM (an NPC
    -- combatant has no owning player), and a PC/bare-NPC combatant has no
    -- npc_current_hp to move — indistinguishable here, the apply_hp_delta
    -- opacity.
    raise exception 'Combatant not found, has no tracked HP, or you may not change it';
  end if;

  return v_row;
end;
$$;

grant execute on function public.apply_npc_hp_delta(uuid, integer) to authenticated;

-- NPC-attacker damage resolution: a NEW, PARALLEL function beside
-- resolve_attack_damage (0032), NOT a modification of it — the accepted
-- duplication precedent between apply_hp_delta and resolve_attack_damage
-- themselves: a different authorization model gets its own RPC. The
-- attacker here is a COMBATANT (an NPC has no character row), and the
-- authorization is is_campaign_dm on the attacking combatant's campaign —
-- an NPC attacker is always DM-controlled; there is no owning-player
-- concept to fall back to. Everything target-side — the same-campaign
-- guard, the lock, the clamp, the at-0 death-save branching with crit
-- doubling, instant death, the stable-break reset, the concentration
-- branch, and the atomic same-transaction roll_log INSERT (with
-- character_id null: the attacker has none) — mirrors resolve_attack_
-- damage verbatim, so an NPC's hit dropping a PC to 0 starts the exact
-- same death-save sequence a PC's hit would.
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

  -- SECURITY DEFINER bypasses RLS, so the attacker-side authorization is
  -- explicit: the attacking combatant must be an NPC (character_id null —
  -- a PC attacker goes through resolve_attack_damage) and the caller must
  -- be its campaign's DM.
  select e.campaign_id into v_campaign_id
  from public.combat_combatants c
  join public.combat_encounters e on e.id = c.encounter_id
  where c.id = p_attacker_combatant_id
    and c.character_id is null
    and public.is_campaign_dm(e.campaign_id);

  if v_campaign_id is null then
    raise exception 'Attacker not found, or you may not resolve its attacks';
  end if;

  -- Same-campaign guard and lock, verbatim from resolve_attack_damage.
  select ch.* into v_target
  from public.characters ch
  where ch.id = p_target_character_id
    and ch.campaign_id = v_campaign_id
  for update;

  if not found then
    raise exception 'Target not found in this campaign';
  end if;

  -- Clamp expression matches apply_hp_delta exactly.
  v_new_hp := least(v_target.max_hp, greatest(0, v_target.current_hp - p_damage));
  v_successes := v_target.death_save_successes;
  v_failures := v_target.death_save_failures;
  v_stable := v_target.is_stable;
  v_dead := v_target.is_dead;
  v_concentrating := v_target.concentrating_on;
  v_pending_dc := v_target.pending_concentration_dc;

  -- Same already-at-0 rules as apply_hp_delta, plus the crit doubling.
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
  end if;

  -- The concentration branch (Prompt 50) — resolve_attack_damage's exact
  -- rules.
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

  -- The atomic log write, for 0030's structural reason: this is the ONLY
  -- way the NPC-attacker path can move a player's HP, and it must always
  -- leave a matching roll_log row. character_id is null — the attacker
  -- has no character; the breakdown carries the monster's identity.
  insert into public.roll_log (campaign_id, roller_user_id, character_id, kind, breakdown, total)
  values (v_campaign_id, auth.uid(), null, 'attack', p_breakdown, p_total)
  returning id, created_at into v_roll_id, v_roll_created_at;

  return query select v_target.id, v_new_hp, v_roll_id, v_roll_created_at, v_instant_death, v_failure_added;
end;
$$;

grant execute on function public.resolve_npc_attack_damage(uuid, uuid, integer, boolean, jsonb, integer) to authenticated;
