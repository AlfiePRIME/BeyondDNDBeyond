-- grow_map_grid (0108) also shifts players' fog-of-war memory.
--
-- map_seen_cells rows are per player and their UPDATE policy only lets a
-- player touch their own, so the DM's grow couldn't move them: after a
-- north/west grow every player's remembered cells sat offset from the map
-- until re-seen. shift_map_seen_cells is SECURITY DEFINER, but only acts
-- for a caller who may write the map (the DM), so it grants nothing new.
-- Two-phase via negative coordinates, since (map_id, user_id, x, y) is
-- unique and a single-pass shift could collide with a not-yet-moved row.

create or replace function public.shift_map_seen_cells(p_map_id uuid, p_dx integer, p_dy integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_write_map(p_map_id) then
    raise exception 'Map not found, or you may not resize it';
  end if;
  if p_dx = 0 and p_dy = 0 then
    return;
  end if;

  update public.map_seen_cells
  set x = -(x + p_dx) - 1, y = -(y + p_dy) - 1
  where map_id = p_map_id;

  update public.map_seen_cells
  set x = -x - 1, y = -y - 1
  where map_id = p_map_id;
end;
$$;

revoke all on function public.shift_map_seen_cells(uuid, integer, integer) from public;
grant execute on function public.shift_map_seen_cells(uuid, integer, integer) to authenticated;

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

  -- Row lock so two near-simultaneous grows of the same map serialize.
  -- Proves only that the caller can READ the map; see the `not found`
  -- check after the final UPDATE for the write check.
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
    -- No other table references map_cells or map_whiteboard_tiles rows, so
    -- 0057/0058's column-introspecting delete-then-reinsert stays safe here.
    perform public.shift_map_coordinate_table('map_cells', p_map_id, v_dx, v_dy);
    perform public.shift_map_coordinate_table('map_whiteboard_tiles', p_map_id, v_dx, v_dy);

    -- concealed_pits: two-phase in-place update (see header) so the rows
    -- are never deleted and their cascading dependents survive.
    update public.concealed_pits
    set x = -(x + v_dx) - 1, y = -(y + v_dy) - 1
    where map_id = p_map_id;

    update public.concealed_pits
    set x = -x - 1, y = -y - 1
    where map_id = p_map_id;

    -- map_objects and map_tokens carry no coordinate uniqueness constraint.
    update public.map_objects
    set x = x + v_dx, y = y + v_dy
    where map_id = p_map_id;

    update public.map_tokens
    set x = x + v_dx, y = y + v_dy
    where map_id = p_map_id;

    -- Cell-anchored lights only; object/token anchors have null x/y.
    update public.light_sources
    set x = x + v_dx, y = y + v_dy
    where map_id = p_map_id
      and x is not null;

    -- Outgoing transitions: two-phase, for the one-per-origin-cell unique.
    update public.map_transitions
    set from_x = -(from_x + v_dx) - 1, from_y = -(from_y + v_dy) - 1
    where from_map_id = p_map_id;

    update public.map_transitions
    set from_x = -from_x - 1, from_y = -from_y - 1
    where from_map_id = p_map_id;

    -- Incoming transitions (from any map, this one included) land on a
    -- cell of THIS map, so their destination moves with it. No uniqueness
    -- constraint covers to_x/to_y.
    update public.map_transitions
    set to_x = to_x + v_dx, to_y = to_y + v_dy
    where to_map_id = p_map_id;

    -- Every player's remembered fog-of-war moves with the cells (0121).
    perform public.shift_map_seen_cells(p_map_id, v_dx, v_dy);
  end if;

  update public.campaign_maps
  set grid_width = grid_width + case when p_edge in ('east', 'west') then p_amount else 0 end,
      grid_height = grid_height + case when p_edge in ('north', 'south') then p_amount else 0 end
  where id = p_map_id
  returning * into v_map;

  if not found then
    -- A reader who isn't the DM: every statement above matched zero rows
    -- under RLS; turn that silent no-op into the same error a missing map
    -- gets rather than returning the unchanged row as if it had grown.
    raise exception 'Map not found, or you may not resize it';
  end if;

  -- Any accepted map art no longer covers the grown footprint (0078).
  update public.map_art
  set stale = true
  where map_id = p_map_id;

  return v_map;
end;
$$;

grant execute on function public.grow_map_grid(uuid, text, integer) to authenticated;
