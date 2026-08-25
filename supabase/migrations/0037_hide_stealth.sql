-- Prompt 60: Hide/Stealth for players and NPCs.
--
-- One row per (hider, observer) pair the hider is currently hidden from —
-- absence of a row means "not hidden from them", the combatant_conditions
-- row's-presence-IS-the-state shape. The rows are written by the roll Route
-- Handler when a Hide roll resolves (delete-then-insert: each attempt
-- REPLACES the previous concealment state rather than accumulating stale
-- pairs), deleted en masse when the hider attacks (revealed to everyone,
-- per SRD) or manually stops hiding, and cascade away with either
-- combatant.

create table if not exists public.combatant_hidden_from (
  id uuid primary key default gen_random_uuid(),
  hider_combatant_id uuid not null references public.combat_combatants (id) on delete cascade,
  observer_combatant_id uuid not null references public.combat_combatants (id) on delete cascade,
  hidden_at timestamptz not null default now(),
  -- One row per pair, ever — a re-hide replaces (delete + insert), never
  -- duplicates. The backing index's leading column is also exactly the
  -- "everything this hider is hidden from" lookup the reveal paths need.
  unique (hider_combatant_id, observer_combatant_id)
);

alter table public.combatant_hidden_from enable row level security;

-- SELECT is member-wide via the hider's encounter (can_read_combatant, the
-- combatant_conditions policy shape) — public table state like conditions
-- and rolls, NOT a map_seen_cells-style privacy exception: the Stealth
-- roll's total is already fully public in roll_log, and who it hid from is
-- no bigger a secret than the roll itself. The per-viewer "you don't see a
-- token hidden from you" is presentation masking (the Prompt 58 posture),
-- not an RLS boundary.
create policy "members read who a combatant is hidden from"
  on public.combatant_hidden_from for select
  to authenticated
  using (exists (
    select 1
    from public.combat_combatants c
    where c.id = hider_combatant_id
      and public.can_read_combatant(c.encounter_id)
  ));

-- Writes are authorized on the HIDER's side only (can_write_combatant —
-- DM, or the owner of the hider's linked character; an NPC hider falls to
-- the DM by construction). The observer side is merely REFERENCED, not
-- modified — a hidden-from row changes nothing about the observer's own
-- data — so no observer-side authorization is needed. The same-encounter
-- subquery guard mirrors 0035's cross-campaign stitching check: a row
-- can't pair a hider with an observer from some other encounter.
create policy "DM, or the owning player, records who their combatant hid from"
  on public.combatant_hidden_from for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.combat_combatants c
      where c.id = hider_combatant_id
        and public.can_write_combatant(c.encounter_id, c.character_id)
    )
    and exists (
      select 1
      from public.combat_combatants h, public.combat_combatants o
      where h.id = hider_combatant_id
        and o.id = observer_combatant_id
        and o.encounter_id = h.encounter_id
    )
  );

create policy "DM, or the owning player, reveals their combatant"
  on public.combatant_hidden_from for delete
  to authenticated
  using (exists (
    select 1
    from public.combat_combatants c
    where c.id = hider_combatant_id
      and public.can_write_combatant(c.encounter_id, c.character_id)
  ));

-- No UPDATE policy: a hidden-from pair is created or removed, never edited.

-- Widen roll_log.kind for the new 'hide' kind — the 0031/0032 arrangement:
-- 0030's inline check auto-named it roll_log_kind_check, 0031 and 0032's
-- drop-and-recreate reused the name, and that is still the live
-- constraint's name (confirmed against the running database before writing
-- this, per this build's never-guess-the-name habit).
alter table public.roll_log drop constraint roll_log_kind_check;
alter table public.roll_log add constraint roll_log_kind_check
  check (kind in ('attack', 'save', 'check', 'skill', 'initiative', 'freeform', 'death_save', 'concentration_save', 'hide'));

-- The one RLS crossing this feature genuinely needs, kept as narrow as it
-- can be. Resolving a Hide attempt compares the hider's Stealth total
-- against every OTHER combatant's passive Perception, and needs each
-- observer's darkvision to know whether they could perceive the hider at
-- all — but characters' SELECT policy (0008) is strictly owner-or-DM, so a
-- regular player's session cannot read another player's ability scores/
-- level/proficiencies/darkvision. This SECURITY DEFINER function bridges
-- exactly that read: the vision/passive-Perception-relevant stats of every
-- character linked to a combatant in one encounter, for campaign MEMBERS
-- (is_campaign_member — this data isn't sensitive the way inventory or
-- private notes are; a DM would state a passive Perception at the table
-- freely, and every player needs it to resolve a Hide against anyone).
-- It computes NOTHING: passive Perception (rules-engine passiveScore) and
-- perception eligibility (computeVisibilityTier) stay in Node, reusing the
-- exact pure functions Prompts 56/59 established — this function's only
-- job is the raw stat read. NPC combatants have no character row and are
-- simply absent from the result (Node applies the flat NPC defaults).
create or replace function public.get_encounter_vision_stats(p_encounter_id uuid)
returns table (
  character_id uuid,
  strength integer,
  dexterity integer,
  constitution integer,
  intelligence integer,
  wisdom integer,
  charisma integer,
  level integer,
  proficiencies text[],
  darkvision_feet integer
)
language sql
security definer
set search_path = public
stable
as $$
  select distinct
    ch.id,
    ch.strength,
    ch.dexterity,
    ch.constitution,
    ch.intelligence,
    ch.wisdom,
    ch.charisma,
    ch.level,
    -- characters.proficiencies is jsonb (a string array app-side) —
    -- flattened to text[] so callers get plain strings, not jsonb.
    array(select jsonb_array_elements_text(ch.proficiencies)),
    ch.darkvision_feet
  from public.combat_combatants c
  join public.characters ch on ch.id = c.character_id
  join public.combat_encounters e on e.id = c.encounter_id
  where c.encounter_id = p_encounter_id
    and public.is_campaign_member(e.campaign_id)
$$;

grant execute on function public.get_encounter_vision_stats(uuid) to authenticated;

-- Live sync via postgres_changes, the combatant_conditions reasoning: the
-- character sheet page (and the roll route's reveal-on-attack side effect)
-- isn't on the room's broadcast channel, so hidden-state changes travel by
-- the publication like every other combat table this build has added.
alter publication supabase_realtime add table public.combatant_hidden_from;
