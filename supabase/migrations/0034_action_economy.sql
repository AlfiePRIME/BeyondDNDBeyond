-- Prompt 53: action economy tracking and the DM strictness toggle.
--
-- Per-turn Action/Bonus Action/Reaction/Movement usage lives on
-- combat_combatants — the row conditions already hang off — because the
-- tracking is inherently combat-scoped: it resets every turn and dies with
-- the encounter, unlike HP/concentration which persist on characters
-- across fights. All four columns default to "unused", so a freshly
-- start_combat'd encounter needs no special handling.

alter table public.combat_combatants
  add column if not exists action_used boolean not null default false,
  add column if not exists bonus_action_used boolean not null default false,
  add column if not exists reaction_used boolean not null default false,
  add column if not exists movement_used_feet integer not null default 0;

-- The DM's enforcement dial. Strict (normal 5e rules, the safe
-- conventional default) hard-blocks a second action / over-speed movement;
-- Freeform only tracks and displays. A plain campaigns column governed by
-- the EXISTING permissive members-update policy (0004) — DM-only
-- enforcement is a UI concern here, exactly the house_rules/live_map
-- precedent, not a new RLS rule.
alter table public.campaigns
  add column if not exists action_economy_strict boolean not null default true;

-- Strictness flips must reach every connected player live — the character
-- sheet isn't on the room's broadcast channel, so this rides a
-- postgres_changes feed like profiles (0012) / characters (0028).
-- Visibility rides campaigns' members-only SELECT policy.
alter publication supabase_realtime add table public.campaigns;

