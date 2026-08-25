-- Void terrain (non-rectangular room shapes) — a post-roadmap addition, not
-- one of the 62 numbered prompts. A third terrain_type, 'void', marks a cell
-- with no floor at all: the DM paints it with the existing terrain brush to
-- carve caves/winding corridors out of the rectangular grid. The grid itself
-- (grid_width x grid_height, movement, vision, rendering coordinates) is
-- untouched — a void cell simply renders as absent for every viewer, costs
-- Infinity in the rules engine, and rejects token/object placement in the
-- clients. No new column, no new table: the whole schema change is widening
-- the terrain vocabulary.
--
-- Widen map_cells' terrain_type CHECK. The constraint name was read from the
-- running database (pg_constraint), not guessed: 0014's inline
-- `check (terrain_type in (...))` auto-named it map_cells_terrain_type_check,
-- and that is still what the live DB reports.
alter table public.map_cells drop constraint map_cells_terrain_type_check;
alter table public.map_cells add constraint map_cells_terrain_type_check
  check (terrain_type in ('normal', 'difficult', 'void'));

-- map_seen_cells.terrain_type (0036) deliberately carries no CHECK — it's a
-- per-viewer snapshot of whatever map_cells held — so a remembered void cell
-- needs no change here.
