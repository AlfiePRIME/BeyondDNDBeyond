-- Prompt 49: death saving throws + instant death.
--
-- Four new characters columns carry the whole death-save state machine:
-- successes/failures tick 0-3, three successes stabilizes (unconscious at
-- 0 HP, safe), three failures — or massive damage while already at 0 —
-- kills. is_dead is permanent within this prompt's scope: nothing here
-- ever clears it, and nothing else is gated on it (no sheet lock).

alter table public.characters
  add column death_save_successes integer not null default 0
    check (death_save_successes between 0 and 3),
  add column death_save_failures integer not null default 0
    check (death_save_failures between 0 and 3),
  add column is_stable boolean not null default false,
  add column is_dead boolean not null default false;

-- Widen roll_log's kind CHECK for the new roll kind. The constraint name
-- was read from the running database (pg_constraint), not guessed:
-- 0030's inline `check (kind in (...))` auto-named it roll_log_kind_check.
alter table public.roll_log drop constraint roll_log_kind_check;
alter table public.roll_log add constraint roll_log_kind_check
  check (kind in ('attack', 'save', 'check', 'skill', 'initiative', 'freeform', 'death_save'));

-- Applies one death-save roll's outcome. The d20 itself is rolled in the
-- roll Route Handler (the only place dice are rolled) and resolved to
-- deltas by the rules engine (resolveDeathSave); this function trusts
-- those pre-computed numbers the same way resolve_attack_damage trusts a
-- pre-computed damage number rather than re-deriving hit/crit in SQL.
--
-- SECURITY INVOKER (the default) for apply_hp_delta/apply_exhaustion_delta's
-- reason: "owner or campaign DM" is exactly what 0008's characters UPDATE
-- policy already says, so the caller's own policies authorize. The
-- SELECT ... FOR UPDATE both serializes concurrent rolls (the new counts
-- are computed from the CURRENT stored counts) and authorizes — row
-- locking filters through the UPDATE policy, apply_exhaustion_delta's
-- exact trick. Deliberately NOT turn-gated: like checks/saves/attacks,
-- the mechanism is provided and the table self-polices when to use it;
-- the turn-based prompt is a UI nicety.
create or replace function public.apply_death_save_roll(
  p_character_id uuid,
  p_successes_delta integer,
  p_failures_delta integer,
  p_recovers boolean
) returns public.characters
language plpgsql
set search_path = public
as $$
declare
  v_current public.characters;
  v_row public.characters;
  v_successes integer;
  v_failures integer;
begin
  select * into v_current
  from public.characters
  where id = p_character_id
  for update;

  if not found then
    -- RLS filters the row out for anyone who isn't the owner or the DM, so
    -- "blocked" and "nonexistent" are indistinguishable here — same
    -- opacity as apply_hp_delta.
    raise exception 'Character not found, or you may not roll its death saves';
  end if;

  if v_current.current_hp <> 0 or v_current.is_stable or v_current.is_dead then
    raise exception 'No death save is needed right now';
  end if;

  if p_recovers then
    -- Natural 20: back on their feet at 1 HP, the whole sequence over.
    update public.characters
    set current_hp = 1,
        death_save_successes = 0,
        death_save_failures = 0,
        is_stable = false,
        updated_at = now()
    where id = p_character_id
    returning * into v_row;
  else
    -- greatest(0, ...) stops a caller from passing a negative delta to
    -- erase counts; least(3, ...) caps the tally where the rules stop
    -- caring (and where the column CHECKs stop allowing).
    v_successes := least(3, v_current.death_save_successes + greatest(0, p_successes_delta));
    v_failures := least(3, v_current.death_save_failures + greatest(0, p_failures_delta));

    update public.characters
    set death_save_successes = v_successes,
        death_save_failures = v_failures,
        is_stable = (v_successes >= 3),
        is_dead = (v_failures >= 3),
        updated_at = now()
    where id = p_character_id
    returning * into v_row;
  end if;

  return v_row;
end;
$$;

grant execute on function public.apply_death_save_roll(uuid, integer, integer, boolean) to authenticated;

