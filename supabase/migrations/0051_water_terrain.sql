-- Water terrain (a post-roadmap addition, not one of the numbered prompts) —
-- widens map_cells.ground_type (0047_ground_types.sql) with a tenth value,
-- 'water', exactly the way 0039_void_terrain.sql and 0049_pit_terrain.sql
-- widened terrain_type's own CHECK. 0047's own header comment anticipated
-- this by name ("leave room for a later 'water' addition to widen this
-- CHECK"). 'water' is purely cosmetic like every other ground type — it
-- never touches terrain_type or movement cost (src/rules-engine/movement.ts
-- is untouched by this migration and stays untouched by design: a water
-- cell only costs double movement when the DM ALSO paints it 'difficult'
-- terrain via the existing terrain brush, the identical mechanism any other
-- difficult cell already uses).
--
-- The constraint name was read from the running database (pg_constraint),
-- not guessed: 0047's inline `check (ground_type in (...))` auto-named it
-- map_cells_ground_type_check, matching the terrain_type/light_level
-- convention. Guarded with `drop constraint if exists` rather than the bare
-- `drop constraint` 0039/0049 use — this migration may be re-applied under
-- a renamed filename against a dev stack that already has this constraint
-- from a direct (non-migration-tracked) application, and the guard makes
-- that safe either way.
alter table public.map_cells drop constraint if exists map_cells_ground_type_check;
alter table public.map_cells add constraint map_cells_ground_type_check
  check (ground_type in (
    'default', 'grass', 'rock', 'forest', 'dense_forest', 'path', 'sand', 'swamp', 'stone', 'water'
  ));

-- Flow direction: a per-cell AUTHORED direction, purely decorative in this
-- addition (nothing in the rules engine or any move/current-push mechanic
-- ever reads it — out of scope, not requested). Nullable and meaningful
-- ONLY when ground_type = 'water', by convention rather than a cross-column
-- CHECK: ground_type and terrain_type are kept fully independent at the
-- schema level (this addition's own confirmed design), and map_cells
-- already tolerates values that are simply inert outside their owning
-- context (an elevation on a void cell, e.g.) rather than forbidding the
-- combination outright. A water cell with no authored direction is null —
-- "water, no flow drawn" is a legitimate, common authored state, not an
-- error.
--
-- Four-way cardinal vocabulary (north/east/south/west), not 8-way: reuses
-- the EXACT words maps.ts's MAP_GROWTH_EDGES already established for "which
-- way" on this schema (see 0046_map_grid_growth.sql), rather than inventing
-- a fresh vocabulary for what is, this prompt, just a decorative arrow.
-- Simple to author (one picker, four buttons) and simple to render (rotate
-- one arrow mesh by a multiple of 90 degrees) — sufficient for "a visible
-- directional cue", which is all that's asked here.
alter table public.map_cells add column if not exists water_flow_direction text;

-- Split into its own drop-then-add (rather than an inline check on the
-- add column above) for the same re-application safety as the ground_type
-- widening: if the column already exists on a dev stack (from a direct,
-- non-migration-tracked application under a different filename), `add
-- column if not exists` alone would silently skip creating/updating the
-- CHECK, leaving this migration unable to guarantee its own constraint
-- ends up as specified below. Naming it explicitly avoids relying on
-- Postgres's auto-generated name for an inline check that may never
-- actually run.
alter table public.map_cells drop constraint if exists map_cells_water_flow_direction_check;
alter table public.map_cells add constraint map_cells_water_flow_direction_check
  check (water_flow_direction is null or water_flow_direction in ('north', 'east', 'south', 'west'));

-- map_seen_cells (0036) deliberately captures terrain/elevation/light only,
-- never ground_type (see 0047's own note) — a remembered water cell renders
-- from its terrain-driven color exactly as it always has, and carries no
-- flow direction either. No change needed there.
