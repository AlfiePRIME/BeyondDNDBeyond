-- Map Editor Batch A4: item containers — flavor loot living on a chest (a
-- MapObject) or inside a still-concealed pit (a concealed_pits row). Items
-- here are deliberately lightweight (name/description/icon/tag), NOT a full
-- character-sheet InventoryItem — see characters.ts's own InventoryItem for
-- the real weapon/armor shape this deliberately does not match.
--
-- Two nullable reference columns with a CHECK that exactly one is ever set
-- — the exact shape 0059's interaction_events already established for the
-- same "either kind of container" problem (a concealed pit is not a
-- MapObject at all): real FK integrity (and ON DELETE CASCADE) per source,
-- instead of an unenforced polymorphic id.
--
-- curse_blessing starts unpopulated (always null) — a later prompt in this
-- batch (A9) defines its real jsonb shape and starts writing to it; adding
-- the column now avoids a second migration reshaping this table awkwardly.
create table if not exists public.map_object_items (
  id uuid primary key default gen_random_uuid(),
  -- A convenience denormalization for client-side queries (e.g. listing
  -- "every item this campaign's DM has authored") — NOT itself trusted for
  -- authorization anywhere below; every RLS check and claim_map_object_item
  -- re-derives the owning campaign from the container reference instead.
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  map_object_id uuid references public.map_objects (id) on delete cascade,
  concealed_pit_id uuid references public.concealed_pits (id) on delete cascade,
  name text not null,
  description text,
  -- A plain reference (e.g. an emoji or a short icon key), not a real asset
  -- join — items here are deliberately lightweight.
  icon text,
  -- Independent of map_objects.tag (Batch A6) — a separate freeform label
  -- on a separate table. Copied into interaction_events.tag at pickup time
  -- so an "item_taken" event can carry a human-readable label too.
  tag text,
  curse_blessing jsonb,
  created_at timestamptz not null default now(),
  constraint map_object_items_one_container check (
    (map_object_id is not null and concealed_pit_id is null)
    or (map_object_id is null and concealed_pit_id is not null)
  )
);

create index if not exists map_object_items_campaign_id_idx
  on public.map_object_items (campaign_id);
create index if not exists map_object_items_map_object_id_idx
  on public.map_object_items (map_object_id) where map_object_id is not null;
create index if not exists map_object_items_concealed_pit_id_idx
  on public.map_object_items (concealed_pit_id) where concealed_pit_id is not null;

alter table public.map_object_items enable row level security;

-- The DM can always read every item they authored, across both container
-- kinds — mirrors is_campaign_dm's use everywhere else in this file.
create policy "the DM can read every item in their campaign's containers"
  on public.map_object_items for select
  to authenticated
  using (public.is_campaign_dm(campaign_id));

