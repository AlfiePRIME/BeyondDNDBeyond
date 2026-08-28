-- Map Art Generation E6: growing a map's grid (grow_map_grid, 0046/0057)
-- extends its footprint, but any already-generated map_art (0077) was
-- rendered against the map's PREVIOUS, smaller dimensions — the new cells
-- have no corresponding art. Per this track's stated v1 scope there is no
-- inpainting/outpainting attempt: growth just marks existing art `stale`
-- (a flag, never a deletion — the DM may still want to see/reference the
-- old art while deciding what to do) with an explicit path back to a
-- fresh, correct state (regenerate, which naturally covers the map's
-- CURRENT footprint since generate-art/route.ts always reads the map's
-- live grid_width/grid_height at request time, not whatever it was when
-- art was first accepted).
--
-- Not null default false: every existing map_art row (and every map with
-- no art at all) is unambiguously "not stale" until a grow actually makes
-- it so — no backfill/migration-window ambiguity.
alter table public.map_art
  add column if not exists stale boolean not null default false;

-- grow_map_grid itself: identical to 0057's version in every way except one
-- new statement at the very end. That statement runs unconditionally, after
-- the grid dimensions themselves are updated — deliberately NOT nested
-- inside the `if v_dx <> 0 or v_dy <> 0` branch above it. That branch is
-- specifically the west/north coordinate-shift special case; it says
-- nothing about which edges enlarge the map's footprint. East/south growth
-- is a pure grid_width/grid_height bump with no coordinate shift at all,
-- but it enlarges the footprint exactly as much as west/north does — art
-- goes stale on every edge, not just the two that happen to shift
-- coordinates.
--
-- Scoped to `where map_id = p_map_id` with no read-then-branch beforehand:
-- a map with no map_art row at all matches zero rows here, a true no-op,
-- so a map with NO generated art attached is completely unaffected by this
-- change — the explicit zero-regression requirement this prompt calls
-- out. No SECURITY DEFINER, matching grow_map_grid's own established
-- posture (0046/0057's own header comments): map_art's own UPDATE RLS
-- (0077, can_write_map-gated) already restricts this exactly like every
-- other write in this function, so a caller who can't write this map
-- still only ever produces harmless zero-rows no-ops throughout the whole
-- function body, this new statement included.
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

  -- Map Art Generation E6: this map's footprint just grew (on ANY edge —
  -- east/south's plain grid_width/grid_height bump enlarges the footprint
  -- exactly as much as a west/north coordinate shift does) — any art
  -- already generated for it no longer covers the full grid. Flag it, do
  -- not delete it: the DM may still want to see/reference the old art
  -- while deciding whether/when to regenerate. A map with no map_art row
  -- matches zero rows here — a true no-op, not merely a harmless UPDATE —
  -- so a map with NO generated art attached is completely unaffected by
  -- this whole feature.
  update public.map_art
  set stale = true
  where map_id = p_map_id;

  return v_map;
end;
$$;

grant execute on function public.grow_map_grid(uuid, text, integer) to authenticated;
