-- DM party dashboard: "a button that opens a secondary tab with a new ui
-- for the DM to manage characters and see all their info... the DM should
-- be able to level up characters / give them XP, apply status effects,
-- give them advantage disadvantage etc" (the project owner's request, with
-- three explicitly-confirmed clarifications: REAL persisted XP tracking
-- with SRD thresholds, conditions applicable OUTSIDE active combat, and a
-- NEW persisted DM-settable advantage/disadvantage flag consumed by the
-- character's next roll wherever it originates).
--
-- Three schema pieces, one feature, one migration (the 0029 shape — table
-- + policies + RPCs + publication travel together when they only make
-- sense together):
--
--   1. characters.xp — persisted experience points. No XP system existed
--      at all before this (verified: 0007 has no such column; "Level up"
--      is a pure manual +1 action on the sheet). A plain integer column,
--      not a ledger table: the app needs exactly "current total" — award
--      history already lands in the dashboard's own award flow and could
--      become a ledger later without touching this column. NOT NULL
--      DEFAULT 0 so every existing character backfills to a real value
--      (the 0100 name_label_color reasoning).
--
--   2. characters.pending_roll_mode — the DM-granted advantage/
--      disadvantage flag for the character's NEXT roll. Deliberately NOT
--      the sheet's existing rollMode toggle (that is plain client-local
--      useState — resets on reload, affects only that one open tab). This
--      column is read AND consumed (reset to 'normal') by the roll Route
--      Handler — the single place every die in the app is generated — via
--      consume_pending_roll_mode below, so it applies no matter which
--      surface triggers the roll (sheet dice panel, Game Room quick
--      actions, click-to-attack, initiative, hide). A closed 3-value text
--      CHECK, the weather_kind/name_label_size small-enum precedent.
--
--   3. character_conditions — status conditions keyed directly on the
--      CHARACTER, independent of combat. Today a condition can only exist
--      on a combat_combatants row (0029: combatant_id NOT NULL, cascade
--      off the encounter), so a character not in a live encounter simply
--      cannot be poisoned/frightened/etc. Chosen shape: a NEW sibling
--      table rather than a nullable character_id column on
--      combatant_conditions, for three concrete reasons confirmed by
--      reading the existing code:
--        (a) blast radius — combatant_conditions has 4 policies + an RPC +
--            a realtime publication + readers in the roll route (three
--            branches), vision code, CombatPanel and the character sheet,
--            all built around the combat_combatants join; a nullable
--            column would force rewriting every one of those policies and
--            auditing every `.in("combatant_id", ...)` reader, on the
--            hot path of live combat.
--        (b) the UNIQUE(combatant_id, condition_key) upsert-dedupe
--            contract breaks under a nullable column (NULLs are distinct
--            in unique constraints) — it would need partial indexes and a
--            CHECK, more machinery than a clean second table.
--        (c) the two lifetimes genuinely differ: combat conditions die
--            with the encounter (cascade); an out-of-combat condition
--            persists until explicitly removed. Two lifecycles, two
--            tables.
--      Double-listing / silent-vanish handling lives in the app layer and
--      is deliberate: the dashboard's apply writes THIS table always (so
--      the condition survives combat starting/ending), and ALSO upserts
--      the live combatant row when one exists (so in-combat mechanics —
--      attacks-against advantage, vision blocking — pick it up
--      immediately); every display surface (sheet Conditions panel, the
--      dashboard) merges the two sources BY KEY, so a condition present in
--      both shows exactly once. See data-access/characterConditions.ts and
--      the dashboard component's own doc comments.

-- ---------------------------------------------------------------------
-- 1 + 2: the two new characters columns.
-- ---------------------------------------------------------------------

alter table public.characters
  add column if not exists xp integer not null default 0 check (xp >= 0),
  add column if not exists pending_roll_mode text not null default 'normal'
    check (pending_roll_mode in ('normal', 'advantage', 'disadvantage'));

