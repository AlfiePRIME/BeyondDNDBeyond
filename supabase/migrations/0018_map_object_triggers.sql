-- Prompt 28: interactive object triggering.
--
-- map_objects' UPDATE policy (0015) is DM-only via can_write_map — right
-- for move/rotate/reconfigure, but a player triggering a playerTriggerable
-- object also has to persist a state change. Same pattern as start_session
-- and transfer_dm: a purpose-built SECURITY DEFINER RPC with its own
-- narrower authorization, instead of loosening the blanket table policy
-- (which would let players move/delete/reconfigure objects too).
--
-- p_triggered is the explicit target state, not a server-side flip, so a
-- retried or duplicate call is idempotent and the caller's realtime
-- broadcast can never disagree with what was persisted.
create or replace function public.trigger_map_object(p_object_id uuid, p_triggered boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_map_id uuid;
  v_campaign_id uuid;
  v_live_map uuid;
  v_config jsonb;
begin
  select o.map_id, m.campaign_id, c.live_map, o.behavior_config
    into v_map_id, v_campaign_id, v_live_map, v_config
  from public.map_objects o
  join public.campaign_maps m on m.id = o.map_id
  join public.campaigns c on c.id = m.campaign_id
  where o.id = p_object_id;

  if v_map_id is null then
    raise exception 'Object not found';
  end if;

  if v_config->>'action' is null then
    raise exception 'This object has no configured action';
  end if;

  if not public.is_campaign_dm(v_campaign_id) then
    -- A non-DM may trigger only what they can legitimately see: member of
    -- the campaign, the object's map is the live one (matching can_read_map's
    -- member branch), and the object itself opts in via playerTriggerable.
    if not (
      public.is_campaign_member(v_campaign_id)
      and v_live_map = v_map_id
      and coalesce(v_config->>'playerTriggerable', 'false') = 'true'
    ) then
      raise exception 'Only the DM can trigger this object';
    end if;
  end if;

  -- Merging just the 'triggered' key (and requiring a configured action to
  -- still be there) means this function can never touch the authoring
  -- fields, even if a reconfigure raced the trigger.
  update public.map_objects
  set behavior_config = behavior_config || jsonb_build_object('triggered', p_triggered)
  where id = p_object_id
    and behavior_config ? 'action';
end;
$$;

grant execute on function public.trigger_map_object(uuid, boolean) to authenticated;