-- A member may also read a CHEST's items, but only while the chest's own
-- map is readable to them (can_read_map's member branch: the currently
-- live map) — the exact visibility a placed chest object already has.
-- Concealed-pit items are deliberately excluded here: the pit's own row
-- stays DM-only readable (0050's concealed_pits policy), so its items must
-- too, or a player could learn a hidden pit exists — and what's inside it
-- — by simply querying this table before ever triggering it. A pit's items
-- instead reach the finding player through the reveal broadcast the
-- fall-resolution code already sends (GameRoom.tsx's handleTokenLanded),
-- never a raw table read.
create policy "a member can read a chest's items on the live map"
  on public.map_object_items for select
  to authenticated
  using (
    map_object_id is not null
    and exists (
      select 1 from public.map_objects o
      where o.id = map_object_items.map_object_id
        and public.can_read_map(o.map_id)
    )
  );

-- Authoring (add/edit/remove) is DM-only in both directions, joined through
-- whichever container this row belongs to — can_write_map already resolves
-- to is_campaign_dm for that map's own campaign, so this can't be spoofed
-- by supplying a mismatched campaign_id alongside a container from a map
-- the caller doesn't actually DM.
create policy "the DM can add an item to their campaign's container"
  on public.map_object_items for insert
  to authenticated
  with check (
    public.is_campaign_dm(campaign_id)
    and (
      (map_object_id is not null and exists (
        select 1 from public.map_objects o
        where o.id = map_object_items.map_object_id and public.can_write_map(o.map_id)
      ))
      or
      (concealed_pit_id is not null and exists (
        select 1 from public.concealed_pits p
        where p.id = map_object_items.concealed_pit_id and public.can_write_map(p.map_id)
      ))
    )
  );

create policy "the DM can edit their campaign's container items"
  on public.map_object_items for update
  to authenticated
  using (public.is_campaign_dm(campaign_id))
  with check (
    public.is_campaign_dm(campaign_id)
    and (
      (map_object_id is not null and exists (
        select 1 from public.map_objects o
        where o.id = map_object_items.map_object_id and public.can_write_map(o.map_id)
      ))
      or
      (concealed_pit_id is not null and exists (
        select 1 from public.concealed_pits p
        where p.id = map_object_items.concealed_pit_id and public.can_write_map(p.map_id)
      ))
    )
  );

create policy "the DM can remove an item from their campaign's container"
  on public.map_object_items for delete
  to authenticated
  using (public.is_campaign_dm(campaign_id));

-- Taking an item is a privileged cross-cutting action a blanket per-row
-- policy can't express: a non-DM member must be able to remove a row (so
-- it's gone for every connected client, not just their own view), but ONLY
-- via this exact path, and it must also land on their own character's
-- inventory — the trigger_map_object RPC's exact purpose-built posture.
--
-- SELECT ... FOR UPDATE locks the row before deleting it: a second,
-- near-simultaneous call for the same item blocks until the first
-- transaction commits, then finds the row already gone and raises —
-- "picked up once, globally" enforced by real row-level locking, not a
-- client-side race between two players clicking Take at once.
--
-- Also logs the item_taken interaction_events row itself, in this SAME
-- transaction, rather than leaving it to a follow-up client-side
-- createInteractionEvent call (interactionEvents.ts's own doc comment
-- explains why that function can never .select() its own insert back —
-- interaction_events' SELECT policy is DM-only, even for the writer).
-- actor_user_id is auth.uid() — never a caller-supplied value — since this
-- function is SECURITY DEFINER and bypasses interaction_events' own RLS
-- for this insert; auth.uid() here IS this table's "only ever attributed
-- to yourself" guarantee, enforced in code instead of by RLS.
create or replace function public.claim_map_object_item(p_item_id uuid)
returns public.map_object_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.map_object_items;
  v_map_id uuid;
  v_campaign_id uuid;
  v_live_map uuid;
begin
  select * into v_item from public.map_object_items where id = p_item_id for update;

  if v_item.id is null then
    raise exception 'Item not found, or already taken';
  end if;

  if v_item.map_object_id is not null then
    select o.map_id into v_map_id from public.map_objects o where o.id = v_item.map_object_id;
  else
    select p.map_id into v_map_id from public.concealed_pits p where p.id = v_item.concealed_pit_id;
  end if;

  if v_map_id is null then
    raise exception 'Container not found';
  end if;

  select m.campaign_id, c.live_map into v_campaign_id, v_live_map
  from public.campaign_maps m
  join public.campaigns c on c.id = m.campaign_id
  where m.id = v_map_id;

  -- The DM always may; a member only for a container on the currently live
  -- map — can_read_map's own member branch, applied here since a player
  -- should only ever take from what's actually on the table right now.
  if not (
    public.is_campaign_dm(v_campaign_id)
    or (public.is_campaign_member(v_campaign_id) and v_live_map = v_map_id)
  ) then
    raise exception 'Not allowed to take this item';
  end if;

  delete from public.map_object_items where id = p_item_id;

  -- Deliberately does NOT also delete a now-empty concealed_pits row
  -- (an earlier version of this function did, "for editor-list tidiness")
  -- — interaction_events.concealed_pit_id is ON DELETE CASCADE (0059), so
  -- that delete would immediately cascade away the very item_taken row
  -- this function inserts right below, in the SAME transaction, silently
  -- destroying its own audit trail entry the instant it's written. A
  -- concealed pit that's been sprung and fully looted is left as an inert,
  -- item-less husk row instead — already visually indistinguishable in
  -- the DM's editor list from a sprung pit that STILL holds items (see
  -- GameRoom.tsx's reveal branch, which preserves the row whenever it has
  -- ANY items, looted or not), so this isn't a new gap, just an unsolved
  -- pre-existing cosmetic one.
  insert into public.interaction_events
    (campaign_id, map_object_id, concealed_pit_id, action_type, tag, actor_user_id)
  values
    (v_campaign_id, v_item.map_object_id, v_item.concealed_pit_id, 'item_taken', v_item.tag, auth.uid());

  return v_item;
end;
$$;

grant execute on function public.claim_map_object_item(uuid) to authenticated;