-- RLS: 0008's "owner or campaign DM can update a character" policy is a
-- blanket USING/WITH CHECK (owner_id = auth.uid() or is_campaign_dm
-- (campaign_id)) with no column list — re-confirmed by reading
-- 0008_character_rls_policies.sql directly, the 0098/0100 discipline — so
-- it already COVERS writes to both new columns. That is exactly the
-- problem for these two: XP awards and advantage grants are DM decisions,
-- and the blanket policy would let a player award THEMSELF xp or
-- advantage with a direct API write. RLS is not column-granular, so the
-- narrowing is a trigger: xp may only be changed by the campaign's DM;
-- pending_roll_mode may only be set to a NON-normal value by the DM
-- (clearing back to 'normal' stays open to the owner too, because
-- consume_pending_roll_mode below runs as whoever triggered the roll —
-- usually the owning player). auth.uid() IS NULL means the caller is the
-- service-role/admin connection (every characters policy is `to
-- authenticated`, so no anon session can reach an UPDATE at all) — those
-- bypass RLS by design and this trigger keeps parity with that.

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
  if new.pending_roll_mode is distinct from old.pending_roll_mode
     and new.pending_roll_mode <> 'normal'
     and not public.is_campaign_dm(old.campaign_id) then
    raise exception 'Only the campaign''s DM can grant advantage or disadvantage';
  end if;
  return new;
end;
$$;

drop trigger if exists characters_dm_managed_columns on public.characters;
create trigger characters_dm_managed_columns
  before update on public.characters
  for each row
  execute function public.enforce_dm_managed_character_columns();

-- Award XP atomically: xp = xp + delta computed from the CURRENT stored
-- value in one UPDATE (the apply_hp_delta reasoning — two
-- near-simultaneous awards must both land, a client read-then-write would
-- lose one). SECURITY INVOKER: the UPDATE rides 0008's characters policy,
-- and the trigger above is the DM-only narrowing; the explicit
-- is_campaign_dm check here just turns that into a clean, specific error
-- before any work happens. Negative deltas are allowed on purpose (the
-- "fix a mistaken award" case), clamped at 0 by GREATEST + the CHECK.
-- Deliberately does NOT touch level/current_hp/max_hp: crossing an SRD
-- threshold surfaces as a suggest-then-confirm "Level up available"
-- control on the dashboard (see PartyDashboard.tsx for why silent
-- auto-leveling was rejected), which then runs the sheet's existing
-- levelUp math.

create or replace function public.award_xp(p_character_id uuid, p_delta integer)
returns public.characters
language plpgsql
set search_path = public
as $$
declare
  v_campaign uuid;
  v_row public.characters;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'An XP award must be a nonzero amount';
  end if;

  select campaign_id into v_campaign
  from public.characters
  where id = p_character_id;

  if not found then
    -- RLS filters the row out for anyone who isn't the owner or the DM,
    -- so "blocked" and "nonexistent" are indistinguishable — the
    -- apply_exhaustion_delta opacity.
    raise exception 'Character not found, or you may not award it XP';
  end if;

  if not public.is_campaign_dm(v_campaign) then
    raise exception 'Only the campaign''s DM can award XP';
  end if;

  update public.characters
  set xp = greatest(0, xp + p_delta),
      updated_at = now()
  where id = p_character_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.award_xp(uuid, integer) to authenticated;

-- Read-and-clear the pending roll mode in one atomic step, returning what
-- it WAS. Called by the roll Route Handler for every character-originated,
-- mode-honoring d20 roll (check/save/skill/attack/initiative/hide — death
-- and concentration saves deliberately stay plain, matching their existing
-- "any client-sent mode is ignored" design). An RPC rather than a client
-- read-then-write for the apply_exhaustion_delta reason: the FOR UPDATE
-- row lock makes two near-simultaneous rolls see the flag exactly once.
-- SECURITY INVOKER: the lock and the UPDATE ride 0008's characters UPDATE
-- policy — owner or DM, which is exactly the set of people the roll route
-- allows to roll for the character in the first place (its own
-- getCharacter read is the gate). Setting BACK to 'normal' is always
-- permitted by the trigger above, so the owning player's own roll can
-- consume a DM-granted flag.

