-- Prompt 45: combat encounters and turn order.
--
-- Two tables rather than fields on campaigns (the way live_map/session_active
-- ride there): later prompts hang per-combatant state (conditions, death
-- saves, concentration) off these rows, which a boolean on campaigns could
-- never carry.

create table if not exists public.combat_encounters (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  round_number integer not null default 1,
  current_turn_index integer not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

-- "The active encounter" is the one with ended_at null — at most one per
-- campaign, enforced here rather than in application code.
create unique index if not exists combat_encounters_one_active_per_campaign
  on public.combat_encounters (campaign_id)
  where ended_at is null;

create table if not exists public.combat_combatants (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.combat_encounters (id) on delete cascade,
  -- Deleting a token removes its combatant from the fight; character_id/
  -- npc_name below are seeding-time snapshots so the row stays meaningful on
  -- its own if the token merely leaves the live map (a mid-combat map
  -- transition) rather than requiring a live join through token_id.
  token_id uuid not null references public.map_tokens (id) on delete cascade,
  character_id uuid references public.characters (id) on delete cascade,
  npc_name text,
  -- Null until entered by hand — Prompt 48 wires the dice roller's
  -- roll-initiative button in; this prompt is manual entry only.
  initiative integer,
  created_at timestamptz not null default now(),
  -- Mirrors map_tokens_pc_xor_npc (0019): a combatant is a PC or an NPC
  -- placeholder, never both, never neither.
  constraint combat_combatants_pc_xor_npc check (
    (character_id is not null and npc_name is null)
    or (character_id is null and npc_name is not null)
  )
);

alter table public.combat_encounters enable row level security;
alter table public.combat_combatants enable row level security;

-- The turn order every player watches; no write policies on encounters at
-- all — every encounter write goes through the RPCs below, which have
-- multi-row invariants (seed-from-live-map, wrap-and-increment) that a
-- per-row policy predicate can't protect.
create policy "members read their campaign's encounters"
  on public.combat_encounters for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

-- SECURITY DEFINER for the usual reason (see can_write_map_token, 0019): it
-- runs inside combat_combatants' policies and must not itself be filtered
-- by combat_encounters' own RLS.
create or replace function public.can_read_combatant(p_encounter_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.combat_encounters e
    where e.id = p_encounter_id
      and public.is_campaign_member(e.campaign_id)
  );
$$;

create policy "members read combatants of their campaign's encounters"
  on public.combat_combatants for select
  to authenticated
  using (public.can_read_combatant(encounter_id));

-- Initiative entry is DM-or-owner, mirroring can_write_map_token (0019):
-- the player who physically rolled the die types their own number, and an
-- NPC row (character_id null) fails the ownership branch by construction so
-- NPC initiative stays DM-only. A plain policy, not an RPC — one row, no
-- cross-row atomicity to protect, unlike advance_turn below. The
-- campaign-equality join closes the same cross-campaign hole 0019 closes.
create or replace function public.can_write_combatant(p_encounter_id uuid, p_character_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.combat_encounters e
    where e.id = p_encounter_id
      and (
        public.is_campaign_dm(e.campaign_id)
        or exists (
          select 1
          from public.characters ch
          where ch.id = p_character_id
            and ch.owner_id = auth.uid()
            and ch.campaign_id = e.campaign_id
        )
      )
  );
$$;

create policy "DM, or the owning player, can update a combatant"
  on public.combat_combatants for update
  to authenticated
  using (public.can_write_combatant(encounter_id, character_id))
  with check (public.can_write_combatant(encounter_id, character_id));

-- Same FOR UPDATE shape as start_session (0013): two near-simultaneous
-- Start presses serialize on the campaign row, and the loser re-reads,
-- sees the winner's encounter, and raises a clear error instead of hitting
-- the partial unique index with an opaque one.
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

  -- "Every combatant present" = every token on the live map at this instant,
  -- party AND hostile/neutral alike — an absent character has no token and
  -- so gets no turn, same as anyone away from the table.
  insert into public.combat_combatants (encounter_id, token_id, character_id, npc_name)
  select v_encounter_id, t.id, t.character_id, t.npc_name
  from public.map_tokens t
  where t.map_id = v_live_map;

  return v_encounter_id;
end;
$$;

grant execute on function public.start_combat(uuid) to authenticated;

-- The FOR UPDATE row lock is the atomicity guarantee: a double-click, or
-- the DM and the current player advancing near-simultaneously, serialize
-- here so the pointer moves exactly one step per call.
create or replace function public.advance_turn(p_encounter_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_index integer;
  v_round integer;
  v_ended timestamptz;
  v_count integer;
  v_current_character uuid;
begin
  select campaign_id, current_turn_index, round_number, ended_at
    into v_campaign_id, v_index, v_round, v_ended
  from public.combat_encounters
  where id = p_encounter_id
  for update;

  if not found then
    raise exception 'Encounter not found';
  end if;

  if v_ended is not null then
    raise exception 'This encounter has already ended';
  end if;

  select count(*) into v_count
  from public.combat_combatants
  where encounter_id = p_encounter_id;

  if v_count = 0 then
    raise exception 'This encounter has no combatants';
  end if;

  -- A combatant deleted mid-round (its token was removed) can leave the
  -- stored index past the end — clamp before reading the current combatant.
  v_index := least(v_index, v_count - 1);

  -- Canonical turn order: initiative desc (nulls last, so not-yet-entered
  -- combatants sort to the bottom), ties broken by created_at then id.
  -- listCombatCombatants in data-access must order identically so
  -- current_turn_index indexes the same row everywhere.
  select c.character_id into v_current_character
  from public.combat_combatants c
  where c.encounter_id = p_encounter_id
  order by c.initiative desc nulls last, c.created_at asc, c.id asc
  offset v_index
  limit 1;

  -- The cross-row authorization a plain policy can't express: the caller
  -- must be the DM, or own the character of the combatant the pointer is ON
  -- right now. An NPC turn (character_id null) is DM-only by construction.
  if not public.is_campaign_dm(v_campaign_id) and not exists (
    select 1
    from public.characters ch
    where ch.id = v_current_character
      and ch.owner_id = auth.uid()
  ) then
    raise exception 'Only the DM or the current combatant''s player can advance the turn';
  end if;

  if v_index + 1 >= v_count then
    update public.combat_encounters
    set current_turn_index = 0, round_number = v_round + 1
    where id = p_encounter_id;
  else
    update public.combat_encounters
    set current_turn_index = v_index + 1
    where id = p_encounter_id;
  end if;
end;
$$;

grant execute on function public.advance_turn(uuid) to authenticated;

-- Idempotent like end_session (0013): two DM windows ending the same fight
-- shouldn't error the loser.
create or replace function public.end_combat(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_campaign_dm(p_campaign_id) then
    raise exception 'Only the DM can end combat';
  end if;

  update public.combat_encounters
  set ended_at = now()
  where campaign_id = p_campaign_id and ended_at is null;
end;
$$;

grant execute on function public.end_combat(uuid) to authenticated;
