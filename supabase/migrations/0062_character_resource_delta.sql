-- Map Editor Batch A9: curses and blessings on placeable items. The
-- curse_blessing jsonb column itself already exists (added, unpopulated, by
-- A4's migration 0060) — no schema change is needed for it, this app writes
-- a structured payload into an already-existing nullable jsonb column. The
-- one genuinely new piece of database plumbing A9 needs is an atomic
-- "resource-count delta" apply function for the "resource-count delta"
-- mechanical effect kind, mirroring apply_hp_delta (0028) and
-- apply_exhaustion_delta (0029) exactly.
--
-- character_resources' own existing write path (setCharacterResourceUses,
-- characterResources.ts) only ever SETS an absolute value from a
-- client-side read of the current one — fine for the DM's own manual
-- editor, but not safe for a delta applied automatically at item-pickup
-- time, which must be computed from whatever the CURRENT stored value is
-- under a row lock, not a value read moments earlier on the client.
--
-- A cursed/blessed item is configured by the DM before any specific
-- character has taken it, so it can't reference a specific
-- character_resources.id (that row doesn't exist yet for an arbitrary
-- future taker) — the effect instead names the resource (e.g. "Ki
-- Points"), matched case-insensitively against the TAKING character's own
-- resources at apply time. A character with no resource by that name is a
-- silent no-op (returns null) rather than an error: the item is still
-- successfully taken either way, a missing resource just means this
-- particular effect has nothing to act on for this particular character.
--
-- SECURITY INVOKER (no `security definer`, matching apply_hp_delta/
-- apply_exhaustion_delta): the row lock (`for update`) and the update both
-- ride character_resources' own existing RLS (0008's can_access_character —
-- owner or campaign DM), so this can't be used to change a resource the
-- caller couldn't already change directly.
create or replace function public.apply_character_resource_delta(
  p_character_id uuid,
  p_resource_name text,
  p_delta integer
)
returns public.character_resources
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_row public.character_resources;
begin
  select id into v_id
  from public.character_resources
  where character_id = p_character_id
    and lower(name) = lower(p_resource_name)
  order by created_at asc
  limit 1
  for update;

  if v_id is null then
    return null;
  end if;

  update public.character_resources
  set current_uses = least(max_uses, greatest(0, current_uses + p_delta))
  where id = v_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.apply_character_resource_delta(uuid, text, integer) to authenticated;