create or replace function public.consume_pending_roll_mode(p_character_id uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_mode text;
begin
  select pending_roll_mode into v_mode
  from public.characters
  where id = p_character_id
  for update;

  if not found then
    -- Unreachable for the roll route (it 404s on an unreadable character
    -- first); harmless "no flag" for anyone else.
    return 'normal';
  end if;

  if v_mode <> 'normal' then
    update public.characters
    set pending_roll_mode = 'normal',
        updated_at = now()
    where id = p_character_id;
  end if;

  return v_mode;
end;
$$;

grant execute on function public.consume_pending_roll_mode(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3: combat-independent conditions.
-- ---------------------------------------------------------------------

-- 0029's combatant_conditions shape exactly, re-keyed on the character:
-- one row per applied condition, no DB-side key enum (the rules-engine
-- catalog is the single source of truth — 0029's own reasoning), level
-- rides exactly and only on exhaustion, and re-applying upserts into a
-- no-op via the UNIQUE.

create table if not exists public.character_conditions (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters (id) on delete cascade,
  condition_key text not null,
  level integer,
  applied_at timestamptz not null default now(),
  unique (character_id, condition_key),
  constraint character_conditions_level_on_exhaustion_only check (
    (condition_key = 'exhaustion' and level between 1 and 6)
    or (condition_key <> 'exhaustion' and level is null)
  )
);

alter table public.character_conditions enable row level security;

-- Visibility/writability both delegate to can_access_character (0008) —
-- owner or campaign DM, the exact audience of the character sheet these
-- rows render on. Deliberately NARROWER than combatant_conditions'
-- member-wide SELECT: a combat badge is public table state like
-- initiative, but an out-of-combat condition lives on a page (the sheet)
-- only the owner and DM can see at all, so matching that visibility keeps
-- the two surfaces consistent. Writes mirror 0029's DM-or-owner spirit
-- (a player marking their own character poisoned after an out-of-combat
-- trap is as legitimate as the in-combat equivalent); the DM-only-ness of
-- the dashboard is a UI scope, not a data-layer rule.

create policy "owner or campaign DM can read a character's conditions"
  on public.character_conditions for select
  to authenticated
  using (public.can_access_character(character_id));

create policy "owner or campaign DM can apply a character condition"
  on public.character_conditions for insert
  to authenticated
  with check (public.can_access_character(character_id));

create policy "owner or campaign DM can change a character condition"
  on public.character_conditions for update
  to authenticated
  using (public.can_access_character(character_id))
  with check (public.can_access_character(character_id));

create policy "owner or campaign DM can remove a character condition"
  on public.character_conditions for delete
  to authenticated
  using (public.can_access_character(character_id));

-- Exhaustion delta, the apply_exhaustion_delta (0029) pattern re-keyed on
-- the character: the new level is computed FROM the current stored level
-- under a row lock so two near-simultaneous clicks both land. SECURITY
-- INVOKER — the characters-row lock rides 0008's UPDATE policy (owner or
-- DM), which is exactly this table's own write rule. 0 deletes the row:
-- absence-of-row = not-exhausted, consistent with the on/off conditions.

create or replace function public.apply_character_exhaustion_delta(p_character_id uuid, p_delta integer)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_current integer;
  v_next integer;
begin
  perform 1 from public.characters
  where id = p_character_id
  for update;

  if not found then
    raise exception 'Character not found, or you may not change its conditions';
  end if;

  select level into v_current
  from public.character_conditions
  where character_id = p_character_id and condition_key = 'exhaustion';

  v_next := least(6, greatest(0, coalesce(v_current, 0) + p_delta));

  if v_next = 0 then
    delete from public.character_conditions
    where character_id = p_character_id and condition_key = 'exhaustion';
  elsif v_current is null then
    insert into public.character_conditions (character_id, condition_key, level)
    values (p_character_id, 'exhaustion', v_next);
  else
    update public.character_conditions
    set level = v_next
    where character_id = p_character_id and condition_key = 'exhaustion';
  end if;

  return v_next;
end;
$$;

grant execute on function public.apply_character_exhaustion_delta(uuid, integer) to authenticated;

-- Live sync for the character sheet and the dashboard (neither is on the
-- Game Room's campaign channel) — the same postgres_changes mechanism and
-- publication as combatant_conditions in 0029. characters itself is
-- already in the publication (0028), which the dashboard's campaign-wide
-- character subscription rides.
alter publication supabase_realtime add table public.character_conditions;
