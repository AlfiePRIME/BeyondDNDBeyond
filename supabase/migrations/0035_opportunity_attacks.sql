-- Prompt 54: opportunity attacks and the Disengage action.
--
-- Disengage is a fifth per-turn economy column on combat_combatants — the
-- row the other four already live on, with the same lifecycle: declared
-- during a turn, reset by advance_turn the moment that combatant's next
-- turn begins. A combatant who has disengaged this turn provokes no
-- opportunity attacks for the rest of the turn, however many times they
-- move. Declaring it consumes the Action (the app sets action_used and
-- disengaged in one UPDATE through the existing can_write_combatant
-- policy — a single-row two-column flip, no new RLS or RPC needed).

alter table public.combat_combatants
  add column if not exists disengaged boolean not null default false;

-- advance_turn, fourth shape (create or replace): everything from
-- 0027/0034 — the FOR UPDATE serialization, the caller-is-DM-or-current-
-- owner authorization, the deleted-mid-round clamp, the wrap-and-
-- increment, the entering combatant's four-column economy reset — is
-- preserved verbatim. The only change: the same reset UPDATE now also
-- clears `disengaged`, so "your turn starts" and "you are no longer
-- disengaged" can never be observed apart (Disengage lasts exactly until
-- the start of the disengager's own next turn).
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

  -- The turn-start reset (Prompt 53, extended by Prompt 54's disengaged):
  -- the ENTERING combatant's economy goes back to defaults; every other
  -- row keeps its state untouched (a spent reaction stays spent until
  -- that combatant's own next turn). Also covers the single-combatant
  -- wrap: index 0 -> 0 still resets.
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
      movement_used_feet = 0,
      disengaged = false
  where id = v_next_combatant;
end;
$$;

grant execute on function public.advance_turn(uuid) to authenticated;

-- One row per offered opportunity attack: the mover's client detects
-- "this hostile was in reach of where I started, is out of reach of where
-- I stopped, and still has its reaction" right after a tracked
-- move_combat_token succeeds, and records one row per qualifying hostile.
-- Its own table, NOT a reuse of action_overrides — an override is a
-- rule-bend permission grant (request -> DM verdict -> consume), while
-- this is a reactive attack OFFER to a specific combatant's controller
-- (pending -> taken/declined, no verdict step, resolved by whoever
-- controls the REACTOR rather than the DM) — the same "exhaustion is
-- distinct from on/off conditions" don't-force-fit precedent. The
-- RLS/postgres_changes plumbing shape below deliberately mirrors 0033's.
create table if not exists public.opportunity_attacks (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  encounter_id uuid not null references public.combat_encounters (id) on delete cascade,
  -- The combatant whose move provoked the attack (the target of the
  -- swing), and the hostile combatant offered the reaction.
  mover_combatant_id uuid not null references public.combat_combatants (id) on delete cascade,
  reactor_combatant_id uuid not null references public.combat_combatants (id) on delete cascade,
  -- pending -> taken (the reactor swung; the app also marks the reactor's
  -- reaction_used) or pending -> declined (reaction left untouched). Both
  -- outcomes are terminal: the UPDATE policy below only targets pending.
  status text not null default 'pending'
    check (status in ('pending', 'taken', 'declined')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists opportunity_attacks_campaign_created_idx
  on public.opportunity_attacks (campaign_id, created_at desc);

alter table public.opportunity_attacks enable row level security;

-- Transparency: every member sees every offer and its outcome — the
-- roll_log/action_overrides "everyone sees the table's state" posture.
-- The prompt banner renders table-wide from exactly this feed; only the
-- resolve controls are controller-gated (below, and mirrored in the UI).
create policy "members read their campaign's opportunity attacks"
  on public.opportunity_attacks for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

-- INSERT: any campaign member — deliberately permissive, the same
-- low-stakes reasoning as other client-orchestrated conveniences here
-- (the detection runs on the MOVER's client, and the mover may be any
-- member): a spurious row grants the inserter nothing — worst case it
-- offers a REACTOR'S controller a free, declinable prompt. The two
-- same-campaign/same-encounter subquery guards mirror 0033's
-- cross-campaign equality check, so a row can't stitch another
-- campaign's encounter or combatants into this campaign's feed; both
-- subqueries run under member-visible SELECT policies (can_read_combatant
-- is SECURITY DEFINER), so filtering and check agree by construction.
create policy "a member records an opportunity-attack offer"
  on public.opportunity_attacks for insert
  to authenticated
  with check (
    public.is_campaign_member(campaign_id)
    and exists (
      select 1
      from public.combat_encounters e
      where e.id = encounter_id
        and e.campaign_id = opportunity_attacks.campaign_id
    )
    and exists (
      select 1
      from public.combat_combatants c
      where c.id = mover_combatant_id
        and c.encounter_id = opportunity_attacks.encounter_id
    )
    and exists (
      select 1
      from public.combat_combatants c
      where c.id = reactor_combatant_id
        and c.encounter_id = opportunity_attacks.encounter_id
    )
  );

-- Resolution is a plain UPDATE policy, not an RPC — the 0033 argument
-- verbatim: a single-row status flip with no cross-row invariant, and
-- "only from pending" IS expressible in USING, which sees the row's
-- pre-update values — so taken/declined are terminal structurally, and
-- two racing resolves serialize on the row lock with the loser's USING
-- recheck matching zero rows (the app reads zero rows as "already
-- resolved"). WHO may resolve is the REACTOR's controller: the DM, or
-- the owner of the reactor combatant's linked character — exactly
-- can_write_combatant (0027, the initiative/conditions rule) joined
-- through the reactor row, so an NPC reactor falls to the DM by
-- construction. The mover's controller deliberately gets no say: the
-- offer belongs to the creature reacting, not the one who provoked it.
create policy "the reactor's controller resolves a pending opportunity attack"
  on public.opportunity_attacks for update
  to authenticated
  using (
    status = 'pending'
    and exists (
      select 1
      from public.combat_combatants c
      where c.id = reactor_combatant_id
        and public.can_write_combatant(c.encounter_id, c.character_id)
    )
  )
  with check (
    status in ('taken', 'declined')
    and exists (
      select 1
      from public.combat_combatants c
      where c.id = reactor_combatant_id
        and public.can_write_combatant(c.encounter_id, c.character_id)
    )
  );

-- No DELETE policy: like roll_log/action_overrides, resolved offers are
-- an audit trail (and cascade away with their encounter/campaign).

-- Live sync via postgres_changes, the 0033 reasoning exactly: the mover
-- and the reactor's controller may be on different pages entirely (or
-- different rooms of the same campaign), and the prompt must land — and
-- disappear on resolution — the moment it happens. Per-subscriber
-- visibility rides the members-only SELECT policy above.
alter publication supabase_realtime add table public.opportunity_attacks;
