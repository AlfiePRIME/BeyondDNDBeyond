-- Ground types (post-roadmap addition, not one of the numbered prompts) —
-- a purely cosmetic, additive dimension layered ON TOP OF (never replacing)
-- the existing mechanical terrain_type. A cell's ground_type only changes
-- the flat color MapSurface renders for it; terrain_type alone still governs
-- movement cost and void-ness (src/rules-engine/movement.ts never reads this
-- column, and never will). A "forest" cell can independently be normal or
-- difficult terrain: the two columns are set, read, and CHECK-constrained
-- completely separately, so painting one can never force a value onto the
-- other.
--
-- The exact terrain_type/light_level convention (0014/0036): sibling
-- CHECK-constrained text column on map_cells, sparse-storage default
-- ('default', the same role 'normal'/'bright' play for their columns — a
-- cell with no explicit ground type IS 'default'), written through the same
-- upsertMapCells rows, painted with its own brush in the map editor.
-- 'default' renders EXACTLY as every cell did before this column existed:
-- MapSurface's cellColor falls back to the terrain-driven NORMAL/DIFFICULT
-- palette whenever ground_type is 'default' (or, on older in-memory shapes,
-- simply absent) — so no existing map's appearance changes one pixel.
--
-- Starter vocabulary (chosen to cover the upcoming map-template pack and
-- leave room for a later "water" addition to widen this CHECK exactly the
-- way 0039 widened terrain_type's): grass, rock, forest, dense_forest,
-- path, sand, swamp, stone.
alter table public.map_cells
  add column if not exists ground_type text not null default 'default'
    check (ground_type in (
      'default', 'grass', 'rock', 'forest', 'dense_forest', 'path', 'sand', 'swamp', 'stone'
    ));

-- map_seen_cells (0036) deliberately captures terrain/elevation/light only,
-- never ground_type — a remembered cell renders from its terrain-driven
-- color exactly as it always has, matching that table's existing "no
-- object-level memory either" scope. No change needed there.
