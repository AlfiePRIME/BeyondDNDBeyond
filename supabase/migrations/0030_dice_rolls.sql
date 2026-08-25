-- Prompt 48: server-rolled dice and the shared roll log.
--
-- Every die result is generated server-side (in the roll Route Handler)
-- and persisted here; clients only ever read rolls back. The structured
-- per-roll detail (die results, each contributing modifier, advantage/
-- disadvantage state, and for attacks the target AC / hit / crit / damage
-- breakdown) is one jsonb column rather than a wide sparse table of
-- per-kind nullable columns — the app layer (data-access/rolls.ts) defines
-- its only schema, the behavior_config precedent.

create table if not exists public.roll_log (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  roller_user_id uuid not null references public.profiles (id) on delete cascade,
  -- Null for free-form rolls and NPC initiative; set null on character
  -- delete so the table's roll history survives a retired PC.
  character_id uuid references public.characters (id) on delete set null,
  kind text not null check (kind in ('attack', 'save', 'check', 'skill', 'initiative', 'freeform')),
  breakdown jsonb not null,
  total integer not null,
  created_at timestamptz not null default now()
);

create index if not exists roll_log_campaign_created_idx
  on public.roll_log (campaign_id, created_at desc);

alter table public.roll_log enable row level security;

-- Rolls are public table talk: every member sees every roll.
create policy "members read their campaign's rolls"
  on public.roll_log for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

-- A member logs their own rolls only; no UPDATE/DELETE policies at all —
-- the log is append-only, a roll can't be retconned.
create policy "members log their own rolls"
  on public.roll_log for insert
  to authenticated
  with check (public.is_campaign_member(campaign_id) and roller_user_id = auth.uid());

-- Applies a resolved attack's damage to a tracked PC target. A NEW
-- authorization model, deliberately NOT apply_hp_delta (0028): that RPC's
-- SECURITY INVOKER check is "owner of the TARGET, or the DM" — right for
-- the manual damage control, wrong for combat, where entitlement follows
-- the ATTACKER. A player's legitimate attack landing on ANOTHER player's
-- PC (charmed ally, friendly fire, PvP) would be wrongly rejected by the
-- target-owner check even though the roll was validly resolved. Same
-- shape of decision as trigger_map_object (0018) / advance_turn (0027):
-- an operation needing different authorization than the table policy gets
-- its own RPC, not a loosened blanket policy. SECURITY DEFINER so the
-- write to the target's row doesn't ride the caller's characters UPDATE
-- policy — this function's own attacker check IS the gate — with the
-- clamp expression kept identical to apply_hp_delta's.
--
-- This RPC is `grant execute ... to authenticated`, same as every other
-- RPC in this schema — any campaign member can call it directly (not just
-- through the roll route), the same way the roll route itself calls it,
-- via the ordinary Supabase client. Unlike apply_hp_delta (where a player
-- can only ever touch their OWN character — self-serve, no different from
-- editing their own sheet), this is the first RPC that lets one player
-- unilaterally move HP on a DIFFERENT player's character. roll_log exists
-- specifically so table damage is auditable; a version of this RPC that
-- only took a bare damage number would let that mutation happen with zero
-- trace if called outside the roll route's own logging call, silently
-- defeating the log's purpose. So the log write is folded into this same
-- function, in the same transaction as the HP update, rather than left as
-- a second, separate insert the caller could skip: this RPC is the ONLY
-- way this table's SECURITY DEFINER path can move another player's HP, and
-- it now always leaves a matching roll_log row behind, structurally, not
-- just by the roll route's convention.
create or replace function public.resolve_attack_damage(
  p_attacker_character_id uuid,
  p_target_character_id uuid,
  p_damage integer,
  p_breakdown jsonb,
  p_total integer
) returns table (
  out_target_id uuid,
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
  v_target_id uuid;
  v_target_hp integer;
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
  -- other campaign. Clamp expression matches apply_hp_delta (0028) exactly.
  update public.characters
  set current_hp = least(max_hp, greatest(0, current_hp - p_damage)),
      updated_at = now()
  where id = p_target_character_id
    and campaign_id = v_campaign_id
  returning id, current_hp into v_target_id, v_target_hp;

  if not found then
    raise exception 'Target not found in this campaign';
  end if;

  insert into public.roll_log (campaign_id, roller_user_id, character_id, kind, breakdown, total)
  values (v_campaign_id, auth.uid(), p_attacker_character_id, 'attack', p_breakdown, p_total)
  returning id, created_at into v_roll_id, v_roll_created_at;

  return query select v_target_id, v_target_hp, v_roll_id, v_roll_created_at;
end;
$$;

grant execute on function public.resolve_attack_damage(uuid, uuid, integer, jsonb, integer) to authenticated;

-- Live sync via postgres_changes, NOT the Game Room's campaign-channel
-- broadcast — a deliberate deviation from the room's usual pattern: rolls
-- can originate from the character sheet page, which has no reason to join
-- the room's realtime channel, while a postgres_changes subscription on
-- this table reaches every subscriber regardless of which page inserted.
-- Same publication as characters (0028) / combatant_conditions (0029);
-- per-subscriber visibility rides the SELECT policy above.
alter publication supabase_realtime add table public.roll_log;
