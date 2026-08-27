-- Whiteboard drawing layer (docs/design/whiteboard-drawing-layer.md, Prompt
-- 3 — persistence, live sync, and the grid-growth extension). The DM's
-- annotation layer is persisted per-cell, "pinned to the tile" (the
-- project owner's own decision, §4.4): a new sibling table keyed exactly
-- like concealed_pits (0050) — (map_id, x, y) composite primary key, sparse
-- (a row exists only for a cell that actually has ink on it) — NOT a new
-- map_cells column (every existing map_cells widening is a small, always-
-- present scalar every cell has SOME value for; a whiteboard tile is the
-- opposite: most cells never have one, and the ones that do carry a real,
-- variable-sized binary payload that a full map_cells fetch has no reason
-- to drag along for cells that never used it) and NOT a Storage bucket
-- path (unlike map-thumbnails/map-references/npc-portraits/handout-storage
-- — see §4.4 for the full reasoning: this feature is many small tiles per
-- map mutated frequently, not one blob per parent row uploaded rarely, and
-- a bytea column moves for free inside grow_map_grid's existing plpgsql
-- transaction via a plain SQL insert ... select, exactly like map_cells'
-- own shift, while a Storage-keyed scheme would need a separate,
-- non-transactional set of Storage API calls to move objects alongside the
-- SQL shift).
--
-- Unlike concealed_pits (DM-only in both directions, since a hidden pit
-- must stay invisible to players), this table is member-readable: the
-- owner's decision is that players see the DM's drawing live with no
-- reveal gate, so can_read_map(map_id) — the same per-viewer-aware
-- predicate map_cells/map_objects already use (0015, extended by 0048 to
-- cover "my own token is on this map" as well as the shared live map) — is
-- the read policy. Writes stay can_write_map(map_id)-gated, DM-only,
-- matching every other map_cells-adjacent write policy.
create table if not exists public.map_whiteboard_tiles (
  map_id uuid not null references public.campaign_maps (id) on delete cascade,
  x integer not null,
  y integer not null,
  tile_png bytea not null,
  updated_at timestamptz not null default now(),
  primary key (map_id, x, y)
);

alter table public.map_whiteboard_tiles enable row level security;

-- drop-if-exists first: this migration may be re-applied under a
-- renumbered filename after already landing once against the shared dev
-- database (0048/0050's own precedent) — other agents may be applying
-- migrations directly to that same shared stack while this one is in
-- flight.
drop policy if exists "read a whiteboard tile iff its map is readable" on public.map_whiteboard_tiles;
drop policy if exists "write a whiteboard tile iff its map is writable" on public.map_whiteboard_tiles;
drop policy if exists "update a whiteboard tile iff its map is writable" on public.map_whiteboard_tiles;
drop policy if exists "delete a whiteboard tile iff its map is writable" on public.map_whiteboard_tiles;

create policy "read a whiteboard tile iff its map is readable"
  on public.map_whiteboard_tiles for select
  to authenticated
  using (public.can_read_map(map_id));

create policy "write a whiteboard tile iff its map is writable"
  on public.map_whiteboard_tiles for insert
  to authenticated
  with check (public.can_write_map(map_id));

create policy "update a whiteboard tile iff its map is writable"
  on public.map_whiteboard_tiles for update
  to authenticated
  using (public.can_write_map(map_id))
  with check (public.can_write_map(map_id));

create policy "delete a whiteboard tile iff its map is writable"
  on public.map_whiteboard_tiles for delete
  to authenticated
  using (public.can_write_map(map_id));

-- Grid-growth integration (§8.1): extend shift_map_coordinate_table's own
-- allowlist (0057) to also cover map_whiteboard_tiles, exactly the
-- mechanism that already generically carries map_cells/concealed_pits'
-- own non-key columns through a west/north shift via information_schema
-- introspection — no new shift code, no hardcoded column list to drift out
-- of sync the next time this table is widened (the exact class of bug
-- 0057 fixed at the mechanism level specifically so this wouldn't need to
-- happen again). Purely additive: the allowlist gains one more literal,
-- the introspection/delete-then-reinsert machinery is completely
-- unchanged, and a map with zero map_whiteboard_tiles rows shifts exactly
-- as before (the `removed` CTE is empty, the insert affects zero rows).
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
  if p_table_name not in ('map_cells', 'concealed_pits', 'map_whiteboard_tiles') then
    raise exception 'shift_map_coordinate_table: unsupported table %', p_table_name;
  end if;

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
  into v_extra_cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = p_table_name
    and column_name not in ('map_id', 'x', 'y')
    and coalesce(is_generated, 'NEVER') = 'NEVER';

  v_extra_select := coalesce(', ' || v_extra_cols, '');

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

-- grow_map_grid itself: identical to 0057's version in every way except
-- one additional shift_map_coordinate_table call for map_whiteboard_tiles,
-- right alongside map_cells/concealed_pits' own — so a map's whiteboard
-- drawing carries along with its cells on a west/north grid grow, the same
-- guarantee already given to map_cells/map_objects/map_tokens/
-- concealed_pits. A map with no whiteboard tiles at all sees this new
-- call affect zero rows, identical to how a map with no concealed pits
-- already sees THAT call affect zero rows today — no behavior change for
-- the already-shipped, already-tested case.
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

  select * into v_map
  from public.campaign_maps
  where id = p_map_id
  for update;

  if not found then
    raise exception 'Map not found, or you may not resize it';
  end if;

  if p_edge = 'west' then
    v_dx := p_amount;
  elsif p_edge = 'north' then
    v_dy := p_amount;
  end if;

  if v_dx <> 0 or v_dy <> 0 then
    perform public.shift_map_coordinate_table('map_cells', p_map_id, v_dx, v_dy);
    perform public.shift_map_coordinate_table('concealed_pits', p_map_id, v_dx, v_dy);
    perform public.shift_map_coordinate_table('map_whiteboard_tiles', p_map_id, v_dx, v_dy);

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
    raise exception 'Map not found, or you may not resize it';
  end if;

  return v_map;
end;
$$;

grant execute on function public.grow_map_grid(uuid, text, integer) to authenticated;
