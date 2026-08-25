-- Prompt 44: DM reference images — existing battle-map art rendered under
-- the editor grid as a sculpting guide. Columns live on campaign_maps
-- (position in grid units from the grid's center, one uniform scale
-- factor), nullable because no reference image is every map's default.
--
-- The all-or-none constraint keeps the four columns from drifting into a
-- half-set state (a path with no placement, or placement with no image).

alter table public.campaign_maps
  add column if not exists reference_image_ref text,
  add column if not exists reference_image_x real,
  add column if not exists reference_image_y real,
  add column if not exists reference_image_scale real check (reference_image_scale > 0);

alter table public.campaign_maps
  add constraint campaign_maps_reference_image_all_or_none check (
    (
      reference_image_ref is null
      and reference_image_x is null
      and reference_image_y is null
      and reference_image_scale is null
    )
    or (
      reference_image_ref is not null
      and reference_image_x is not null
      and reference_image_y is not null
      and reference_image_scale is not null
    )
  );

-- Storage: same map-scoped {map_id}/{uuid}.ext path shape as map-thumbnails
-- (0024), but the SELECT policy uses can_write_map, NOT can_read_map — on
-- purpose. A thumbnail becomes player-visible once its map is live; a
-- reference image is an editor-only aid that must never be player-visible
-- under any circumstance, live map or not. can_write_map already means
-- "is the DM of the owning campaign", which is exactly that guarantee.
-- Reference art can be a full battle-map scan, hence the 10MB ceiling.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'map-references',
  'map-references',
  false,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp']
);

create policy "only the DM can read their maps' reference images"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'map-references'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can upload reference images for their campaign's maps"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'map-references'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can replace their campaign's map reference images"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'map-references'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'map-references'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can delete their campaign's map reference images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'map-references'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  );
