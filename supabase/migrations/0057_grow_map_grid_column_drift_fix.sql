-- Fixes two real, currently-shipped data-corruption bugs in grow_map_grid
-- (0046_map_grid_growth.sql), found incidentally while researching that RPC
-- for an unrelated whiteboard-drawing-layer design spike
-- (docs/design/whiteboard-drawing-layer.md §8.2), and confirmed here by
-- direct reproduction against this table's own live rows before writing
-- this fix:
--
-- 1. map_cells' west/north shift (the delete-then-reinsert 0046's own doc
--    comment explains — a plain `update ... set x = x + v_dx` risks
--    transient primary-key collisions since map_cells' PK is (map_id, x,
--    y)) names an explicit, hardcoded column list: `elevation, terrain_type,
--    light_level`. That list was correct the day 0046 shipped, but
--    map_cells has been widened TWICE since — `ground_type`
--    (0047_ground_types.sql) and `water_flow_direction`
--    (0051_water_terrain.sql) — and neither migration (correctly, in
--    isolation) touched grow_map_grid. The result: every west/north grid
--    grow silently reset every shifted cell's ground_type back to
--    'default' and water_flow_direction back to null, discarding whatever
--    the DM had actually painted there. East/south growth never re-keys
--    existing cells at all, so it was never affected.
--
-- 2. concealed_pits (0050_concealed_pits.sql, a DM-only shadow table
--    storing a hidden pit trap's real map/x/y/bottom-elevation, shaped and
--    secured exactly like map_transitions) is a THIRD table keyed by the
--    same (map_id, x, y) composite primary key as map_cells, sharing the
--    exact same "grid coordinates are this row's identity" shape — but it
--    postdates grow_map_grid (0046) by four migrations, and nothing ever
--    added it to the shift. Every other per-cell table (map_cells,
--    map_objects, map_tokens) has its coordinates correctly re-keyed on a
--    west/north grow; concealed_pits silently does not, leaving a hidden
--    trap pinned to its OLD coordinates — now the wrong cell relative to
--    the shifted, larger grid.
--
-- Root cause common to both: a hardcoded enumeration (of map_cells'
-- non-key columns; of "which tables get shifted at all") that has already
-- drifted out of sync with the schema twice and will keep doing so every
-- time a future migration adds a column to map_cells or a new
-- (map_id, x, y)-keyed table, unless the shift mechanism itself stops
-- being a hardcoded list. Fixed at the mechanism level, not by extending
-- the same list one more time:
--
-- shift_map_coordinate_table(p_table_name, p_map_id, p_dx, p_dy) replaces
-- map_cells' inline delete-then-reinsert with a version that reads
-- p_table_name's CURRENT non-key columns from information_schema.columns
-- at call time and reinserts every one of them unchanged, alongside x/y
-- recomputed by the given shift — so the next column added to map_cells
-- (or to any future table registered here) needs no matching update to
-- this function ever again. A plain PL/pgSQL `select *`/`update ... set
-- x = x + $1` can't do this directly (Postgres has no `SELECT * REPLACE
-- (...)`, unlike BigQuery/Snowflake, and map_cells/concealed_pits' PK must
-- stay a true, non-deferrable constraint — both are upsert targets via
-- `.upsert(..., { onConflict: "map_id,x,y" })` in maps.ts/concealedPits.ts,
-- and Postgres only accepts a non-deferrable unique/PK constraint as an
-- ON CONFLICT arbiter), so this uses `execute format(...)` to build the
-- column list once per call instead. p_table_name is only ever a literal
-- ('map_cells', 'concealed_pits') supplied by grow_map_grid itself below,
-- never caller/request-controlled, and is additionally checked against an
-- explicit allowlist so a typo fails loudly instead of silently shifting
-- nothing (or something unintended) — this allowlist is the one remaining
-- hardcoded list here, and deliberately so: it is a list of which whole
-- TABLES participate in the coordinate shift (changes only on the rare,
-- already-reviewed occasion a new (map_id, x, y)-keyed table is invented,
-- exactly as concealed_pits itself was), not a list of a single table's
-- ever-growing COLUMNS (which changed twice with zero reviewer awareness
-- that grow_map_grid even existed) — the actual class of bug being fixed.
--
-- No SECURITY DEFINER, matching grow_map_grid's own posture (0046's header
-- comment): this helper runs with the calling role's own privileges, so
-- map_cells/concealed_pits' existing RLS keeps applying to the DELETE/
-- INSERT exactly as before — a caller who can't write this map still gets
-- a harmless zero-rows no-op, never a bypass.
create or replace function public.shift_map_coordinate_table(
  p_table_name text,
  p_map_id uuid,
  p_dx integer,
  p_dy integer
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_extra_cols text;
  v_extra_select text;
begin
  if p_table_name not in ('map_cells', 'concealed_pits') then
    raise exception 'shift_map_coordinate_table: unsupported table %', p_table_name;
  end if;

  -- Every column on this table except the (map_id, x, y) key itself, in
  -- stable column order. Excludes generated/computed columns on purpose —
  -- those can never appear in an explicit INSERT column list (Postgres
  -- computes them itself), so a future generated column added to either
  -- table stays correctly excluded here without this function needing to
  -- know it exists, the same "don't need to be told" property this whole
  -- fix is for.
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
  into v_extra_cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = p_table_name
    and column_name not in ('map_id', 'x', 'y')
    and coalesce(is_generated, 'NEVER') = 'NEVER';

  v_extra_select := coalesce(', ' || v_extra_cols, '');

  -- Same delete-then-reinsert shape 0046 already established for
  -- map_cells (see its own comment on why a plain UPDATE can't be used
  -- here): freeing every key for this map before reinserting any shifted
  -- row means there is never an instant where two rows share a key, no
  -- matter how small the shift amount is relative to the grid's own
  -- width/height. Column list built once above, referenced by name (not
  -- position) on both the RETURNING and INSERT sides, so physical column
  -- order on the table can never desync the two.
  execute format(
    'with removed as (
       delete from public.%1$I
       where map_id = $1
       returning map_id, x, y%2$s
     )
     insert into public.%1$I (map_id, x, y%2$s)
     select map_id, x + $2, y + $3%2$s
     from removed',
    p_table_name,
    v_extra_select
  )
  using p_map_id, p_dx, p_dy;
end;
$$;

-- grow_map_grid itself: identical signature/behavior/authorization to
-- 0046's version in every way EXCEPT the two fixes above — replaces the
-- map_cells inline delete-then-reinsert (and its hardcoded column list)
-- with a call to shift_map_coordinate_table, and adds the equivalent call
-- for concealed_pits right alongside it. map_objects/map_tokens' plain
-- UPDATEs are untouched: neither table has a coordinate-based uniqueness
-- constraint (both are keyed by their own uuid `id`), so they were never
-- exposed to this bug's root cause and need no change.
create or replace function public.grow_map_grid(
  p_map_id uuid,
  p_edge text,
  p_amount integer
)
returns public.campaign_maps
language plpgsql
set search_path = public
as $$
declare
  v_map public.campaign_maps;
  v_dx integer := 0;
  v_dy integer := 0;
begin
  if p_edge not in ('north', 'south', 'east', 'west') then
    raise exception 'Edge must be north, south, east, or west';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Growth amount must be a positive integer';
  end if;

  -- Locks the row for the rest of this transaction, so two near-simultaneous
  -- grows of the same map (start_session's row-lock precedent, 0013)
  -- serialize instead of the second racing the first with a stale
  -- grid_width/grid_height read. This SELECT only proves the map exists and
  -- is READABLE by the caller (campaign_maps' SELECT policy also lets a
  -- member read the campaign's current live map) — it does NOT by itself
  -- prove the caller may WRITE it; see the `not found` check after the
  -- final UPDATE below for that.
  select * into v_map
  from public.campaign_maps
  where id = p_map_id
  for update;

  if not found then
    -- RLS makes "doesn't exist" and "not yours to even see" indistinguishable
    -- here, same opacity as getMap's null.
    raise exception 'Map not found, or you may not resize it';
  end if;

  if p_edge = 'west' then
    v_dx := p_amount;
  elsif p_edge = 'north' then
    v_dy := p_amount;
  end if;

  if v_dx <> 0 or v_dy <> 0 then
    -- Re-indexes every existing cell/concealed pit so the new (0,0) origin
    -- lands correctly, carrying EVERY current column of each table forward
    -- unchanged except x/y — see shift_map_coordinate_table's own comment
    -- for why this can no longer drift out of sync the way the old inline
    -- map_cells column list did.
    perform public.shift_map_coordinate_table('map_cells', p_map_id, v_dx, v_dy);
    perform public.shift_map_coordinate_table('concealed_pits', p_map_id, v_dx, v_dy);

    -- map_objects and map_tokens are keyed by their own uuid `id` — x/y
    -- carry no uniqueness constraint on either table, so a plain shift
    -- (unlike map_cells/concealed_pits above) can never collide mid-update.
    -- Same harmless zero-rows-affected outcome for a caller who can't write
    -- this map.
    update public.map_objects
    set x = x + v_dx, y = y + v_dy
    where map_id = p_map_id;

    update public.map_tokens
    set x = x + v_dx, y = y + v_dy
    where map_id = p_map_id;
  end if;

  update public.campaign_maps
  set grid_width = grid_width + case when p_edge in ('east', 'west') then p_amount else 0 end,
      grid_height = grid_height + case when p_edge in ('north', 'south') then p_amount else 0 end
  where id = p_map_id
  returning * into v_map;

  if not found then
    -- The initial SELECT above only proves the caller can READ this map —
    -- campaign_maps' SELECT policy is broader than its UPDATE one (a member
    -- can read the campaign's live map; only the DM can write it). A non-DM
    -- caller reaches this exact point having had every statement above
    -- silently affect zero rows (map_cells/concealed_pits/map_objects/
    -- map_tokens' RLS is exactly as DM-only as campaign_maps' own UPDATE
    -- policy, so nothing was actually shifted either) — this turns that
    -- silent no-op into the same raised exception a nonexistent map gets,
    -- rather than deceptively returning the unchanged row as if the grow
    -- had succeeded.
    raise exception 'Map not found, or you may not resize it';
  end if;

  return v_map;
end;
$$;

grant execute on function public.grow_map_grid(uuid, text, integer) to authenticated;
