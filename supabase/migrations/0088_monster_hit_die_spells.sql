-- Enemy/NPC placement follow-up: monster_templates/monster_stat_blocks
-- gain two fields the DM's own request specifically asked for beyond bare
-- attacks — a rollable hit-die formula (today only a flat max_hp integer
-- exists) and a simple named-spells list (today only the attacks[] array
-- exists, with no spellcasting concept at all). Both columns follow the
-- exact same "plain jsonb/text column, no new mechanics engine" posture
-- attacks[] itself already established — spells are flavor/reference text
-- a DM reads and adjudicates narratively, never a rules-engine-resolved
-- spell-slot system (this app has none for NPCs, and this migration isn't
-- the place to add one).
alter table public.monster_templates
  add column if not exists hit_die text not null default '',
  add column if not exists spells jsonb not null default '[]';

alter table public.monster_stat_blocks
  add column if not exists hit_die text not null default '',
  add column if not exists spells jsonb not null default '[]';

-- Backfill the 8 seeded templates (0073_monster_templates.sql) with real
-- SRD hit-die formulas matching each one's own already-seeded max_hp
-- exactly (verified against the actual SRD stat blocks those rows are
-- built on, not guessed): Goblin 2d6=7, Zombie 3d8+9=22, Trader (Commoner)
-- 1d8=4, Guard 2d8+2=11, High Guard (Veteran) 9d8+18=58, Demon (Dretch)
-- 4d6+4=18, Witch (Green Hag) 11d8+33=82. Daemon has no SRD stat block to
-- match (0073's own seed comment) — 4d8+8=26 follows that row's existing
-- convention-built rationale (a d8 hit die, mid-tier, more disciplined
-- than the Dretch it's contrasted against). Only Witch gets a real spells
-- list — the SRD Green Hag's own innate at-will spellcasting, explicitly
-- flagged as "not modeled as a stored attack" in 0073's own seed comment;
-- every other seeded creature has no canonical spells.
update public.monster_templates set hit_die = '2d6', spells = '[]' where name = 'Goblin';
update public.monster_templates set hit_die = '3d8+9', spells = '[]' where name = 'Zombie';
update public.monster_templates set hit_die = '1d8', spells = '[]' where name = 'Trader';
update public.monster_templates set hit_die = '2d8+2', spells = '[]' where name = 'Guard';
update public.monster_templates set hit_die = '9d8+18', spells = '[]' where name = 'High Guard';
update public.monster_templates set hit_die = '4d8+8', spells = '[]' where name = 'Daemon';
update public.monster_templates set hit_die = '4d6+4', spells = '[]' where name = 'Demon';
update public.monster_templates
  set hit_die = '11d8+33', spells = '["Dancing Lights", "Minor Illusion", "Vicious Mockery"]'::jsonb
  where name = 'Witch';
