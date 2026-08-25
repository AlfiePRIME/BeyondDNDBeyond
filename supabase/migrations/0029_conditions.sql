-- Prompt 47: status conditions on combatants.
--
-- One row per applied condition rather than fourteen boolean columns: a
-- future condition is a new rules-engine catalog entry, not a schema
-- change. The catalog itself (names, descriptions, mechanical-effect
-- flags) is static SRD data and lives in code
-- (src/rules-engine/srd/conditions.ts) like RACES/CLASSES/SPELLS.

create table if not exists public.combatant_conditions (
  id uuid primary key default gen_random_uuid(),
  combatant_id uuid not null references public.combat_combatants (id) on delete cascade,
  -- Deliberately no CHECK enumerating the valid keys: the rules-engine
  -- catalog is the single source of truth for what conditions exist, and a
  -- DB-side enum copy could silently drift from it — the same reasoning as
  -- asset names and other categorical values validated app-side only. The
  -- app layer types this as the catalog's ConditionKey (or 'exhaustion'),
  -- so nothing else ever gets written.
  condition_key text not null,
  -- Exhaustion is the one leveled condition (SRD levels 1-6, cumulative
  -- effects); every other condition is on/off, where the row's presence IS
  -- the state. That shape difference is structural rather than catalog
  -- data, so unlike the key list it DOES get a constraint: level rides
  -- exactly and only on exhaustion.
  level integer,
  applied_at timestamptz not null default now(),
  -- Re-applying a present condition upserts into a no-op, never an error
  -- or a duplicate badge.
  unique (combatant_id, condition_key),
  constraint combatant_conditions_level_on_exhaustion_only check (
    (condition_key = 'exhaustion' and level between 1 and 6)
    or (condition_key <> 'exhaustion' and level is null)
  )
);

alter table public.combatant_conditions enable row level security;

-- Every member sees every combatant's conditions — a poisoned badge is
-- public table state, like initiative. The combat_combatants join inside
-- the predicate runs under the caller's own combatant SELECT policy.
create policy "members read a combatant's conditions"
  on public.combatant_conditions for select
  to authenticated
  using (exists (
    select 1
    from public.combat_combatants c
    where c.id = combatant_id
      and public.can_read_combatant(c.encounter_id)
  ));

-- Writes reuse can_write_combatant (0027) verbatim — DM, or the owner of
-- the combatant's linked character; an NPC row (character_id null) is
-- DM-only by construction. Plain policies rather than an RPC for the
-- on/off conditions: applying or removing one condition row has no
-- cross-row atomicity concern (the initiative-entry reasoning), unlike
-- exhaustion below.
create policy "DM, or the owning player, can apply a condition"
  on public.combatant_conditions for insert
  to authenticated
  with check (exists (
    select 1
    from public.combat_combatants c
    where c.id = combatant_id
      and public.can_write_combatant(c.encounter_id, c.character_id)
  ));

create policy "DM, or the owning player, can change a condition"
  on public.combatant_conditions for update
  to authenticated
  using (exists (
    select 1
    from public.combat_combatants c
    where c.id = combatant_id
      and public.can_write_combatant(c.encounter_id, c.character_id)
  ))
  with check (exists (
    select 1
    from public.combat_combatants c
    where c.id = combatant_id
      and public.can_write_combatant(c.encounter_id, c.character_id)
  ));

create policy "DM, or the owning player, can remove a condition"
  on public.combatant_conditions for delete
  to authenticated
  using (exists (
    select 1
    from public.combat_combatants c
    where c.id = combatant_id
      and public.can_write_combatant(c.encounter_id, c.character_id)
  ));

-- Exhaustion has apply_hp_delta's (0028) problem, not initiative's: the
-- new level is computed FROM the current stored level, so two
-- near-simultaneous clicks must both land instead of a client-side
-- read-then-write losing one to the race. SECURITY INVOKER for 0028's
-- reason too — the combatant UPDATE policy (can_write_combatant) is
-- already exactly the right authorization, and the FOR UPDATE lock on the
-- combatant row applies it naturally (row locking filters through the
-- UPDATE policy), so the lock is simultaneously the serialization point
-- and the authorization check. Clamped 0-6; 0 means "no exhaustion" and
-- deletes the row, keeping absence-of-row = not-applied consistent with
-- the on/off conditions.
create or replace function public.apply_exhaustion_delta(p_combatant_id uuid, p_delta integer)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_current integer;
  v_next integer;
begin
  perform 1 from public.combat_combatants
  where id = p_combatant_id
  for update;

  if not found then
    -- RLS filters the row out for anyone who isn't the DM or the owner, so
    -- "blocked" and "nonexistent" are indistinguishable here — same
    -- opacity as apply_hp_delta.
    raise exception 'Combatant not found, or you may not change its conditions';
  end if;

  select level into v_current
  from public.combatant_conditions
  where combatant_id = p_combatant_id and condition_key = 'exhaustion';

  v_next := least(6, greatest(0, coalesce(v_current, 0) + p_delta));

  if v_next = 0 then
    delete from public.combatant_conditions
    where combatant_id = p_combatant_id and condition_key = 'exhaustion';
  elsif v_current is null then
    insert into public.combatant_conditions (combatant_id, condition_key, level)
    values (p_combatant_id, 'exhaustion', v_next);
  else
    update public.combatant_conditions
    set level = v_next
    where combatant_id = p_combatant_id and condition_key = 'exhaustion';
  end if;

  return v_next;
end;
$$;

grant execute on function public.apply_exhaustion_delta(uuid, integer) to authenticated;

-- Live sync for the character sheet page (which isn't on the Game Room's
-- campaign channel) — same postgres_changes mechanism, and the same
-- publication, as characters in 0028.
alter publication supabase_realtime add table public.combatant_conditions;
