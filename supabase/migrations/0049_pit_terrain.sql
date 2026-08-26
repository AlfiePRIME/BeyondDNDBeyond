-- Pits and falling (docs/design/pits-and-falling.md) — a post-roadmap
-- addition, not one of the 62 numbered prompts. A fourth terrain_type,
-- 'pit', marks a cell whose own `elevation` is the pit's FLOOR — depth is
-- derived at move-resolution time from the mover's previous elevation, not
-- stored (see the design doc §3). No new column, no new table for the
-- visible-pit case: exactly 0039_void_terrain.sql's pattern, widening the
-- terrain vocabulary.
--
-- Widen map_cells' terrain_type CHECK. The constraint name was read from the
-- running database (pg_constraint), not guessed — 0039 already confirmed it
-- as map_cells_terrain_type_check.
alter table public.map_cells drop constraint map_cells_terrain_type_check;
alter table public.map_cells add constraint map_cells_terrain_type_check
  check (terrain_type in ('normal', 'difficult', 'void', 'pit'));

-- map_seen_cells.terrain_type (0036) carries no CHECK — 0039's reasoning
-- applies unchanged, so a remembered pit cell needs no change here.
