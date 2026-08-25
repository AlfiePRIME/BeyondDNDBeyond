-- Prompt 50: concentration tracking.
--
-- Two new characters columns carry the whole mechanic:
--
--  * concentrating_on — the spell's name as plain text (like class/race,
--    not FK'd to anything: spells are a static rules-engine catalog).
--    NULL means not concentrating. At most one spell at a time; starting a
--    new one silently replaces the old (no save, no prompt).
--  * pending_concentration_dc — a server-authoritative "this character owes
--    a Constitution save" flag, set by the two damage RPCs below when a
--    concentrating character takes damage WITHOUT dropping to 0. The DC is
--    max(10, floor(damage / 2)) per the SRD ("10 or half the damage taken,
--    whichever is higher"; standard 5e convention floors the half —
--    integer division below is floor for non-negative operands). Storing
--    it on the row (rather than deriving it client-side from "I clicked
--    the damage button") makes the prompt live-synced to every viewer and
--    makes the DC unspoofable: the roll route re-reads it from this column
--    and never trusts a client-sent DC.
--
--    Deliberate scope simplification: a second hit before the first check
--    resolves OVERWRITES the pending DC with the fresh one rather than
--    queuing multiple pending checks. RAW 5e technically requires one
--    check per instance of damage; stacking a queue adds real complexity
--    for an edge case unlikely to matter at a friends' table.
--
-- Concentration ends immediately, with no save, when the character drops
-- to exactly 0 HP (becoming incapacitated/unconscious ends concentration
-- outright per SRD) — implemented INSIDE apply_hp_delta and
-- resolve_attack_damage as one more branch on the same locked row, in the
-- same atomic UPDATE, because it's a deterministic function of values
-- those RPCs already hold and must never be missed. Dropping to 0 and
-- owing a save are mutually exclusive per hit: at 0 the concentration is
-- simply gone (and any stale pending DC cleared with it). A LATER hit
-- while already at 0 (death-save failure, instant death) needs no
-- concentration handling — the transition to 0 already cleared it, so
-- there is nothing left to end; the at-0 branch below re-clears
-- defensively only because a row could in principle be hand-edited into
-- concentrating-at-0.
--
-- The other no-save ending — an incapacitating condition being applied —
-- is client-orchestrated in the Game Room (apply the condition through the
-- untouched 0029 path, then a separate stop-concentrating write): self/DM-
-- scoped with no cross-player security concern, the same accepted
-- write-then-side-effect shape as the initiative and death-save flows.

alter table public.characters
  add column concentrating_on text,
  add column pending_concentration_dc integer;

-- Widen roll_log's kind CHECK for the new roll kind. The constraint name
-- was read from the running database (pg_constraint), not guessed: 0031's
-- drop-and-recreate reused the name roll_log_kind_check, and that is still
-- what the live DB reports.
alter table public.roll_log drop constraint roll_log_kind_check;
alter table public.roll_log add constraint roll_log_kind_check
  check (kind in ('attack', 'save', 'check', 'skill', 'initiative', 'freeform', 'death_save', 'concentration_save'));

-- Resolves one pending concentration check. The d20 itself is rolled in
-- the roll Route Handler (the only place dice are rolled), which compares
-- total >= the stored DC and passes only the verdict — this function
-- trusts that pre-computed boolean the way apply_death_save_roll trusts
-- pre-computed deltas.
--
-- SECURITY INVOKER (the default), apply_death_save_roll's exact
-- authorization trick: the SELECT ... FOR UPDATE both serializes
-- concurrent resolutions and authorizes, because row locking filters
-- through 0008's characters UPDATE policy (owner or campaign DM). The
-- pending-check re-validation raises a distinct exception so a stale
-- double-submit (two clients racing to resolve the same check) fails
-- loudly instead of double-clearing.
create or replace function public.resolve_concentration_save(
  p_character_id uuid,
  p_passed boolean
) returns public.characters
language plpgsql
set search_path = public
as $$
declare
  v_current public.characters;
  v_row public.characters;
begin
  select * into v_current
  from public.characters
  where id = p_character_id
  for update;

  if not found then
    -- RLS filters the row out for anyone who isn't the owner or the DM, so
    -- "blocked" and "nonexistent" are indistinguishable here — same
    -- opacity as apply_hp_delta.
    raise exception 'Character not found, or you may not roll its concentration saves';
  end if;

  if v_current.pending_concentration_dc is null then
    raise exception 'No concentration check is pending';
  end if;

  -- The pending flag clears no matter what; the spell survives only a
  -- pass. Nothing else on the row is touched.
  update public.characters
  set pending_concentration_dc = null,
      concentrating_on = case when p_passed then concentrating_on else null end,
      updated_at = now()
  where id = p_character_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.resolve_concentration_save(uuid, boolean) to authenticated;

-- apply_hp_delta, reshaped a third time (0028 → 0031 → here): the same
-- SELECT-FOR-UPDATE-then-branch-then-UPDATE, with a new concentration
-- branch alongside — not entangled with — the 0031 death-save bookkeeping:
--
--  * damage that lands the character AT 0 HP (from above 0, or already
--    there): concentration and any pending DC are cleared outright — the
--    SRD's incapacitated-ends-concentration rule, no save;
--  * damage that leaves a CONCENTRATING character above 0: sets
--    pending_concentration_dc = max(10, floor(damage / 2)), overwriting
--    any still-unresolved previous DC (the scope simplification above);
--  * healing never touches either column.
--
-- Every 0031 behavior — the clamp, the death-save tally rules, instant
-- death, the stable-break reset, the heal-clears-slate rule, the SECURITY
-- INVOKER lock-through-the-UPDATE-policy authorization, the exception
-- message — is preserved verbatim.
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
    -- RLS filters the row out for anyone who isn't the owner or the DM, so
    -- "blocked" and "nonexistent" are indistinguishable here — same
    -- opacity as getCharacter's null.
    raise exception 'Character not found, or you may not change its HP';
  end if;

  -- The 0028 clamp, verbatim — computed under the lock instead of inline
  -- in the UPDATE, which is the same serialization guarantee.
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
  elsif p_delta > 0 and v_current.current_hp = 0 and v_new_hp > 0 then
    v_successes := 0;
    v_failures := 0;
    v_stable := false;
  end if;

  -- The concentration branch (Prompt 50) — independent of the death-save
  -- branching above, reading only the damage and the resulting HP.
  if p_delta < 0 then
    if v_new_hp = 0 then
      -- At 0 HP concentration ends outright, no save — and a pending
      -- check on the way down is mooted with it.
      v_concentrating := null;
      v_pending_dc := null;
    elsif v_concentrating is not null then
      -- Still standing: owes a CON save at max(10, floor(damage / 2)).
      -- Integer division IS the floor here (both operands non-negative).
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

-- resolve_attack_damage grows the same concentration branch. CREATE OR
-- REPLACE, not drop-and-recreate, this time: unlike 0031 neither the
-- parameter list nor the RETURNS TABLE column list changes (PostgreSQL
-- only requires a DROP when the signature or return shape changes — the
-- new columns ride back to callers through the characters row refetch and
-- realtime, not new OUT columns). Everything from 0031 — the SECURITY
-- DEFINER attacker-based authorization, the same-campaign guard, the
-- at-0 death-save branching with crit doubling, the atomic same-
-- transaction roll_log INSERT — is preserved verbatim.
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

  -- SECURITY DEFINER bypasses characters RLS, so the attacker-side
  -- authorization is explicit: the caller owns the attacking character,
  -- or is that character's campaign DM.
  select ch.campaign_id into v_campaign_id
  from public.characters ch
  where ch.id = p_attacker_character_id
    and (ch.owner_id = auth.uid() or public.is_campaign_dm(ch.campaign_id));

  if v_campaign_id is null then
    raise exception 'Attacker not found, or you may not resolve its attacks';
  end if;

  -- Same-campaign guard: an attacker can never reach a character in some
  -- other campaign. Locked so the death-save branching below reads the
  -- pre-damage current_hp under the same serialization as the write.
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
  -- Dropping from >0 to exactly 0 adds nothing — it only starts the
  -- sequence's eligibility.
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

  -- The concentration branch (Prompt 50) — apply_hp_delta's exact rules,
  -- reading p_damage instead of a delta.
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
