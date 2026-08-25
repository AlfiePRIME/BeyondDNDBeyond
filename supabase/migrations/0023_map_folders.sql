-- Prompt 39: folders for organizing a campaign's maps, plus a per-map
-- thumbnail reference. RLS is DM-only for BOTH read and write — stricter
-- than campaign_maps' member-sees-live-map SELECT carve-out — because the
-- map list itself is DM-only end to end (the maps page 404s non-DM
-- members); a non-DM has no map browsing surface for folder names to
-- appear on.

create table if not exists public.map_folders (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

alter table public.map_folders enable row level security;

create policy "a DM can read their campaign's map folders"
  on public.map_folders for select
  to authenticated
  using (public.is_campaign_dm(campaign_id));

create policy "a DM can create map folders in their campaign"
  on public.map_folders for insert
  to authenticated
  with check (public.is_campaign_dm(campaign_id));

create policy "a DM can rename their campaign's map folders"
  on public.map_folders for update
  to authenticated
  using (public.is_campaign_dm(campaign_id))
  with check (public.is_campaign_dm(campaign_id));

create policy "a DM can delete their campaign's map folders"
  on public.map_folders for delete
  to authenticated
  using (public.is_campaign_dm(campaign_id));

-- set null, not cascade: deleting a folder unfiles its maps (they fall back
-- to the picker's synthetic "Unfiled" group) rather than deleting them.
alter table public.campaign_maps
  add column if not exists folder_id uuid references public.map_folders (id) on delete set null;

-- Storage object path of the map's latest top-down snapshot (map-thumbnails
-- bucket, 0024); null until the first save-time capture lands.
alter table public.campaign_maps
  add column if not exists thumbnail_ref text;