-- advance_turn, third shape (create or replace): everything from 0027 —
-- the FOR UPDATE serialization, the caller-is-DM-or-current-owner
-- authorization, the deleted-mid-round clamp, the wrap-and-increment — is
-- preserved verbatim. New: after moving the pointer, the combatant it now
-- points AT gets its four economy columns reset in the same transaction,
-- so "your turn starts" and "your economy is fresh" can never be observed
-- apart. The reset re-runs the canonical turn-order query at the NEW
-- index for the row id (not just character_id — an NPC combatant has no
-- character, and it's the combatant ROW that carries the state).
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
  v_next_index integer;
  v_next_combatant uuid;
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
    v_next_index := 0;
    update public.combat_encounters
    set current_turn_index = 0, round_number = v_round + 1
    where id = p_encounter_id;
  else
    v_next_index := v_index + 1;
    update public.combat_encounters
    set current_turn_index = v_next_index
    where id = p_encounter_id;
  end if;

  -- The turn-start reset (Prompt 53): the ENTERING combatant's economy
  -- goes back to defaults; every other row keeps its state untouched (a
  -- spent reaction stays spent until that combatant's own next turn).
  -- Also covers the single-combatant wrap: index 0 -> 0 still resets.
  select c.id into v_next_combatant
  from public.combat_combatants c
  where c.encounter_id = p_encounter_id
  order by c.initiative desc nulls last, c.created_at asc, c.id asc
  offset v_next_index
  limit 1;

  update public.combat_combatants
  set action_used = false,
      bonus_action_used = false,
      reaction_used = false,
      movement_used_feet = 0
  where id = v_next_combatant;
end;
$$;

grant execute on function public.advance_turn(uuid) to authenticated;

-- The tracked token move. SECURITY DEFINER out of necessity, not
-- preference: one call must authorize a map_tokens write (the
-- can_write_map_token owner-or-DM shape), read/write the linked
-- combatant's movement_used_feet, and read characters.speed plus
-- campaigns.action_economy_strict — no single existing policy spans those
-- tables, so the authorization is re-checked explicitly here (definer
-- bypasses map_tokens RLS).
--
-- The budget path applies ONLY when the token is the active encounter's
-- CURRENT combatant: anything else (no combat, token not in the fight,
-- someone else's turn) falls through to a plain move with no bookkeeping,
-- so this function is always safe to call. GameRoom decides client-side
-- whether to call this or plain moveMapToken — a UX/gameplay split, not a
-- security boundary (skipping it just means the move isn't budget-checked,
-- the same low-stakes self-scoped looseness as other client-orchestrated
-- conveniences).
--
-- On the tracked path: the combatant row is locked, the cumulative total
-- computed from the CURRENT stored value (two quick drags in one turn must
-- stack, not race), and in Strict mode a total past characters.speed
-- rejects the WHOLE move — no partial/clamped move, matching every other
-- "blocked, clear reason" surface. An NPC current combatant has no speed
-- anywhere (stat blocks are Prompt 61), so it accumulates for display but
-- never blocks. Freeform accumulates too — usage is still tracked and
-- displayed, never enforced. Returns the updated map_tokens row exactly
-- like moveMapToken so callers' apply/publish flow is unchanged.
create or replace function public.move_combat_token(
  p_token_id uuid,
  p_x integer,
  p_y integer,
  p_elevation integer,
  p_feet_cost integer
)
returns public.map_tokens
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token public.map_tokens;
  v_campaign_id uuid;
  v_encounter_id uuid;
  v_index integer;
  v_count integer;
  v_combatant_id uuid;
  v_character_id uuid;
  v_current_id uuid;
  v_used integer;
  v_new_total integer;
  v_speed integer;
  v_strict boolean;
begin
  if p_feet_cost is null or p_feet_cost < 0 then
    raise exception 'Invalid movement cost';
  end if;

  select t.* into v_token
  from public.map_tokens t
  where t.id = p_token_id
  for update;

  if not found then
    raise exception 'Token not found';
  end if;

  -- can_write_map_token verbatim (0019): the DM, or the owner of the
  -- token's linked character.
  if not public.can_write_map_token(v_token.map_id, v_token.character_id) then
    raise exception 'You may not move that token';
  end if;

  select m.campaign_id into v_campaign_id
  from public.campaign_maps m
  where m.id = v_token.map_id;

  select e.id, e.current_turn_index into v_encounter_id, v_index
  from public.combat_encounters e
  where e.campaign_id = v_campaign_id
    and e.ended_at is null;

  if v_encounter_id is not null then
    select c.id, c.character_id into v_combatant_id, v_character_id
    from public.combat_combatants c
    where c.encounter_id = v_encounter_id
      and c.token_id = p_token_id;

    if v_combatant_id is not null then
      -- The canonical turn-order lookup with advance_turn's clamp, so
      -- "current" means exactly what every other surface means by it.
      select count(*) into v_count
      from public.combat_combatants
      where encounter_id = v_encounter_id;

      v_index := least(v_index, v_count - 1);

      select c.id into v_current_id
      from public.combat_combatants c
      where c.encounter_id = v_encounter_id
      order by c.initiative desc nulls last, c.created_at asc, c.id asc
      offset v_index
      limit 1;
    end if;
  end if;

  if v_combatant_id is not null and v_combatant_id = v_current_id then
    select c.movement_used_feet into v_used
    from public.combat_combatants c
    where c.id = v_combatant_id
    for update;

    v_new_total := v_used + p_feet_cost;

    select action_economy_strict into v_strict
    from public.campaigns
    where id = v_campaign_id;

    if v_character_id is not null then
      select ch.speed into v_speed
      from public.characters ch
      where ch.id = v_character_id;
    end if;

    if v_strict and v_speed is not null and v_new_total > v_speed then
      raise exception 'Not enough movement: this move costs % ft with % of % ft already used this turn',
        p_feet_cost, v_used, v_speed;
    end if;

    update public.combat_combatants
    set movement_used_feet = v_new_total
    where id = v_combatant_id;
  end if;

  update public.map_tokens
  set x = p_x, y = p_y, elevation = p_elevation
  where id = p_token_id
  returning * into v_token;

  return v_token;
end;
$$;

grant execute on function public.move_combat_token(uuid, integer, integer, integer, integer) to authenticated;