-- apply_hp_delta, reshaped from 0028's single-statement UPDATE into
-- apply_exhaustion_delta's SELECT-FOR-UPDATE-then-branch-then-UPDATE,
-- because the death-save rules branch on the PRE-delta current_hp:
--
--  * damage while ALREADY at 0 HP that is >= max_hp: instant death
--    (is_dead, no failure bookkeeping — skipping death saves entirely);
--  * any other damage while already at 0: one added failure, cascading to
--    is_dead at three. (This is the manual damage control with no concept
--    of a critical hit, so it never doubles the failure — that lives in
--    resolve_attack_damage.) If the character was STABLE, the damage
--    breaks stability and the tally restarts from zero before that
--    failure lands — the SRD's "no more saves needed until they take
--    damage again", plus its counts-reset-on-stabilize corollary, without
--    which the stored successes (kept at 3 for display) would immediately
--    re-stabilize them on the next roll;
--  * healing from 0 to above 0 (through this path): a clean slate —
--    successes/failures/is_stable cleared, so a later 0-HP event starts a
--    fresh sequence. is_dead is never cleared: permanent, as above.
--  * dropping from >0 to exactly 0 adds NO failure — it only starts
--    eligibility for the sequence.
--
-- Everything else — the clamp expression, the SECURITY INVOKER
-- owner-or-DM authorization (now enforced by the lock filtering through
-- the UPDATE policy instead of the UPDATE itself), the exception message,
-- the realtime publication membership from 0028 — is unchanged. A dead
-- character's HP can still be changed (no gating on is_dead); the
-- bookkeeping just stops, since there is no tally left to keep.
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

  update public.characters
  set current_hp = v_new_hp,
      death_save_successes = v_successes,
      death_save_failures = v_failures,
      is_stable = v_stable,
      is_dead = v_dead,
      updated_at = now()
  where id = p_character_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.apply_hp_delta(uuid, integer) to authenticated;

-- resolve_attack_damage grows a p_critical parameter (the route already
-- computes outcome.critical) and the same already-at-0 branching as
-- apply_hp_delta above — a critical hit landing on a 0-HP target adds TWO
-- failures instead of one, per SRD. Dropped and recreated (not replaced)
-- because both the parameter list and the RETURNS TABLE shape change.
drop function public.resolve_attack_damage(uuid, uuid, integer, jsonb, integer);

-- Same SECURITY DEFINER attacker-based authorization as 0030, and the
-- roll_log INSERT stays folded into this same transaction as the HP
-- UPDATE — preserved exactly, for 0030's reason: this is the one RPC that
-- lets a player move HP on a DIFFERENT player's character, so a
-- successful call must structurally leave a matching, auditable log row
-- no matter who calls it or how. The single-statement UPDATE becomes
-- SELECT-FOR-UPDATE-then-branch so the function can see the target's
-- pre-damage current_hp to decide instant-death vs. failure-counting vs.
-- neither. Two new OUT columns report the fallout so callers can reflect
-- it: out_instant_death, and out_failure_added (0, 1, or 2). The out_
-- prefix keeps every RETURNS TABLE name collision-proof against real
-- column names (the join_campaign_by_invite_code shadowing gotcha).
create function public.resolve_attack_damage(
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

  update public.characters
  set current_hp = v_new_hp,
      death_save_successes = v_successes,
      death_save_failures = v_failures,
      is_stable = v_stable,
      is_dead = v_dead,
      updated_at = now()
  where id = v_target.id;

  insert into public.roll_log (campaign_id, roller_user_id, character_id, kind, breakdown, total)
  values (v_campaign_id, auth.uid(), p_attacker_character_id, 'attack', p_breakdown, p_total)
  returning id, created_at into v_roll_id, v_roll_created_at;

  return query select v_target.id, v_new_hp, v_roll_id, v_roll_created_at, v_instant_death, v_failure_added;
end;
$$;

grant execute on function public.resolve_attack_damage(uuid, uuid, integer, boolean, jsonb, integer) to authenticated;
