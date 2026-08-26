-- Freeform combat mode: a genuinely lighter-weight combat experience for
-- tables that find the fully-automated Strict path (structured attack
-- rolls auto-checking AC and applying damage, hard action-economy
-- enforcement) takes the fun out of it. The project owner's explicit
-- decision: KEEP BOTH MODES — this migration adds nothing to and changes
-- nothing about Strict mode's existing behavior (start_combat,
-- advance_turn, add_combatant, resolve_attack_damage,
-- resolve_npc_attack_damage, apply_npc_hp_delta are all untouched below).
-- Everything here is new, additive, and reachable only when a campaign's
-- action_economy_strict is false.
--
-- The real gap this closes (confirmed by reading add_combatant/0038
-- directly, not assumed): the ONLY existing way to seat a combatant beyond
-- start_combat's initial seed is add_combatant, which requires an existing
-- MAP TOKEN — itself requiring either a linked character or a full
-- monster_stat_blocks row first. A Freeform DM who wants to drop "a
-- goblin" or "the bandit captain" into the turn order by name alone, with
-- HP/AC/attacks narrated at the table rather than modeled anywhere, has no
-- lightweight path today.
--
-- token_id drops its NOT NULL so a combatant can exist with no map
-- presence at all — exactly a 0038 "bare unstatted NPC" (character_id
-- null, monster_stat_block_id null, npc_current_hp null), just without
-- even a token underneath it. Every existing reader already handles that
-- shape correctly: combatantLabel (CombatPanel) reads npc_name regardless
-- of a token; combatantHp/canApplyHp already return "no HP control" for
-- npc_current_hp === null (the DM tracks/narrates HP for a bare NPC, same
-- as always); can_write_combatant already falls a character_id-null row to
-- DM-only; move_combat_token's token_id join simply never matches a null
-- column, so an ad-hoc combatant is inert to every token-keyed query
-- (opportunity attacks, movement budget, vision) exactly like it should
-- be — it has no position to speak of.
alter table public.combat_combatants
  alter column token_id drop not null;

-- The lightweight add path itself: DM-only (is_campaign_dm), requires an
-- ALREADY-ACTIVE encounter (the add_combatant precedent — this is not a
-- second start_combat), and — the Freeform gate — raises unless the
-- campaign's action_economy_strict is false. A Strict table's whole point
-- is the fully-modeled stat-block/token path (add_combatant/start_combat),
-- so this shortcut is deliberately out of reach there; nothing about
-- Strict's own combatants, turn order, or damage resolution changes.
-- Initiative is left null, exactly like start_combat's original seed
-- ("null until entered by hand") — the existing Set/Roll initiative
-- controls (setCombatantInitiative, already DM-writable for any
-- character_id-null row via can_write_combatant) need no change to work
-- for this row too, so there is no second RPC or UI step to enter it.
create or replace function public.add_freeform_combatant(
  p_encounter_id uuid,
  p_npc_name text
) returns public.combat_combatants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_ended timestamptz;
  v_strict boolean;
  v_name text;
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

  select action_economy_strict into v_strict
  from public.campaigns
  where id = v_campaign_id;

  if coalesce(v_strict, true) then
    raise exception 'Ad-hoc named combatants are a Freeform-mode feature — turn off Strict mode to add one.';
  end if;

  v_name := trim(both from coalesce(p_npc_name, ''));
  if v_name = '' then
    raise exception 'Give the combatant a name';
  end if;

  insert into public.combat_combatants (encounter_id, token_id, npc_name)
  values (p_encounter_id, null, left(v_name, 80))
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.add_freeform_combatant(uuid, text) to authenticated;
