-- Fixes a real regression from 0048 (per-viewer map visibility): the DM's
-- own `.insert(...).select().single()` on campaign_maps — createMap/
-- createPopulatedMap's normal pattern (src/data-access/maps.ts), and so
-- MapsManager.tsx's "Create & edit" button for EVERY map, template or
-- blank — has been failing with "new row violates row-level security
-- policy for table campaign_maps" ever since, even for a legitimate DM.
--
-- Root cause: `INSERT ... RETURNING` (what `.insert().select()` compiles
-- to) re-checks the table's SELECT policy against the just-inserted row.
-- 0048 rewrote that SELECT policy to `using (can_read_map(id))`, and
-- can_read_map's body does its OWN separate lookup of campaign_maps BY ID
-- (`select 1 from campaign_maps m ... where m.id = p_map_id`) — a fresh,
-- separate scan of the very table being inserted into, executed via a
-- SECURITY DEFINER function call during that same INSERT command. Within a
-- single command, Postgres has not yet advanced its command counter past
-- the row's own insertion, so that fresh scan cannot see the row: exists()
-- comes back false, can_read_map returns false, and the RETURNING
-- projection is rejected as an RLS violation — reproduced by hand against
-- the live instance for a plain vanilla DM insert (code 42501), and it
-- reproduces identically for a blank map as for any template, confirming
-- this is normal MVCC command-visibility behavior (not a version-specific
-- fluke) and entirely unrelated to the new map templates.
--
-- This is a different shape from the README's documented INSERT+RETURNING
-- gotcha (a row that depends on a DIFFERENT table's not-yet-existing row,
-- like campaigns depending on campaign_members) — here the dependency is
-- on the SAME row, in the SAME table, via an unnecessary re-fetch-by-id.
-- The 0015-era policy (before 0048) never had this problem because it
-- checked the row's own already-bound columns directly (`campaign_maps.id`,
-- `campaign_maps.campaign_id`) instead of re-querying campaign_maps for
-- them — the fix below restores that shape while keeping 0048's added "my
-- own token is on this map" branch. can_read_map itself is UNCHANGED and
-- kept exactly as 0048 left it: it's still correct and still needed as-is
-- for map_cells/map_objects/map_tokens/light_sources, none of which
-- self-reference campaign_maps the way campaign_maps' own SELECT policy
-- was doing.
drop policy if exists "a map is readable per can_read_map" on public.campaign_maps;

create policy "a map is readable per can_read_map"
  on public.campaign_maps for select
  to authenticated
  using (
    public.is_campaign_dm(campaign_id)
    or (
      public.is_campaign_member(campaign_id)
      and (
        exists (
          select 1
          from public.campaigns c
          where c.id = campaign_maps.campaign_id
            and c.live_map = campaign_maps.id
        )
        or exists (
          select 1
          from public.map_tokens mt
          join public.characters ch on ch.id = mt.character_id
          where mt.map_id = campaign_maps.id
            and ch.owner_id = auth.uid()
        )
      )
    )
  );
