-- Movement Collision & Gated Interaction Checks: an optional skill check
-- gating a transition's own confirm-prompt (GameRoom.tsx's
-- maybeOfferTransition/handleConfirmTransition, behind the new
-- pendingInteraction "roll-then-DM-continues" flow) — the map_transitions
-- table's own equivalent of map_objects.behavior_config's new requiredCheck
-- key (src/data-access/mapObjects.ts's ObjectMovementConfig), needed as a
-- REAL column here since a transition is a row in its own table, not a
-- jsonb blob a new key can just be added to.
--
-- Nullable, defaulting to null — every existing transition, and every new
-- one left unconfigured, offers the ordinary Yes/No confirm immediately,
-- exactly as before this column existed.
--
-- Values are one of the 18 SRD skill names (src/rules-engine/srd/skills.ts's
-- own SkillName/SKILLS), spelled exactly as that module's own strings —
-- kept in sync by hand, the same rules-engine/data-access CrossingType
-- precedent (mapObjects.ts's own doc comment) already documents, since
-- rules-engine cannot be imported from a migration. Guarded with `if not
-- exists` / `drop constraint if exists` (0053's crossing_type / 0051's
-- water_flow_direction precedent) rather than a bare `add column`, in case
-- a dev stack already has this from a direct, non-migration-tracked
-- application under a different filename.
alter table public.map_transitions add column if not exists required_skill text;

alter table public.map_transitions drop constraint if exists map_transitions_required_skill_check;
alter table public.map_transitions add constraint map_transitions_required_skill_check
  check (required_skill is null or required_skill in (
    'Acrobatics', 'Animal Handling', 'Arcana', 'Athletics', 'Deception',
    'History', 'Insight', 'Intimidation', 'Investigation', 'Medicine',
    'Nature', 'Perception', 'Performance', 'Persuasion', 'Religion',
    'Sleight of Hand', 'Stealth', 'Survival'
  ));
